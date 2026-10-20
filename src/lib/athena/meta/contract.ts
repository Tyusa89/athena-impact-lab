// Meta Model API contract for the Athena prototype. Pure + client-safe (no secrets, no I/O).
// Verified from dev.meta.ai docs (Oct 2026): OpenAI-compatible Chat Completions at
// POST https://api.meta.ai/v1/chat/completions, Bearer auth, model "muse-spark-1.3",
// structured output via response_format { type: "json_schema", json_schema: { name, schema } },
// response.choices[0].message.content, choices[0].finish_reason ("length" = hit token cap),
// response.usage token counts (reasoning tokens count as output).
// NOT verified: exact name of the output-cap parameter (we send OpenAI-style `max_tokens`) and pricing.
import { z } from "zod";
import { SCENARIOS, WORKSPACES, type EvidenceRecord } from "../data";
import { filterVisible } from "../engine";

export const META_ENDPOINT = "https://api.meta.ai/v1/chat/completions";
export const META_MODEL = "muse-spark-1.3";
export const MAX_INPUT_TOKENS = 3000;
export const MAX_OUTPUT_TOKENS = 1200;
export const REQUEST_TIMEOUT_MS = 30_000;
/** Synthetic-only allowlist: only these bundled scenario IDs can ever be sent. */
export const SYNTHETIC_SCENARIO_ALLOWLIST: readonly string[] = SCENARIOS.map((s) => s.id);
const WORKSPACE_IDS = WORKSPACES.map((w) => w.id) as readonly string[];

/** Rough, conservative token estimate (~3 chars/token). */
export const estimateTokens = (s: string) => Math.ceil(s.length / 3);

export const RequestSchema = z.object({
  scenarioId: z.string().refine((id) => SYNTHETIC_SCENARIO_ALLOWLIST.includes(id), "Scenario not in synthetic allowlist"),
  workspaces: z.array(z.string().refine((w) => WORKSPACE_IDS.includes(w), "Unknown workspace")).max(WORKSPACE_IDS.length),
  ownerConfirmed: z.literal(true),
});
export type MetaRequest = z.infer<typeof RequestSchema>;

const ids = z.array(z.string()).min(1).max(20);
export const OutputSchema = z
  .object({
    observations: z.array(z.object({ text: z.string().max(400), cited_ids: ids }).strict()).max(10),
    hypotheses: z.array(z.object({ text: z.string().max(400), verified: z.literal(false), cited_ids: ids }).strict()).max(6),
    missing_evidence: z.array(z.string().max(300)).max(8),
    recommendations: z.array(z.object({ text: z.string().max(300), requires_human_approval: z.literal(true), cited_ids: ids }).strict()).max(6),
  })
  .strict();
export type MetaOutput = z.infer<typeof OutputSchema>;

/** JSON schema sent as response_format (mirrors OutputSchema). */
export const RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "AthenaAnalysis",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["observations", "hypotheses", "missing_evidence", "recommendations"],
      properties: {
        observations: { type: "array", items: { type: "object", additionalProperties: false, required: ["text", "cited_ids"], properties: { text: { type: "string" }, cited_ids: { type: "array", items: { type: "string" } } } } },
        hypotheses: { type: "array", items: { type: "object", additionalProperties: false, required: ["text", "verified", "cited_ids"], properties: { text: { type: "string" }, verified: { type: "boolean", enum: [false] }, cited_ids: { type: "array", items: { type: "string" } } } } },
        missing_evidence: { type: "array", items: { type: "string" } },
        recommendations: { type: "array", items: { type: "object", additionalProperties: false, required: ["text", "requires_human_approval", "cited_ids"], properties: { text: { type: "string" }, requires_human_approval: { type: "boolean", enum: [true] }, cited_ids: { type: "array", items: { type: "string" } } } } },
      },
    },
  },
} as const;

/** Server-side reconstruction: records come only from bundled synthetic data, filtered BEFORE prompt building. */
export function authorizedRecords(req: Pick<MetaRequest, "scenarioId" | "workspaces">): EvidenceRecord[] {
  const s = SCENARIOS.find((x) => x.id === req.scenarioId);
  if (!s) throw new Error("Scenario not in synthetic allowlist");
  return filterVisible(s.records, req.workspaces);
}

export function buildMessages(question: string, records: EvidenceRecord[]) {
  const rows = records.map(({ id, department, date, metric, period, value, unit }) => ({ id, department, date, metric, period, value, unit }));
  const system =
    "You analyse SYNTHETIC business records for a fictional company. Use ONLY the records provided. " +
    "Cite record ids exactly as given in cited_ids. Never cite ids not in the input. Do not claim causation or proof; " +
    "hypotheses are unverified co-movement. Recommendations are proposals that require human approval; you cannot execute actions. " +
    "If evidence is missing, list it in missing_evidence.";
  return [
    { role: "system" as const, content: system },
    { role: "user" as const, content: `Question: ${question}\nRecords (JSON): ${JSON.stringify(rows)}` },
  ];
}

const CAUSAL = /\b(proves?|proven|caused|causes|is the cause|definitively|confirms that)\b/i;

export type ValidationResult = { ok: true; output: MetaOutput } | { ok: false; errors: string[] };

/** Strict output gate: schema, citation provenance, cross-workspace leaks, causal claims. */
export function validateOutput(raw: string, authorized: EvidenceRecord[], allRecords: EvidenceRecord[]): ValidationResult {
  let json: unknown;
  try { json = JSON.parse(raw); } catch { return { ok: false, errors: ["Output is not valid JSON"] }; }
  const parsed = OutputSchema.safeParse(json);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((i) => `Schema: ${i.path.join(".") || "(root)"} ${i.message}`) };
  const out = parsed.data;
  const allowed = new Set(authorized.map((r) => r.id));
  const hidden = allRecords.filter((r) => !allowed.has(r.id));
  const errors: string[] = [];
  const cited = [...out.observations, ...out.hypotheses, ...out.recommendations].flatMap((x) => x.cited_ids);
  for (const id of new Set(cited)) if (!allowed.has(id)) errors.push(`Unsupported citation: ${id}`);
  const texts = [...out.observations.map((x) => x.text), ...out.hypotheses.map((x) => x.text), ...out.missing_evidence, ...out.recommendations.map((x) => x.text)];
  for (const r of hidden) if (texts.some((t) => t.includes(r.id) || t.includes(r.source))) errors.push(`Cross-workspace leak: reference to unauthorized record ${r.id}`);
  for (const t of texts) if (CAUSAL.test(t)) { errors.push(`Causal-proof language rejected: "${t.slice(0, 60)}"`); break; }
  return errors.length ? { ok: false, errors } : { ok: true, output: out };
}
