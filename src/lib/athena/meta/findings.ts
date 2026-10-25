// Verified findings: deterministic sentences rendered by Athena from verified facts. Pure + client-safe.
// No model text is involved. The server renders these from authorized records and returns them with the Meta result,
// so the UI never recomputes them from client state. Wording and numbers come from the engine's own describeChange.
import type { Department, EvidenceRecord, MetricKey } from "../data";
import { computeFacts, describeChange } from "../engine";
import { factIdFor } from "./numericGrounding";

export interface VerifiedFinding {
  fact_id: string;
  metric: MetricKey;
  department: Department;
  direction: "up" | "down" | "flat";
  /** e.g. "Recognized revenue: $1,240,000 → $1,018,000 (-17.9% relative)". Always Athena-authored. */
  text: string;
  /** The exact records behind this finding (prior, current). */
  supporting_ids: string[];
}

const WORD = { up: "increased", down: "decreased", flat: "was flat" } as const;

export function renderFindings(authorized: EvidenceRecord[]): VerifiedFinding[] {
  return computeFacts(authorized).map((f) => ({
    fact_id: factIdFor(f.metric),
    metric: f.metric,
    department: f.department,
    direction: f.direction,
    text: `${f.label} ${WORD[f.direction]}: ${describeChange(f)}`,
    supporting_ids: [...f.evidenceIds],
  }));
}
