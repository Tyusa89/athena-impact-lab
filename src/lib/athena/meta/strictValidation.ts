// STRICT output validation with UNIFORM PUBLIC REJECTION (Phase H2.2). Pure and client-safe; provider-, dataset- and prototype-neutral. OPT-IN: only `meta/strictRuntime.ts`
// uses it, and nothing live calls that yet. The legacy `validateAuthorizedOutput` and its detailed messages are untouched (the goldens pin them).
//
// What changes relative to the legacy gate, for model text produced from the SCOPED prompt (which contains no user text and no record identifiers):
//   * strict mentions in all three lanes: any reference to a metric or department the caller may not discover is rejected, directional or not, in this department or another;
//   * no record id is exempt from the numeral rule, and any record id or source label (authorized or not) in model text is a leak: the model was never shown one;
//   * a response that says nothing is rejected (G4.7 E17, tightened in G4.7b): a strict response must contain at least one reasoning entry that carries content, so neither an
//     all-empty response nor one filled only with blank, punctuation-only or placeholder text ("n/a") passes;
//   * every rejection, whatever the reason, is ONE fixed public response. The reason is kept as a CLOSED category code for server diagnostics only (never text, ids or labels).
// Because the public response is identical for every failure, a rejection cannot tell a caller which rule fired, nor whether a hidden metric, department, record id or source
// label was involved. What remains observable is accept versus reject, which is why the scoped prompt (H2.1) matters: the caller cannot steer the model to a hidden term.
import type { AuthorizedEvidence } from "../core/access";
import type { Evidence } from "../core/evidence";
import type { AnalysisContext } from "../core/facts";
import { validateAuthorizedOutput, type MetaOutput } from "./analysis";
import type { VerifiedFinding } from "./render";
import { semanticText } from "./semantic";

/** The only public wording for a rejected model output. */
export const STRICT_REJECTION_REASON = "The model output did not pass validation and was not used.";
/** The closed set of server-side diagnostic categories. Anything else is reported as "unknown". */
export const DIAGNOSTIC_CATEGORIES = ["json", "legacy", "schema", "leak", "ref", "relevance", "unsafe", "causal", "numeral", "magnitude", "direction", "domain", "unavailable", "provider", "empty", "unknown"] as const;
export type DiagnosticCategory = (typeof DIAGNOSTIC_CATEGORIES)[number];
const CLOSED = new Set<string>(DIAGNOSTIC_CATEGORIES);
export const toDiagnostics = (cats: readonly unknown[]): DiagnosticCategory[] => [...new Set(cats.map((c) => (typeof c === "string" && CLOSED.has(c) ? (c as DiagnosticCategory) : "unknown")))];

/** Entries a model uses to fill a lane without saying anything. Matched EXACTLY against the normalized form, so "N/A.", "n.a." and " None " all reduce to a member here while a
 * sentence that merely starts with one of these words ("No data exists for channel-level lead sources.") does not. */
const PLACEHOLDER = new Set([
  "na", "n a", "nan", "none", "nil", "null", "undefined", "nothing", "no", "nope", "nada",
  "not applicable", "not available", "not known", "no data", "no evidence", "no information", "no comment", "no gaps", "no gap",
  "unknown", "unclear", "tbd", "tba", "todo", "to be determined", "to be confirmed", "pending", "empty", "blank", "idk",
  "same", "as above", "see above", "same as above",
]);
/**
 * G4.7b (STRICT only): does one reasoning entry say anything at all? Deliberately narrow - it judges the PRESENCE of content, never its quality, usefulness or topic, so a terse
 * but real gap ("Staffing.", "CAC by channel.") passes. An entry carries no content when, after `semanticText` normalization (which folds compatibility forms, drops invisible
 * characters and combining marks, and unifies dashes and slashes) and stripping what punctuation that leaves, it is empty, holds no two-letter word (so "." , "---", "?" and "123"
 * all fail), or is exactly one of the PLACEHOLDER forms. It introduces no semantic restriction beyond that: nothing here inspects what the entry is about.
 */
function saysSomething(text: unknown): boolean {
  if (typeof text !== "string") return false;
  const norm = semanticText(text).replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
  if (!norm || PLACEHOLDER.has(norm)) return false;
  return /\p{L}{2,}/u.test(norm);
}

/** The public rejection, built fresh each time so no caller can alter a shared object. Byte-identical for every cause. */
export const strictRejection = () => ({ state: "rejected" as const, reason: STRICT_REJECTION_REASON, requestSent: true as const });
export type StrictRejection = ReturnType<typeof strictRejection>;

export type StrictValidation =
  | { ok: true; output: MetaOutput; findings: VerifiedFinding[] }
  /** `diagnostics` is SERVER-SIDE ONLY: closed category codes. Never put it in a response. */
  | { ok: false; diagnostics: DiagnosticCategory[] };

/**
 * Validate model text for the strict profile. `discoverableMetrics` is the access policy's grant (`Prepared.discoverableMetrics`), supplied by the server. There is deliberately no
 * option to relax strictness: the profile is fixed here.
 */
export function validateStrictOutput<E extends Evidence>(raw: string, authorized: AuthorizedEvidence<E>, withheld: readonly E[], ctx: AnalysisContext, discoverableMetrics: readonly string[]): StrictValidation {
  // F2: an explicit grant is structurally required. A JS caller (or a cast) that omits it must fail loudly, never fall back to a grant inferred from the records' departments or their metrics.
  if (!Array.isArray(discoverableMetrics) || !discoverableMetrics.every((k) => typeof k === "string")) throw new TypeError("Strict validation requires an explicit discoverable-metrics grant");
  const v = validateAuthorizedOutput(raw, authorized, withheld, ctx, { discoverable: discoverableMetrics, strictMentions: true, generalVocabulary: true }, { exemptRecordIds: false, leakScope: "all", refConsistency: true, strictCausal: true });
  if (!v.ok) return { ok: false, diagnostics: toDiagnostics(v.categories) };
  // G4.7 E17 (+ G4.7b): a strict response must SAY something. Rejected as `empty`: every lane empty, AND a response whose entries all carry no content ([" "], ["."], ["n/a"]).
  // G4.7 counted array length alone, which `missing_evidence` could satisfy with blank or placeholder text - it carries no refs, so no other guard inspects it. Judged across all
  // three lanes together, so ONE real entry anywhere passes and a junk entry beside a real one is tolerated. The schema still permits empty lanes, legacy behavior is unchanged
  // (the legacy validator has no non-empty rule at all), and every other rule still applies to what is present - this runs last and weakens nothing.
  const entries: unknown[] = [...v.output.interpretations.map((i) => i.text), ...v.output.missing_evidence, ...v.output.recommendations.map((r) => r.text)];
  if (!entries.some(saysSomething)) return { ok: false, diagnostics: ["empty"] };
  return { ok: true, output: v.output, findings: v.findings };
}
