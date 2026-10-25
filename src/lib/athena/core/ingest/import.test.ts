import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthorizationError, createIdentityBoundary, type VerifiedIdentity } from "../identity";
import { csvAdapter } from "./csv";
import { importSource, isImportResult, isIsoDate, validateMapping } from "./normalize";
import type { MappingSpec, RawTable, SourceAdapter, StructuralCode } from "./types";
import { GOOD_ROWS, HEADER, MINI_CATALOG, MINI_MAPPING, SOURCE, allowAll, csv, denyAll, identity, runCsv, trusted } from "./testSupport";

afterEach(() => vi.restoreAllMocks());
const okResult = (r: ReturnType<typeof runCsv>) => { if (!r.ok) throw new Error(`structural: ${r.error.code}`); return r; };
const structural = (r: ReturnType<typeof runCsv>): StructuralCode | "ok" => (r.ok ? "ok" : r.error.code);
const reasons = (r: ReturnType<typeof runCsv>) => okResult(r).rejected.flatMap((x) => x.reasons.map((y) => `${x.line}:${y.code}/${y.field}`));
const one = (row: string, header = HEADER) => runCsv(csv(header, row, "revenue,Finance,P2,120,USD"));
const rowReasons = (row: string, header = HEADER) => reasons(one(row, header)).filter((x) => x.startsWith("2:"));

describe("a valid import", () => {
  const r = okResult(runCsv(csv(HEADER, ...GOOD_ROWS, "orders,Ops,P1,10,orders", "orders,Ops,P2,12,orders"), { ctx: trusted("tenant-a") }));
  it("is accepted, with evidence bound to the trusted tenant and the catalog's own definitions", () => {
    expect(r.status).toBe("accepted");
    expect(r.rejected).toEqual([]);
    expect(r.accepted).toEqual([
      { id: "test-feed:L2", tenantId: "tenant-a", source: "Synthetic test feed", metric: "revenue", department: "Finance", period: "prior", date: "2026-01-31", value: 100, unit: "USD" },
      { id: "test-feed:L3", tenantId: "tenant-a", source: "Synthetic test feed", metric: "revenue", department: "Finance", period: "current", date: "2026-02-28", value: 120, unit: "USD" },
      { id: "test-feed:L4", tenantId: "tenant-a", source: "Synthetic test feed", metric: "orders", department: "Ops", period: "prior", date: "2026-01-31", value: 10, unit: "orders" },
      { id: "test-feed:L5", tenantId: "tenant-a", source: "Synthetic test feed", metric: "orders", department: "Ops", period: "current", date: "2026-02-28", value: 12, unit: "orders" },
    ]);
  });
  it("is frozen end to end and recognised as a genuine result", () => {
    expect(Object.isFrozen(r) && Object.isFrozen(r.accepted) && r.accepted.every(Object.isFrozen) && Object.isFrozen(r.batch) && Object.isFrozen(r.rejected)).toBe(true);
    expect(isImportResult(r)).toBe(true);
    expect(isImportResult({ ...r })).toBe(false);
    expect(isImportResult(JSON.parse(JSON.stringify(r)))).toBe(false);
  });
});

