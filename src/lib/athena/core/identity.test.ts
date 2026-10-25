import { describe, expect, it, vi } from "vitest";
import { AuthorizationError, authorizeEvidence, type AccessPolicy } from "./access";
import type { Evidence } from "./evidence";
import * as accessModule from "./access";
import * as identityModule from "./identity";
import { createIdentityBoundary, type IdentityVerifier, type VerifiedIdentity } from "./identity";

// The identity boundary: contexts exist only as the output of a designated verifier. These tests treat the verifier as the one trusted component.
const reader: IdentityVerifier = { assurance: "verified", verify: (c) => c as VerifiedIdentity | null };
const make = (verifier: IdentityVerifier = reader, timeoutMs?: number) => createIdentityBoundary(verifier, timeoutMs === undefined ? {} : { timeoutMs });
const ev = (tenantId: string, id: string): Evidence => ({ id, tenantId, source: `SRC-${id}`, metric: "m", department: "d", period: "prior", date: "2027-01-31", value: 1, unit: "u" });
const permitAll: AccessPolicy = { evidenceScope: (c) => ({ tenantId: c.tenantId, permits: () => true }) };

describe("there is no way to build a context from a tenant id and an actor id", () => {
  it("the modules export no issuing or minting function", () => {
    expect(Object.keys(identityModule).sort()).toEqual(["AuthorizationError", "IDENTITY_TIMEOUT_MS", "createIdentityBoundary"]);
    const surface = [...Object.keys(accessModule), ...Object.keys(identityModule)];
    expect(surface.filter((n) => /issue|mint|trust|forge|impersonat/i.test(n))).toEqual([]);
  });
  it("createIdentityBoundary takes a verifier and a credential; it has no (tenant, actor) overload", async () => {
    const b = make({ assurance: "verified", verify: () => null });
    await expect(b.authenticate({ tenantId: "t", actorId: "a" })).rejects.toBeInstanceOf(AuthorizationError); // the claim is not an identity until the verifier says so
    expect(() => b.authenticateSync({ tenantId: "t", actorId: "a" })).toThrow(AuthorizationError);
  });
  it("a verifier with a missing or invented assurance level is refused when the boundary is built", () => {
    for (const bad of [undefined, null, {}, { verify: () => null }, { assurance: "admin", verify: () => null }, { assurance: "VERIFIED", verify: () => null }] as never[]) expect(() => createIdentityBoundary(bad)).toThrow(AuthorizationError);
  });
});

describe("only the verifier decides who the caller is", () => {
  it("the context holds exactly the verified tenant and actor, stamped with the verifier's assurance", async () => {
    const b = make({ assurance: "verified", verify: () => ({ tenantId: "t-1", actorId: "u-1" }) });
    const ctx = await b.authenticate("any credential");
    expect({ ...ctx }).toEqual({ tenantId: "t-1", actorId: "u-1", assurance: "verified" });
  });
  it("extra fields in the verifier's answer, including an attempt to raise the assurance or add roles, are dropped", async () => {
    const b = make({ assurance: "simulated", verify: () => ({ tenantId: "t", actorId: "a", assurance: "verified", roles: ["admin"], isAdmin: true }) as never });
    const ctx = await b.authenticate(null);
    expect(ctx.assurance).toBe("simulated");
    expect(Object.keys(ctx).sort()).toEqual(["actorId", "assurance", "tenantId"]);
  });
  it("each field of the answer is read once, so a getter cannot show one value to the check and another to the context", () => {
    let reads = 0;
    const answer = { get tenantId() { reads++; return reads === 1 ? "t" : "other-tenant"; }, actorId: "a" };
    const ctx = make({ assurance: "verified", verify: () => answer }).authenticateSync(null);
    expect(ctx.tenantId).toBe("t");
    expect(reads).toBe(1);
  });
  it("the context cannot be edited afterwards", () => {
    const ctx = make().authenticateSync({ tenantId: "t", actorId: "a" });
    for (const edit of [() => { (ctx as { tenantId: string }).tenantId = "x"; }, () => { (ctx as { actorId: string }).actorId = "x"; }, () => { (ctx as { assurance: string }).assurance = "verified"; }, () => { (ctx as unknown as Record<string, unknown>)["role"] = "admin"; }]) expect(edit).toThrow(TypeError);
  });
});

