// Meta Model API contract for the Athena prototype. Pure + client-safe (no secrets, no I/O).
// Verified from dev.meta.ai docs (Oct 2026): OpenAI-compatible Chat Completions at
// POST https://api.meta.ai/v1/chat/completions, Bearer auth, model "muse-spark-1.3",
// structured output via response_format { type: "json_schema", json_schema: { name, schema } },
// response.choices[0].message.content, choices[0].finish_reason ("length" = hit token cap),
// response.usage token counts (reasoning tokens count as output).
// Verified (dev.meta.ai/docs/reasoning): `max_tokens` is the Chat Completions output cap; reasoning tokens count
// toward it and are billed as output (usage.completion_tokens_details.reasoning_tokens). `reasoning_effort`
// accepts minimal|low|medium|high; "none" returns HTTP 400 for Muse Spark; default effort is not documented.
// NOT verified: pricing.
import { z } from "zod";
import { SCENARIOS, WORKSPACES, type EvidenceRecord } from "../data";
import { filterVisible } from "../engine";

export const META_ENDPOINT = "https://api.meta.ai/v1/chat/completions";
export const META_MODEL = "muse-spark-1.3";
export const MAX_INPUT_TOKENS = 3000;
/** Hard server cap sent as max_tokens. Includes hidden reasoning tokens. */
export const MAX_OUTPUT_TOKENS = 2000;
export const REASONING_EFFORT = "minimal" as const;
export const LIMITS = { observations: 5, hypotheses: 3, missing: 4, recommendations: 3, text: 200, ids: 6 } as const;
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

const ids = z.array(z.string()).min(1).max(LIMITS.ids);
const txt = z.string().min(1).max(LIMITS.text);
export const OutputSchema = z
  .object({
    observations: z.array(z.object({ text: txt, cited_ids: ids }).strict()).max(LIMITS.observations),
    hypotheses: z.array(z.object({ text: txt, verified: z.literal(false), cited_ids: ids }).strict()).max(LIMITS.hypotheses),
    missing_evidence: z.array(txt).max(LIMITS.missing),
    recommendations: z.array(z.object({ text: txt, requires_human_approval: z.literal(true), cited_ids: ids }).strict()).max(LIMITS.recommendations),
  })
  .strict();
export type MetaOutput = z.infer<typeof OutputSchema>;

const T = { type: "string", maxLength: LIMITS.text } as const;
const I = { type: "array", minItems: 1, maxItems: LIMITS.ids, items: { type: "string" } } as const;
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
        observations: { type: "array", maxItems: LIMITS.observations, items: { type: "object", additionalProperties: false, required: ["text", "cited_ids"], properties: { text: T, cited_ids: I } } },
        hypotheses: { type: "array", maxItems: LIMITS.hypotheses, items: { type: "object", additionalProperties: false, required: ["text", "verified", "cited_ids"], properties: { text: T, verified: { type: "boolean", enum: [false] }, cited_ids: I } } },
        missing_evidence: { type: "array", maxItems: LIMITS.missing, items: T },
        recommendations: { type: "array", maxItems: LIMITS.recommendations, items: { type: "object", additionalProperties: false, required: ["text", "requires_human_approval", "cited_ids"], properties: { text: T, requires_human_approval: { type: "boolean", enum: [true] }, cited_ids: I } } },
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
    "If evidence is missing, list it in missing_evidence. BE TERSE: at most " + `${LIMITS.observations} observations, ${LIMITS.hypotheses} hypotheses, ${LIMITS.missing} missing_evidence, ${LIMITS.recommendations} recommendations; ` + "each text one sentence under 25 words. Output only the JSON object.";
  return [
    { role: "system" as const, content: system },
    { role: "user" as const, content: `Question: ${question}\nRecords (JSON): ${JSON.stringify(rows)}` },
  ];
}

/** Always rejected, in every field: assertions of proven causality. */
const STRONG_CAUSAL = /\b(proves?|proven|caused|is the cause|definitively|confirms that)\b/;
/** "cause(s)" is a claim unless an investigative cue precedes it in the same sentence. */
const CAUSE_WORD = /\bcauses?\b/;
const INVESTIGATIVE = /\b(investigate|investigating|identify|examine|review|explore|assess|determine|diagnose|analy[sz]e|check|audit|verify|test|possible|potential|likely|underlying|root)\b/;

/** Normalize to defeat case/width/zero-width obfuscation (NFKC, strip invisible chars, lowercase). */
export const normalizeText = (t: string) => t.normalize("NFKC").replace(/[\u00AD\u200B-\u200F\u2060\uFEFF]/g, "").replace(/\s+/g, " ").toLowerCase();

/** Returns true if text makes an unsupported causal claim. Investigative wording is allowed only in
 * recommendations and missing_evidence; observations and hypotheses stay strict (any "cause(s)" fails). */
export function hasCausalClaim(text: string, allowInvestigative: boolean): boolean {
  const t = normalizeText(text);
  if (STRONG_CAUSAL.test(t)) return true;
  for (const sentence of t.split(/[.!?;]+/)) {
    const m = CAUSE_WORD.exec(sentence);
    if (!m) continue;
    if (!allowInvestigative || !INVESTIGATIVE.test(sentence.slice(0, m.index))) return true;
  }
  return false;
}

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
  const causalChecks: [string, boolean][] = [
    ...out.observations.map((x) => [x.text, false] as [string, boolean]),
    ...out.hypotheses.map((x) => [x.text, false] as [string, boolean]),
    ...out.missing_evidence.map((x) => [x, true] as [string, boolean]),
    ...out.recommendations.map((x) => [x.text, true] as [string, boolean]),
  ];
  for (const [t, inv] of causalChecks) if (hasCausalClaim(t, inv)) { errors.push(`Causal-proof language rejected: "${t.slice(0, 60)}"`); break; }
  return errors.length ? { ok: false, errors } : { ok: true, output: out };
}