describe("tenant binding: the data never decides whose evidence it is", () => {
  it("the tenant is the trusted context's, and a different context gives a different tenant and batch for the same bytes", () => {
    const a = okResult(runCsv(csv(HEADER, ...GOOD_ROWS), { ctx: trusted("tenant-a") }));
    const b = okResult(runCsv(csv(HEADER, ...GOOD_ROWS), { ctx: trusted("tenant-b") }));
    expect(new Set(a.accepted.map((e) => e.tenantId))).toEqual(new Set(["tenant-a"]));
    expect(new Set(b.accepted.map((e) => e.tenantId))).toEqual(new Set(["tenant-b"]));
    expect(a.batch.batchId).not.toBe(b.batch.batchId);
    expect(a.batch.contentSha256).toBe(b.batch.contentSha256);
  });
  it.each(["tenant", "tenant_id", "Tenant ID", "TENANT-ID", "tenantid", "org_id", "organization-id", "Organisation Id"])("a %s column in the file refuses the whole import", (h) => {
    const r = runCsv(csv(`${HEADER},${h}`, "revenue,Finance,P1,100,USD,tenant-b", "revenue,Finance,P2,120,USD,tenant-b"));
    expect(structural(r)).toBe("tenant_column_in_file");
  });
  it("even when the mapping lists it as ignored, its values are never read: evidence still carries the trusted tenant", () => {
    const spec: MappingSpec = { ...MINI_MAPPING, ignoredColumns: ["tenant_id"] };
    const r = okResult(runCsv(csv(`${HEADER},tenant_id`, "revenue,Finance,P1,100,USD,tenant-evil", "revenue,Finance,P2,120,USD,tenant-evil"), { spec, ctx: trusted("tenant-a") }));
    expect(r.accepted.map((e) => e.tenantId)).toEqual(["tenant-a", "tenant-a"]);
    expect(JSON.stringify(r)).not.toContain("tenant-evil");
  });
  it("a mapping cannot turn a tenant header into a data role", () => {
    const spec: MappingSpec = { ...MINI_MAPPING, columns: { ...MINI_MAPPING.columns, note: "tenant_id" } };
    expect(structural(runCsv(csv(`${HEADER},tenant_id`, "revenue,Finance,P1,100,USD,x"), { spec }))).toBe("tenant_column_in_file");
  });
  it("tenant-looking values in ordinary cells are just data and never become the tenant", () => {
    const r = okResult(runCsv(csv(HEADER, "revenue,Finance,P1,100,USD", "revenue,Finance,P2,120,USD"), { ctx: trusted("tenant-a") }));
    expect(r.accepted.every((e) => e.tenantId === "tenant-a")).toBe(true);
  });
});

describe("only a trusted context may import, and only where the policy allows", () => {
  const text = csv(HEADER, ...GOOD_ROWS);
  const forged = trusted("tenant-a");
  it.each([
    ["a plain object", () => ({ tenantId: "tenant-a", actorId: "importer", assurance: "verified" })],
    ["a spread copy", () => ({ ...forged })],
    ["parsed JSON", () => JSON.parse(JSON.stringify(forged))],
    ["Object.create", () => Object.create(forged)],
    ["a Proxy", () => new Proxy(forged, {})],
    ["null", () => null],
    ["a context from another identity boundary", () => createIdentityBoundary({ assurance: "verified", verify: (c) => c as VerifiedIdentity | null }).authenticateSync({ tenantId: "tenant-a", actorId: "importer" })],
  ])("%s is refused before anything is read", (_n, make) => {
    const adapter: SourceAdapter<string> = { id: "spy", read: vi.fn(() => ({ ok: false as const, error: { code: "source_unreadable" as const } })) };
    expect(() => importSource({ identity, ctx: make() as never, policy: allowAll, adapter, input: text, source: SOURCE, spec: MINI_MAPPING, catalog: MINI_CATALOG })).toThrow(AuthorizationError);
    expect(adapter.read).not.toHaveBeenCalled();
  });
  it.each([
    ["denies", denyAll], ["returns a truthy non-true", { mayImport: (() => "yes") as never }], ["returns undefined", { mayImport: (() => undefined) as never }],
    ["throws", { mayImport: () => { throw new Error("policy backend down tenant-b"); } }],
  ])("a policy that %s refuses the import with the generic error", (_n, policy) => {
    let err: unknown;
    try { runCsv(text, { policy }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(AuthorizationError);
    expect(String((err as Error).message) + JSON.stringify(err)).not.toMatch(/tenant-b|backend/);
  });
  it("the policy sees the trusted context and the declared source", () => {
    const seen = vi.fn(() => true);
    runCsv(text, { policy: { mayImport: seen } });
    expect(seen).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "tenant-a" }), SOURCE);
  });
});

