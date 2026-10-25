// Catalog-driven normalization and validation: turns an untrusted RawTable into tenant-bound Evidence. Pure and deterministic.
//
// Rules this module enforces (all fail closed):
//  * The tenant is the trusted context's tenant. Nothing in the data can set, change or influence it; a tenant-like column is refused.
//  * Metric, domain and unit must agree with the catalog's own definition of the metric. Unknown or ambiguous names are rejected, never guessed.
//  * Numbers, dates and periods are parsed strictly; nothing is defaulted, inferred or repaired.
//  * A (metric, period) seen more than once is a duplicate or a conflict: ALL its rows are rejected, so no row silently wins.
//  * Rejections carry a line, a field role and a closed code, never the cell's content.
import { assertCatalog, metricDef, type Catalog } from "../catalog";
import type { Evidence } from "../evidence";
import { AuthorizationError, type IdentityBoundary, type TrustedContext } from "../identity";
import { sha256Hex } from "./sha256";
import {
  DEFAULT_IMPORT_LIMITS, type FieldRole, type ImportBatch, type ImportOptions, type ImportResult, type MappingSpec, type Provenance, type RawTable, type RejectedRecord,
  type RejectionCode, type RejectionReason, type SourceAdapter, type SourceDescriptor, type StructuralCode, type StructuralError,
} from "./types";

/** Who may import, per trusted context and source. Evaluated before anything is read. Fail closed: only exactly `true` allows. */
export interface ImportPolicy {
  mayImport(ctx: TrustedContext, source: SourceDescriptor): boolean;
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const SOURCE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/;
const PREFIX_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/;
const BAD_CHARS = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/;
const TENANT_HEADER = /^(tenant|tenant[ _-]?id|organi[sz]ation[ _-]?id|org[ _-]?id)$/i;
const VALUE_RE = /^-?(0|[1-9]\d*)(\.\d+)?$/;
const MAX_ABS = 1e12;
const MAX_NOTE = 240;
const MAX_SOURCE_LABEL = 120;

/** A real calendar date in strict YYYY-MM-DD form. */
export function isIsoDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (y < 1900 || y > 2200 || mo < 1 || mo > 12 || d < 1) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1]!;
  return d <= days;
}

/** Configuration problems (not data problems). Messages are for developers and may name configured names, never input data. */
export function validateMapping(spec: MappingSpec, catalog: Catalog): string[] {
  const out: string[] = [];
  const c = spec?.columns;
  if (!c) return ["columns missing"];
  const roles = Object.entries(c).filter(([, v]) => v !== undefined) as [string, string][];
  for (const [role, name] of roles) if (typeof name !== "string" || name.length === 0) out.push(`column for ${role} must be a non-empty string`);
  const names = roles.map(([, n]) => n);
  if (new Set(names).size !== names.length) out.push("two roles map to the same column");
  for (const req of ["metric", "period", "value", "unit"] as const) if (!c[req]) out.push(`column for ${req} is required`);
  const ignored = spec.ignoredColumns ?? [];
  for (const ig of ignored) if (names.includes(ig)) out.push("an ignored column is also mapped");
  if (spec.metricNames !== undefined) {
    const seen = new Map<string, string>(), targets = new Set<string>();
    for (const [src, key] of Object.entries(spec.metricNames)) {
      if (!src || src.trim() !== src) out.push("metric names must be non-empty and trimmed");
      if (!metricDef(catalog, key)) out.push("a metric name maps to a key that is not in the catalog");
      const lower = src.toLowerCase();
      if (seen.has(lower)) out.push("two metric names differ only by case");
      seen.set(lower, key);
      if (targets.has(key)) out.push("two metric names map to the same catalog metric (ambiguous)");
      targets.add(key);
    }
  }
  const units = new Set(catalog.metrics.map((m) => m.unit));
  for (const [alias, unit] of Object.entries(spec.unitAliases ?? {})) if (!alias || !units.has(unit)) out.push("a unit alias maps to a unit no catalog metric uses");
  const { prior, current } = spec.periods ?? ({} as MappingSpec["periods"]);
  if (!prior?.label || !current?.label || prior.label === current.label) out.push("period labels must be non-empty and distinct");
  if (!prior || !isIsoDate(prior.end) || !current || !isIsoDate(current.end)) out.push("period end dates must be valid ISO dates");
  else if (!(prior.end < current.end)) out.push("the prior period must end before the current period");
  if (spec.idPrefix !== undefined && !PREFIX_RE.test(spec.idPrefix)) out.push("idPrefix has an invalid form");
  return out;
}

