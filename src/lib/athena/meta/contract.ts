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
import { assertCatalog } from "../core/catalog";
import type { AnalysisContext } from "../core/facts";
import { ROLES, SCENARIOS, WORKSPACES, type EvidenceRecord } from "../data";
import { PROTOTYPE_CONTEXT, filterVisible } from "../engine";
import { renderFindings, type VerifiedFinding } from "./findings";
import { checkSemantics, semanticScope } from "./semanticGuards";
import { INVISIBLE_CHARS, buildVerifiedFacts, supportingIdsFor, verifyNoNumerals } from "./numericGrounding";

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
export function buildMessages(question: string, records: EvidenceRecord[], ctx: AnalysisContext = PROTOTYPE_CONTEXT) {
  const system =
    "You analyse SYNTHETIC business facts for a fictional company. Use ONLY VERIFIED_FACTS, which the server computed. " +
    "Refer to facts only by fact_id in refs. NEVER write any digit or number in any text: Athena displays every number itself, " +
    "and you must not restate what a metric did, spell out numbers, fractions or multiples (such as forty percent, half, doubled), " +
    "or discuss any metric or department that is not in VERIFIED_FACTS. Give unverified interpretations (co-movement, not causation or proof), " +
    "proposed actions that require human approval (you cannot execute anything), and missing_evidence. " +
    "Every interpretation and recommendation must have refs listing the fact_ids it relies on. " +
    "BE TERSE: at most " + `${LIMITS.interpretations} interpretations, ${LIMITS.missing} missing_evidence, ${LIMITS.recommendations} recommendations; ` + "each text one sentence under 25 words. Output only the JSON object.";
  return [
    { role: "system" as const, content: system },
    { role: "user" as const, content: `Question: ${question}\nPERIODS (JSON): ${JSON.stringify({ prior: ctx.periods.prior, current: ctx.periods.current })}\nVERIFIED_FACTS (JSON): ${JSON.stringify(buildVerifiedFacts(records, ctx))}` },
  ];
}

/** Always rejected, in every field: assertions of proven causality. */
const STRONG_CAUSAL = /\b(proves?|proven|caused|is the cause|definitively|confirms that)\b/;
/** "cause(s)" is a claim unless an investigative cue precedes it in the same sentence. */
const CAUSE_WORD = /\bcauses?\b/;
const INVESTIGATIVE = /\b(investigate|investigating|identify|examine|review|explore|assess|determine|diagnose|analy[sz]e|check|audit|verify|test|possible|potential|likely|underlying|root)\b/;

/** Normalize to defeat case/width/zero-width obfuscation (NFKC, strip invisible chars, lowercase). */
/** Comparison key for leak detection: NFKD (folds full-width and compatibility forms, splits accents), drops invisible characters
 * and combining marks, lower-cases, and keeps only letters and digits, so dash variants, spaces, underscores, case and zero-width
 * insertions cannot hide an identifier. Applied to BOTH the hidden identifier and the model text before comparing. */
