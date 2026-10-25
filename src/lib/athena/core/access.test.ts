import { describe, expect, it } from "vitest";
import { AuthorizationError, assertAuthorized, authorizeEvidence, isAuthorizedEvidence, isTrustedContext, issueTrustedContext, type AccessPolicy, type EvidenceScope } from "./access";
import type { Evidence } from "./evidence";
import { computeAuthorizedFacts, computeFacts, type AnalysisContext } from "./facts";
import { SUPPORT_CATALOG, SUPPORT_PERIODS } from "./fixtures";

// Authorization is enforced by authorizeEvidence, independent of what a policy or store does. Nothing here involves a UI, a model or a provider.
const ctx: AnalysisContext = { catalog: SUPPORT_CATALOG, periods: SUPPORT_PERIODS };
const ev = (tenantId: string, id: string, over: Partial<Evidence> = {}): Evidence => ({ id, tenantId, source: `SRC-${tenantId}-${id}`, metric: "tickets_opened", department: "Support", period: "prior", date: "2027-01-31", value: 1000, unit: "tickets", ...over });
const pair = (tenantId: string, n: string, metric = "tickets_opened", unit = "tickets", department = "Support"): Evidence[] => [
  ev(tenantId, `${n}-P`, { metric, unit, department, period: "prior", value: 100 }),
  ev(tenantId, `${n}-C`, { metric, unit, department, period: "current", value: 150, date: "2027-02-28" }),
];
/** Policy that grants a given actor a set of record-id prefixes within its own tenant (mixed authority inside one tenant). */
const policyFor = (grants: Record<string, string[]>): AccessPolicy => ({
  evidenceScope: (c) => ({ tenantId: c.tenantId, permits: (e) => (grants[c.actorId] ?? []).some((p) => e.id.startsWith(p)) }),
});
const permitAll: AccessPolicy = { evidenceScope: (c) => ({ tenantId: c.tenantId, permits: () => true }) };

const A = "tenant-a", B = "tenant-b";
const all = [...pair(A, "A1"), ...pair(A, "A2", "csat", "%"), ...pair(B, "B1"), ...pair(B, "B2", "csat", "%")];

describe("trusted context", () => {
  const ok = issueTrustedContext(A, "alice");
  it("is issued only for non-empty, trimmed ids", () => {
    for (const [t, a] of [["", "x"], ["x", ""], [" x", "y"], ["x", "y "], [undefined, "y"], ["x", null], [1, "y"]] as const) expect(() => issueTrustedContext(t as never, a as never)).toThrow(AuthorizationError);
  });
  it("is frozen and recognised", () => {
    expect(isTrustedContext(ok)).toBe(true);
    expect(Object.isFrozen(ok)).toBe(true);
    expect(() => { (ok as { tenantId: string }).tenantId = B; }).toThrow(TypeError);
  });
  it.each([
    ["a plain object with the right fields", () => ({ tenantId: A, actorId: "alice" })],
    ["a spread copy of a real context", () => ({ ...ok })],
    ["a JSON round trip", () => JSON.parse(JSON.stringify(ok))],
    ["an object inheriting from a real context", () => Object.create(ok)],
    ["null", () => null],
    ["a string", () => "tenant-a"],
  ])("a forged context (%s) is refused", (_n, make) => {
    expect(isTrustedContext(make())).toBe(false);
    expect(() => authorizeEvidence(make() as never, permitAll, all)).toThrow(AuthorizationError);
  });
});