const structural = (code: StructuralCode, line?: number): ImportResult => ({ ok: false, error: line === undefined ? { code } : ({ code, line } as StructuralError) });
const results = new WeakSet<object>();
/** True only for results produced by `importSource` (the ledger accepts nothing else). */
export const isImportResult = (x: unknown): x is Extract<ImportResult, { ok: true }> => typeof x === "object" && x !== null && results.has(x);

export interface ImportRequest<Input> {
  identity: IdentityBoundary;
  ctx: TrustedContext;
  policy: ImportPolicy;
  adapter: SourceAdapter<Input>;
  input: Input;
  source: SourceDescriptor;
  spec: MappingSpec;
  catalog: Catalog;
  options?: ImportOptions;
}

/**
 * Import one batch. Throws `AuthorizationError` (generic) when the context is not one the identity boundary issued, or the policy does not allow
 * this context to import from this source. Everything else is reported in the result: a structural error for a bad file or mapping, or
 * per-row rejections.
 */
export function importSource<Input>(req: ImportRequest<Input>): ImportResult {
  const { identity, ctx, policy, adapter, input, source, spec, catalog } = req;
  if (!identity.owns(ctx)) throw new AuthorizationError();
  let allowed = false;
  try { allowed = policy.mayImport(ctx, source) === true; } catch { allowed = false; }
  if (!allowed) throw new AuthorizationError();
  const limits = req.options?.limits ?? DEFAULT_IMPORT_LIMITS;
  const mode = req.options?.mode ?? "all_or_nothing";
  if (!SOURCE_ID_RE.test(source.sourceId) || !source.kind || !source.label || source.label.length > MAX_SOURCE_LABEL || BAD_CHARS.test(source.label)) return structural("bad_mapping");
  assertCatalog(catalog);
  if (validateMapping(spec, catalog).length) return structural("bad_mapping");

  let read;
  try { read = adapter.read(input, limits); } catch { return structural("source_unreadable"); }
  if (!read || !read.ok) return read && !read.ok ? { ok: false, error: read.error } : structural("source_unreadable");
  const table: RawTable = read.table;
  if (table.rows.length > limits.maxRows) return structural("too_many_rows");
  if (table.columns.length > limits.maxColumns) return structural("too_many_columns");

  // ---- header: exact names, no duplicates, no unexpected columns, no tenant column
  const cols = table.columns;
  if (new Set(cols).size !== cols.length) return structural("duplicate_header");
  const mapped = Object.values(spec.columns).filter((v): v is string => typeof v === "string");
  const ignored = new Set(spec.ignoredColumns ?? []);
  for (const h of cols) if (TENANT_HEADER.test(h.trim()) && !ignored.has(h)) return structural("tenant_column_in_file");
  for (const m of mapped) if (!cols.includes(m)) return structural("missing_column");
  for (const h of cols) if (!mapped.includes(h) && !ignored.has(h)) return structural("unexpected_column");
  const at = (name: string | undefined) => (name === undefined ? -1 : cols.indexOf(name));
  const ix = { recordId: at(spec.columns.recordId), metric: at(spec.columns.metric), domain: at(spec.columns.domain), period: at(spec.columns.period), periodEnd: at(spec.columns.periodEnd), value: at(spec.columns.value), unit: at(spec.columns.unit), source: at(spec.columns.source), note: at(spec.columns.note) };

  const contentSha256 = sha256Hex(JSON.stringify([cols, table.rows.map((r) => r.cells)]));
  const batch: ImportBatch = Object.freeze({ batchId: `batch-${sha256Hex(`${ctx.tenantId}\u0000${source.sourceId}\u0000${contentSha256}`).slice(0, 24)}`, tenantId: ctx.tenantId, source: Object.freeze({ ...source }), adapterId: adapter.id, contentSha256, rowCount: table.rows.length });

  const metricByName = spec.metricNames ? new Map(Object.entries(spec.metricNames)) : undefined;
  const periods = { [spec.periods.prior.label]: { role: "prior" as const, end: spec.periods.prior.end }, [spec.periods.current.label]: { role: "current" as const, end: spec.periods.current.end } };
  const idPrefix = spec.idPrefix ?? source.sourceId;

  interface Row { line: number; reasons: RejectionReason[]; key?: string; id?: string; ev?: Omit<Evidence, "tenantId"> & { _key: string; _sig: string } }
  const rows: Row[] = [];
  for (const r of table.rows) {
    const reasons: RejectionReason[] = [];
    const bad = (code: RejectionCode, field: FieldRole) => { reasons.push({ code, field }); };
    if (r.cells.length !== cols.length) { bad("field_count_mismatch", "row"); rows.push({ line: r.line, reasons }); continue; }
    const cell = (i: number) => (i < 0 ? undefined : r.cells[i]!.trim());
    const text = (role: FieldRole, i: number): string | undefined => { const v = cell(i); if (v !== undefined && BAD_CHARS.test(v)) { bad("invalid_character", role); return undefined; } return v; };

    let id: string | undefined;
    if (ix.recordId < 0) id = `${idPrefix}:L${r.line}`;
    else { const v = text("recordId", ix.recordId); if (v !== undefined) { if (ID_RE.test(v)) id = v; else bad("id_invalid", "recordId"); } }

    // metric
    const metricCell = text("metric", ix.metric);
    let key: string | undefined;
    if (metricCell !== undefined) {
      if (metricCell === "") bad("metric_missing", "metric");
      else if (metricByName) key = metricByName.get(metricCell);
      else key = metricDef(catalog, metricCell) ? metricCell : undefined;
      if (metricCell !== "" && key === undefined) bad("metric_unknown", "metric");
    }
    const def = key === undefined ? undefined : metricDef(catalog, key);

    // domain (only if the mapping asks for it): must equal the catalog's domain for the metric
    if (ix.domain >= 0) {
      const d = text("domain", ix.domain);
      if (d !== undefined) { if (d === "") bad("domain_missing", "domain"); else if (def && d !== def.domain) bad("domain_mismatch", "domain"); else if (!def && !catalog.domains.some((x) => x.id === d)) bad("domain_mismatch", "domain"); }
    }

    // unit: explicit alias table, then exact equality with the catalog unit
    const unitCell = text("unit", ix.unit);
    if (unitCell !== undefined) {
      if (unitCell === "") bad("unit_missing", "unit");
      else if (def) { const u = spec.unitAliases && Object.prototype.hasOwnProperty.call(spec.unitAliases, unitCell) ? spec.unitAliases[unitCell]! : unitCell; if (u !== def.unit) bad("unit_mismatch", "unit"); }
    }

    // value: strict decimal, bounded, at most 15 significant digits
    const valueCell = text("value", ix.value);
    let value: number | undefined;
    if (valueCell !== undefined) {
      if (valueCell === "") bad("value_missing", "value");
      else if (!VALUE_RE.test(valueCell) || valueCell.replace(/[-.]/g, "").length > 15) bad("value_invalid", "value");
      else { const v = Number(valueCell); if (!Number.isFinite(v) || Math.abs(v) > MAX_ABS) bad("value_out_of_range", "value"); else value = v === 0 ? 0 : v; }
    }

    // period (label) and optional period end date
    const periodCell = text("period", ix.period);
    const p = periodCell === undefined ? undefined : Object.prototype.hasOwnProperty.call(periods, periodCell) ? periods[periodCell] : undefined;
    if (periodCell !== undefined) { if (periodCell === "") bad("period_missing", "period"); else if (!p) bad("period_unknown", "period"); }
    if (ix.periodEnd >= 0) {
      const e = text("periodEnd", ix.periodEnd);
      if (e !== undefined) { if (e === "") bad("date_missing", "periodEnd"); else if (!isIsoDate(e)) bad("date_invalid", "periodEnd"); else if (p && e !== p.end) bad("date_mismatch", "periodEnd"); }
    }

    // provenance label and note
    let srcLabel = source.label;
    if (ix.source >= 0) { const s = text("source", ix.source); if (s === undefined) { /* already rejected */ } else if (s === "" || s.length > MAX_SOURCE_LABEL) bad("source_invalid", "source"); else srcLabel = s; }
    let note: string | undefined;
    if (ix.note >= 0) { const n = text("note", ix.note); if (n !== undefined) { if (n.length > MAX_NOTE) bad("note_invalid", "note"); else if (n !== "") note = n; } }

    const row: Row = { line: r.line, reasons };
    // Every row with a SYNTACTICALLY VALID id reserves it, whatever else is wrong with the row. (Malformed ids were already rejected above and
    // stay out, so they can never match anything; a row with the wrong cell count never reaches here, its cells being misaligned.)
    if (id !== undefined) row.id = id;
    const ok = reasons.length === 0 && def && value !== undefined && p && id !== undefined && unitCell !== undefined;
    if (ok) {
      row.ev = { id: id!, source: srcLabel, metric: def!.key, department: def!.domain, period: p!.role, date: p!.end, value: value!, unit: def!.unit, ...(note !== undefined ? { note } : {}), _key: `${def!.key}\u0000${p!.role}`, _sig: `${value}\u0000${def!.unit}\u0000${srcLabel}` };
    }
    // Remember the key even when the row is otherwise rejected, so a bad row still blocks a good one with the same key.
    if (!ok && def && p) row.key = `${def.key}\u0000${p.role}`;
    rows.push(row);
  }

  // ---- duplicates and conflicts: every member of a repeated (metric, period) or repeated id is rejected
  const byKey = new Map<string, Row[]>();
  const byId = new Map<string, Row[]>();
  for (const row of rows) {
    const k = row.ev?._key ?? row.key;
    if (k !== undefined) (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(row);
    if (row.id !== undefined) (byId.get(row.id) ?? byId.set(row.id, []).get(row.id)!).push(row); // all rows with a valid id, not only fully valid ones
  }
  for (const group of byKey.values()) {
    if (group.length < 2) continue;
    const sigs = new Set(group.map((g) => g.ev?._sig ?? `invalid:${g.line}`));
    const code: RejectionCode = sigs.size === 1 && group.every((g) => g.ev) ? "duplicate_record" : "conflicting_record";
    for (const g of group) g.reasons.push({ code, field: "row" });
  }
  for (const group of byId.values()) if (group.length > 1) for (const g of group) g.reasons.push({ code: "id_duplicate", field: "recordId" });

  const rejected: RejectedRecord[] = [];
  const valid: Row[] = [];
  for (const row of rows) { if (row.reasons.length) rejected.push(Object.freeze({ line: row.line, reasons: Object.freeze(row.reasons.map((x) => Object.freeze({ ...x }))) })); else valid.push(row); }

  const commit = mode === "accept_valid" || rejected.length === 0;
  const accepted: Evidence[] = [];
  const provenance: Record<string, Provenance> = {};
  if (commit) for (const row of valid) {
    const { _key, _sig, ...base } = row.ev!;
    void _key; void _sig;
    const e: Evidence = Object.freeze({ ...base, tenantId: ctx.tenantId });
    accepted.push(e);
    provenance[e.id] = Object.freeze({ batchId: batch.batchId, sourceId: source.sourceId, adapterId: adapter.id, line: row.line, contentSha256 });
  }
  const status = rejected.length === 0 ? "accepted" : accepted.length > 0 ? "partial" : "rejected";
  const result: ImportResult = Object.freeze({ ok: true as const, status, batch, accepted: Object.freeze(accepted), rejected: Object.freeze(rejected), provenance: Object.freeze(provenance) });
  results.add(result);
  return result;
}