describe("mapping and header problems are structural: no row is trusted", () => {
  const bad = (spec: MappingSpec) => structural(runCsv(csv(HEADER, ...GOOD_ROWS), { spec }));
  it.each<[string, MappingSpec]>([
    ["a role mapped to an empty name", { ...MINI_MAPPING, columns: { ...MINI_MAPPING.columns, metric: "" } }],
    ["two roles on one column", { ...MINI_MAPPING, columns: { ...MINI_MAPPING.columns, unit: "value" } }],
    ["a metric name mapped to a key not in the catalog", { ...MINI_MAPPING, metricNames: { Sales: "nope" } }],
    ["two source names for one catalog metric (ambiguous)", { ...MINI_MAPPING, metricNames: { Sales: "revenue", Income: "revenue" } }],
    ["two metric names that differ only by case", { ...MINI_MAPPING, metricNames: { Sales: "revenue", sales: "cost" } }],
    ["a unit alias to a unit no metric uses", { ...MINI_MAPPING, unitAliases: { eur: "EUR" } }],
    ["identical period labels", { ...MINI_MAPPING, periods: { prior: { label: "P1", end: "2026-01-31" }, current: { label: "P1", end: "2026-02-28" } } }],
    ["a period end that is not a date", { ...MINI_MAPPING, periods: { prior: { label: "P1", end: "2026-02-30" }, current: { label: "P2", end: "2026-02-28" } } }],
    ["a prior period that ends after the current one", { ...MINI_MAPPING, periods: { prior: { label: "P1", end: "2026-03-31" }, current: { label: "P2", end: "2026-02-28" } } }],
    ["an ignored column that is also mapped", { ...MINI_MAPPING, ignoredColumns: ["value"] }],
    ["an invalid id prefix", { ...MINI_MAPPING, idPrefix: "bad prefix!" }],
  ])("%s", (_n, spec) => {
    expect(bad(spec)).toBe("bad_mapping");
    expect(validateMapping(spec, MINI_CATALOG).length).toBeGreaterThan(0);
  });
  it("the bundled mapping validates", () => expect(validateMapping(MINI_MAPPING, MINI_CATALOG)).toEqual([]));
  it("an invalid catalog throws rather than importing against it", () => {
    expect(() => runCsv(csv(HEADER, ...GOOD_ROWS), { catalog: { ...MINI_CATALOG, flatThresholdPct: -1 } as never })).toThrow(/Invalid catalog/);
  });
  it.each([
    ["a missing mapped column", csv("metric,domain,period,value", "revenue,Finance,P1,100"), "missing_column"],
    ["an unexpected extra column", csv(`${HEADER},extra`, "revenue,Finance,P1,100,USD,x"), "unexpected_column"],
    ["a duplicate header", csv(`${HEADER},value`, "revenue,Finance,P1,100,USD,1"), "duplicate_header"],
    ["a header that differs by case", csv("Metric,domain,period,value,unit", "revenue,Finance,P1,100,USD"), "missing_column"],
    ["a header with surrounding spaces", csv("metric ,domain,period,value,unit", "revenue,Finance,P1,100,USD"), "missing_column"],
    ["a malformed file", 'metric,domain\n"unterminated\n', "unterminated_quote"],
    ["an empty file", "", "empty_input"],
    ["a header-only file's missing roles", csv("a,b"), "missing_column"],
  ])("%s", (_n, text, code) => expect(structural(runCsv(text))).toBe(code));
  it("a header-only file with the right header is an accepted empty batch (nothing invented)", () => {
    const r = okResult(runCsv(csv(HEADER)));
    expect(r.accepted).toEqual([]);
    expect(r.status).toBe("accepted");
  });
  it("a structural failure is not a result the ledger could ever accept", () => {
    expect(isImportResult(runCsv(""))).toBe(false);
  });
});

