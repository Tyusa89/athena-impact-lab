// Deterministic rule-based analysis grounded strictly in visible synthetic records.
// SECURITY NOTE: this is a client-side SIMULATION of role filtering. It is not
// authorization. A real system must enforce access on the server.
import { METRIC_LABELS, PERIODS, type Department, type EvidenceRecord, type MetricKey } from "./data";

export interface Fact {
  metric: MetricKey;
  label: string;
  department: Department;
  prior: number;
  current: number;
  unit: string;
  /** Relative change vs prior period: (current - prior) / prior * 100. null if prior is 0. */
  changePct: number | null;
  /** For rate metrics (unit "%"): absolute change in percentage points. */
  changePp: number | null;
  direction: "up" | "down" | "flat";
  evidenceIds: string[];
  periodLabel: string;
}

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
export const FLAT_THRESHOLD_PCT = 3;

const r1 = (n: number) => Math.round(n * 10) / 10;

export function filterVisible(records: EvidenceRecord[], workspaces: readonly string[]) {
  const set = new Set(workspaces);
  return records.filter((r) => set.has(r.workspace));
}

export function computeFacts(records: EvidenceRecord[]): Fact[] {
  const keys = Array.from(new Set(records.map((r) => r.metric)));
  const facts: Fact[] = [];
  for (const m of keys) {
    const ps = records.filter((r) => r.metric === m && r.period === "prior");
    const cs = records.filter((r) => r.metric === m && r.period === "current");
    if (ps.length !== 1 || cs.length !== 1) continue; // require exactly one pair; ambiguity → no fact
    const p = ps[0]!, c = cs[0]!;
    if (p.unit !== c.unit || p.department !== c.department) continue;
    const changePct = p.value === 0 ? null : r1(((c.value - p.value) / p.value) * 100);
    const changePp = c.unit === "%" ? r1(c.value - p.value) : null;
    const direction = changePct === null || Math.abs(changePct) < FLAT_THRESHOLD_PCT ? "flat" : changePct > 0 ? "up" : "down";
    facts.push({ metric: m, label: METRIC_LABELS[m], department: c.department, prior: p.value, current: c.value, unit: c.unit, changePct, changePp, direction, evidenceIds: [p.id, c.id], periodLabel: `${PERIODS.prior.label} → ${PERIODS.current.label}` });
  }
  return facts;
}

export function describeChange(f: Fact): string {
  const fmt = (v: number) => (f.unit === "USD" ? `$${v.toLocaleString("en-US")}` : f.unit === "%" ? `${v}%` : `${v.toLocaleString("en-US")} ${f.unit}`);
  const rel = f.changePct === null ? "n/a" : `${f.changePct > 0 ? "+" : ""}${f.changePct}%`;
  const pp = f.changePp !== null ? `, ${f.changePp > 0 ? "+" : ""}${f.changePp} pp` : "";
  return `${fmt(f.prior)} → ${fmt(f.current)} (${rel} relative${pp})`;
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
