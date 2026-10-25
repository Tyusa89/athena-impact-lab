// Business domain catalog: the configurable vocabulary of an analysis (metrics, domains, units, aliases, polarity,
// aggregation). Pure and dependency-free: nothing here knows about Athena, a UI, a data source or a model provider.
// A catalog is data; the calculation, grounding and guard code reads it instead of hard-coding any one business.

/** Which direction of change is good for the business (drives valence words such as "improved"). */
export type Polarity = "higher_is_better" | "lower_is_better";
/** How the metric's values are formed. Descriptive metadata: the engine compares one value per period and never re-aggregates. */
export type Aggregation = "sum" | "average" | "rate" | "ratio" | "snapshot";

export interface MetricDef {
  /** Stable identifier. Used in fact ids ("F-<key>"), so it is restricted to [a-z][a-z0-9_]*. */
  readonly key: string;
  readonly label: string;
  /** Id of the owning domain (a department, function or area). */
  readonly domain: string;
  /** Canonical unit of recorded values, e.g. "USD", "%", "days". */
  readonly unit: string;
  readonly polarity: Polarity;
  readonly aggregation: Aggregation;
  /** Lower-case phrases that refer to this metric in free text. Matched on whole words; longest phrase wins. */
  readonly aliases: readonly string[];
}
export interface DomainDef {
  readonly id: string;
  /** Lower-case phrases that refer to this domain in free text. */
  readonly aliases: readonly string[];
}
export interface Catalog {
  readonly metrics: readonly MetricDef[];
  readonly domains: readonly DomainDef[];
  /** A relative change smaller than this many percent is reported as flat. */
  readonly flatThresholdPct: number;
}

/** Literal metric keys / domain ids of a catalog declared `as const`. */
export type MetricKeyOf<C extends Catalog> = C["metrics"][number]["key"];
export type DomainIdOf<C extends Catalog> = C["domains"][number]["id"];

interface Index { metrics: ReadonlyMap<string, MetricDef>; domains: ReadonlyMap<string, DomainDef> }
const indexes = new WeakMap<Catalog, Index>();
function indexOf(c: Catalog): Index {
  assertCatalog(c);
  let ix = indexes.get(c);
  if (!ix) { ix = { metrics: new Map(c.metrics.map((m) => [m.key, m])), domains: new Map(c.domains.map((d) => [d.id, d])) }; indexes.set(c, ix); }
  return ix;
}

export const metricDef = (c: Catalog, key: string): MetricDef | undefined => indexOf(c).metrics.get(key);
export const domainDef = (c: Catalog, id: string): DomainDef | undefined => indexOf(c).domains.get(id);
export function requireMetric(c: Catalog, key: string): MetricDef {
  const m = metricDef(c, key);
  if (!m) throw new Error("Metric is not in the catalog");
  return m;
}
export const metricLabel = (c: Catalog, key: string): string => requireMetric(c, key).label;
export const metricDomain = (c: Catalog, key: string): string => requireMetric(c, key).domain;
/** The direction of change that is good for the business. */
export const goodDirection = (c: Catalog, key: string): "up" | "down" => (requireMetric(c, key).polarity === "higher_is_better" ? "up" : "down");

const KEY_RE = /^[a-z][a-z0-9_]*$/;
/** Fact ids are "F-<key>" and model refs are capped at 40 characters. */
const MAX_KEY = 38;

const POLARITIES: readonly string[] = ["higher_is_better", "lower_is_better"];
const AGGREGATIONS: readonly string[] = ["sum", "average", "rate", "ratio", "snapshot"];
const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const isStringArray = (x: unknown): x is string[] => Array.isArray(x) && x.every((v) => typeof v === "string");
/** Own accessor properties could return a different value on each read, which would defeat both validation and freezing. */
const hasAccessor = (o: object) => Object.values(Object.getOwnPropertyDescriptors(o)).some((d) => "get" in d || "set" in d);