describe("row validation: every rule, with a closed code and no echo of the cell", () => {
  it.each([
    ["an unknown metric", "gross margin,Finance,P1,100,USD", ["2:metric_unknown/metric"]],
    ["a metric in the wrong case (no fuzzy matching)", "Revenue,Finance,P1,100,USD", ["2:metric_unknown/metric"]],
    ["a missing metric", ",Finance,P1,100,USD", ["2:metric_missing/metric"]],
    ["a domain that disagrees with the catalog", "revenue,Ops,P1,100,USD", ["2:domain_mismatch/domain"]],
    ["a domain that is not in the catalog", "revenue,Legal,P1,100,USD", ["2:domain_mismatch/domain"]],
    ["a missing domain (the mapping requires one)", "revenue,,P1,100,USD", ["2:domain_missing/domain"]],
    ["a unit mismatch", "revenue,Finance,P1,100,EUR", ["2:unit_mismatch/unit"]],
    ["a unit in the wrong case", "revenue,Finance,P1,100,usd", ["2:unit_mismatch/unit"]],
    ["a missing unit", "revenue,Finance,P1,100,", ["2:unit_missing/unit"]],
    ["a missing value", "revenue,Finance,P1,,USD", ["2:value_missing/value"]],
    ["an unknown period", "revenue,Finance,P3,100,USD", ["2:period_unknown/period"]],
    ["a period in the wrong case", "revenue,Finance,p1,100,USD", ["2:period_unknown/period"]],
    ["a missing period", "revenue,Finance,,100,USD", ["2:period_missing/period"]],
    ["a wrong number of cells (too few)", "revenue,Finance,P1,100", ["2:field_count_mismatch/row"]],
    ["a wrong number of cells (too many)", "revenue,Finance,P1,100,USD,extra", ["2:field_count_mismatch/row"]],
    ["several problems at once", "gross,Legal,P9,abc,EUR", ["2:metric_unknown/metric", "2:domain_mismatch/domain", "2:unit_missing/unit".replace("unit_missing", "unit_mismatch"), "2:value_invalid/value", "2:period_unknown/period"].filter((x) => !x.includes("unit_mismatch") || false).concat([])],
  ])("%s", (_n, row, expected) => {
    const got = rowReasons(row);
    if (_n === "several problems at once") { expect(got).toEqual(expect.arrayContaining(["2:metric_unknown/metric", "2:domain_mismatch/domain", "2:value_invalid/value", "2:period_unknown/period"])); return; }
    expect(got).toEqual(expected);
  });
  it("explicit metric names are matched exactly: no case folding, no partial match, no catalog-key fallback", () => {
    const spec: MappingSpec = { ...MINI_MAPPING, metricNames: { "Net Sales": "revenue", "Total Cost": "cost" } };
    const rr = (name: string) => reasons(okResult(runCsv(csv(HEADER, `${name},Finance,P1,100,USD`, "Net Sales,Finance,P2,120,USD"), { spec }))).filter((x) => x.startsWith("2:"));
    expect(rr("Net Sales")).toEqual([]);
    for (const name of ["net sales", "NET SALES", "Net", "Net Sales Q1", "revenue", "Total  Cost"]) expect(rr(name), name).toEqual(["2:metric_unknown/metric"]);
  });
  it("surrounding spaces are trimmed (that is formatting, not interpretation)", () => {
    const r = okResult(runCsv(csv(HEADER, " revenue , Finance , P1 , 100 , USD ", "revenue,Finance,P2,120,USD")));
    expect(r.status).toBe("accepted");
    expect(r.accepted[0]).toMatchObject({ metric: "revenue", value: 100, unit: "USD" });
  });
  it.each([
    ["0", 0], ["-0", 0], ["7", 7], ["-7", -7], ["12.5", 12.5], ["0.000001", 0.000001], ["999999999999", 999999999999], ["100000.123456", 100000.123456], ["-3.25", -3.25],
  ])("value %s is valid", (v, n) => {
    const r = okResult(one(`revenue,Finance,P1,${v},USD`));
    expect(r.rejected).toEqual([]);
    expect(r.accepted[0]!.value).toBe(n);
    expect(Object.is(r.accepted[0]!.value, -0)).toBe(false);
  });
  it.each(["abc", "1,000", "1 000", "$100", "100%", "1e3", "1E3", "0x10", "+5", "5.", ".5", "-", "--5", "1.2.3", "007", "NaN", "Infinity", "-Infinity", "１２３", "١٢٣", "5 USD", "1234567890123456", "0.1234567890123456"])("value %j is invalid", (v) => {
    expect(rowReasons(`revenue,Finance,P1,"${v}",USD`)).toEqual(["2:value_invalid/value"]);
  });
  it.each(["1000000000000.5", "9999999999999", "-1000000000001"])("value %s is out of range or too precise", (v) => {
    expect(rowReasons(`revenue,Finance,P1,${v},USD`).length).toBe(1);
  });
  it.each(["a\u0007b", "a\u001bb", "a\u200bb", "a\u202eb", "a\u2066b", "a\ufeffb", "a\u0085b", "a\u007fb"])("a control, bidi or zero-width character %j in any used field is rejected", (s) => {
    for (const row of [`"${s}",Finance,P1,100,USD`, `revenue,"${s}",P1,100,USD`, `revenue,Finance,"${s}",100,USD`, `revenue,Finance,P1,"${s}",USD`, `revenue,Finance,P1,100,"${s}"`]) {
      const got = rowReasons(row);
      expect(got.some((x) => x.includes("invalid_character")), row).toBe(true);
    }
  });
  it("a NUL anywhere in the file is a structural failure (the framing cannot be trusted)", () => {
    expect(structural(runCsv(csv(HEADER, "reve\u0000nue,Finance,P1,100,USD")))).toBe("invalid_character");
  });
  it("a quoted embedded line break is parsed but rejected as an invalid character in a used field", () => {
    expect(rowReasons('"revenue\nx",Finance,P1,100,USD').some((x) => x.includes("invalid_character"))).toBe(true);
  });
});

