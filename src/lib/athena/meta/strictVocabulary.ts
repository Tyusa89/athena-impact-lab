// Vocabulary rules for STRICT mention checking (Phase H2.3). Pure and client-safe; neutral (no dataset, no provider).
//
// Two jobs, both in the safe direction:
//   1. RECOGNIZE MORE restricted references: the strict matcher tolerates inflections of a catalog alias (plural, possessive, which becomes a plural once apostrophes are stripped, and the singular
//      of a plural alias), so "revenues", "lead volumes", "response times" and "closed deal" are no longer invisible. Legacy matching is untouched.
//   2. ALLOW plain department vocabulary: a hidden DEPARTMENT word is acceptable only when the operator declared it generic (`DomainDef.generalTerms`), no data-bearing noun sits within two words of it,
//      and its clause says nothing about change or comparison.
//      Anything else that could identify a restricted metric or disclose data is rejected (fail closed). A METRIC is never exempt.
import type { Catalog } from "../core/catalog";

export interface StrictEntity {
  kind: "metric" | "dept";
  key: string;
  /** the catalog alias that matched (base form) */ term: string;
  start: number;
  end: number;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Alias -> pattern accepting the alias, its plural (`s`, `es`, `ies` for a trailing y) and, for an alias ending in `s` (at least 5 letters), the singular. Spaces match any whitespace run. */
function patternFor(alias: string): string {
  const body = (w: string) => esc(w).replace(/\s+/g, "\\s+");
  const forms = new Set<string>();
  const add = (stem: string, suffix: string) => forms.add(`${body(stem)}${suffix}`);
  if (alias.endsWith("s") && alias.length >= 5) {
    add(alias.slice(0, -1), "(?:s|es)?");
    add(alias, "(?:es)?");
  } else if (alias.endsWith("y") && alias.length >= 4) {
    add(alias, "(?:s)?");
    add(alias.slice(0, -1), "ies");
  } else add(alias, "(?:s|es)?");
  return `\\b(?:${[...forms].join("|")})\\b`;
}

const tables = new WeakMap<
  Catalog,
  { kind: "metric" | "dept"; key: string; term: string; re: RegExp }[]
>();
function tableFor(c: Catalog) {
  let t = tables.get(c);
  if (!t) {
    const list = [
      ...c.metrics.flatMap((m) =>
        m.aliases.map((term) => ({ term, kind: "metric" as const, key: m.key })),
      ),
      ...c.domains.flatMap((d) =>
        d.aliases.map((term) => ({ term, kind: "dept" as const, key: d.id })),
      ),
    ].sort((a, b) => b.term.length - a.term.length); // longest phrase first, as the legacy matcher: a metric phrase wins over a department word inside it
    t = list.map((x) => ({ ...x, re: new RegExp(patternFor(x.term), "g") }));
    tables.set(c, t);
  }
  return t;
}

/** Catalog metrics and departments named in `norm` (text already normalized by `semanticText`), inflections included. Overlaps resolve longest-first. */
export function strictEntities(norm: string, catalog: Catalog): StrictEntity[] {
  const taken: [number, number][] = [];
  const out: StrictEntity[] = [];
  for (const t of tableFor(catalog)) {
    t.re.lastIndex = 0;
    for (let m = t.re.exec(norm); m; m = t.re.exec(norm)) {
      const start = m.index,
        end = start + m[0].length;
      if (taken.some(([a, b]) => start < b && end > a)) continue;
      taken.push([start, end]);
      out.push({ kind: t.kind, key: t.key, term: t.term, start, end });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Nouns that make a department word a reference to DATA about it ("sales numbers", "budget variance", "operations capacity"). Matched with or without a plural. */
const DATA_NOUNS = new Set([
  "performance",
  "result",
  "number",
  "figure",
  "metric",
  "kpi",
  "data",
  "statistic",
  "stat",
  "actual",
  "trend",
  "rate",
  "ratio",
  "volume",
  "growth",
  "decline",
  "drop",
  "increase",
  "decrease",
  "gain",
  "loss",
  "total",
  "score",
  "cost",
  "spend",
  "spending",
  "revenue",
  "income",
  "profit",
  "margin",
  "forecast",
  "target",
  "quota",
  "count",
  "value",
  "variance",
  "level",
  "output",
  "productivity",
  "efficiency",
  "capacity",
  "throughput",
  "utilization",
  "utilisation",
  "velocity",
  "pace",
  "benchmark",
  "record",
  "report",
  "size",
  "price",
  "pricing",
  "expense",
  "saving",
  "yield",
  "share",
  "return",
]);
const wordsOf = (s: string) => s.match(/[a-z]+/g) ?? [];
const dataBearing = (w: string) =>
  DATA_NOUNS.has(w) || DATA_NOUNS.has(w.replace(/(?:ies)$/, "y").replace(/(?:es|s)$/, ""));

/** Words that say something CHANGED or compare it. A hidden department word in a clause with one of these is a statement about how that department is doing, which the claim detector may not
 * recognize ("Operations slowed."), so it is rejected rather than trusted to be neutral. Deliberately excludes "improve/improving" (the ordinary imperative: "consider improving the customer
 * experience"; the claim detector handles "sales are improving") and short ambiguous words ("up", "down", "more", "less") that appear in ordinary phrasing ("follow up", "more staff"). */
const CHANGE_WORDS = new Set([
  "rose",
  "rise",
  "rises",
  "rising",
  "risen",
  "fell",
  "fall",
  "falls",
  "falling",
  "fallen",
  "declined",
  "declines",
  "declining",
  "grew",
  "grow",
  "grows",
  "growing",
  "grown",
  "increased",
  "increases",
  "increasing",
  "decreased",
  "decreases",
  "decreasing",
  "dropped",
  "drops",
  "dropping",
  "slowed",
  "slows",
  "slowing",
  "slowdown",
  "weakened",
  "weakens",
  "weakening",
  "strengthened",
  "strengthens",
  "strengthening",
  "worsened",
  "worsens",
  "worsening",
  "deteriorated",
  "deteriorates",
  "deteriorating",
  "surged",
  "surges",
  "surging",
  "spiked",
  "spikes",
  "jumped",
  "plunged",
  "tumbled",
  "soared",
  "climbed",
  "slipped",
  "lagged",
  "lagging",
  "stalled",
  "stagnated",
  "stagnant",
  "recovered",
  "recovering",
  "doubled",
  "halved",
  "tripled",
  "outperformed",
  "underperformed",
  "improved",
  "improves",
  "gained",
  "lost",
  "shrank",
  "shrunk",
  "shrinking",
  "expanded",
  "contracted",
  "accelerated",
  "decelerated",
  "dipped",
  "sank",
  "collapsed",
  "higher",
  "lower",
  "better",
  "worse",
  "stronger",
  "weaker",
  "faster",
  "slower",
]);
const clauseOf = (norm: string, start: number, end: number) =>
  `${
    norm
      .slice(0, start)
      .split(/[.;:!?(),\n]/)
      .pop() ?? ""
  } ${norm.slice(end).split(/[.;:!?(),\n]/)[0] ?? ""}`;

/** True when the department word reads as a reference to DATA about it, or to how it changed: a data-bearing noun within two words, or a change/comparison word anywhere in its clause. Fail closed. */
export function referencesData(norm: string, e: Pick<StrictEntity, "start" | "end">): boolean {
  const before = wordsOf(
    norm
      .slice(0, e.start)
      .split(/[.;:!?(),\n]/)
      .pop() ?? "",
  ).slice(-2);
  const after = wordsOf(norm.slice(e.end).split(/[.;:!?(),\n]/)[0] ?? "").slice(0, 2);
  if ([...before, ...after].some(dataBearing)) return true;
  return wordsOf(clauseOf(norm, e.start, e.end)).some((w) => CHANGE_WORDS.has(w));
}

/** The department words the operator declared generic for this catalog (empty when the catalog declares none). */
export function generalTermsOf(catalog: Catalog, domainId: string): ReadonlySet<string> {
  return new Set(catalog.domains.find((d) => d.id === domainId)?.generalTerms ?? []);
}
