// The prototype's business domain: a fictional home-goods company. This catalog reproduces, exactly, the metrics, labels,
// departments, units, wording aliases and polarity the prototype used before the catalog existed. Synthetic only.
// The reusable engine (./core) never imports this file; the prototype wires it in.
import type { Catalog } from "./core/catalog";

export const PROTOTYPE_CATALOG = {
  flatThresholdPct: 3,
  domains: [
    { id: "Marketing", aliases: ["marketing", "campaigns", "campaign", "advertising", "paid social", "paid media", "ad spend", "ad spending"], generalTerms: ["marketing", "campaign", "campaigns", "advertising"] },
    { id: "Sales", aliases: ["sales team", "sales teams", "sales pipeline", "sales reps", "salespeople", "sales", "pipeline"], generalTerms: ["sales", "sales team", "sales teams", "sales reps", "salespeople"] },
    { id: "Operations", aliases: ["operations", "operational", "warehouse", "logistics", "supply chain", "suppliers", "supplier", "inventory"], generalTerms: ["operations", "operational"] },
    { id: "Finance", aliases: ["finance", "financial", "accounting", "ledger", "budgets", "budget"], generalTerms: ["finance", "financial", "accounting", "budget", "budgets"] },
  ],
  metrics: [
    { key: "leads", label: "Marketing leads", domain: "Marketing", unit: "leads", polarity: "higher_is_better", aggregation: "sum", aliases: ["lead volume", "lead count", "lead generation", "lead flow", "lead inflow", "inbound leads", "new leads", "leads"] },
    { key: "mql_rate", label: "Lead quality (MQL rate)", domain: "Marketing", unit: "%", polarity: "higher_is_better", aggregation: "rate", aliases: ["marketing qualified leads", "qualified leads", "qualified lead", "lead quality", "mql rate", "mqls", "mql"] },
    { key: "conversion_rate", label: "Sales conversion rate", domain: "Sales", unit: "%", polarity: "higher_is_better", aggregation: "rate", aliases: ["conversion rate", "conversion rates", "conversions", "conversion"] },
    { key: "closed_deals", label: "Closed deals", domain: "Sales", unit: "deals", polarity: "higher_is_better", aggregation: "sum", aliases: ["closed deals", "closed won", "deals closed", "won deals", "deal volume", "deal count", "closings", "deals"] },
    { key: "fulfillment_days", label: "Avg. fulfillment time", domain: "Operations", unit: "days", polarity: "lower_is_better", aggregation: "average", aliases: ["fulfillment time", "fulfillment times", "fulfilment time", "fulfilment times", "fulfillment", "fulfilment", "delivery time", "delivery times", "shipping time", "shipping times"] },
    { key: "backorder_rate", label: "Backorder rate", domain: "Operations", unit: "%", polarity: "lower_is_better", aggregation: "rate", aliases: ["backorder rate", "backorders", "backorder", "back order", "back orders"] },
    { key: "revenue", label: "Recognized revenue", domain: "Finance", unit: "USD", polarity: "higher_is_better", aggregation: "sum", aliases: ["recognized revenue", "recognised revenue", "revenue", "top line"] },
    { key: "cac", label: "Customer acquisition cost", domain: "Marketing", unit: "USD", polarity: "lower_is_better", aggregation: "ratio", aliases: ["customer acquisition cost", "customer acquisition costs", "acquisition cost", "acquisition costs", "cost per acquisition", "cac"] },
  ],
} as const satisfies Catalog;
