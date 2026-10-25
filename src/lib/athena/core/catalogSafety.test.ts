import { describe, expect, it } from "vitest";
import { PERIODS, SCENARIOS, type EvidenceRecord } from "../data";
import { factsBlockReason } from "../meta/adapter.server";
import { buildMessages, validateOutput } from "../meta/contract";
import { renderFindings } from "../meta/findings";
import { buildVerifiedFacts, verifyNoNumerals } from "../meta/numericGrounding";
import { checkSemantics, directionalClaims, magnitudeExpressions, semanticScope } from "../meta/semanticGuards";
import { PROTOTYPE_CATALOG } from "../prototypeCatalog";
import { goodDirection, metricDef, metricDomain, metricLabel, requireMetric, validateCatalog, type Catalog } from "./catalog";
import { computeFacts, validateRecords, type AnalysisContext, type CoreRecord } from "./facts";
import { SUPPORT_CATALOG, SUPPORT_PERIODS, SUPPORT_RECORDS } from "./fixtures";

// C1: a catalog is validated before any use and cannot change afterwards, so cached indexes and term tables cannot go stale.
// C2: a fact is produced only when BOTH records agree with the catalog's own definition of the metric.
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const fresh = () => clone(SUPPORT_CATALOG) as unknown as { flatThresholdPct: number; domains: { id: string; aliases: string[] }[]; metrics: { key: string; label: string; domain: string; unit: string; polarity: string; aggregation: string; aliases: string[] }[] };
const asCatalog = (c: unknown) => c as Catalog;
const periods = SUPPORT_PERIODS;
const records = SUPPORT_RECORDS;

/** A catalog that fails validation in several different ways. */
const invalidCatalogs: [string, () => Catalog][] = [
  ["alias shared by two metrics", () => { const c = fresh(); c.metrics[1]!.aliases.push("tickets"); return asCatalog(c); }],
  ["metric refers to an unknown domain", () => { const c = fresh(); c.metrics[0]!.domain = "Nowhere"; return asCatalog(c); }],
  ["duplicate metric key", () => { const c = fresh(); c.metrics[1]!.key = c.metrics[0]!.key; return asCatalog(c); }],
  ["negative flat threshold", () => { const c = fresh(); c.flatThresholdPct = -1; return asCatalog(c); }],
  ["metrics is not an array", () => asCatalog({ ...fresh(), metrics: {} })],
  ["missing polarity value", () => { const c = fresh(); c.metrics[0]!.polarity = "sideways"; return asCatalog(c); }],
  ["aliases is not an array", () => { const c = fresh(); (c.metrics[0] as unknown as { aliases: unknown }).aliases = "tickets"; return asCatalog(c); }],
  ["accessor property", () => { const c = fresh(); Object.defineProperty(c.metrics[0]!, "label", { get: () => "x", enumerable: true }); return asCatalog(c); }],
  ["null", () => asCatalog(null)],
];