export const leakKey = (t: string) =>
  t.normalize("NFKD").replace(INVISIBLE_CHARS, "").replace(/\p{M}/gu, "").normalize("NFKD").replace(INVISIBLE_CHARS, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

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

/** `categories` are safe internal diagnostic codes (no text, ids or labels) that may be logged server-side. */
export type ValidationResult = { ok: true; output: MetaOutput; findings: VerifiedFinding[] } | { ok: false; errors: string[]; categories: string[] };
const fail = (...issues: { code: string; message: string }[]): ValidationResult => ({ ok: false, errors: issues.map((i) => i.message), categories: [...new Set(issues.map((i) => i.code))] });

const LEGACY_MESSAGE = "Legacy response format rejected: observations, hypotheses, claims and cited_ids are no longer accepted; send interpretations, recommendations and missing_evidence with fact refs";
/** Deliberately generic: never names the record, source or identifier that triggered it. */
const LEAK_MESSAGE = "Cross-workspace leak: the output refers to a record or source outside the authorized scope";
const isObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
function isLegacyShape(json: unknown): boolean {
  if (!isObject(json)) return false;
  if ("observations" in json || "hypotheses" in json) return true;
  return ["interpretations", "recommendations"].some((k) => Array.isArray(json[k]) && (json[k] as unknown[]).some((it) => isObject(it) && ("cited_ids" in it || "claims" in it)));
}

/**
 * Strict output gate: legacy-shape rejection, schema, fact references, cross-workspace leaks, causal claims, numeral policy and semantic guards.
 * Client-visible errors never contain record ids, source labels, fact ids, unauthorized metric/department names or model text.
 */
export function validateOutput(raw: string, authorized: EvidenceRecord[], allRecords: EvidenceRecord[], ctx: AnalysisContext = PROTOTYPE_CONTEXT): ValidationResult {
  assertCatalog(ctx.catalog); // before anything else, so no early return can skip it
  let json: unknown;
  try { json = JSON.parse(raw); } catch { return fail({ code: "json", message: "Output is not valid JSON" }); }
  if (isLegacyShape(json)) return fail({ code: "legacy", message: LEGACY_MESSAGE });
  const parsed = OutputSchema.safeParse(json);
  // Paths come from the schema itself. The unrecognized-key message is replaced because it would echo model-supplied key names (which could be unauthorized identifiers).
  if (!parsed.success) return fail(...parsed.error.issues.map((i) => ({ code: "schema", message: `Schema: ${i.path.join(".") || "(root)"} ${i.code === "unrecognized_keys" ? `contains ${i.keys.length} unrecognized key(s)` : i.message}` })));
  const out = parsed.data;
  const facts = buildVerifiedFacts(authorized, ctx);
  const known = new Set(facts.map((f) => f.fact_id));
  const hidden = allRecords.filter((r) => !authorized.some((a) => a.id === r.id));
  const texts = [...out.interpretations.map((x) => x.text), ...out.missing_evidence, ...out.recommendations.map((x) => x.text)];
  // A leak is reported on its own, so nothing else (which might quote model text) is returned alongside it.
  const textKeys = texts.map(leakKey);
  if (hidden.some((r) => { const idKey = leakKey(r.id), sourceKey = leakKey(r.source); return textKeys.some((k) => (idKey && k.includes(idKey)) || (sourceKey && k.includes(sourceKey))); })) return fail({ code: "leak", message: LEAK_MESSAGE });
  const issues: { code: string; message: string }[] = [];
  const badRefs = new Set([...out.interpretations, ...out.recommendations].flatMap((x) => x.refs).filter((ref) => !known.has(ref)));
  if (badRefs.size) issues.push({ code: "ref", message: `Unknown or unauthorized fact reference: ${badRefs.size} reference(s) rejected` });
  const lanes: { text: string; lane: "interpretation" | "recommendation" | "gap"; where: string }[] = [
    ...out.interpretations.map((x, i) => ({ text: x.text, lane: "interpretation" as const, where: `interpretation ${i + 1}` })),
    ...out.recommendations.map((x, i) => ({ text: x.text, lane: "recommendation" as const, where: `proposed action ${i + 1}` })),
    ...out.missing_evidence.map((t, i) => ({ text: t, lane: "gap" as const, where: `gap ${i + 1}` })),
  ];
  for (const l of lanes) if (hasCausalClaim(l.text, l.lane !== "interpretation")) { issues.push({ code: "causal", message: `Causal-proof language rejected in ${l.where}` }); break; }
  const recordIds = allRecords.map((r) => r.id);
  for (const l of lanes) for (const message of verifyNoNumerals(l.text, recordIds, ctx.periods)) issues.push({ code: "numeral", message });
  // Semantic guards: directional contradictions, magnitude expressions, unauthorized or unavailable domains. Reject, never rewrite.
  const scope = semanticScope(authorized, facts, ctx.catalog);
  for (const l of lanes) for (const i of checkSemantics(l.text, l.lane, scope, l.where)) issues.push({ code: i.code, message: i.message });
  if (issues.length) return fail(...issues);
  const enrich = <T extends { refs: string[] }>(x: T) => ({ ...x, refs: [...new Set(x.refs)], supporting_ids: supportingIdsFor(x.refs, facts) });
  return {
    ok: true,
    output: { interpretations: out.interpretations.map(enrich), missing_evidence: out.missing_evidence, recommendations: out.recommendations.map(enrich) },
    findings: renderFindings(authorized, ctx),
  };
}
