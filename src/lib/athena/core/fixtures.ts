// A second, unrelated business used only to prove the engine is parameterized by its catalog. Not part of the prototype.
import type { Catalog } from "./catalog";
import type { CoreRecord, PeriodPair } from "./facts";

export const SUPPORT_CATALOG = {
  flatThresholdPct: 3,
  domains: [
    { id: "Support", aliases: ["support", "helpdesk", "customer care"] },
    { id: "Billing", aliases: ["billing", "invoicing"] },
  ],
  metrics: [
    { key: "tickets_opened", label: "Tickets opened", domain: "Support", unit: "tickets", polarity: "lower_is_better", aggregation: "sum", aliases: ["ticket volume", "tickets opened", "tickets"] },
    { key: "first_response_hours", label: "First response time", domain: "Support", unit: "hours", polarity: "lower_is_better", aggregation: "average", aliases: ["first response time", "response time"] },
    { key: "csat", label: "Customer satisfaction", domain: "Support", unit: "%", polarity: "higher_is_better", aggregation: "rate", aliases: ["customer satisfaction", "csat"] },
    { key: "refunds", label: "Refunds issued", domain: "Billing", unit: "USD", polarity: "lower_is_better", aggregation: "sum", aliases: ["refunds", "refund volume"] },
  ],
} as const satisfies Catalog;

export const SUPPORT_PERIODS: PeriodPair = { prior: { label: "Jan 2027" }, current: { label: "Feb 2027" } };

const rec = (id: string, metric: string, department: string, period: "prior" | "current", value: number, unit: string): CoreRecord => ({ id, metric, department, period, value, unit });
export const SUPPORT_RECORDS: CoreRecord[] = [
  rec("SUP-001-P", "tickets_opened", "Support", "prior", 1000, "tickets"), rec("SUP-001-C", "tickets_opened", "Support", "current", 1200, "tickets"),
  rec("SUP-002-P", "first_response_hours", "Support", "prior", 5, "hours"), rec("SUP-002-C", "first_response_hours", "Support", "current", 5.1, "hours"),
  rec("SUP-003-P", "csat", "Support", "prior", 92, "%"), rec("SUP-003-C", "csat", "Support", "current", 88, "%"),
];
