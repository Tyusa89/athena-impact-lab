// The SCOPED prompt profile (Phase H2.1). Pure and client-safe; provider-, dataset- and prototype-neutral. OPT-IN: nothing in the runtime, the server functions or the
// UI calls it yet. The legacy `buildMessages` stays the default and is untouched.
//
// What the legacy prompt does that this one does not:
//   * it forwards the user's question verbatim  -> here the model never sees user text. The server composes a fixed-wording brief and a FOCUS list from the question's
//     matches against the catalog, filtered to metrics the caller may DISCOVER. A question that names a hidden metric, a hidden department, a hidden record id or source, a
//     made-up word or an instruction therefore yields exactly the same prompt as a question that names nothing.
//   * it sends both record ids of every fact -> here facts carry no record identifiers at all. Citations never needed them: the model refers to `fact_id`, and the server derives
//     supporting record ids from its own facts (`supportingIdsFor`, `validateOutput`), unchanged.
// What it adds: discoverable metrics that have no verified data are listed apart, under UNAVAILABLE_METRICS, so the model can ask for that evidence (missing_evidence) without
// ever being given a value for them or being told anything about a metric the caller cannot discover.
//
// The model sees only: fixed instructions, the validated analysis subject, the period labels (server configuration), verified facts of authorized metrics (no ids, no sources, no
// notes), the keys of discoverable metrics without data, and the focus keys. Every one of those is derived on the server from authorized evidence and the access policy's grant.
import { assertAuthorized, type AuthorizedEvidence } from "../core/access";
import { assertCatalog } from "../core/catalog";
import type { Evidence } from "../core/evidence";
import type { AnalysisContext } from "../core/facts";
import { DEFAULT_PROMPT_SUBJECT, SUBJECT_RE } from "./analysis";
import { buildAuthorizedFacts, type VerifiedFact } from "./grounding";
import { LIMITS } from "./limits";
import { mentionedIn } from "./semantic";

/** A verified fact as the scoped prompt shows it: no record identifiers. */
export interface ScopedFact<M extends string = string> {
  fact_id: string;
  metric: M;
  department: string;
  unit: string;
  prior: number;
  current: number;
  change_pct: number | null;
  change_pp: number | null;
  direction: "up" | "down" | "flat";
}
export interface ScopedUnavailable { metric: string; status: "no_verified_data" }

/** Upper bound on question text examined for focus matching (the question is validated upstream; this only bounds work if it is not). */
const MAX_QUESTION_CHARS = 1200;
const BRIEF_FOCUSED = "Concentrate on the metrics listed in FOCUS_METRICS and on how they may relate to the other verified facts.";
const BRIEF_OVERVIEW = "No particular focus: give an overview of the verified changes and how they may relate.";

/** The metric keys the caller may discover: metrics with verified facts plus the access policy's explicit grant, restricted to the catalog. Never inferred from a department. */
export function scopedDiscoverable(facts: readonly Pick<VerifiedFact, "metric">[], grant: readonly string[], ctx: AnalysisContext): string[] {
  assertCatalog(ctx.catalog);
  const known = new Set(ctx.catalog.metrics.map((m) => m.key));
  const have = new Set([...facts.map((f) => f.metric), ...grant].filter((k) => known.has(k)));
  return ctx.catalog.metrics.map((m) => m.key).filter((k) => have.has(k)); // catalog order: stable bytes
}

/** The focus: catalog metrics the question names (or whose department it names), kept only if discoverable. A non-string or empty question focuses nothing. The question's own
 * words are never returned or stored; only catalog keys are. */
export function scopedFocus(question: unknown, ctx: AnalysisContext, discoverable: readonly string[]): string[] {
  assertCatalog(ctx.catalog);
  if (typeof question !== "string" || question.length === 0) return [];
  const m = mentionedIn(question.slice(0, MAX_QUESTION_CHARS), ctx.catalog);
  const named = new Set([...m.metrics, ...ctx.catalog.metrics.filter((x) => m.domains.includes(x.domain)).map((x) => x.key)]);
  const allowed = new Set(discoverable);
  return ctx.catalog.metrics.map((x) => x.key).filter((k) => named.has(k) && allowed.has(k));
}