describe("verification that is unavailable or wrong fails closed, with one generic error", () => {
  const SECRET = "idp.internal.example password=hunter2 tenant-bravo";
  const bad: [string, IdentityVerifier["verify"]][] = [
    ["throws", () => { throw new Error(SECRET); }],
    ["rejects", () => Promise.reject(new Error(SECRET))],
    ["returns null", () => null],
    ["returns undefined", () => undefined as never],
    ["returns a string", () => "tenant-a" as never],
    ["returns a number", () => 5 as never],
    ["returns an array", () => ["t", "a"] as never],
    ["returns empty ids", () => ({ tenantId: "", actorId: "a" })],
    ["returns whitespace-padded ids", () => ({ tenantId: " t", actorId: "a" })],
    ["returns a missing actor", () => ({ tenantId: "t" }) as never],
    ["returns a non-string tenant", () => ({ tenantId: 7, actorId: "a" }) as never],
    ["returns an oversized id", () => ({ tenantId: "t".repeat(257), actorId: "a" })],
  ];
  it.each(bad)("async: a verifier that %s -> AuthorizationError", async (_n, verify) => {
    const err = await make({ assurance: "verified", verify }).authenticate("cred").catch((e) => e);
    expect(err).toBeInstanceOf(AuthorizationError);
    expect(err.message).toBe("Authorization failed");
    expect(String(err.stack) + JSON.stringify(err) + err.message).not.toMatch(/hunter2|idp\.internal|bravo/);
  });
  it.each(bad.filter(([n]) => n !== "rejects"))("sync: a verifier that %s -> AuthorizationError", (_n, verify) => {
    expect(() => make({ assurance: "verified", verify }).authenticateSync("cred")).toThrow(AuthorizationError);
  });
  it("a verifier that never answers times out instead of hanging the request", async () => {
    const b = make({ assurance: "verified", verify: () => new Promise(() => {}) }, 25);
    const t0 = Date.now();
    await expect(b.authenticate("cred")).rejects.toBeInstanceOf(AuthorizationError);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
  it("a slow answer that arrives after the deadline does not become a context", async () => {
    const b = make({ assurance: "verified", verify: () => new Promise((r) => setTimeout(() => r({ tenantId: "t", actorId: "a" }), 120)) }, 20);
    await expect(b.authenticate("cred")).rejects.toBeInstanceOf(AuthorizationError);
  });
  it("an asynchronous verifier is refused by the synchronous entry point (it cannot be silently treated as authenticated)", () => {
    const b = make({ assurance: "verified", verify: async () => ({ tenantId: "t", actorId: "a" }) });
    expect(() => b.authenticateSync("cred")).toThrow(AuthorizationError);
  });
  it("a refused asynchronous verifier's later rejection does not surface as an unhandled rejection", async () => {
    const seen: unknown[] = [];
    const on = (e: unknown) => seen.push(e);
    process.on("unhandledRejection", on);
    try {
      const b = make({ assurance: "verified", verify: () => Promise.reject(new Error("late failure")) });
      expect(() => b.authenticateSync("cred")).toThrow(AuthorizationError);
      await new Promise((r) => setTimeout(r, 30));
    } finally { process.off("unhandledRejection", on); }
    expect(seen).toEqual([]);
  });
  it("one failure does not poison the boundary: the next valid credential still works", async () => {
    let n = 0;
    const b = make({ assurance: "verified", verify: () => (n++ === 0 ? null : { tenantId: "t", actorId: "a" }) });
    await expect(b.authenticate("x")).rejects.toBeInstanceOf(AuthorizationError);
    await expect(b.authenticate("x")).resolves.toMatchObject({ tenantId: "t" });
  });
  it("no timer is left running after a successful verification", async () => {
    const spy = vi.spyOn(globalThis, "clearTimeout");
    await make({ assurance: "verified", verify: () => ({ tenantId: "t", actorId: "a" }) }).authenticate("x");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("a context is honoured only by the boundary that produced it", () => {
  const a = make(), b = make();
  const ctxA = a.authenticateSync({ tenantId: "t", actorId: "u" });
  it("each boundary recognises only its own contexts, even for identical fields", () => {
    const ctxB = b.authenticateSync({ tenantId: "t", actorId: "u" });
    expect([a.owns(ctxA), a.owns(ctxB), b.owns(ctxA), b.owns(ctxB)]).toEqual([true, false, false, true]);
  });
  it("authorizeEvidence refuses a context from another boundary", () => {
    expect(() => authorizeEvidence(b, ctxA, permitAll, [ev("t", "r1")])).toThrow(AuthorizationError);
    expect(authorizeEvidence(a, ctxA, permitAll, [ev("t", "r1")]).authorized).toHaveLength(1);
  });
  it.each([
    ["spread copy", () => ({ ...ctxA })],
    ["JSON round trip", () => JSON.parse(JSON.stringify(ctxA))],
    ["structuredClone", () => structuredClone({ ...ctxA })],
    ["Object.create(ctx)", () => Object.create(ctxA)],
    ["Object.assign onto {}", () => Object.assign({}, ctxA)],
    ["Object.freeze of a rebuilt object", () => Object.freeze({ tenantId: "t", actorId: "u", assurance: "verified" })],
    ["a Proxy around the real context", () => new Proxy(ctxA, {})],
    ["null / undefined / primitives", () => null],
  ])("a reconstructed context (%s) is refused", (_n, build) => {
    const forged = build() as never;
    expect(a.owns(forged)).toBe(false);
    expect(() => authorizeEvidence(a, forged, permitAll, [ev("t", "r1")])).toThrow(AuthorizationError);
  });
  it("a boundary built by other code (with a lying verifier) cannot get its contexts accepted by this one", () => {
    const attacker = make({ assurance: "verified", verify: () => ({ tenantId: "t", actorId: "u" }) });
    const ctx = attacker.authenticateSync("anything");
    expect(() => authorizeEvidence(a, ctx, permitAll, [ev("t", "r1")])).toThrow(AuthorizationError);
  });
});
