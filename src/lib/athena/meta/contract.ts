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
import { PERIODS, ROLES, SCENARIOS, WORKSPACES, type EvidenceRecord } from "../data";
import { filterVisible } from "../engine";
import { renderFindings, type VerifiedFinding } from "./findings";
import { buildVerifiedFacts, supportingIdsFor, verifyNoNumerals } from "./numericGrounding";

export const META_ENDPOINT = "https://api.meta.ai/v1/chat/completions";
export const META_MODEL = "muse-spark-1.3";
export const MAX_INPUT_TOKENS = 3000;
/** Hard server cap sent as max_tokens. Includes hidden reasoning tokens. */
export const MAX_OUTPUT_TOKENS = 2000;
export const REASONING_EFFORT = "minimal" as const;
export const LIMITS = { interpretations: 3, missing: 4, recommendations: 3, text: 200, refs: 4 } as const;
export const REQUEST_TIMEOUT_MS = 30_000;
/** Synthetic-only allowlist: only these bundled scenario IDs can ever be sent. */
export const SYNTHETIC_SCENARIO_ALLOWLIST: readonly string[] = SCENARIOS.map((s) => s.id);
const WORKSPACE_IDS = WORKSPACES.map((w) => w.id) as readonly string[];

/** DEMO ROLE FILTERING ONLY — NOT REAL AUTHORIZATION. Server-owned, frozen role → workspace allowlist.
 * Copied (not referenced) from the UI role list so runtime mutation of ROLES cannot widen it.
 * Any caller can still CLAIM any listed role: there is no sign-in. */
export const SERVER_ROLE_WORKSPACES: Readonly<Record<string, readonly string[]>> = Object.freeze(
  Object.fromEntries(ROLES.map((r) => [r.id, Object.freeze(r.workspaces.filter((w) => WORKSPACE_IDS.includes(w)))])),
);
export function workspacesForRole(roleId: string): readonly string[] {
  if (!Object.prototype.hasOwnProperty.call(SERVER_ROLE_WORKSPACES, roleId)) throw new Error("Unknown role");
  return SERVER_ROLE_WORKSPACES[roleId]!;
}

/** Rough, conservative token estimate (~3 chars/token). */
export const estimateTokens = (s: string) => Math.ceil(s.length / 3);

export const RequestSchema = z.object({
  scenarioId: z.string().refine((id) => SYNTHETIC_SCENARIO_ALLOWLIST.includes(id), "Scenario not in synthetic allowlist"),
  // Only an allowlisted role id is accepted; any client workspaces/records/other fields are stripped by zod.
  roleId: z.string().refine((r) => Object.prototype.hasOwnProperty.call(SERVER_ROLE_WORKSPACES, r), "Unknown role"),
  ownerConfirmed: z.literal(true),
});
export type MetaRequest = z.infer<typeof RequestSchema>;

// Three lanes. Verified findings are NOT part of the model output: Athena renders them server-side from verified facts.
// The model supplies only unverified interpretations and human-approval-gated proposals, each pointing at fact ids.
// There are deliberately no observations, numeric claims or record citations in this contract (hard switch from v1).
const refs = z.array(z.string().min(1).max(40)).min(1).max(LIMITS.refs);
const txt = z.string().min(1).max(LIMITS.text);
export const OutputSchema = z
  .object({
    interpretations: z.array(z.object({ text: txt, verified: z.literal(false), refs }).strict()).max(LIMITS.interpretations),
    missing_evidence: z.array(txt).max(LIMITS.missing),
    recommendations: z.array(z.object({ text: txt, requires_human_approval: z.literal(true), refs }).strict()).max(LIMITS.recommendations),
  })
  .strict();
/** Exactly what the model may send. */
export type ModelOutput = z.infer<typeof OutputSchema>;
/** Validated model output enriched server-side: citations are derived from the referenced verified facts, never from the model. */
export type MetaOutput = {
  interpretations: { text: string; verified: false; refs: string[]; supporting_ids: string[] }[];
  missing_evidence: string[];
  recommendations: { text: string; requires_human_approval: true; refs: string[]; supporting_ids: string[] }[];
};