describe("C1: every entry point validates the catalog before use", () => {
  const ctxOf = (catalog: Catalog): AnalysisContext => ({ catalog, periods });
  const entries: [string, (c: Catalog) => unknown][] = [
    ["metricDef", (c) => metricDef(c, "csat")],
    ["requireMetric", (c) => requireMetric(c, "csat")],
    ["metricLabel", (c) => metricLabel(c, "csat")],
    ["metricDomain", (c) => metricDomain(c, "csat")],
    ["goodDirection", (c) => goodDirection(c, "csat")],
    ["core computeFacts", (c) => computeFacts(records, ctxOf(c))],
    ["core validateRecords", (c) => validateRecords(records, c)],
    ["buildVerifiedFacts", (c) => buildVerifiedFacts(records, ctxOf(c))],
    ["renderFindings", (c) => renderFindings(records, ctxOf(c))],
    ["buildMessages", (c) => buildMessages("q", records as unknown as EvidenceRecord[], ctxOf(c))],
    ["validateOutput", (c) => validateOutput("{}", records as unknown as EvidenceRecord[], records as unknown as EvidenceRecord[], ctxOf(c))],
    ["semanticScope", (c) => semanticScope(records as unknown as EvidenceRecord[], [], c)],
    ["checkSemantics (hand-built scope)", (c) => checkSemantics("Tickets rose.", "interpretation", { facts: [], departments: new Set(["Support"]), catalog: c })],
    ["directionalClaims", (c) => directionalClaims("Tickets rose.", "interpretation", c)],
    ["magnitudeExpressions", (c) => magnitudeExpressions("Tickets doubled.", "interpretation", c)],
  ];
  for (const [bad, make] of invalidCatalogs) {
    it.each(entries)(`rejects "${bad}" at %s`, (_name, run) => {
      const c = make();
      expect(() => run(c)).toThrow(/Invalid catalog/);
    });
  }
  it("the invalid catalogs really are invalid under validateCatalog (or unreadable)", () => {
    for (const [name, make] of invalidCatalogs) expect(validateCatalog(make()), name).not.toEqual([]);
  });
  it("the check does not depend on the input having content: empty records and empty text still reject an invalid catalog", () => {
    const c = invalidCatalogs[0]![1]();
    expect(() => computeFacts([], ctxOf(c))).toThrow(/Invalid catalog/);
    expect(() => buildVerifiedFacts([], ctxOf(c))).toThrow(/Invalid catalog/);
    expect(() => renderFindings([], ctxOf(c))).toThrow(/Invalid catalog/);
    expect(() => directionalClaims("", "interpretation", c)).toThrow(/Invalid catalog/);
    expect(() => magnitudeExpressions("", "interpretation", c)).toThrow(/Invalid catalog/);
    expect(() => checkSemantics("", "interpretation", { facts: [], departments: new Set(), catalog: c })).toThrow(/Invalid catalog/);
  });
  it("a rejected catalog stays rejected: failure is not cached as success", () => {
    const c = invalidCatalogs[0]![1]();
    expect(() => metricDef(c, "csat")).toThrow(/Invalid catalog/);
    expect(() => metricDef(c, "csat")).toThrow(/Invalid catalog/);
    expect(() => computeFacts(records, ctxOf(c))).toThrow(/Invalid catalog/);
  });
  it("the bundled catalogs are valid", () => {
    expect(() => metricDef(PROTOTYPE_CATALOG, "revenue")).not.toThrow();
    expect(() => metricDef(SUPPORT_CATALOG, "csat")).not.toThrow();
  });
});