describe("tenant isolation does not depend on the policy or the store", () => {
  const alice = issueTrustedContext(A, "alice");
  it("a policy that permits everything still yields only the caller's tenant", () => {
    const r = authorizeEvidence(alice, permitAll, all);
    expect(r.authorized.map((e) => e.id)).toEqual(["A1-P", "A1-C", "A2-P", "A2-C"]);
    expect(r.withheld.map((e) => e.id)).toEqual(["B1-P", "B1-C", "B2-P", "B2-C"]);
    expect(r.authorized.every((e) => e.tenantId === A)).toBe(true);
  });
  it("the other tenant sees only its own records", () => {
    const r = authorizeEvidence(issueTrustedContext(B, "bob"), permitAll, all);
    expect(r.authorized.map((e) => e.id)).toEqual(["B1-P", "B1-C", "B2-P", "B2-C"]);
  });
  it("the same record id in two tenants never crosses", () => {
    const dup = [ev(A, "SAME", { source: "A-SOURCE" }), ev(B, "SAME", { source: "B-SOURCE-SECRET" })];
    const r = authorizeEvidence(alice, permitAll, dup);
    expect(r.authorized.map((e) => e.source)).toEqual(["A-SOURCE"]);
    expect(r.withheld.map((e) => e.source)).toEqual(["B-SOURCE-SECRET"]);
  });
  it("a policy scope for another tenant is refused outright", () => {
    const wrong: AccessPolicy = { evidenceScope: () => ({ tenantId: B, permits: () => true }) };
    expect(() => authorizeEvidence(alice, wrong, all)).toThrow(AuthorizationError);
  });
  it("a missing scope is refused", () => {
    expect(() => authorizeEvidence(alice, { evidenceScope: () => undefined as never }, all)).toThrow(AuthorizationError);
  });
  it("a record's tenant is compared exactly (case, whitespace, prefix, substring)", () => {
    const near = [ev("Tenant-A", "n1"), ev("tenant-a ", "n2"), ev("tenant-", "n3"), ev("tenant-aa", "n4"), ev(A, "ok")];
    const r = authorizeEvidence(alice, permitAll, near);
    expect(r.authorized.map((e) => e.id)).toEqual(["ok"]);
    expect(r.withheld).toHaveLength(4);
  });
});

describe("cross-role access within a tenant (mixed authority)", () => {
  const policy = policyFor({ alice: ["A1"], carol: ["A2"], dave: ["A1", "A2"] });
  const ids = (actor: string) => authorizeEvidence(issueTrustedContext(A, actor), policy, all).authorized.map((e) => e.id);
  it("each actor gets only the records its role grants", () => {
    expect(ids("alice")).toEqual(["A1-P", "A1-C"]);
    expect(ids("carol")).toEqual(["A2-P", "A2-C"]);
    expect(ids("dave")).toEqual(["A1-P", "A1-C", "A2-P", "A2-C"]);
  });
  it("a record the role may not see is withheld, not dropped silently from the server's view", () => {
    const r = authorizeEvidence(issueTrustedContext(A, "alice"), policy, all);
    expect(r.withheld.map((e) => e.id)).toEqual(["A2-P", "A2-C", "B1-P", "B1-C", "B2-P", "B2-C"]);
  });
  it("a role cannot see half of a pair it was not granted: the fact simply does not exist", () => {
    const half: AccessPolicy = { evidenceScope: (c) => ({ tenantId: c.tenantId, permits: (e) => e.id === "A1-P" }) };
    const r = authorizeEvidence(alice(), half, all);
    expect(r.authorized.map((e) => e.id)).toEqual(["A1-P"]);
    expect(computeAuthorizedFacts(r.authorized, ctx)).toEqual([]);
  });
  function alice() { return issueTrustedContext(A, "alice"); }
});

