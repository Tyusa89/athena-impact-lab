import { describe, expect, it } from "vitest";
import { SCENARIOS, PERIODS } from "../data";
import { PROTOTYPE_CATALOG } from "../prototypeCatalog";
import { goodDirection, metricDef, metricDomain, metricLabel, requireMetric, validateCatalog, type Catalog } from "./catalog";
import { computeFacts, describeChange, validateRecords, type AnalysisContext, type CoreRecord } from "./facts";
import { SUPPORT_CATALOG, SUPPORT_PERIODS, SUPPORT_RECORDS } from "./fixtures";

describe("prototype catalog", () => {
  it("is structurally sound", () => expect(validateCatalog(PROTOTYPE_CATALOG)).toEqual([]));
  it("describes every metric used by every bundled scenario, with matching domain and unit", () => {
    for (const sc of SCENARIOS) expect(validateRecords(sc.records, PROTOTYPE_CATALOG)).toEqual([]);
  });
  it("reproduces the prototype's polarity, domains, aggregation and labels", () => {
    expect(PROTOTYPE_CATALOG.metrics.map((m) => [m.key, goodDirection(PROTOTYPE_CATALOG, m.key), m.domain, m.aggregation])).toEqual([
      ["leads", "up", "Marketing", "sum"], ["mql_rate", "up", "Marketing", "rate"], ["conversion_rate", "up", "Sales", "rate"], ["closed_deals", "up", "Sales", "sum"],
      ["fulfillment_days", "down", "Operations", "average"], ["backorder_rate", "down", "Operations", "rate"], ["revenue", "up", "Finance", "sum"], ["cac", "down", "Marketing", "ratio"],
    ]);
    expect(metricLabel(PROTOTYPE_CATALOG, "revenue")).toBe("Recognized revenue");
    expect(metricDomain(PROTOTYPE_CATALOG, "cac")).toBe("Marketing");
    expect(PROTOTYPE_CATALOG.flatThresholdPct).toBe(3);
  });
  it("keeps exactly the wording aliases the prototype had before the catalog existed (pinned counts)", () => {
    expect(Object.fromEntries(PROTOTYPE_CATALOG.metrics.map((m) => [m.key, m.aliases.length]))).toEqual({ leads: 8, mql_rate: 7, conversion_rate: 4, closed_deals: 8, fulfillment_days: 10, backorder_rate: 5, revenue: 4, cac: 6 });
    expect(Object.fromEntries(PROTOTYPE_CATALOG.domains.map((d) => [d.id, d.aliases.length]))).toEqual({ Marketing: 8, Sales: 7, Operations: 8, Finance: 6 });
    expect(PROTOTYPE_CATALOG.metrics.find((m) => m.key === "revenue")!.aliases).toContain("top line");
    expect(PROTOTYPE_CATALOG.domains.find((d) => d.id === "Finance")!.aliases).toContain("ledger");
  });
  it("lookups fail closed for unknown metrics", () => {
    expect(metricDef(PROTOTYPE_CATALOG, "nope")).toBeUndefined();
    expect(() => requireMetric(PROTOTYPE_CATALOG, "nope")).toThrow("not in the catalog");
  });
});

describe("validateCatalog", () => {
  const base: Catalog = { flatThresholdPct: 3, domains: [{ id: "A", aliases: ["alpha"] }], metrics: [{ key: "m1", label: "M1", domain: "A", unit: "u", polarity: "higher_is_better", aggregation: "sum", aliases: ["em one"] }] };
  const m1 = base.metrics[0]!;
  const bad = (c: Partial<Catalog>) => validateCatalog({ ...base, ...c }).join(" | ");
  it("accepts a minimal catalog", () => expect(validateCatalog(base)).toEqual([]));
  it("rejects duplicate keys, unknown domains, bad keys, shared or malformed aliases and a bad threshold", () => {
    expect(bad({ metrics: [m1, m1] })).toContain("duplicate metric key");
    expect(bad({ metrics: [{ ...m1, domain: "Z" }] })).toContain("unknown domain");
    expect(bad({ metrics: [{ ...m1, key: "Bad-Key" }] })).toContain("must match");
    expect(bad({ metrics: [{ ...m1, key: "k".repeat(39) }] })).toContain("at most 38");
    expect(bad({ metrics: [m1, { ...m1, key: "m2" }] })).toContain("is shared by");
    expect(bad({ metrics: [{ ...m1, aliases: ["alpha"] }] })).toContain("is shared by");
    expect(bad({ metrics: [{ ...m1, aliases: ["Upper"] }] })).toContain("lower-case");
    expect(bad({ metrics: [{ ...m1, aliases: [] }] })).toContain("no aliases");
    expect(bad({ metrics: [{ ...m1, unit: " " }] })).toContain("empty unit");
    expect(bad({ domains: [base.domains[0]!, base.domains[0]!] })).toContain("duplicate domain id");
    expect(bad({ flatThresholdPct: -1 })).toContain("flatThresholdPct");
    expect(bad({ flatThresholdPct: Number.NaN })).toContain("flatThresholdPct");
  });
});

