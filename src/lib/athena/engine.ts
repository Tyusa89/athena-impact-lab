// Deterministic rule-based analysis grounded strictly in visible synthetic records.
// SECURITY NOTE: this is a client-side SIMULATION of role filtering. It is not
// authorization. A real system must enforce access on the server.
import { computeFacts as coreComputeFacts, describeChange, type AnalysisContext, type CoreFact } from "./core/facts";
import { PERIODS, type Department, type EvidenceRecord, type MetricKey } from "./data";
import { PROTOTYPE_CATALOG } from "./prototypeCatalog";

/** The prototype's business domain and reporting window. The reusable calculation lives in ./core; this is the wiring. */
export const PROTOTYPE_CONTEXT: AnalysisContext = { catalog: PROTOTYPE_CATALOG, periods: PERIODS };

export type Fact = CoreFact<MetricKey, Department>;
export { describeChange };

export interface Signal {
  key: string;
  title: string;
  /** Observation status only. Never implies causation. */
  status: "observed" | "not-observed" | "not-visible";
  detail: string;
  evidenceIds: string[];
}

export interface Hypothesis {
  title: string;
  reasoning: string;
  plausibility: "Medium" | "Low";
  verified: false;
  evidenceIds: string[];
}
export interface Action {
  id: string;
  owner: Department;
  title: string;
  rationale: string;
  evidenceIds: string[];
  requiresApproval: true;
}

export interface Analysis {
  facts: Fact[];
  signals: Signal[];
  hypotheses: Hypothesis[];
  alternatives: string[];
  actions: Action[];
  limitations: string[];
  evidenceCoverage: "Full" | "Partial" | "Minimal";
  citedIds: string[];
  visibleRecordCount: number;
  visibleWorkspaceCount: number;
}

export const DEMO_QUESTION = "Why are sales declining while marketing leads are rising?";
export const FLAT_THRESHOLD_PCT = PROTOTYPE_CATALOG.flatThresholdPct;

export function filterVisible(records: EvidenceRecord[], workspaces: readonly string[]) {
  const set = new Set(workspaces);
  return records.filter((r) => set.has(r.workspace));
}

export function computeFacts(records: EvidenceRecord[]): Fact[] {
  return coreComputeFacts(records, PROTOTYPE_CONTEXT);
}

function signal(key: string, title: string, f: Fact | undefined, want: Fact["direction"]): Signal {
  if (!f) return { key, title, status: "not-visible", detail: "No records visible under the current simulated role.", evidenceIds: [] };
  const ok = f.direction === want;
  return { key, title, status: ok ? "observed" : "not-observed", detail: `${f.label}: ${describeChange(f)}.${ok ? "" : ` Direction is ${f.direction}, not ${want}.`}`, evidenceIds: f.evidenceIds };
}

