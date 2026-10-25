// Verified findings: deterministic sentences rendered by Athena from verified facts. Pure + client-safe.
// No model text is involved. The server renders these from authorized records and returns them with the Meta result,
// so the UI never recomputes them from client state. Wording and numbers come from the engine's own describeChange.
import { computeFacts, describeChange, type AnalysisContext, type CoreRecord } from "../core/facts";
import { factIdFor } from "./grounding";

export interface VerifiedFinding<M extends string = string> {
  fact_id: string;
  metric: M;
  department: string;
  direction: "up" | "down" | "flat";
  /** e.g. "Recognized revenue: $1,240,000 → $1,018,000 (-17.9% relative)". Always Athena-authored. */
  text: string;
  /** The exact records behind this finding (prior, current). */
  supporting_ids: string[];
}

const WORD = { up: "increased", down: "decreased", flat: "was flat" } as const;

export function renderFindings<R extends CoreRecord>(authorized: readonly R[], ctx: AnalysisContext): VerifiedFinding<R["metric"]>[] {
  return computeFacts(authorized, ctx).map((f) => ({
    fact_id: factIdFor(f.metric),
    metric: f.metric,
    department: f.department,
    direction: f.direction,
    text: `${f.label} ${WORD[f.direction]}: ${describeChange(f)}`,
    supporting_ids: [...f.evidenceIds],
  }));
}