const T = { type: "string", maxLength: LIMITS.text } as const;
const R = { type: "array", minItems: 1, maxItems: LIMITS.refs, items: { type: "string" } } as const;
/** JSON schema sent as response_format (mirrors OutputSchema). */
export const RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "AthenaAnalysisV2",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["interpretations", "missing_evidence", "recommendations"],
      properties: {
        interpretations: { type: "array", maxItems: LIMITS.interpretations, items: { type: "object", additionalProperties: false, required: ["text", "verified", "refs"], properties: { text: T, verified: { type: "boolean", enum: [false] }, refs: R } } },
        missing_evidence: { type: "array", maxItems: LIMITS.missing, items: T },
        recommendations: { type: "array", maxItems: LIMITS.recommendations, items: { type: "object", additionalProperties: false, required: ["text", "requires_human_approval", "refs"], properties: { text: T, requires_human_approval: { type: "boolean", enum: [true] }, refs: R } } },
      },
    },
  },
} as const;

/** Server-side reconstruction: records come only from bundled synthetic data, filtered BEFORE prompt building. */
export function authorizedRecords(req: Pick<MetaRequest, "scenarioId" | "roleId">): EvidenceRecord[] {
  const s = SCENARIOS.find((x) => x.id === req.scenarioId);
  if (!s) throw new Error("Scenario not in synthetic allowlist");
  return filterVisible(s.records, workspacesForRole(req.roleId));
}

/** Facts-only prompt: every authorized record is represented by exactly one verified fact (enforced by the adapter), so raw
 * records add no evidence. Facts carry the record ids, values, units, department and direction; the two period dates are constant. */
export function buildMessages(question: string, records: EvidenceRecord[]) {
  const system =
    "You analyse SYNTHETIC business facts for a fictional company. Use ONLY VERIFIED_FACTS, which the server computed. " +
    "Refer to facts only by fact_id in refs. NEVER write any digit or number in any text: Athena displays every number itself, " +
    "and you must not restate what a metric did. Give unverified interpretations (co-movement, not causation or proof), " +
    "proposed actions that require human approval (you cannot execute anything), and missing_evidence. " +
    "Every interpretation and recommendation must have refs listing the fact_ids it relies on. " +
    "BE TERSE: at most " + `${LIMITS.interpretations} interpretations, ${LIMITS.missing} missing_evidence, ${LIMITS.recommendations} recommendations; ` + "each text one sentence under 25 words. Output only the JSON object.";
  return [
    { role: "system" as const, content: system },
    { role: "user" as const, content: `Question: ${question}\nPERIODS (JSON): ${JSON.stringify({ prior: PERIODS.prior, current: PERIODS.current })}\nVERIFIED_FACTS (JSON): ${JSON.stringify(buildVerifiedFacts(records))}` },
  ];
}

/** Always rejected, in every field: assertions of proven causality. */
const STRONG_CAUSAL = /\b(proves?|proven|caused|is the cause|definitively|confirms that)\b/;
/** "cause(s)" is a claim unless an investigative cue precedes it in the same sentence. */
const CAUSE_WORD = /\bcauses?\b/;
const INVESTIGATIVE = /\b(investigate|investigating|identify|examine|review|explore|assess|determine|diagnose|analy[sz]e|check|audit|verify|test|possible|potential|likely|underlying|root)\b/;

/** Normalize to defeat case/width/zero-width obfuscation (NFKC, strip invisible chars, lowercase). */
/** Invisible / formatting characters that can split or hide an identifier: soft hyphen, combining grapheme joiner, Arabic letter mark,
 * Hangul/Khmer/Mongolian fillers, zero-width and bidi controls, word joiner and invisible operators, variation selectors, BOM. */