/** Every output field is derived only from records in visible workspaces. */
export function analyze(allRecords: EvidenceRecord[], visibleWorkspaces: readonly string[]): Analysis {
  const visible = filterVisible(allRecords, visibleWorkspaces);
  const facts = computeFacts(visible);
  const get = (m: MetricKey) => facts.find((f) => f.metric === m);
  const leads = get("leads"), mql = get("mql_rate"), conv = get("conversion_rate"), deals = get("closed_deals");
  const ful = get("fulfillment_days"), back = get("backorder_rate"), rev = get("revenue");
  const opsFact = ful ?? back;

  const signals: Signal[] = [
    signal("leads", "Lead volume increased", leads, "up"),
    signal("quality", "Lead quality decreased", mql, "down"),
    signal("conversion", "Sales conversion decreased", conv, "down"),
    signal("fulfillment", "Fulfillment time increased", opsFact, "up"),
    signal("revenue", "Revenue decreased", rev, "down"),
  ];

  const hypotheses: Hypothesis[] = [];
  if (leads?.direction === "up" && mql?.direction === "down" && conv?.direction === "down")
    hypotheses.push({ title: "Lower-intent lead mix may be diluting the pipeline", reasoning: "Lead volume rose while MQL rate and conversion fell in the same period. This is co-movement only; no source-level attribution or experiment exists in the data.", plausibility: "Medium", verified: false, evidenceIds: [...leads.evidenceIds, ...mql.evidenceIds, ...conv.evidenceIds] });
  if (opsFact?.direction === "up" && conv?.direction === "down")
    hypotheses.push({ title: "Fulfillment delays may be suppressing closes", reasoning: "Longer fulfillment coincides with lower conversion. No order-abandonment records exist to confirm a causal link.", plausibility: back?.direction === "up" && ful?.direction === "up" ? "Medium" : "Low", verified: false, evidenceIds: Array.from(new Set([...opsFact.evidenceIds, ...(back?.direction === "up" ? back.evidenceIds : []), ...conv.evidenceIds])) });
  if (rev?.direction === "down" && hypotheses.length)
    hypotheses.push({ title: "Revenue decline may be downstream of the signals above", reasoning: "Revenue fell in the same period. Contribution of each factor is not decomposed.", plausibility: "Low", verified: false, evidenceIds: rev.evidenceIds });

  const actions: Action[] = [];
  if (mql?.direction === "down") actions.push({ id: "ACT-MKT-1", owner: "Marketing", title: "Review channel mix toward higher-MQL sources (2-week test)", rationale: "Observed MQL rate decrease.", evidenceIds: mql.evidenceIds, requiresApproval: true });
  if (conv?.direction === "down") actions.push({ id: "ACT-SAL-1", owner: "Sales", title: "Pilot a lead-score gate before rep assignment", rationale: "Observed conversion decrease.", evidenceIds: conv.evidenceIds, requiresApproval: true });
  if (opsFact?.direction === "up") actions.push({ id: "ACT-OPS-1", owner: "Operations", title: "Show stock ETA at quote time; review backordered SKUs", rationale: "Observed fulfillment time increase.", evidenceIds: opsFact.evidenceIds, requiresApproval: true });
  if (rev?.direction === "down") actions.push({ id: "ACT-FIN-1", owner: "Finance", title: "Re-forecast next quarter with sensitivity ranges", rationale: "Observed revenue decrease.", evidenceIds: rev.evidenceIds, requiresApproval: true });

  // Alternatives are generated only from visible metrics, so restricted domains are never mentioned.
  const alternatives: string[] = ["Seasonal demand variation (only two periods available; no seasonal baseline)."];
  if (conv || deals) alternatives.push("Sales capacity or pricing changes not captured in visible records.");
  if (mql) alternatives.push("A change in the lead-scoring definition could shift the MQL rate without a real quality change.");
  if (opsFact) alternatives.push("Fulfillment changes could reflect a one-off supplier or system event.");
  if (rev) alternatives.push("Revenue timing/recognition effects unrelated to demand.");

  const observed = signals.filter((s) => s.status === "observed").length;
  const notVisible = signals.filter((s) => s.status === "not-visible").length;
  const evidenceCoverage = notVisible === 0 ? "Full" : notVisible <= 2 ? "Partial" : "Minimal";

  const limitations = [
    `Two-period comparison only (${PERIODS.prior.label} vs ${PERIODS.current.label}); no seasonality baseline.`,
    "All hypotheses are UNVERIFIED: co-movement is not causation; no experiment or attribution model exists.",
    "Role filtering is a client-side simulation. No real server authorization is provided.",
    "All records are synthetic and fictional.",
  ];
  if (notVisible > 0) limitations.unshift("Analysis is limited to your visible workspaces; some signals cannot be evaluated.");
  if (observed === 0 && notVisible < signals.length) limitations.unshift("No expected signals were observed in visible data.");

  const citedIds = Array.from(new Set(facts.flatMap((f) => f.evidenceIds)));
  return {
    facts,
    signals,
    hypotheses,
    alternatives,
    actions,
    limitations,
    evidenceCoverage,
    citedIds,
    visibleRecordCount: visible.length,
    visibleWorkspaceCount: new Set(visible.map((r) => r.workspace)).size,
  };
}