describe("core calculation is parameterized by the catalog (a different business, no prototype data)", () => {
  const ctx: AnalysisContext = { catalog: SUPPORT_CATALOG, periods: SUPPORT_PERIODS };
  it("the second catalog is sound and consistent with its records", () => {
    expect(validateCatalog(SUPPORT_CATALOG)).toEqual([]);
    expect(validateRecords(SUPPORT_RECORDS, SUPPORT_CATALOG)).toEqual([]);
  });
  it("computes facts, directions, labels and period labels from the catalog", () => {
    const f = Object.fromEntries(computeFacts(SUPPORT_RECORDS, ctx).map((x) => [x.metric, x]));
    expect(Object.keys(f).sort()).toEqual(["csat", "first_response_hours", "tickets_opened"]);
    expect(f["tickets_opened"]).toMatchObject({ label: "Tickets opened", department: "Support", prior: 1000, current: 1200, changePct: 20, changePp: null, direction: "up", evidenceIds: ["SUP-001-P", "SUP-001-C"], periodLabel: "Jan 2027 → Feb 2027" });
    expect(f["csat"]).toMatchObject({ unit: "%", changePp: -4, direction: "down" });
    expect(f["first_response_hours"]).toMatchObject({ direction: "flat" }); // +2.0% is under this catalog's threshold of 3
  });
  it("the flat threshold comes from the catalog", () => {
    const tight: AnalysisContext = { ...ctx, catalog: { ...SUPPORT_CATALOG, flatThresholdPct: 1 } };
    expect(computeFacts(SUPPORT_RECORDS, tight).find((x) => x.metric === "first_response_hours")!.direction).toBe("up");
  });
  it("metrics outside the catalog, unit mismatches and ambiguous pairs yield no fact", () => {
    const rec = (over: Partial<CoreRecord>): CoreRecord => ({ id: "X-1", metric: "tickets_opened", department: "Support", period: "prior", value: 1, unit: "tickets", ...over });
    expect(computeFacts([rec({}), rec({ id: "X-2", period: "current" })], ctx)).toHaveLength(1);
    expect(computeFacts([rec({ metric: "revenue" }), rec({ metric: "revenue", id: "X-2", period: "current" })], ctx)).toEqual([]);
    expect(computeFacts([rec({}), rec({ id: "X-2", period: "current", unit: "cases" })], ctx)).toEqual([]);
    expect(computeFacts([rec({}), rec({ id: "X-3" }), rec({ id: "X-2", period: "current" })], ctx)).toEqual([]);
    expect(computeFacts([rec({}), rec({ id: "X-2", period: "current", department: "Other" })], ctx)).toEqual([]);
  });
  it("validateRecords reports unknown metrics, wrong domains and wrong units", () => {
    const r: CoreRecord = { id: "X", metric: "csat", department: "Billing", period: "prior", value: 1, unit: "pts" };
    expect(validateRecords([r, { ...r, id: "Y", metric: "zzz" }], SUPPORT_CATALOG).join("|")).toMatch(/domain Billing.*unit pts.*\|Y: metric zzz/);
  });
  it("describeChange renders without any catalog", () => {
    expect(describeChange({ unit: "USD", prior: 1_240_000, current: 1_018_000, changePct: -17.9, changePp: null })).toBe("$1,240,000 → $1,018,000 (-17.9% relative)");
    expect(describeChange({ unit: "%", prior: 34, current: 21, changePct: -38.2, changePp: -13 })).toBe("34% → 21% (-38.2% relative, -13 pp)");
    expect(describeChange({ unit: "days", prior: 0, current: 2, changePct: null, changePp: null })).toBe("0 days → 2 days (n/a relative)");
  });
  it("the prototype context gives the same facts the engine returns (periods taken from the caller)", () => {
    const sc = SCENARIOS[0]!;
    const viaCore = computeFacts(sc.records, { catalog: PROTOTYPE_CATALOG, periods: PERIODS });
    expect(viaCore.map((x) => x.periodLabel)).toEqual(viaCore.map(() => "Q2 2026 → Q3 2026"));
  });
});
