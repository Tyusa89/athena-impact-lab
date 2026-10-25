// Neutral ingestion contract. Pure types: no format, no vendor, no I/O, no knowledge of the intelligence engine or any model provider.
//
// Pipeline:   source system --(SourceAdapter)--> RawTable --(importTable + MappingSpec + Catalog + TrustedContext)--> ImportResult
//             --(EvidenceLedger.commit)--> EvidenceStore --(authorizeEvidence)--> AuthorizedEvidence --> existing fact engine.
// An adapter only turns a source into a table of strings. Everything that decides what a value MEANS (metric, domain, unit, period, date,
// number) is the same for every source and is driven by the catalog. Tenant identity comes from the trusted context, never from the data.
import type { Evidence } from "../evidence";

/** Where a batch came from. `label` becomes the provenance label on evidence rows that do not carry their own. */
export interface SourceDescriptor {
  /** Stable id of the source system or feed, e.g. "crm-export". [A-Za-z0-9._-]{1,48}. */
  readonly sourceId: string;
  /** Open set: "csv" today; "api", "database", "upload" for future adapters. */
  readonly kind: string;
  /** Human-readable provenance label, shown on evidence. */
  readonly label: string;
}

/** Resource limits applied before and while a source is read. */
export interface ImportLimits {
  readonly maxBytes: number;
  readonly maxRows: number;
  readonly maxColumns: number;
  readonly maxFieldChars: number;
}
export const DEFAULT_IMPORT_LIMITS: ImportLimits = Object.freeze({ maxBytes: 1_048_576, maxRows: 10_000, maxColumns: 32, maxFieldChars: 512 });

/** What every adapter produces: a header and rows of strings, with the source line each row came from. Cells are untrusted text. */
export interface RawRow { readonly line: number; readonly cells: readonly string[] }
export interface RawTable { readonly columns: readonly string[]; readonly rows: readonly RawRow[] }

/** Whole-input failures: the framing or the mapping is wrong, so no row can be trusted. Closed set; messages never contain input text. */
export const STRUCTURAL_CODES = [
  "empty_input", "input_too_large", "too_many_rows", "too_many_columns", "field_too_long", "unterminated_quote", "stray_quote", "invalid_line_ending", "invalid_character",
  "missing_header", "duplicate_header", "missing_column", "unexpected_column", "tenant_column_in_file", "bad_mapping", "source_unreadable",
] as const;
export type StructuralCode = (typeof STRUCTURAL_CODES)[number];
export interface StructuralError { readonly code: StructuralCode; readonly line?: number }

export type SourceReadResult = { ok: true; table: RawTable } | { ok: false; error: StructuralError };
/** A source adapter. Future adapters (API, database, upload) implement this and nothing else; they never see the catalog, a tenant or the engine. */
export interface SourceAdapter<Input> {
  readonly id: string;
  read(input: Input, limits: ImportLimits): SourceReadResult;
}

export interface PeriodSpec { readonly label: string; readonly end: string }
export interface MappingSpec {
  /** Which header names play which role. Names are matched exactly. Optional roles that are omitted are not inferred. */
  readonly columns: {
    readonly recordId?: string;
    readonly metric: string;
    readonly domain?: string;
    readonly period: string;
    readonly periodEnd?: string;
    readonly value: string;
    readonly unit: string;
    readonly source?: string;
    readonly note?: string;
  };
  /** Headers that exist in the source but are deliberately never read. A tenant-like header is refused unless listed here. */
  readonly ignoredColumns?: readonly string[];
  /** Explicit source metric name -> catalog metric key (one to one). Absent: the cell must already be a catalog key. */
  readonly metricNames?: Readonly<Record<string, string>>;
  /** Explicit source unit text -> the catalog's unit. Absent entries must already equal the catalog unit exactly. */
  readonly unitAliases?: Readonly<Record<string, string>>;
  /** The two reporting periods the engine compares. A row's period must be one of these labels. */
  readonly periods: { readonly prior: PeriodSpec; readonly current: PeriodSpec };
  /** Prefix for generated record ids when there is no recordId column. Defaults to the source id. */
  readonly idPrefix?: string;
}

/** Row-level rejection reasons. Closed set. A rejection names the line and the field role, never the cell's content. */
export const REJECTION_CODES = [
  "field_count_mismatch", "invalid_character", "id_invalid", "id_duplicate", "metric_missing", "metric_unknown", "domain_missing", "domain_mismatch",
  "unit_missing", "unit_mismatch", "value_missing", "value_invalid", "value_out_of_range", "period_missing", "period_unknown", "date_missing", "date_invalid", "date_mismatch",
  "source_invalid", "note_invalid", "duplicate_record", "conflicting_record",
] as const;
export type RejectionCode = (typeof REJECTION_CODES)[number];
export type FieldRole = "recordId" | "metric" | "domain" | "period" | "periodEnd" | "value" | "unit" | "source" | "note" | "row";
export interface RejectionReason { readonly code: RejectionCode; readonly field: FieldRole }
export interface RejectedRecord { readonly line: number; readonly reasons: readonly RejectionReason[] }

export interface ImportBatch {
  /** Deterministic: derived from the tenant, the source and the exact content. Re-importing the same bytes gives the same id. */
  readonly batchId: string;
  /** The tenant the evidence is bound to. Always the trusted context's tenant, never a value from the data. */
  readonly tenantId: string;
  readonly source: SourceDescriptor;
  readonly adapterId: string;
  /** SHA-256 of the parsed table (header and cells), for provenance and idempotent re-import. */
  readonly contentSha256: string;
  readonly rowCount: number;
}
export interface Provenance { readonly batchId: string; readonly sourceId: string; readonly adapterId: string; readonly line: number; readonly contentSha256: string }

export type ImportStatus = "accepted" | "partial" | "rejected";
export type ImportResult =
  | { readonly ok: true; readonly status: ImportStatus; readonly batch: ImportBatch; readonly accepted: readonly Evidence[]; readonly rejected: readonly RejectedRecord[]; readonly provenance: Readonly<Record<string, Provenance>> }
  | { readonly ok: false; readonly error: StructuralError };

export interface ImportOptions {
  readonly limits?: ImportLimits;
  /** "all_or_nothing" (default): any rejected row means nothing from the batch becomes evidence. "accept_valid": valid rows only. */
  readonly mode?: "all_or_nothing" | "accept_valid";
}
