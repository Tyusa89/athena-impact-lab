// Two unrelated synthetic datasets used to show the ingestion foundation is independent of any one business. SYNTHETIC ONLY.
//   A  business operations: Marketing / Sales / Operations / Finance, with a source-system vocabulary mapped by an explicit table.
//   B  customer support:    Support / CustomerExperience, with a different catalog, different periods and catalog keys used directly.
// The CSV files sit beside this module in ./fixtures.
import type { Catalog } from "../catalog";
import type { MappingSpec, SourceDescriptor } from "./types";

/** Dataset A's catalog is the prototype's business-operations catalog (src/lib/athena/prototypeCatalog.ts); the mapping below targets its keys. */
export const BUSINESS_OPS_SOURCE: SourceDescriptor = { sourceId: "ops-export", kind: "csv", label: "Synthetic business operations export" };
export const BUSINESS_OPS_MAPPING: MappingSpec = {
  columns: { recordId: "Record", metric: "Measure", domain: "Dept", period: "Quarter", value: "Amount", unit: "Unit", source: "System", note: "Comment" },
  metricNames: {
    "Marketing Leads": "leads", "MQL Rate": "mql_rate", "CAC": "cac", "Win Rate": "conversion_rate", "Closed Won Deals": "closed_deals",
    "Days to Fulfil": "fulfillment_days", "Backorders %": "backorder_rate", "Revenue (GL)": "revenue",
  },
  unitAliases: { pct: "%", usd: "USD" },
  periods: { prior: { label: "Q2 2026", end: "2026-06-30" }, current: { label: "Q3 2026", end: "2026-09-30" } },
};

export const SUPPORT_DESK_CATALOG = {
  flatThresholdPct: 3,
  domains: [
    { id: "Support", aliases: ["support", "service desk", "helpdesk"], generalTerms: ["support", "service desk", "helpdesk"] },
    { id: "CustomerExperience", aliases: ["customer experience", "cx"], generalTerms: ["customer experience", "cx"] },
  ],
  metrics: [
    { key: "tickets_opened", label: "Tickets opened", domain: "Support", unit: "tickets", polarity: "lower_is_better", aggregation: "sum", aliases: ["ticket volume", "tickets opened", "tickets"] },
    { key: "first_response_hours", label: "First response time", domain: "Support", unit: "hours", polarity: "lower_is_better", aggregation: "average", aliases: ["first response time", "response time"] },
    { key: "resolution_hours", label: "Resolution time", domain: "Support", unit: "hours", polarity: "lower_is_better", aggregation: "average", aliases: ["resolution time", "time to resolve"] },
    { key: "csat", label: "Customer satisfaction", domain: "CustomerExperience", unit: "%", polarity: "higher_is_better", aggregation: "rate", aliases: ["customer satisfaction", "csat"] },
  ],
} as const satisfies Catalog;
export const SUPPORT_DESK_PERIODS = { prior: { label: "Jan 2027" }, current: { label: "Feb 2027" } } as const;

export const SUPPORT_DESK_SOURCE: SourceDescriptor = { sourceId: "desk-export", kind: "csv", label: "Synthetic service desk export" };
export const SUPPORT_DESK_MAPPING: MappingSpec = {
  columns: { domain: "area", metric: "metric", period: "period", value: "value", unit: "unit", note: "note" },
  periods: { prior: { label: "Jan 2027", end: "2027-01-31" }, current: { label: "Feb 2027", end: "2027-02-28" } },
};