describe("C1: a validated catalog cannot change afterwards", () => {
  it("is frozen (deeply) after first use, so every later mutation throws", () => {
    const c = fresh();
    expect(computeFacts(records, { catalog: asCatalog(c), periods })).toHaveLength(3);
    const mutations: [string, () => void][] = [
      ["assign flat threshold", () => { c.flatThresholdPct = 0; }],
      ["assign metric label", () => { c.metrics[0]!.label = "Changed"; }],
      ["assign metric domain", () => { c.metrics[0]!.domain = "Billing"; }],
      ["assign metric unit", () => { c.metrics[0]!.unit = "cases"; }],
      ["assign polarity", () => { c.metrics[0]!.polarity = "higher_is_better"; }],
      ["push a metric", () => { c.metrics.push({ ...c.metrics[0]!, key: "extra", aliases: ["extra"] }); }],
      ["remove a metric", () => { c.metrics.pop(); }],
      ["push a metric alias", () => { c.metrics[0]!.aliases.push("incoming"); }],
      ["replace a metric alias", () => { c.metrics[0]!.aliases[0] = "other"; }],
      ["push a domain", () => { c.domains.push({ id: "New", aliases: ["new"] }); }],
      ["push a domain alias", () => { c.domains[0]!.aliases.push("desk"); }],
      ["rename a domain", () => { c.domains[0]!.id = "Renamed"; }],
      ["add a property", () => { (c as unknown as Record<string, unknown>)["extra"] = 1; }],
      ["replace the metrics array", () => { (c as unknown as { metrics: unknown }).metrics = []; }],
    ];
    for (const [name, mutate] of mutations) expect(mutate, name).toThrow(TypeError);
    expect(Object.isFrozen(c) && Object.isFrozen(c.metrics) && Object.isFrozen(c.metrics[0]) && Object.isFrozen(c.metrics[0]!.aliases) && Object.isFrozen(c.domains[0]!.aliases)).toBe(true);
  });
  it("every entry point freezes it, not only computeFacts", () => {
    for (const use of [
      (c: Catalog) => metricLabel(c, "csat"),
      (c: Catalog) => directionalClaims("Tickets rose.", "interpretation", c),
      (c: Catalog) => magnitudeExpressions("Tickets doubled.", "interpretation", c),
      (c: Catalog) => semanticScope([], [], c),
      (c: Catalog) => buildVerifiedFacts(records, { catalog: c, periods }),
    ]) {
      const c = fresh();
      use(asCatalog(c));
      expect(Object.isFrozen(c.metrics[0]!.aliases)).toBe(true);
    }
  });
  it("freezes nested data even when the caller froze only the outer object", () => {
    const c = fresh();
    Object.freeze(c);
    expect(() => { c.metrics[0]!.label = "early"; }).not.toThrow(); // nested part still mutable
    metricDef(asCatalog(c), "csat");
    expect(() => { c.metrics[0]!.label = "late"; }).toThrow(TypeError);
  });
  it("freezes the prototype catalog on first use", () => {
    computeFacts(SCENARIOS[0]!.records, { catalog: PROTOTYPE_CATALOG, periods: PERIODS });
    expect(Object.isFrozen(PROTOTYPE_CATALOG) && Object.isFrozen(PROTOTYPE_CATALOG.metrics[0]) && Object.isFrozen(PROTOTYPE_CATALOG.metrics[0]!.aliases)).toBe(true);
    expect(() => { (PROTOTYPE_CATALOG.metrics as unknown as unknown[]).push({}); }).toThrow(TypeError);
  });
  it("cached indexes and term tables cannot be made stale: a failed mutation changes nothing", () => {
    const c = asCatalog(fresh());
    const before = JSON.stringify(directionalClaims("Ticket volume rose.", "interpretation", c));
    expect(metricDomain(c, "csat")).toBe("Support");
    expect(() => { (c.metrics[2] as { domain: string }).domain = "Billing"; }).toThrow(TypeError);
    expect(() => { (c.metrics[0]!.aliases as string[]).push("ticket volume rose"); }).toThrow(TypeError);
    expect(metricDomain(c, "csat")).toBe("Support");
    expect(JSON.stringify(directionalClaims("Ticket volume rose.", "interpretation", c))).toBe(before);
    expect(directionalClaims("Customer satisfaction deteriorated.", "interpretation", c)[0]).toMatchObject({ dir: "down" });
  });
  it("a mutation made BEFORE first use is validated, so an invalid result is refused and a valid one is what gets cached", () => {
    const broken = fresh();
    broken.metrics[1]!.aliases.push("tickets"); // collision introduced before use
    expect(() => metricDef(asCatalog(broken), "csat")).toThrow(/Invalid catalog/);
    expect(Object.isFrozen(broken)).toBe(false); // refused catalogs are not marked valid
    broken.metrics[1]!.aliases.pop(); // caller repairs it; it is validated afresh and then accepted
    expect(metricLabel(asCatalog(broken), "csat")).toBe("Customer satisfaction");
    expect(Object.isFrozen(broken.metrics[1]!.aliases)).toBe(true);
  });
  it("a copy of a frozen catalog is a new, separately validated catalog", () => {
    const base = asCatalog(fresh());
    metricDef(base, "csat");
    const copy = { ...base, metrics: base.metrics.map((m) => (m.key === "csat" ? { ...m, aliases: ["tickets"] } : m)) } as Catalog; // alias collision in the copy
    expect(() => metricDef(copy, "csat")).toThrow(/Invalid catalog/);
    expect(metricLabel(base, "csat")).toBe("Customer satisfaction");
  });
  it("reporting-period reference caches follow the labels they are given (no stale regexp)", () => {
    const p = { prior: { label: "Jan 2027" }, current: { label: "Feb 2027" } };
    expect(verifyNoNumerals("Compared with the period in 2027.", [], p)).toEqual([]);
    expect(verifyNoNumerals("Compared with the period in 2030.", [], p)).not.toEqual([]);
    p.prior.label = "Jan 2030"; p.current.label = "Feb 2030"; // same object, new labels
    expect(verifyNoNumerals("Compared with the period in 2030.", [], p)).toEqual([]);
    expect(verifyNoNumerals("Compared with the period in 2027.", [], p)).not.toEqual([]);
  });
});