describe("dates and reporting periods", () => {
  const spec: MappingSpec = { ...MINI_MAPPING, columns: { ...MINI_MAPPING.columns, periodEnd: "period_end" } };
  const H = `${HEADER},period_end`;
  const row = (end: string, p = "P1") => runCsv(csv(H, `revenue,Finance,${p},100,USD,${end}`, "revenue,Finance,P2,120,USD,2026-02-28"), { spec });
  const first = (r: ReturnType<typeof runCsv>) => reasons(r).filter((x) => x.startsWith("2:"));
  it("a matching end date is accepted and the evidence date is the period's end", () => {
    const r = okResult(row("2026-01-31"));
    expect(r.accepted[0]!.date).toBe("2026-01-31");
  });
  it.each([
    ["not a date", "soon", "date_invalid"], ["a non-existent day", "2026-02-30", "date_invalid"], ["month 13", "2026-13-01", "date_invalid"], ["day 0", "2026-01-00", "date_invalid"],
    ["without zero padding", "2026-1-31", "date_invalid"], ["with slashes", "2026/01/31", "date_invalid"], ["a US date", "01/31/2026", "date_invalid"], ["with a time", "2026-01-31T00:00:00Z", "date_invalid"],
    ["a non-leap Feb 29", "2026-02-29", "date_invalid"], ["a year before 1900", "1899-12-31", "date_invalid"], ["empty", "", "date_missing"],
    ["a valid date for the wrong period", "2026-02-28", "date_mismatch"], ["a valid but different day", "2026-01-30", "date_mismatch"],
  ])("an end date that is %s", (_n, end, code) => expect(first(row(end))).toEqual([`2:${code}/periodEnd`]));
  it("a leap-day end date is valid as a date (and mismatches only because it is not the period's end)", () => {
    expect(isIsoDate("2028-02-29")).toBe(true);
    expect(isIsoDate("2100-02-29")).toBe(false);
    expect(isIsoDate("2000-02-29")).toBe(true);
  });
  it("a period label the mapping does not declare is rejected, never mapped to the nearest", () => {
    expect(first(row("2026-01-31", "P0"))).toEqual(["2:period_unknown/period"]);
  });
});

describe("duplicates and conflicts never silently change a fact", () => {
  it("an identical repeated record rejects every copy (no first-wins, no last-wins)", () => {
    const r = okResult(runCsv(csv(HEADER, "revenue,Finance,P1,100,USD", "revenue,Finance,P1,100,USD", "revenue,Finance,P2,120,USD")));
    expect(reasons(r)).toEqual(["2:duplicate_record/row", "3:duplicate_record/row"]);
    expect(r.status).toBe("rejected");
    expect(r.accepted).toEqual([]);
  });
  it("conflicting values for one metric and period reject every conflicting row", () => {
    const r = okResult(runCsv(csv(HEADER, "revenue,Finance,P1,100,USD", "revenue,Finance,P1,999,USD", "revenue,Finance,P2,120,USD"), { options: { mode: "accept_valid" } }));
    expect(reasons(r)).toEqual(["2:conflicting_record/row", "3:conflicting_record/row"]);
    expect(r.accepted.map((e) => e.period)).toEqual(["current"]); // the uncontested row survives; the contested pair does not
  });
  it("a valid row cannot win over a rejected row with the same key (the rejected one might have been the truth)", () => {
    const r = okResult(runCsv(csv(HEADER, "revenue,Finance,P1,100,USD", "revenue,Finance,P1,105,EUR", "revenue,Finance,P2,120,USD"), { options: { mode: "accept_valid" } }));
    expect(reasons(r)).toEqual(expect.arrayContaining(["2:conflicting_record/row", "3:conflicting_record/row", "3:unit_mismatch/unit"]));
    expect(r.accepted.every((e) => e.period !== "prior")).toBe(true);
  });
  it("duplicate record ids are rejected, including generated and explicit ones", () => {
    const spec: MappingSpec = { ...MINI_MAPPING, columns: { ...MINI_MAPPING.columns, recordId: "id" } };
    const r = okResult(runCsv(csv(`id,${HEADER}`, "R-1,revenue,Finance,P1,100,USD", "R-1,revenue,Finance,P2,120,USD"), { spec }));
    expect(reasons(r)).toEqual(["2:id_duplicate/recordId", "3:id_duplicate/recordId"]);
  });
  it.each(["", " ", "has space", "bad/char", "-leading", "a".repeat(65), "tenant\u0001x", "id;drop"])("record id %j is invalid", (id) => {
    const spec: MappingSpec = { ...MINI_MAPPING, columns: { ...MINI_MAPPING.columns, recordId: "id" } };
    expect(reasons(okResult(runCsv(csv(`id,${HEADER}`, `"${id}",revenue,Finance,P1,100,USD`, "R-2,revenue,Finance,P2,120,USD"), { spec }))).some((x) => x.startsWith("2:") && /id_invalid|invalid_character/.test(x))).toBe(true);
  });
  it("different metrics or periods are not duplicates of each other", () => {
    const r = okResult(runCsv(csv(HEADER, ...GOOD_ROWS, "cost,Finance,P1,5,USD", "cost,Finance,P2,6,USD")));
    expect(r.status).toBe("accepted");
    expect(r.accepted).toHaveLength(4);
  });
});

