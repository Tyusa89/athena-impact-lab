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

/** Structural problems that would make the catalog ambiguous or unsafe to use. Empty when the catalog is sound. Messages are for developers. */
export function validateCatalog(c: Catalog): string[] {
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