describe("empty scopes and failures fail closed", () => {
  const alice = issueTrustedContext(A, "alice");
  it("an actor with no grants gets nothing; everything is withheld", () => {
    const r = authorizeEvidence(alice, policyFor({}), all);
    expect(r.authorized).toHaveLength(0);
    expect(r.withheld).toHaveLength(all.length);
    expect(computeAuthorizedFacts(r.authorized, ctx)).toEqual([]);
  });
  it("no candidates is an empty, still-branded result", () => {
    const r = authorizeEvidence(alice, permitAll, []);
    expect(r.authorized).toHaveLength(0);
    expect(isAuthorizedEvidence(r.authorized)).toBe(true);
  });
  it.each([
    ["policy throws", { evidenceScope: () => { throw new Error("db password hunter2"); } } as AccessPolicy],
    ["permits throws", { evidenceScope: (c) => ({ tenantId: c.tenantId, permits: () => { throw new Error("secret-id A1-P"); } }) } as AccessPolicy],
  ])("%s -> a generic AuthorizationError that echoes nothing", (_n, policy) => {
    let err: unknown;
    try { authorizeEvidence(alice, policy, all); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(AuthorizationError);
    expect((err as Error).message).toBe("Authorization failed");
    expect(JSON.stringify(err) + String(err)).not.toMatch(/hunter2|secret-id|A1-P|tenant-a/);
  });
  it.each([["a truthy string", "yes"], ["1", 1], ["undefined", undefined], ["null", null], ["an object", {}], ["false", false]])("permits() returning %s denies (only exactly true allows)", (_n, v) => {
    const odd: AccessPolicy = { evidenceScope: (c): EvidenceScope => ({ tenantId: c.tenantId, permits: (() => v) as never }) };
    expect(authorizeEvidence(alice, odd, all).authorized).toHaveLength(0);
  });
  it("malformed candidates are withheld, never authorized", () => {
    const bad = [{ ...ev(A, "x"), id: "" }, { ...ev(A, "y"), tenantId: "" }, { ...ev(A, "z"), tenantId: undefined as never }, null as never, 5 as never, ev(A, "good")];
    const r = authorizeEvidence(alice, permitAll, bad);
    expect(r.authorized.map((e) => e.id)).toEqual(["good"]);
    expect(r.withheld).toHaveLength(5);
  });
});

describe("authorized evidence cannot be forged, copied into, or altered", () => {
  const alice = issueTrustedContext(A, "alice");
  const { authorized, withheld } = authorizeEvidence(alice, permitAll, all);
  it("is frozen, with frozen records, and carries the tenant", () => {
    expect(Object.isFrozen(authorized) && Object.isFrozen(withheld) && authorized.every(Object.isFrozen)).toBe(true);
    expect(authorized.tenantId).toBe(A);
    expect(() => (authorized as unknown as Evidence[]).push(ev(B, "evil"))).toThrow(TypeError);
    expect(() => { (authorized[0] as { tenantId: string }).tenantId = B; }).toThrow(TypeError);
    expect(() => { (authorized as unknown as Evidence[])[0] = ev(B, "evil"); }).toThrow(TypeError);
  });
  it("later changes to the source records do not reach it", () => {
    const src = [ev(A, "live", { value: 1 })];
    const r = authorizeEvidence(alice, permitAll, src);
    (src[0] as { value: number }).value = 999;
    expect(r.authorized[0]!.value).toBe(1);
  });
  it.each([
    ["spread", () => [...authorized]], ["slice", () => authorized.slice()], ["filter", () => authorized.filter(() => true)], ["map", () => authorized.map((e) => e)],
    ["Array.from", () => Array.from(authorized)], ["concat", () => authorized.concat([])], ["Object.assign onto a new array", () => Object.assign([], authorized)],
    ["a hand-built array with the tenant field", () => Object.assign([ev(A, "x")], { tenantId: A })], ["a plain array", () => all], ["the withheld list", () => withheld], ["a JSON round trip", () => JSON.parse(JSON.stringify(authorized))],
    ["null", () => null], ["an object", () => ({ length: 0 })],
  ])("%s is not authorized evidence", (_n, make) => {
    const x = make() as never;
    expect(isAuthorizedEvidence(x)).toBe(false);
    expect(() => assertAuthorized(x)).toThrow(AuthorizationError);
    expect(() => computeAuthorizedFacts(x, ctx)).toThrow(AuthorizationError);
  });
  it("the genuine article is accepted, and computes the same facts as the pure function", () => {
    expect(() => assertAuthorized(authorized)).not.toThrow();
    expect(computeAuthorizedFacts(authorized, ctx)).toEqual(computeFacts(authorized, ctx));
    expect(computeAuthorizedFacts(authorized, ctx).map((f) => f.metric).sort()).toEqual(["csat", "tickets_opened"]);
  });
  it("facts from a different tenant's evidence never appear in this tenant's facts", () => {
    const only = authorizeEvidence(alice, permitAll, [...pair(A, "A1"), ...pair(B, "B9", "refunds", "USD", "Billing")]);
    expect(computeAuthorizedFacts(only.authorized, ctx).map((f) => f.metric)).toEqual(["tickets_opened"]);
  });
});
