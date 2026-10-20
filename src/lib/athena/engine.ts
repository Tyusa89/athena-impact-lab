// Deterministic rule-based analysis grounded strictly in visible synthetic records.
import { METRIC_LABELS, type EvidenceRecord, type MetricKey } from "./data";

export interface Fact {
  metric: MetricKey;
  label: string;
  prior: number;
  current: number;
  unit: string;
  changePct: number;
  direction: "up" | "down" | "flat";
  evidenceIds: string[];
  department: string;
}

export interface ChainStep {
  key: string;
  title: string;
  status: "supported" | "not-supported" | "insufficient-evidence";
  detail: string;
  evidenceIds: string[];
}

export interface Hypothesis { title: string; reasoning: string; confidence: "High" | "Medium" | "Low"; evidenceIds: string[] }
export interface Action { id: string; owner: string; title: string; rationale: string; evidenceIds: string[]; requiresApproval: true }

export interface Analysis {
  question: string;
  facts: Fact[];
  chain: ChainStep[];
  hypotheses: Hypothesis[];
  alternatives: string[];
  actions: Action[];
  limitations: string[];
  overallConfidence: "High" | "Medium" | "Low";
  citedIds: string[];
  hiddenCount: number;
}

export const DEMO_QUESTION = "Why are sales declining while marketing leads are rising?";
const FLAT = 3; // % threshold

export function filterVisible(records: EvidenceRecord[], workspaces: string[]) {
  const set = new Set(workspaces);
  return records.filter((r) => set.has(r.workspace));
}

export function computeFacts(records: EvidenceRecord[]): Fact[] {
  const keys = Array.from(new Set(records.map((r) => r.metric)));
  const facts: Fact[] = [];
  for (const m of keys) {
    const p = records.find((r) => r.metric === m && r.period === "prior");
    const c = records.find((r) => r.metric === m && r.period === "current");
    if (!p || !c) continue;
    const changePct = p.value === 0 ? 0 : ((c.value - p.value) / p.value) * 100;
    const direction = Math.abs(changePct) < FLAT ? "flat" : changePct > 0 ? "up" : "down";
    facts.push({ metric: m, label: METRIC_LABELS[m], prior: p.value, current: c.value, unit: c.unit, changePct: Math.round(changePct * 10) / 10, direction, evidenceIds: [p.id, c.id], department: c.department });
  }
  return facts;
}

function step(key: string, title: string, f: Fact | undefined, want: Fact["direction"], okText: (f: Fact) => string): ChainStep {
  if (!f) return { key, title, status: "insufficient-evidence", detail: "No visible records for this metric under current permissions.", evidenceIds: [] };
  const ok = f.direction === want;
  return { key, title, status: ok ? "supported" : "not-supported", detail: ok ? okText(f) : `${f.label} is ${f.direction} (${f.changePct}%) — does not support this link.`, evidenceIds: f.evidenceIds };
}

