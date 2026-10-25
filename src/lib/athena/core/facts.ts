// Verified-fact calculation, parameterized by a catalog and a pair of reporting periods. Pure and dependency-free.
// This is the single place where a prior/current pair of records becomes a fact, a direction and a rendered change.
import { metricDef, type Catalog } from "./catalog";

/** The minimum a record must carry to be compared across periods. `department` holds the id of the record's catalog domain. */
export interface CoreRecord {
  id: string;
  metric: string;
  department: string;
  period: "prior" | "current";
  value: number;
  unit: string;
}
export interface PeriodPair {
  readonly prior: { readonly label: string };
  readonly current: { readonly label: string };
}
/** Everything a calculation needs to know about the business and the reporting window. */
export interface AnalysisContext {
  readonly catalog: Catalog;
  readonly periods: PeriodPair;
}

export type Direction = "up" | "down" | "flat";
export interface CoreFact<M extends string = string, D extends string = string> {
  metric: M;
  label: string;
  department: D;
  prior: number;
  current: number;
  unit: string;
  /** Relative change vs prior period: (current - prior) / prior * 100. null if prior is 0. */
  changePct: number | null;
  /** For rate metrics (unit "%"): absolute change in percentage points. */
  changePp: number | null;
  direction: Direction;
  evidenceIds: string[];
  periodLabel: string;
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/** One fact per catalog metric that has exactly one prior and one current record with matching unit and domain.
 * Anything ambiguous, mismatched or outside the catalog yields no fact (fail closed; the coverage guard then blocks sending). */
export function computeFacts<R extends CoreRecord>(records: readonly R[], ctx: AnalysisContext): CoreFact<R["metric"], R["department"]>[] {
  const keys = Array.from(new Set(records.map((r) => r.metric)));
  const facts: CoreFact<R["metric"], R["department"]>[] = [];
  for (const m of keys) {
    const def = metricDef(ctx.catalog, m);
    if (!def) continue;
    const ps = records.filter((r) => r.metric === m && r.period === "prior");
    const cs = records.filter((r) => r.metric === m && r.period === "current");
    if (ps.length !== 1 || cs.length !== 1) continue; // require exactly one pair; ambiguity → no fact
    const p = ps[0]!, c = cs[0]!;
    if (p.unit !== c.unit || p.department !== c.department) continue;
    const changePct = p.value === 0 ? null : r1(((c.value - p.value) / p.value) * 100);
    const changePp = c.unit === "%" ? r1(c.value - p.value) : null;
    const direction: Direction = changePct === null || Math.abs(changePct) < ctx.catalog.flatThresholdPct ? "flat" : changePct > 0 ? "up" : "down";
    facts.push({ metric: m, label: def.label, department: c.department, prior: p.value, current: c.value, unit: c.unit, changePct, changePp, direction, evidenceIds: [p.id, c.id], periodLabel: `${ctx.periods.prior.label} → ${ctx.periods.current.label}` });
  }
  return facts;
}

export function describeChange(f: Pick<CoreFact, "unit" | "prior" | "current" | "changePct" | "changePp">): string {
  const fmt = (v: number) => (f.unit === "USD" ? `$${v.toLocaleString("en-US")}` : f.unit === "%" ? `${v}%` : `${v.toLocaleString("en-US")} ${f.unit}`);
  const rel = f.changePct === null ? "n/a" : `${f.changePct > 0 ? "+" : ""}${f.changePct}%`;
  const pp = f.changePp !== null ? `, ${f.changePp > 0 ? "+" : ""}${f.changePp} pp` : "";
  return `${fmt(f.prior)} → ${fmt(f.current)} (${rel} relative${pp})`;
}

/** Problems that make records inconsistent with the catalog (unknown metric, wrong domain or unit). Empty when consistent. For data-loading code and tests. */
export function validateRecords(records: readonly CoreRecord[], catalog: Catalog): string[] {
  const out: string[] = [];
  for (const r of records) {
    const def = metricDef(catalog, r.metric);
    if (!def) out.push(`${r.id}: metric ${r.metric} is not in the catalog`);
    else {
      if (def.domain !== r.department) out.push(`${r.id}: domain ${r.department} does not match the metric's domain ${def.domain}`);
      if (def.unit !== r.unit) out.push(`${r.id}: unit ${r.unit} does not match the metric's unit ${def.unit}`);
    }
  }
  return out;
}
