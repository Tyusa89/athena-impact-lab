// STRICT output validation with UNIFORM PUBLIC REJECTION (Phase H2.2). Pure and client-safe; provider-, dataset- and prototype-neutral. OPT-IN: only `meta/strictRuntime.ts`
// uses it, and nothing live calls that yet. The legacy `validateAuthorizedOutput` and its detailed messages are untouched (the goldens pin them).
//
// What changes relative to the legacy gate, for model text produced from the SCOPED prompt (which contains no user text and no record identifiers):
//   * strict mentions in all three lanes: any reference to a metric or department the caller may not discover is rejected, directional or not, in this department or another;
//   * no record id is exempt from the numeral rule, and any record id or source label (authorized or not) in model text is a leak: the model was never shown one;
//   * every rejection, whatever the reason, is ONE fixed public response. The reason is kept as a CLOSED category code for server diagnostics only (never text, ids or labels).
// Because the public response is identical for every failure, a rejection cannot tell a caller which rule fired, nor whether a hidden metric, department, record id or source
// label was involved. What remains observable is accept versus reject, which is why the scoped prompt (H2.1) matters: the caller cannot steer the model to a hidden term.
import type { AuthorizedEvidence } from "../core/access";
import type { Evidence } from "../core/evidence";
import type { AnalysisContext } from "../core/facts";
import { validateAuthorizedOutput, type MetaOutput } from "./analysis";
import type { VerifiedFinding } from "./render";

/** The only public wording for a rejected model output. */
export const STRICT_REJECTION_REASON = "The model output did not pass validation and was not used.";
/** The closed set of server-side diagnostic categories. Anything else is reported as "unknown". */
export const DIAGNOSTIC_CATEGORIES = ["json", "legacy", "schema", "leak", "ref", "unsafe", "causal", "numeral", "magnitude", "direction", "domain", "unavailable", "provider", "unknown"] as const;
export type DiagnosticCategory = (typeof DIAGNOSTIC_CATEGORIES)[number];
const CLOSED = new Set<string>(DIAGNOSTIC_CATEGORIES);
export const toDiagnostics = (cats: readonly unknown[]): DiagnosticCategory[] => [...new Set(cats.map((c) => (typeof c === "string" && CLOSED.has(c) ? (c as DiagnosticCategory) : "unknown")))];

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
  const v = validateAuthorizedOutput(raw, authorized, withheld, ctx, { discoverable: discoverableMetrics, strictMentions: true }, { exemptRecordIds: false, leakScope: "all" });
  return v.ok ? { ok: true, output: v.output, findings: v.findings } : { ok: false, diagnostics: toDiagnostics(v.categories) };
}