export function analyze(allRecords: EvidenceRecord[], visibleWorkspaces: string[]): Analysis {
  const visible = filterVisible(allRecords, visibleWorkspaces);
  const facts = computeFacts(visible);
  const get = (m: MetricKey) => facts.find((f) => f.metric === m);
  const leads = get("leads"), mql = get("mql_rate"), conv = get("conversion_rate"), ful = get("fulfillment_days"), back = get("backorder_rate"), rev = get("revenue");

  const opsFact = ful ?? back;
  const chain: ChainStep[] = [
    step("leads", "Marketing leads up", leads, "up", (f) => `Leads ${f.prior.toLocaleString()} → ${f.current.toLocaleString()} (+${f.changePct}%).`),
    step("quality", "Lead quality down", mql, "down", (f) => `MQL rate ${f.prior}% → ${f.current}% (${f.changePct}%).`),
    step("conversion", "Sales conversion down", conv, "down", (f) => `Conversion ${f.prior}% → ${f.current}% (${f.changePct}%).`),
    step("fulfillment", "Inventory fulfillment delays", opsFact, "up", (f) => `${f.label} ${f.prior} → ${f.current} ${f.unit} (+${f.changePct}%).`),
    step("revenue", "Revenue impact", rev, "down", (f) => `Revenue $${f.prior.toLocaleString()} → $${f.current.toLocaleString()} (${f.changePct}%).`),
  ];

  const hypotheses: Hypothesis[] = [];
  if (leads?.direction === "up" && mql?.direction === "down" && conv?.direction === "down")
    hypotheses.push({ title: "Lead mix shifted toward lower-intent sources", reasoning: "Lead volume rose while MQL rate and conversion fell in the same period, consistent with lower-intent leads diluting the pipeline. Correlation only; source-level attribution not verified.", confidence: "Medium", evidenceIds: [...leads.evidenceIds, ...mql.evidenceIds, ...conv.evidenceIds] });
  if (opsFact?.direction === "up" && conv?.direction === "down")
    hypotheses.push({ title: "Fulfillment delays are suppressing closes", reasoning: "Longer fulfillment/backorders coincide with falling conversion; customers may abandon orders with long lead times.", confidence: back && ful && back.direction === "up" ? "Medium" : "Low", evidenceIds: [...opsFact.evidenceIds, ...(back && back !== opsFact ? back.evidenceIds : []), ...conv.evidenceIds] });
  if (rev?.direction === "down" && hypotheses.length)
    hypotheses.push({ title: "Revenue decline is a downstream effect", reasoning: "Revenue fell alongside the funnel signals above; magnitude not decomposed per cause.", confidence: "Low", evidenceIds: rev.evidenceIds });

  const actions: Action[] = [];
  if (mql?.direction === "down") actions.push({ id: "ACT-1", owner: "Marketing", title: "Rebalance spend toward higher-MQL channels for 2 weeks", rationale: "MQL rate decline observed.", evidenceIds: mql.evidenceIds, requiresApproval: true });
  if (conv?.direction === "down") actions.push({ id: "ACT-2", owner: "Sales", title: "Add lead-score gate before SDR assignment", rationale: "Conversion decline observed.", evidenceIds: conv.evidenceIds, requiresApproval: true });
  if (opsFact?.direction === "up") actions.push({ id: "ACT-3", owner: "Operations", title: "Show stock ETA at quote time; expedite backordered SKUs", rationale: "Fulfillment delay observed.", evidenceIds: opsFact.evidenceIds, requiresApproval: true });
  if (rev?.direction === "down") actions.push({ id: "ACT-4", owner: "Finance", title: "Re-forecast Q4 revenue with funnel + fulfillment sensitivity", rationale: "Revenue decline observed.", evidenceIds: rev.evidenceIds, requiresApproval: true });

  const hiddenCount = allRecords.length - visible.length;
  const missing = chain.filter((c) => c.status === "insufficient-evidence").length;
  const supported = chain.filter((c) => c.status === "supported").length;
  const overallConfidence = missing > 0 ? "Low" : supported >= 5 ? "Medium" : supported >= 3 ? "Low" : "Low";

  const limitations = [
    "Two-period comparison only (Q2 vs Q3 2026); no seasonality baseline.",
    "Co-movement is not causation; no controlled experiment or attribution model.",
    "All records are synthetic and fictional.",
  ];
  if (hiddenCount > 0) limitations.unshift(`${hiddenCount} records are hidden by simulated permissions and were excluded from analysis.`);

  const citedIds = Array.from(new Set([...facts.flatMap((f) => f.evidenceIds)]));
  return {
    question: DEMO_QUESTION,
    facts,
    chain,
    hypotheses,
    alternatives: [
      "Seasonal demand shift unrelated to lead source.",
      "Pricing or competitor promotions changing close rates.",
      "Sales capacity constraints (SDR headcount/turnover) not captured in data.",
      "CRM scoring model change altering MQL definition.",
    ],
    actions,
    limitations,
    overallConfidence,
    citedIds,
    hiddenCount,
  };
}