/** The catalog must be plain data of the declared shape. Checked before anything else reads it. */
function shapeProblems(c: unknown): string[] {
  if (!isRecord(c)) return ["catalog must be an object"];
  const out: string[] = [];
  if (hasAccessor(c)) out.push("catalog must not have accessor properties");
  if (typeof c["flatThresholdPct"] !== "number") out.push("flatThresholdPct must be a number");
  const { metrics, domains } = c;
  if (!Array.isArray(metrics)) out.push("metrics must be an array");
  else metrics.forEach((m, i) => {
    if (!isRecord(m)) { out.push(`metrics[${i}] must be an object`); return; }
    if (hasAccessor(m)) out.push(`metrics[${i}] must not have accessor properties`);
    for (const k of ["key", "label", "domain", "unit"]) if (typeof m[k] !== "string") out.push(`metrics[${i}].${k} must be a string`);
    if (typeof m["polarity"] !== "string" || !POLARITIES.includes(m["polarity"])) out.push(`metrics[${i}].polarity must be one of ${POLARITIES.join(", ")}`);
    if (typeof m["aggregation"] !== "string" || !AGGREGATIONS.includes(m["aggregation"])) out.push(`metrics[${i}].aggregation must be one of ${AGGREGATIONS.join(", ")}`);
    if (!isStringArray(m["aliases"])) out.push(`metrics[${i}].aliases must be an array of strings`);
  });
  if (!Array.isArray(domains)) out.push("domains must be an array");
  else domains.forEach((d, i) => {
    if (!isRecord(d)) { out.push(`domains[${i}] must be an object`); return; }
    if (hasAccessor(d)) out.push(`domains[${i}] must not have accessor properties`);
    if (typeof d["id"] !== "string") out.push(`domains[${i}].id must be a string`);
    if (!isStringArray(d["aliases"])) out.push(`domains[${i}].aliases must be an array of strings`);
  });
  return out;
}

/** Structural problems that would make the catalog ambiguous or unsafe to use. Empty when the catalog is sound. Messages are for developers.
 * Pure: it does not freeze or mark the catalog. Use `assertCatalog` for the checked, immutable form every entry point requires. */
export function validateCatalog(c: Catalog): string[] {
  const shape = shapeProblems(c);
  if (shape.length) return shape;
  const problems: string[] = [];
  const keys = new Set<string>(), ids = new Set<string>();
  for (const d of c.domains) {
    if (!d.id) problems.push("domain with empty id");
    if (ids.has(d.id)) problems.push(`duplicate domain id ${d.id}`);
    ids.add(d.id);
  }
  for (const m of c.metrics) {
    if (!KEY_RE.test(m.key) || m.key.length > MAX_KEY) problems.push(`metric key ${m.key} must match ${KEY_RE} and be at most ${MAX_KEY} characters`);
    if (keys.has(m.key)) problems.push(`duplicate metric key ${m.key}`);
    keys.add(m.key);
    if (!ids.has(m.domain)) problems.push(`metric ${m.key} refers to unknown domain ${m.domain}`);
    if (!m.label.trim()) problems.push(`metric ${m.key} has an empty label`);
    if (!m.unit.trim()) problems.push(`metric ${m.key} has an empty unit`);
    if (m.aliases.length === 0) problems.push(`metric ${m.key} has no aliases`);
  }
  // An alias must identify exactly one metric or domain, otherwise the guards could attribute a claim to the wrong one.
  const owner = new Map<string, string>();
  const claim = (alias: string, who: string) => {
    if (alias !== alias.toLowerCase().trim() || !alias) problems.push(`alias "${alias}" of ${who} must be non-empty, lower-case and trimmed`);
    const prev = owner.get(alias);
    if (prev !== undefined && prev !== who) problems.push(`alias "${alias}" is shared by ${prev} and ${who}`);
    owner.set(alias, who);
  };
  for (const m of c.metrics) for (const a of m.aliases) claim(a, `metric:${m.key}`);
  for (const d of c.domains) for (const a of d.aliases) claim(a, `domain:${d.id}`);
  if (!(c.flatThresholdPct >= 0)) problems.push("flatThresholdPct must be a non-negative number");
  return problems;
}

const validated = new WeakSet<Catalog>();
function deepFreeze(x: unknown, seen = new Set<object>()): void {
  if (typeof x !== "object" || x === null || seen.has(x)) return;
  seen.add(x);
  Object.freeze(x);
  for (const v of Object.values(x)) deepFreeze(v, seen); // always recurse: an outer object the caller froze may still hold mutable parts
}

/**
 * The invariant every analysis entry point relies on: a catalog it reads has passed `validateCatalog` and is deeply frozen.
 * The first call validates (throwing on any problem; a rejected catalog is never remembered as valid) and then freezes it in
 * place; later calls are a set lookup. Because it can no longer change, indexes and term tables cached against it cannot go stale.
 * To use a different vocabulary, build a new catalog object.
 */
export function assertCatalog(c: Catalog): void {
  if (validated.has(c)) return;
  const problems = validateCatalog(c);
  if (problems.length) throw new Error(`Invalid catalog: ${problems.join("; ")}`);
  deepFreeze(c);
  validated.add(c);
}