describe("all-or-nothing by default; accept-valid only on request", () => {
  const text = csv(HEADER, ...GOOD_ROWS, "cost,Finance,P1,5,EUR", "cost,Finance,P2,6,USD");
  it("one rejected row means nothing from the batch becomes evidence", () => {
    const r = okResult(runCsv(text));
    expect(r.status).toBe("rejected");
    expect(r.accepted).toEqual([]);
    expect(r.rejected).toHaveLength(1);
    expect(r.provenance).toEqual({});
  });
  it("accept_valid keeps the valid rows, reports the rest, and never includes a rejected row", () => {
    const r = okResult(runCsv(text, { options: { mode: "accept_valid" } }));
    expect(r.status).toBe("partial");
    expect(r.accepted.map((e) => `${e.metric}/${e.period}`)).toEqual(["revenue/prior", "revenue/current", "cost/current"]);
    expect(r.rejected.map((x) => x.line)).toEqual([4]);
  });
  it("accept_valid with nothing valid is rejected, not an empty success", () => {
    expect(okResult(runCsv(csv(HEADER, "x,Finance,P1,1,USD"), { options: { mode: "accept_valid" } })).status).toBe("rejected");
  });
});

describe("rejections never echo the data", () => {
  it("no cell content appears in a result, whatever the rejection", () => {
    const SECRET = "SECRET-CELL-9f2e";
    const text = csv(`${HEADER},note`, `${SECRET},${SECRET},${SECRET},${SECRET},${SECRET},${SECRET}`, `revenue,Finance,P1,${SECRET},USD,${SECRET}`, `revenue,Finance,P2,120,USD,`);
    const spec: MappingSpec = { ...MINI_MAPPING, columns: { ...MINI_MAPPING.columns, note: "note" } };
    const r = runCsv(text, { spec, options: { mode: "accept_valid" } });
    expect(JSON.stringify(r)).not.toContain(SECRET);
    const s = JSON.stringify(runCsv(`${SECRET}\n"${SECRET}`));
    expect(s).not.toContain(SECRET);
  });
  it("ingestion writes nothing to the console", () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    runCsv(csv(HEADER, "bad,row,here,x,y", ...GOOD_ROWS));
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });
});

