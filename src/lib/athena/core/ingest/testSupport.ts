// Helpers shared by the ingestion tests: a test composition root (an identity adapter that reads the identity out of the credential, as a real
// adapter would read a validated token) and small builders. Not used by production code.
import { createIdentityBoundary, type IdentityBoundary, type TrustedContext, type VerifiedIdentity } from "../identity";
import type { Catalog } from "../catalog";
import { csvAdapter } from "./csv";
import { importSource, type ImportPolicy } from "./normalize";
import type { ImportOptions, ImportResult, MappingSpec, SourceDescriptor } from "./types";

export const identity: IdentityBoundary = createIdentityBoundary({ assurance: "verified", verify: (c) => c as VerifiedIdentity | null });
export const trusted = (tenantId: string, actorId = "importer"): TrustedContext => identity.authenticateSync({ tenantId, actorId });
export const allowAll: ImportPolicy = { mayImport: () => true };
export const denyAll: ImportPolicy = { mayImport: () => false };

export const SOURCE: SourceDescriptor = { sourceId: "test-feed", kind: "csv", label: "Synthetic test feed" };
/** A minimal mapping against a one-metric catalog, with catalog keys used directly. */
export const MINI_CATALOG = {
  flatThresholdPct: 3,
  domains: [{ id: "Finance", aliases: ["finance"] }, { id: "Ops", aliases: ["ops"] }],
  metrics: [
    { key: "revenue", label: "Revenue", domain: "Finance", unit: "USD", polarity: "higher_is_better", aggregation: "sum", aliases: ["revenue"] },
    { key: "cost", label: "Cost", domain: "Finance", unit: "USD", polarity: "lower_is_better", aggregation: "sum", aliases: ["cost"] },
    { key: "orders", label: "Orders", domain: "Ops", unit: "orders", polarity: "higher_is_better", aggregation: "sum", aliases: ["orders"] },
  ],
} as const satisfies Catalog;
export const MINI_MAPPING: MappingSpec = {
  columns: { metric: "metric", domain: "domain", period: "period", value: "value", unit: "unit" },
  periods: { prior: { label: "P1", end: "2026-01-31" }, current: { label: "P2", end: "2026-02-28" } },
};
export const HEADER = "metric,domain,period,value,unit";
export const GOOD_ROWS = ["revenue,Finance,P1,100,USD", "revenue,Finance,P2,120,USD"];
export const csv = (...lines: string[]) => lines.join("\n") + "\n";

export function runCsv(text: string, over: { ctx?: TrustedContext; policy?: ImportPolicy; spec?: MappingSpec; catalog?: Catalog; options?: ImportOptions; source?: SourceDescriptor; id?: IdentityBoundary } = {}): ImportResult {
  return importSource({ identity: over.id ?? identity, ctx: over.ctx ?? trusted("tenant-a"), policy: over.policy ?? allowAll, adapter: csvAdapter, input: text, source: over.source ?? SOURCE, spec: over.spec ?? MINI_MAPPING, catalog: over.catalog ?? MINI_CATALOG, ...(over.options ? { options: over.options } : {}) });
}