const INVISIBLE = /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0]/g;
/** Comparison key for leak detection: NFKD (folds full-width and compatibility forms, splits accents), drops invisible characters
 * and combining marks, lower-cases, and keeps only letters and digits, so dash variants, spaces, underscores, case and zero-width
 * insertions cannot hide an identifier. Applied to BOTH the hidden identifier and the model text before comparing. */
export const leakKey = (t: string) =>
  t.normalize("NFKD").replace(INVISIBLE, "").replace(/\p{M}/gu, "").normalize("NFKD").replace(INVISIBLE, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

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

export type ValidationResult = { ok: true; output: MetaOutput; findings: VerifiedFinding[] } | { ok: false; errors: string[] };

const LEGACY_MESSAGE = "Legacy response format rejected: observations, hypotheses, claims and cited_ids are no longer accepted; send interpretations, recommendations and missing_evidence with fact refs";
const isObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
function isLegacyShape(json: unknown): boolean {
  if (!isObject(json)) return false;
  if ("observations" in json || "hypotheses" in json) return true;
  return ["interpretations", "recommendations"].some((k) => Array.isArray(json[k]) && (json[k] as unknown[]).some((it) => isObject(it) && ("cited_ids" in it || "claims" in it)));
}

/** Strict output gate: legacy-shape rejection, schema, fact references, cross-workspace leaks, causal claims, numeral policy. */
export function validateOutput(raw: string, authorized: EvidenceRecord[], allRecords: EvidenceRecord[]): ValidationResult {
  let json: unknown;
  try { json = JSON.parse(raw); } catch { return { ok: false, errors: ["Output is not valid JSON"] }; }
  if (isLegacyShape(json)) return { ok: false, errors: [LEGACY_MESSAGE] };
  const parsed = OutputSchema.safeParse(json);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((i) => `Schema: ${i.path.join(".") || "(root)"} ${i.message}`) };
  const out = parsed.data;
  const facts = buildVerifiedFacts(authorized);
  const known = new Set(facts.map((f) => f.fact_id));
  const hidden = allRecords.filter((r) => !authorized.some((a) => a.id === r.id));
  const errors: string[] = [];
  for (const ref of new Set([...out.interpretations, ...out.recommendations].flatMap((x) => x.refs))) if (!known.has(ref)) errors.push(`Unknown or unauthorized fact reference: ${ref}`);
  const texts = [...out.interpretations.map((x) => x.text), ...out.missing_evidence, ...out.recommendations.map((x) => x.text)];
  const textKeys = texts.map(leakKey);
  for (const r of hidden) {
    const idKey = leakKey(r.id), sourceKey = leakKey(r.source);
    if (textKeys.some((k) => (idKey && k.includes(idKey)) || (sourceKey && k.includes(sourceKey)))) errors.push(`Cross-workspace leak: reference to unauthorized record ${r.id}`);
  }
  const causalChecks: [string, boolean][] = [
    ...out.interpretations.map((x) => [x.text, false] as [string, boolean]),
    ...out.missing_evidence.map((x) => [x, true] as [string, boolean]),
    ...out.recommendations.map((x) => [x.text, true] as [string, boolean]),
  ];
  for (const [t, inv] of causalChecks) if (hasCausalClaim(t, inv)) { errors.push(`Causal-proof language rejected: "${t.slice(0, 60)}"`); break; }
  const recordIds = allRecords.map((r) => r.id);
  for (const t of texts) errors.push(...verifyNoNumerals(t, recordIds));
  if (errors.length) return { ok: false, errors };
  const enrich = <T extends { refs: string[] }>(x: T) => ({ ...x, refs: [...new Set(x.refs)], supporting_ids: supportingIdsFor(x.refs, facts) });
  return {
    ok: true,
    output: { interpretations: out.interpretations.map(enrich), missing_evidence: out.missing_evidence, recommendations: out.recommendations.map(enrich) },
    findings: renderFindings(authorized),
  };
}