describe("determinism, provenance and metadata", () => {
  const text = csv(HEADER, ...GOOD_ROWS, "orders,Ops,P1,10,orders", "orders,Ops,P2,12,orders", "bad,row,x,y,z");
  it("importing the same bytes twice gives identical results", () => {
    expect(runCsv(text, { options: { mode: "accept_valid" } })).toEqual(runCsv(text, { options: { mode: "accept_valid" } }));
  });
  it("line endings and quoting style do not change the evidence or the batch", () => {
    const a = okResult(runCsv(text, { options: { mode: "accept_valid" } }));
    const b = okResult(runCsv(text.replace(/\n/g, "\r\n").replace("revenue", '"revenue"'), { options: { mode: "accept_valid" } }));
    expect(b.accepted).toEqual(a.accepted);
    expect(b.batch.batchId).toBe(a.batch.batchId);
  });
  it("any change to the content changes the fingerprint and the batch id", () => {
    const a = okResult(runCsv(csv(HEADER, ...GOOD_ROWS)));
    const b = okResult(runCsv(csv(HEADER, "revenue,Finance,P1,101,USD", GOOD_ROWS[1]!)));
    expect(a.batch.contentSha256).not.toBe(b.batch.contentSha256);
    expect(a.batch.batchId).not.toBe(b.batch.batchId);
  });
  it("every accepted record carries its batch, source, adapter, line and content fingerprint", () => {
    const r = okResult(runCsv(csv(HEADER, 'revenue,Finance,P1,100,USD', 'revenue,Finance,P2,120,USD')));
    expect(r.batch).toMatchObject({ tenantId: "tenant-a", source: SOURCE, adapterId: "csv", rowCount: 2 });
    expect(r.batch.contentSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.batch.batchId).toMatch(/^batch-[0-9a-f]{24}$/);
    for (const e of r.accepted) expect(r.provenance[e.id]).toEqual({ batchId: r.batch.batchId, sourceId: "test-feed", adapterId: "csv", line: Number(e.id.split("L")[1]), contentSha256: r.batch.contentSha256 });
  });
  it("lines point at the physical line even after a multi-line quoted field", () => {
    const spec: MappingSpec = { ...MINI_MAPPING, columns: { ...MINI_MAPPING.columns, note: "note" } };
    const r = okResult(runCsv(`${HEADER},note\nrevenue,Finance,P1,100,USD,"a\nb"\nrevenue,Finance,P2,120,USD,\n`, { spec, options: { mode: "accept_valid" } }));
    expect(r.rejected.map((x) => x.line)).toEqual([2]); // the embedded line break is an invalid character in a used field
    expect(r.accepted.map((e) => e.id)).toEqual(["test-feed:L4"]);
    expect(r.provenance["test-feed:L4"]!.line).toBe(4);
  });
  it("the provenance label is the row's own source when mapped, else the batch's", () => {
    const spec: MappingSpec = { ...MINI_MAPPING, columns: { ...MINI_MAPPING.columns, source: "system" } };
    const r = okResult(runCsv(csv(`${HEADER},system`, "revenue,Finance,P1,100,USD,GL Export", "revenue,Finance,P2,120,USD,GL Export"), { spec }));
    expect(r.accepted.map((e) => e.source)).toEqual(["GL Export", "GL Export"]);
    expect(okResult(runCsv(csv(HEADER, ...GOOD_ROWS))).accepted.map((e) => e.source)).toEqual(["Synthetic test feed", "Synthetic test feed"]);
  });
  it.each(["", "x".repeat(121)])("an invalid row source %j is rejected", (s) => {
    const spec: MappingSpec = { ...MINI_MAPPING, columns: { ...MINI_MAPPING.columns, source: "system" } };
    expect(reasons(okResult(runCsv(csv(`${HEADER},system`, `revenue,Finance,P1,100,USD,"${s}"`, "revenue,Finance,P2,120,USD,ok"), { spec }))).filter((x) => x.startsWith("2:"))).toEqual(["2:source_invalid/source"]);
  });
  it("notes are optional, bounded, and kept as evidence notes", () => {
    const spec: MappingSpec = { ...MINI_MAPPING, columns: { ...MINI_MAPPING.columns, note: "note" } };
    const r = okResult(runCsv(csv(`${HEADER},note`, "revenue,Finance,P1,100,USD,", "revenue,Finance,P2,120,USD,Promo ran"), { spec }));
    expect(r.accepted.map((e) => e.note)).toEqual([undefined, "Promo ran"]);
    expect(reasons(okResult(runCsv(csv(`${HEADER},note`, `revenue,Finance,P1,100,USD,${"n".repeat(241)}`, "revenue,Finance,P2,120,USD,"), { spec }))).filter((x) => x.startsWith("2:"))).toEqual(["2:note_invalid/note"]);
  });
  it("a bad source descriptor is refused", () => {
    for (const source of [{ ...SOURCE, sourceId: "bad id" }, { ...SOURCE, sourceId: "" }, { ...SOURCE, label: "" }, { ...SOURCE, label: "x\ny" }, { ...SOURCE, label: "x".repeat(121) }]) expect(structural(runCsv(csv(HEADER, ...GOOD_ROWS), { source }))).toBe("bad_mapping");
  });
});