describe("C2: a fact needs both records to agree with the catalog's definition of the metric", () => {
  const ctx: AnalysisContext = { catalog: SUPPORT_CATALOG, periods };
  const pair = (over: Partial<CoreRecord>, over2: Partial<CoreRecord> = over): CoreRecord[] => [
    { id: "T-P", metric: "tickets_opened", department: "Support", period: "prior", value: 1000, unit: "tickets", ...over },
    { id: "T-C", metric: "tickets_opened", department: "Support", period: "current", value: 1200, unit: "tickets", ...over2 },
  ];
  it("control: a consistent pair yields a fact", () => expect(computeFacts(pair({}), ctx)).toHaveLength(1));
  it("both records in the wrong domain (agreeing with each other) yield no fact", () => {
    expect(computeFacts(pair({ department: "Billing" }), ctx)).toEqual([]);
    expect(computeFacts(pair({ department: "Nowhere" }), ctx)).toEqual([]);
  });
  it("both records in the wrong unit (agreeing with each other) yield no fact", () => {
    expect(computeFacts(pair({ unit: "cases" }), ctx)).toEqual([]);
    expect(computeFacts(pair({ unit: "%" }), ctx)).toEqual([]); // would also have produced a bogus pp change
    expect(computeFacts(pair({ unit: "" }), ctx)).toEqual([]);
  });
  it("one record wrong, either side, yields no fact", () => {
    expect(computeFacts(pair({}, { department: "Billing" }), ctx)).toEqual([]);
    expect(computeFacts(pair({ department: "Billing" }, {}), ctx)).toEqual([]);
    expect(computeFacts(pair({}, { unit: "cases" }), ctx)).toEqual([]);
    expect(computeFacts(pair({ unit: "cases" }, {}), ctx)).toEqual([]);
  });
  it("a mismatched metric does not disturb a consistent one in the same set", () => {
    const good = pair({});
    const bad = pair({ metric: "csat", unit: "pts", id: "B" }).map((r, i) => ({ ...r, id: `B-${i}` }));
    expect(computeFacts([...good, ...bad], ctx).map((f) => f.metric)).toEqual(["tickets_opened"]);
  });
  it("the catalog's own definition decides, not the first record", () => {
    // a catalog that says tickets are measured in "cases" makes the formerly consistent pair inconsistent
    const cat = { ...fresh(), metrics: fresh().metrics.map((m) => (m.key === "tickets_opened" ? { ...m, unit: "cases" } : m)) } as unknown as Catalog;
    expect(computeFacts(pair({}), { catalog: cat, periods })).toEqual([]);
    expect(computeFacts(pair({ unit: "cases" }), { catalog: cat, periods })).toHaveLength(1);
  });
  it("validateRecords reports the same pairs that computeFacts refuses", () => {
    for (const recs of [pair({ department: "Billing" }), pair({ unit: "cases" })]) {
      expect(validateRecords(recs, SUPPORT_CATALOG)).not.toEqual([]);
      expect(computeFacts(recs, ctx)).toEqual([]);
    }
    expect(validateRecords(pair({}), SUPPORT_CATALOG)).toEqual([]);
  });

  describe("prototype pipeline fails closed on a consistent-but-wrong pair", () => {
    const base = SCENARIOS[0]!.records;
    const wrong = (patch: Partial<EvidenceRecord>) => base.map((r) => (r.metric === "revenue" ? ({ ...r, ...patch } as EvidenceRecord) : r));
    it.each([
      ["unit", { unit: "EUR" }],
      ["department", { department: "Sales" as const, workspace: "ws-sales" }],
    ])("revenue records with a wrong %s on both periods give no revenue fact, no finding, and block sending", (_n, patch) => {
      const recs = wrong(patch);
      expect(buildVerifiedFacts(recs).some((f) => f.metric === "revenue")).toBe(false);
      expect(renderFindings(recs).some((f) => f.metric === "revenue")).toBe(false);
      expect(factsBlockReason(recs)).toMatch(/unpaired/);
    });
    it("control: the unmodified scenario has a revenue fact and is not blocked", () => {
      expect(buildVerifiedFacts(base).some((f) => f.metric === "revenue")).toBe(true);
      expect(factsBlockReason(base)).toBeNull();
    });
  });
});
