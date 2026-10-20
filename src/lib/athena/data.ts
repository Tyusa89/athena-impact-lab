// SYNTHETIC DATA ONLY. Fictional company. Not connected to EcoNest systems.
export type Department = "Sales" | "Marketing" | "Finance" | "Operations";

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

export const METRIC_LABELS: Record<MetricKey, string> = {
  leads: "Marketing leads",
  mql_rate: "Lead quality (MQL rate)",
  conversion_rate: "Sales conversion rate",
  closed_deals: "Closed deals",
  fulfillment_days: "Avg. fulfillment time",
  backorder_rate: "Backorder rate",
  revenue: "Recognized revenue",
  cac: "Customer acquisition cost",
};

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

function build(prefix: string, rows: Row[]): EvidenceRecord[] {
  const out: EvidenceRecord[] = [];
  rows.forEach(([metric, department, workspace, source, prior, current, unit, note], i) => {
    const n = String(i + 1).padStart(3, "0");
    out.push({ id: `${prefix}-${department.slice(0, 3).toUpperCase()}-${n}P`, department, workspace, date: "2026-06-30", source, metric, period: "prior", value: prior, unit });
    out.push({ id: `${prefix}-${department.slice(0, 3).toUpperCase()}-${n}C`, department, workspace, date: "2026-09-30", source, metric, period: "current", value: current, unit, note });
  });
  return out;
}

export const SCENARIOS: Scenario[] = [
  {
    id: "baseline",
    name: "Q3 Paid-Social Surge",
    description: "Leads up after a broad paid-social push; quality, conversion and fulfillment degrade.",
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
    name: "Lead Quality Only",
    description: "Leads up and quality down, but operations are healthy.",
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
    name: "Fulfillment Bottleneck",
    description: "Lead quality stable; a warehouse bottleneck drives cancellations.",
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