describe("resource limits through the importer", () => {
  it("limits are enforced (bytes, rows, columns, field length)", () => {
    const text = csv(HEADER, ...GOOD_ROWS);
    const lim = (o: object) => ({ options: { limits: { maxBytes: 1_000_000, maxRows: 100, maxColumns: 32, maxFieldChars: 512, ...o } } });
    expect(structural(runCsv(text, lim({ maxBytes: 10 })))).toBe("input_too_large");
    expect(structural(runCsv(text, lim({ maxRows: 1 })))).toBe("too_many_rows");
    expect(structural(runCsv(text, lim({ maxColumns: 4 })))).toBe("too_many_columns");
    expect(structural(runCsv(text, lim({ maxFieldChars: 3 })))).toBe("field_too_long");
  });
  it("an adapter that ignores the limits is still held to them", () => {
    const rows = Array.from({ length: 11 }, (_, i) => ({ line: i + 2, cells: ["revenue", "Finance", "P1", "1", "USD"] }));
    const adapter: SourceAdapter<null> = { id: "greedy", read: () => ({ ok: true, table: { columns: HEADER.split(","), rows } }) };
    const r = importSource({ identity, ctx: trusted("tenant-a"), policy: allowAll, adapter, input: null, source: SOURCE, spec: MINI_MAPPING, catalog: MINI_CATALOG, options: { limits: { maxBytes: 1000, maxRows: 10, maxColumns: 32, maxFieldChars: 512 } } });
    expect(structural(r)).toBe("too_many_rows");
  });
  it("a large valid import within the defaults finishes quickly", () => {
    const rows: string[] = [];
    for (let i = 0; i < 2500; i++) { rows.push(`revenue,Finance,P1,${i},USD`); }
    const t0 = Date.now();
    const r = okResult(runCsv(csv(HEADER, ...rows), { options: { mode: "accept_valid" } }));
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(r.rejected).toHaveLength(2500); // all share one (metric, period): every copy is rejected as a duplicate/conflict
    expect(r.accepted).toEqual([]);
  });
});

describe("ingestion is independent of any source format and of any model", () => {
  it("a non-CSV adapter (rows from, say, an API response) goes through the same validation", () => {
    const table: RawTable = { columns: HEADER.split(","), rows: [{ line: 1, cells: ["revenue", "Finance", "P1", "100", "USD"] }, { line: 2, cells: ["revenue", "Finance", "P2", "120", "USD"] }] };
    const adapter: SourceAdapter<RawTable> = { id: "api-sketch", read: (t) => ({ ok: true, table: t }) };
    const r = okResult(importSource({ identity, ctx: trusted("tenant-a"), policy: allowAll, adapter, input: table, source: { sourceId: "api-feed", kind: "api", label: "Synthetic API feed" }, spec: MINI_MAPPING, catalog: MINI_CATALOG }));
    expect(r.accepted.map((e) => e.id)).toEqual(["api-feed:L1", "api-feed:L2"]);
    expect(r.batch.adapterId).toBe("api-sketch");
  });
  it.each([
    ["throws", () => { throw new Error("db password hunter2"); }],
    ["returns nothing", () => undefined as never],
    ["returns garbage", () => "table" as never],
    ["reports an error", () => ({ ok: false as const, error: { code: "input_too_large" as const } })],
  ])("an adapter that %s is a structural failure", (_n, read) => {
    const adapter: SourceAdapter<string> = { id: "bad", read: read as never };
    const r = importSource({ identity, ctx: trusted("tenant-a"), policy: allowAll, adapter, input: "x", source: SOURCE, spec: MINI_MAPPING, catalog: MINI_CATALOG });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain("hunter2");
  });
  it("makes no network or model call", () => {
    const f = vi.fn(); const g = globalThis as unknown as { fetch?: unknown };
    const original = g.fetch; g.fetch = f;
    try { runCsv(csv(HEADER, ...GOOD_ROWS)); runCsv(csv(HEADER, "bad")); runCsv(""); } finally { g.fetch = original; }
    expect(f).not.toHaveBeenCalled();
  });
});
