import { describe, expect, it } from "vitest";
import { AuthorizationError, createIdentityBoundary, type VerifiedIdentity } from "../identity";
import type { Evidence } from "../evidence";
import { createEvidenceLedger } from "./ledger";
import type { ImportResult } from "./types";
import { GOOD_ROWS, HEADER, MINI_MAPPING, SOURCE, csv, identity, runCsv, trusted } from "./testSupport";

const A = trusted("tenant-a"), B = trusted("tenant-b");
const imp = (ctx = A, ...lines: string[]) => runCsv(csv(HEADER, ...(lines.length ? lines : GOOD_ROWS)), { ctx });
const genuine = (r: ImportResult) => { if (!r.ok) throw new Error("structural"); return r; };

describe("committing imported evidence", () => {
  it("makes it available through the store for the same tenant and dataset, frozen, with provenance", () => {
    const ledger = createEvidenceLedger(identity);
    const r = genuine(imp());
    expect(ledger.commit(A, r, "main")).toEqual({ committed: true, added: 2 });
    const got = ledger.store.candidates(A, "main");
    expect(got).toEqual(r.accepted);
    expect(Object.isFrozen(got) && got.every(Object.isFrozen)).toBe(true);
    expect(ledger.provenanceOf(A, "main", got[0]!.id)).toEqual(r.provenance[got[0]!.id]);
    expect(ledger.batches(A, "main")).toEqual([r.batch]);
  });
  it("nothing is visible before a commit, in another dataset, or to another tenant", () => {
    const ledger = createEvidenceLedger(identity);
    expect(ledger.store.candidates(A, "main")).toEqual([]);
    ledger.commit(A, imp(), "main");
    expect(ledger.store.candidates(A, "other")).toEqual([]);
    expect(ledger.store.candidates(B, "main")).toEqual([]);
    expect(ledger.provenanceOf(B, "main", "test-feed:L2")).toBeUndefined();
    expect(ledger.batches(B, "main")).toEqual([]);
  });
  it("the same bytes imported by two tenants stay two separate bodies of evidence", () => {
    const ledger = createEvidenceLedger(identity);
    ledger.commit(A, imp(A), "main");
    ledger.commit(B, imp(B), "main");
    expect(new Set(ledger.store.candidates(A, "main").map((e) => e.tenantId))).toEqual(new Set(["tenant-a"]));
    expect(new Set(ledger.store.candidates(B, "main").map((e) => e.tenantId))).toEqual(new Set(["tenant-b"]));
  });
  it("rejected rows never reach the ledger (accept_valid keeps only the valid ones)", () => {
    const ledger = createEvidenceLedger(identity);
    const r = genuine(runCsv(csv(HEADER, ...GOOD_ROWS, "cost,Finance,P1,5,EUR", "cost,Finance,P2,6,USD"), { options: { mode: "accept_valid" } }));
    ledger.commit(A, r, "main");
    expect(ledger.store.candidates(A, "main").map((e) => `${e.metric}/${e.period}`)).toEqual(["revenue/prior", "revenue/current", "cost/current"]);
  });
  it("an all-or-nothing rejection commits nothing", () => {
    const ledger = createEvidenceLedger(identity);
    expect(ledger.commit(A, genuine(imp(A, "revenue,Finance,P1,5,EUR")), "main")).toEqual({ committed: false, reason: "not_importable", added: 0 });
    expect(ledger.store.candidates(A, "main")).toEqual([]);
  });
});

describe("only genuine results, under their own tenant, can be committed", () => {
  const ledger = createEvidenceLedger(identity);
  const real = genuine(imp());
  it.each([
    ["a hand-built result", () => ({ ok: true, status: "accepted", batch: real.batch, accepted: real.accepted, rejected: [], provenance: {} })],
    ["a spread copy of a real result", () => ({ ...real })],
    ["a JSON round trip", () => JSON.parse(JSON.stringify(real))],
    ["evidence the caller invented", () => ({ ...real, accepted: [{ ...real.accepted[0]!, tenantId: "tenant-a", value: 1e9 }] })],
    ["a structural failure", () => runCsv("")],
    ["null", () => null],
  ])("%s is refused", (_n, make) => {
    expect(() => ledger.commit(A, make(), "main")).toThrow(AuthorizationError);
    expect(ledger.store.candidates(A, "main")).toEqual([]);
  });
  it("a result imported for tenant A cannot be committed under tenant B", () => {
    expect(() => ledger.commit(B, real, "main")).toThrow(AuthorizationError);
    expect(ledger.store.candidates(B, "main")).toEqual([]);
    expect(ledger.store.candidates(A, "main")).toEqual([]);
  });
  it.each([
    ["a plain object", () => ({ tenantId: "tenant-a", actorId: "importer", assurance: "verified" })],
    ["a copy", () => ({ ...A })],
    ["a context from another identity boundary", () => createIdentityBoundary({ assurance: "verified", verify: (c) => c as VerifiedIdentity | null }).authenticateSync({ tenantId: "tenant-a", actorId: "importer" })],
  ])("%s is refused for every operation", (_n, make) => {
    const bad = make() as never;
    expect(() => ledger.commit(bad, real, "main")).toThrow(AuthorizationError);
    expect(() => ledger.store.candidates(bad, "main")).toThrow(AuthorizationError);
    expect(() => ledger.provenanceOf(bad, "main", "x")).toThrow(AuthorizationError);
    expect(() => ledger.batches(bad, "main")).toThrow(AuthorizationError);
  });
  it.each(["", " ", "has space", "../x", "a".repeat(49), "x;y", "a\u0000b"])("dataset name %j is refused", (d) => {
    expect(() => ledger.commit(A, real, d)).toThrow(AuthorizationError);
    expect(() => ledger.store.candidates(A, d)).toThrow(AuthorizationError);
  });
});

