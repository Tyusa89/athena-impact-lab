// Product-neutral evidence: one recorded value of one metric for one reporting period, with the tenant it belongs to and
// where it came from. Pure types, no dependencies. Source systems (CSV, warehouse, CRM, a demo fixture) map into this shape.
import type { CoreRecord } from "./facts";

export interface Evidence extends CoreRecord {
  /** Record identity. Unique within a tenant. Cited back to the user, so it is only ever shown for authorized evidence. */
  readonly id: string;
  /** The customer (tenant) this evidence belongs to. Set by the system that loaded the record, never by a client or a model. */
  readonly tenantId: string;
  /** Source provenance: a human-readable label of the system or file the value came from. Treated as restricted like the id. */
  readonly source: string;
  /** Metric identity: a key of the catalog in use. */
  readonly metric: string;
  /** Domain (department, function) the metric belongs to, per the catalog. */
  readonly department: string;
  /** Which side of the comparison this value is on. */
  readonly period: "prior" | "current";
  /** Reporting-period end date, ISO 8601 (YYYY-MM-DD). */
  readonly date: string;
  readonly value: number;
  readonly unit: string;
  readonly note?: string | undefined;
}
