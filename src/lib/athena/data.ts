// SYNTHETIC DATA ONLY. Fictional company. Not connected to EcoNest systems.
import type { DomainIdOf, MetricKeyOf } from "./core/catalog";
import { PROTOTYPE_CATALOG } from "./prototypeCatalog";

/** Identifiers come from the prototype catalog (./prototypeCatalog); the unions below are derived from it, not declared here. */
export type Department = DomainIdOf<typeof PROTOTYPE_CATALOG>;

export interface EvidenceRecord {
  id: string;
  department: Department;
  workspace: string; // simulated workspace for role-based visibility
  date: string; // ISO
  source: string; // fictional source label
  metric: MetricKey;
  period: "prior" | "current";
  value: number;
  unit: string;
  note?: string | undefined;
}

export type MetricKey =
  | "leads"
  | "mql_rate"
  | "conversion_rate"
  | "closed_deals"
  | "fulfillment_days"
  | "backorder_rate"
  | "revenue"
  | "cac";

export const METRIC_LABELS = Object.fromEntries(PROTOTYPE_CATALOG.metrics.map((m) => [m.key, m.label])) as Record<MetricKey, string>;

export const COMPANY = {
  name: "Verdant Hollow Home Goods",
  label: "FICTIONAL COMPANY — synthetic records for demonstration",
};

export interface Scenario {
  id: string;
  name: string;
  description: string;
  records: EvidenceRecord[];
}

type Row = [MetricKey, Department, string, string, number, number, string, string?];

export const PERIODS = {
  prior: { label: "Q2 2026", date: "2026-06-30" },
  current: { label: "Q3 2026", date: "2026-09-30" },
} as const;

export const DEPT_WORKSPACE: Record<Department, string> = {
  Marketing: "ws-marketing",
  Sales: "ws-sales",
  Operations: "ws-ops",
  Finance: "ws-finance",
};

const DEPT_CODE: Record<Department, string> = { Marketing: "MKT", Sales: "SAL", Operations: "OPS", Finance: "FIN" };

/** Builds paired prior/current records. IDs are numbered per department; workspace is derived from department. */
export function build(prefix: string, rows: Row[]): EvidenceRecord[] {
  const out: EvidenceRecord[] = [];
  const counters: Partial<Record<Department, number>> = {};
  rows.forEach(([metric, department, workspace, source, prior, current, unit, note]) => {
    if (workspace !== DEPT_WORKSPACE[department]) throw new Error(`Workspace mismatch for ${metric}`);
    const n = String((counters[department] = (counters[department] ?? 0) + 1)).padStart(3, "0");
    const base = `${prefix}-${DEPT_CODE[department]}-${n}`;
    out.push({ id: `${base}-Q2`, department, workspace, date: PERIODS.prior.date, source, metric, period: "prior", value: prior, unit });
    out.push({ id: `${base}-Q3`, department, workspace, date: PERIODS.current.date, source, metric, period: "current", value: current, unit, note });
  });
  return out;
}

export const SCENARIOS: Scenario[] = [
  {
    id: "baseline",
    name: "Scenario A — Q3 synthetic snapshot",
    description: "Synthetic Q2 vs Q3 2026 records across four departments.",
    records: build("VH", [
      ["leads", "Marketing", "ws-marketing", "SYN-CRM Campaign Export", 4200, 6300, "leads", "Paid social share rose 22% → 51%"],
      ["mql_rate", "Marketing", "ws-marketing", "SYN-CRM Lead Scoring", 34, 21, "%"],
      ["cac", "Marketing", "ws-marketing", "SYN-Ads Spend Ledger", 118, 141, "USD"],
      ["conversion_rate", "Sales", "ws-sales", "SYN-Pipeline Snapshot", 9.5, 5.4, "%"],
      ["closed_deals", "Sales", "ws-sales", "SYN-Pipeline Snapshot", 399, 340, "deals"],
      ["fulfillment_days", "Operations", "ws-ops", "SYN-WMS Shipment Log", 3.1, 7.8, "days", "Supplier delay on SKU family 'Bamboo Linen'"],
      ["backorder_rate", "Operations", "ws-ops", "SYN-WMS Inventory Report", 4, 17, "%"],
      ["revenue", "Finance", "ws-finance", "SYN-GL Revenue Summary", 1_240_000, 1_018_000, "USD"],
    ]),
  },
  {
    id: "quality-only",
    name: "Scenario B — Q3 synthetic snapshot",
    description: "Synthetic Q2 vs Q3 2026 records across four departments.",
    records: build("VQ", [
      ["leads", "Marketing", "ws-marketing", "SYN-CRM Campaign Export", 4000, 5600, "leads"],
      ["mql_rate", "Marketing", "ws-marketing", "SYN-CRM Lead Scoring", 33, 24, "%"],
      ["conversion_rate", "Sales", "ws-sales", "SYN-Pipeline Snapshot", 9.0, 6.1, "%"],
      ["closed_deals", "Sales", "ws-sales", "SYN-Pipeline Snapshot", 360, 342, "deals"],
      ["fulfillment_days", "Operations", "ws-ops", "SYN-WMS Shipment Log", 3.1, 3.1, "days"],
      ["backorder_rate", "Operations", "ws-ops", "SYN-WMS Inventory Report", 4, 4, "%"],
      ["revenue", "Finance", "ws-finance", "SYN-GL Revenue Summary", 1_150_000, 1_096_000, "USD"],
    ]),
  },
  {
    id: "ops-only",
    name: "Scenario C — Q3 synthetic snapshot",
    description: "Synthetic Q2 vs Q3 2026 records across four departments.",
    records: build("VO", [
      ["leads", "Marketing", "ws-marketing", "SYN-CRM Campaign Export", 4100, 4700, "leads"],
      ["mql_rate", "Marketing", "ws-marketing", "SYN-CRM Lead Scoring", 33, 33, "%"],
      ["conversion_rate", "Sales", "ws-sales", "SYN-Pipeline Snapshot", 9.2, 7.0, "%"],
      ["closed_deals", "Sales", "ws-sales", "SYN-Pipeline Snapshot", 377, 329, "deals"],
      ["fulfillment_days", "Operations", "ws-ops", "SYN-WMS Shipment Log", 3.2, 9.1, "days", "Warehouse WMS migration backlog"],
      ["backorder_rate", "Operations", "ws-ops", "SYN-WMS Inventory Report", 5, 21, "%"],
      ["revenue", "Finance", "ws-finance", "SYN-GL Revenue Summary", 1_200_000, 1_002_000, "USD"],
    ]),
  },
];

export const WORKSPACES = [
  { id: "ws-marketing", label: "Marketing workspace" },
  { id: "ws-sales", label: "Sales workspace" },
  { id: "ws-ops", label: "Operations workspace" },
  { id: "ws-finance", label: "Finance workspace" },
] as const;

export const ROLES: { id: string; label: string; workspaces: string[] }[] = [
  { id: "exec", label: "Executive (all workspaces)", workspaces: ["ws-marketing", "ws-sales", "ws-ops", "ws-finance"] },
  { id: "marketing", label: "Marketing Manager", workspaces: ["ws-marketing", "ws-sales"] },
  { id: "ops", label: "Operations Lead", workspaces: ["ws-ops", "ws-sales"] },
  { id: "finance", label: "Finance Analyst", workspaces: ["ws-finance"] },
];