describe("a later import can never silently change a fact", () => {
  it("re-importing the same content is an idempotent no-op", () => {
    const ledger = createEvidenceLedger(identity);
    const r = genuine(imp());
    ledger.commit(A, r, "main");
    expect(ledger.commit(A, genuine(imp()), "main")).toEqual({ committed: false, reason: "already_imported", added: 0 });
    expect(ledger.store.candidates(A, "main")).toHaveLength(2);
    expect(ledger.batches(A, "main")).toHaveLength(1);
  });
  it("a different value for an existing metric and period is a conflict: nothing is added, nothing changes", () => {
    const ledger = createEvidenceLedger(identity);
    ledger.commit(A, imp(), "main");
    const before = JSON.stringify(ledger.store.candidates(A, "main"));
    const out = ledger.commit(A, genuine(imp(A, "revenue,Finance,P1,999,USD", "cost,Finance,P1,5,USD")), "main");
    expect(out).toEqual({ committed: false, reason: "conflicts_with_existing", added: 0 });
    expect(JSON.stringify(ledger.store.candidates(A, "main"))).toBe(before);
    expect(ledger.store.candidates(A, "main").some((e) => e.metric === "cost")).toBe(false); // all or nothing: the new cost row did not slip in
  });
  it("the same fact from another feed is a duplicate, not an update", () => {
    const ledger = createEvidenceLedger(identity);
    ledger.commit(A, imp(), "main");
    const other = genuine(runCsv(csv(HEADER, ...GOOD_ROWS, "cost,Finance,P1,5,USD"), { ctx: A, source: { ...SOURCE, sourceId: "other-feed" } }));
    expect(ledger.commit(A, other, "main")).toEqual({ committed: false, reason: "duplicate_of_existing", added: 0 });
    expect(ledger.store.candidates(A, "main")).toHaveLength(2);
  });
  it("a new fact with an id that is already taken is refused", () => {
    const ledger = createEvidenceLedger(identity);
    ledger.commit(A, imp(), "main");
    const clash = genuine(runCsv(csv(HEADER, "cost,Finance,P1,5,USD", "cost,Finance,P2,6,USD"), { ctx: A })); // generated ids test-feed:L2, L3 again
    expect(ledger.commit(A, clash, "main")).toEqual({ committed: false, reason: "duplicate_id", added: 0 });
  });
  it("new, non-overlapping evidence is added alongside what is there", () => {
    const ledger = createEvidenceLedger(identity);
    ledger.commit(A, imp(), "main");
    const more = genuine(runCsv(csv(HEADER, "cost,Finance,P1,5,USD", "cost,Finance,P2,6,USD"), { ctx: A, source: { ...SOURCE, sourceId: "costs" } }));
    expect(ledger.commit(A, more, "main")).toEqual({ committed: true, added: 2 });
    expect(ledger.store.candidates(A, "main").map((e) => e.metric)).toEqual(["revenue", "revenue", "cost", "cost"]);
  });
  it("another tenant's identical facts never count as duplicates or conflicts", () => {
    const ledger = createEvidenceLedger(identity);
    ledger.commit(A, imp(A), "main");
    expect(ledger.commit(B, imp(B, "revenue,Finance,P1,999,USD", "revenue,Finance,P2,1,USD"), "main")).toEqual({ committed: true, added: 2 });
    expect(ledger.store.candidates(A, "main").map((e) => e.value)).toEqual([100, 120]);
  });
  it("datasets are independent for one tenant", () => {
    const ledger = createEvidenceLedger(identity);
    ledger.commit(A, imp(), "d1");
    expect(ledger.commit(A, imp(A, "revenue,Finance,P1,7,USD", "revenue,Finance,P2,8,USD"), "d2")).toMatchObject({ committed: true });
    expect(ledger.store.candidates(A, "d1").map((e) => e.value)).toEqual([100, 120]);
    expect(ledger.store.candidates(A, "d2").map((e) => e.value)).toEqual([7, 8]);
  });
  it("what the store returns cannot be used to alter the ledger", () => {
    const ledger = createEvidenceLedger(identity);
    ledger.commit(A, imp(), "main");
    const got = ledger.store.candidates(A, "main") as Evidence[];
    expect(() => got.push(got[0]!)).toThrow(TypeError);
    expect(() => { (got[0] as { value: number }).value = 0; }).toThrow(TypeError);
    expect(ledger.store.candidates(A, "main")[0]!.value).toBe(100);
  });
});

describe("the mapping's periods are the only periods", () => {
  it("evidence dates come from the mapping, not the data", () => {
    const r = genuine(imp());
    expect(r.accepted.map((e) => e.date)).toEqual([MINI_MAPPING.periods.prior.end, MINI_MAPPING.periods.current.end]);
  });
});