export const SCOPED_SYSTEM = (subject: string) =>
  `You analyse ${subject}. Use ONLY VERIFIED_FACTS and UNAVAILABLE_METRICS, which the server prepared. ` +
  "Refer to facts only by fact_id in refs. NEVER write any digit or number in any text: Athena displays every number itself, " +
  "and you must not restate what a metric did, spell out numbers, fractions or multiples (such as forty percent, half, doubled), " +
  "or discuss any metric or department that is not in VERIFIED_FACTS or UNAVAILABLE_METRICS. A metric in UNAVAILABLE_METRICS has no verified data: you may name it only to ask for that evidence in missing_evidence " +
  "or as the thing an investigation should obtain, and you must not say what it did or how it compares. The user's own wording is not provided; FOCUS_METRICS says what to concentrate on. " +
  "Athena already shows the verified changes and their direction beside your answer, so treat each fact's direction as known and reason about what it could mean instead of repeating it. " +
  "Give unverified interpretations (co-movement, not causation or proof), proposed actions that require human approval (you cannot execute anything), and missing_evidence. " +
  "Every interpretation and recommendation must have refs listing the fact_ids it relies on. " +
  "INTERPRETATIONS: each is one specific, testable hypothesis that links two or more cited facts through a concrete business mechanism (for example a shift in the mix of sources, segments or channels, " +
  "or a timing or capacity limit in a process). Hedge it once, and do not claim it as established or as the cause. A sentence that only says metrics may move together, or calls for joint review, is too generic. " +
  "MISSING_EVIDENCE: name the concrete breakdowns or data that would confirm or rule out your hypotheses (what to split, by which dimension, over which periods); include at least one when any hypothesis is open. " +
  "RECOMMENDATIONS: each is one actionable investigation that says what to compare, segment, trace or collect and which cited facts motivate it; do not use vague verbs such as review, monitor or consider on their own. " +
  "Business concepts that are not metrics are fine in hypotheses, but never assert or imply a measured value, trend or comparison for anything outside VERIFIED_FACTS. " +
  `BE TERSE: at most ${LIMITS.interpretations} interpretations, ${LIMITS.missing} missing_evidence, ${LIMITS.recommendations} recommendations; each text one sentence under 25 words. Output only the JSON object.`;

/**
 * Scoped, opt-in prompt. Requires evidence that came from `authorizeEvidence`. `discoverableMetrics` is the access policy's grant (`EvidenceScope.discoverableMetrics`, as carried by
 * `Prepared.discoverableMetrics`): server-supplied, never taken from a request. `question` is read only to choose FOCUS keys and never appears in the output.
 */
export function buildScopedMessages<E extends Evidence>(question: unknown, authorized: AuthorizedEvidence<E>, ctx: AnalysisContext, discoverableMetrics: readonly string[], subject: string = DEFAULT_PROMPT_SUBJECT) {
  assertAuthorized(authorized);
  assertCatalog(ctx.catalog);
  if (!SUBJECT_RE.test(subject)) throw new Error("Invalid prompt subject");
  if (!Array.isArray(discoverableMetrics) || !discoverableMetrics.every((k) => typeof k === "string")) throw new TypeError("The scoped prompt requires an explicit discoverable-metrics grant"); // F2
  const facts = buildAuthorizedFacts(authorized, ctx);
  const discoverable = scopedDiscoverable(facts, discoverableMetrics, ctx);
  const have = new Set(facts.map((f) => f.metric));
  const unavailable: ScopedUnavailable[] = discoverable.filter((k) => !have.has(k)).map((metric) => ({ metric, status: "no_verified_data" as const }));
  const scopedFacts: ScopedFact[] = facts.map((f) => ({
    fact_id: f.fact_id, metric: f.metric, department: f.department, unit: f.unit, prior: f.prior.value, current: f.current.value,
    change_pct: f.change_pct, change_pp: f.change_pp, direction: f.direction,
  }));
  const focus = scopedFocus(question, ctx, discoverable);
  const user =
    `Brief: ${focus.length ? BRIEF_FOCUSED : BRIEF_OVERVIEW}\n` +
    `FOCUS_METRICS (JSON): ${JSON.stringify(focus)}\n` +
    `PERIODS (JSON): ${JSON.stringify({ prior: ctx.periods.prior, current: ctx.periods.current })}\n` +
    `VERIFIED_FACTS (JSON): ${JSON.stringify(scopedFacts)}\n` +
    `UNAVAILABLE_METRICS (JSON): ${JSON.stringify(unavailable)}`;
  return [
    { role: "system" as const, content: SCOPED_SYSTEM(subject) },
    { role: "user" as const, content: user },
  ];
}
