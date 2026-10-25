import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthorizationError, authorizeEvidence, type AccessPolicy } from "../core/access";
import { createIdentityBoundary, type IdentityVerifier, type VerifiedIdentity } from "../core/identity";
import { DEMO_TENANT_ID, METRIC_LABELS, ROLES, SCENARIOS, build } from "../data";
import { DEMO_QUESTION, PROTOTYPE_CONTEXT } from "../engine";
import { authorizeDemo, demoAccessPolicy, demoActorId, demoEvidenceStore, demoIdentity, resolveDemoRequest, simulatedDemoVerifier, type PrototypeEvidence } from "../prototypeAdapter";
import { museSpark } from "./providers/muse";
import { PROTOTYPE_RUNTIME, runMeta, type EngineRuntime } from "./adapter.server";

// PR B-2: the identity boundary. No network: fetch is always a local fake. The "identity provider" is a stand-in verifier.
const READY = { META_MODEL_API_KEY: "test-key", META_MODEL_ENABLED: "true" };
const reply = (content: unknown) => vi.fn(async (..._a: unknown[]) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) }, finish_reason: "stop" }], usage: { prompt_tokens: 900, completion_tokens: 200 } }), { status: 200 }));
const lane = (text: string, refs = ["F-revenue"]) => ({ interpretations: [{ text, verified: false as const, refs }], missing_evidence: [] as string[], recommendations: [] as unknown[] });
const claim = (roleId: string, extra: Record<string, unknown> = {}) => ({ scenarioId: "baseline", roleId, ownerConfirmed: true, ...extra });
const sentBody = (f: ReturnType<typeof reply>) => JSON.stringify(JSON.parse((f.mock.calls[0]![1] as { body: string }).body).messages);
const quiet = () => ({ err: vi.spyOn(console, "error").mockImplementation(() => {}), info: vi.spyOn(console, "info").mockImplementation(() => {}) });
afterEach(() => vi.restoreAllMocks());

// ---- two tenants in one shared store, behind a "token" verifier that knows which token belongs to whom
const ACME = "tenant-acme", BRAVO = "tenant-bravo";
const owned = (tenantId: string, prefix: string, rows: Parameters<typeof build>[1]) => build(prefix, rows).map((r) => ({ ...r, tenantId })) as PrototypeEvidence[];
const acmeRecords = owned(ACME, "AC", [["revenue", "Finance", "ws-finance", "ACME GL Revenue", 1000, 800, "USD"], ["leads", "Marketing", "ws-marketing", "ACME CRM Leads", 500, 600, "leads"]]);
const bravoRecords = owned(BRAVO, "BR", [["revenue", "Finance", "ws-finance", "BRAVO-SECRET Ledger", 9000, 9500, "USD"], ["cac", "Marketing", "ws-marketing", "BRAVO-SECRET Ads", 90, 120, "USD"]]);
const everything = [...acmeRecords, ...bravoRecords];
const HIDDEN_STRINGS = bravoRecords.flatMap((r) => [r.id, r.source]);

const TOKENS: Record<string, VerifiedIdentity> = { "token-acme-analyst": { tenantId: ACME, actorId: "acme-analyst" }, "token-bravo-admin": { tenantId: BRAVO, actorId: "bravo-admin" } };
const tokenVerifier: IdentityVerifier = { assurance: "verified", verify: (c) => (typeof c === "string" && Object.prototype.hasOwnProperty.call(TOKENS, c) ? TOKENS[c]! : null) };
const grantAll: AccessPolicy<PrototypeEvidence> = { evidenceScope: (c) => ({ tenantId: c.tenantId, permits: () => true }) };
const runtimeFor = (token: unknown, over: Partial<EngineRuntime> = {}): EngineRuntime => ({
  resolve: () => ({ ok: true, credential: token, dataset: "shared" }),
  identity: createIdentityBoundary(tokenVerifier),
  allowSimulatedIdentity: false,
  store: { candidates: () => everything },
  policy: grantAll,
  analysis: PROTOTYPE_CONTEXT,
  question: DEMO_QUESTION,
  provider: museSpark,
  ...over,
});

describe("1. forged tenant and actor identities", () => {
  it("a token the verifier does not know is not an identity, whatever tenant or actor it names", async () => {
    quiet();
    for (const forged of ["token-unknown", "token-acme-analyst ", "TOKEN-ACME-ANALYST", "", null, undefined, 42, { tenantId: ACME, actorId: "acme-analyst" }, ["token-acme-analyst"], "constructor", "__proto__", "toString"]) {
      const f = reply(lane("x"));
      const r = await runMeta({}, READY, f as never, runtimeFor(forged));
      expect(r, String(forged)).toEqual({ state: "blocked", reason: "Authorization failed; nothing sent.", requestSent: false });
      expect(f).not.toHaveBeenCalled();
    }
  });
  it("a valid token yields exactly the verified tenant, and that tenant's evidence only", async () => {
    quiet();
    const f = reply(lane("Mix may matter.", ["F-revenue", "F-leads"]));
    const r = await runMeta({}, READY, f as never, runtimeFor("token-acme-analyst"));
    expect(r.state).toBe("ok");
    expect(r.state === "ok" && r.authorizedIds.sort()).toEqual(acmeRecords.map((x) => x.id).sort());
    const wire = sentBody(f);
    for (const s of HIDDEN_STRINGS) expect(wire).not.toContain(s);
  });
  it("the demo identity adapter ignores a tenant, actor, role list or admin flag supplied in the claim", () => {
    for (const extra of [{ tenantId: "tenant-other" }, { actorId: "demo-role:exec" }, { roles: ["exec"] }, { isAdmin: true }, { workspaces: ["ws-finance"] }, { assurance: "verified" }]) {
      const r = resolveDemoRequest(claim("finance", extra));
      expect(r.ok).toBe(true);
      const ctx = r.ok ? demoIdentity.authenticateSync(r.credential) : null;
      expect({ ...ctx }).toEqual({ tenantId: DEMO_TENANT_ID, actorId: demoActorId("finance"), assurance: "simulated" });
    }
    // and the verifier itself, handed a hostile claim directly
    const hostile = simulatedDemoVerifier.verify({ kind: "simulated-demo-role-claim", roleId: "finance", tenantId: "tenant-other", actorId: "demo-role:exec" });
    expect(hostile).toEqual({ tenantId: DEMO_TENANT_ID, actorId: demoActorId("finance") });
  });
  it.each(["root", "Exec", " exec", "exec ", "EXEC", "constructor", "__proto__", "toString", "hasOwnProperty", "valueOf", "", "exec\u0000", "exec/../finance"])("the demo adapter does not accept the role %j", (roleId) => {
    expect(simulatedDemoVerifier.verify({ kind: "simulated-demo-role-claim", roleId })).toBeNull();
    expect(resolveDemoRequest(claim(roleId)).ok).toBe(false);
  });
  it.each([null, undefined, "exec", 5, {}, { roleId: "exec" }, { kind: "other", roleId: "exec" }, { kind: "simulated-demo-role-claim" }, { kind: "simulated-demo-role-claim", roleId: 7 }])("the demo verifier treats %j as no identity", (c) => {
    expect(simulatedDemoVerifier.verify(c)).toBeNull();
  });
});

describe("2. copied, serialized and reconstructed contexts", () => {
  it("a context cannot be supplied by the request path at all: the resolver returns a credential, and any ctx it returns is ignored", async () => {
    quiet();
    const real = demoIdentity.authenticateSync({ kind: "simulated-demo-role-claim", roleId: "exec" });
    for (const smuggled of [real, { ...real }, JSON.parse(JSON.stringify(real)), Object.create(real)]) {
      const f = reply(lane("x"));
      const r = await runMeta({}, READY, f as never, { ...PROTOTYPE_RUNTIME, resolve: () => ({ ok: true, ctx: smuggled, dataset: "baseline" }) as never });
      expect(r).toMatchObject({ state: "blocked", requestSent: false });
      expect(f).not.toHaveBeenCalled();
    }
  });
  it("a real context handed back to the boundary as a 'credential' is not an identity for a verifier that does not accept it", async () => {
    const real = demoIdentity.authenticateSync({ kind: "simulated-demo-role-claim", roleId: "exec" });
    await expect(demoIdentity.authenticate(real)).rejects.toBeInstanceOf(AuthorizationError);
  });
});

describe("3. contexts cannot be issued outside the designated identity boundary", () => {
  const attacker = createIdentityBoundary({ assurance: "verified", verify: () => ({ tenantId: DEMO_TENANT_ID, actorId: demoActorId("exec") }) });
  it("a boundary built by other code cannot authorize evidence through the demo's boundary or the live path", async () => {
    quiet();
    const ctx = attacker.authenticateSync("anything");
    expect(() => authorizeEvidence(demoIdentity, ctx, demoAccessPolicy, demoEvidenceStore.candidates(ctx, "baseline"))).toThrow(AuthorizationError);
    // the live path takes its context from ITS boundary; an attacker boundary only helps if the runtime was composed with it
    const f = reply(lane("x"));
    const r = await runMeta({}, READY, f as never, { ...PROTOTYPE_RUNTIME, resolve: () => ({ ok: true, credential: "anything", dataset: "baseline" }) });
    expect(r).toMatchObject({ state: "blocked", reason: "Authorization failed; nothing sent." });
    expect(f).not.toHaveBeenCalled();
  });
  it("the only public ways to obtain a context are boundary.authenticate / authenticateSync, which call the verifier", async () => {
    let calls = 0;
    const counting = createIdentityBoundary({ assurance: "verified", verify: (c) => { calls++; return c as VerifiedIdentity; } });
    await counting.authenticate({ tenantId: "t", actorId: "a" });
    counting.authenticateSync({ tenantId: "t", actorId: "a" });
    expect(calls).toBe(2);
  });
  it("the live path never reads an identity from the request: a hostile request produces the same evidence as a plain one", async () => {
    quiet();
    const plain = reply(lane("Mix may matter.")), hostile = reply(lane("Mix may matter."));
    await runMeta(claim("finance"), READY, plain as never);
    await runMeta(claim("finance", { tenantId: BRAVO, actorId: "bravo-admin", assurance: "verified", token: "token-bravo-admin" }), READY, hostile as never);
    expect(sentBody(hostile)).toBe(sentBody(plain));
  });
});

describe("4. cross-tenant evidence access", () => {
  it.each([["token-acme-analyst", ACME, BRAVO], ["token-bravo-admin", BRAVO, ACME]])("%s sees only %s, never %s", async (token, own, other) => {
    quiet();
    const f = reply(lane("Mix may matter.", ["F-revenue"]));
    const r = await runMeta({}, READY, f as never, runtimeFor(token));
    expect(r.state).toBe("ok");
    const owner = (id: string) => everything.find((x) => x.id === id)!.tenantId;
    expect(r.state === "ok" && r.authorizedIds.every((id) => owner(id) === own)).toBe(true);
    const otherStrings = everything.filter((x) => x.tenantId === other).flatMap((x) => [x.id, x.source]);
    for (const s of otherStrings) expect(sentBody(f)).not.toContain(s);
  });
  it("the demo boundary cannot produce any tenant but the demo tenant, so other tenants' records in the store are never reachable from it", () => {
    const foreign = { ...SCENARIOS[0]!.records[0]!, id: "FOREIGN-1", tenantId: BRAVO, source: "BRAVO-SECRET" } as PrototypeEvidence;
    const store = { candidates: () => [foreign, ...(demoEvidenceStore.candidates({} as never, "baseline") as PrototypeEvidence[])] };
    const ctx = demoIdentity.authenticateSync({ kind: "simulated-demo-role-claim", roleId: "exec" });
    const r = authorizeEvidence(demoIdentity, ctx, demoAccessPolicy, store.candidates());
    expect(r.authorized.some((e) => e.id === "FOREIGN-1")).toBe(false);
    expect(r.withheld.some((e) => e.id === "FOREIGN-1")).toBe(true);
  });
});

describe("5. unauthorized role escalation", () => {
  const restricted = ROLES.filter((r) => r.id !== "exec");
  it.each(restricted.map((r) => r.id))("claiming %s never yields more than that role's workspaces, whatever else the claim says", (role) => {
    const base = authorizeDemo({ scenarioId: "baseline", roleId: role }).authorized.map((e) => e.id);
    const roleDef = ROLES.find((r) => r.id === role)!;
    const exec = authorizeDemo({ scenarioId: "baseline", roleId: "exec" }).authorized;
    expect(base.length).toBeLessThan(exec.length);
    expect(authorizeDemo({ scenarioId: "baseline", roleId: role }).authorized.every((e) => roleDef.workspaces.includes(e.workspace))).toBe(true);
    const r = resolveDemoRequest(claim(role, { roles: ["exec"], role: "exec", permissions: ["*"], isAdmin: true, workspaces: ["ws-marketing", "ws-sales", "ws-ops", "ws-finance"] }));
    const ctx = r.ok ? demoIdentity.authenticateSync(r.credential) : null;
    expect(ctx?.actorId).toBe(demoActorId(role));
  });
  it("a context cannot be edited into a more privileged one", () => {
    const ctx = demoIdentity.authenticateSync({ kind: "simulated-demo-role-claim", roleId: "finance" });
    expect(() => { (ctx as { actorId: string }).actorId = demoActorId("exec"); }).toThrow(TypeError);
    expect(() => { (ctx as { assurance: string }).assurance = "verified"; }).toThrow(TypeError);
    expect(demoAccessPolicy.evidenceScope(ctx).permits(SCENARIOS[0]!.records.find((r) => r.workspace === "ws-marketing") as PrototypeEvidence)).toBe(false);
  });
  it("the demo's contexts are marked simulated and a runtime that disallows simulated identity refuses them", async () => {
    quiet();
    expect(demoIdentity.assurance).toBe("simulated");
    expect(demoIdentity.authenticateSync({ kind: "simulated-demo-role-claim", roleId: "exec" }).assurance).toBe("simulated");
    const f = reply(lane("x"));
    const r = await runMeta(claim("exec"), READY, f as never, { ...PROTOTYPE_RUNTIME, allowSimulatedIdentity: false });
    expect(r).toEqual({ state: "blocked", reason: "Authorization failed; nothing sent.", requestSent: false });
    expect(f).not.toHaveBeenCalled();
    expect(PROTOTYPE_RUNTIME.allowSimulatedIdentity).toBe(true); // the demo itself is unchanged
  });
  it("a verified runtime accepts a verified identity and the same runtime with the demo's simulated one is refused", async () => {
    quiet();
    const ok = await runMeta({}, READY, reply(lane("Mix may matter.")) as never, runtimeFor("token-acme-analyst"));
    expect(ok.state).toBe("ok");
    const simulatedInVerifiedRuntime = runtimeFor("ignored", { identity: demoIdentity, resolve: () => ({ ok: true, credential: { kind: "simulated-demo-role-claim", roleId: "exec" }, dataset: "baseline" }), store: demoEvidenceStore, policy: demoAccessPolicy });
    expect(await runMeta({}, READY, reply(lane("x")) as never, simulatedInVerifiedRuntime)).toMatchObject({ state: "blocked", reason: "Authorization failed; nothing sent." });
  });
  it("an identity provider cannot raise its own assurance by naming one in its answer", () => {
    const b = createIdentityBoundary({ assurance: "simulated", verify: () => ({ tenantId: "t", actorId: "a", assurance: "verified" }) as never });
    expect(b.authenticateSync(null).assurance).toBe("simulated");
  });
});

describe("6. identity verification unavailable: fail closed", () => {
  const SECRET = "idp.corp.internal:8443 client_secret=hunter2 tenant-bravo BRAVO-SECRET";
  const broken: [string, IdentityVerifier["verify"]][] = [
    ["throws", () => { throw new Error(SECRET); }],
    ["rejects", () => Promise.reject(new Error(SECRET))],
    ["answers nothing", () => null],
    ["answers garbage", () => "yes" as never],
    ["answers an identity without an actor", () => ({ tenantId: ACME }) as never],
  ];
  it.each(broken)("an identity provider that %s sends nothing, reveals nothing, and does not read evidence", async (_n, verify) => {
    const { err, info } = quiet();
    const candidates = vi.fn(() => everything);
    const f = reply(lane("x"));
    const rt = runtimeFor("token-acme-analyst", { identity: createIdentityBoundary({ assurance: "verified", verify }), store: { candidates } });
    const r = await runMeta({}, READY, f as never, rt);
    expect(r).toEqual({ state: "blocked", reason: "Authorization failed; nothing sent.", requestSent: false });
    expect(f).not.toHaveBeenCalled();
    expect(candidates).not.toHaveBeenCalled(); // evidence is not even loaded without an identity
    const out = (JSON.stringify(r) + JSON.stringify([...err.mock.calls, ...info.mock.calls].flat().map(String))).toLowerCase();
    expect(out).not.toMatch(/hunter2|idp\.corp|client_secret|bravo|secret/);
  });
  it("an identity provider that hangs times out and sends nothing", async () => {
    quiet();
    const f = reply(lane("x"));
    const rt = runtimeFor("token-acme-analyst", { identity: createIdentityBoundary({ assurance: "verified", verify: () => new Promise(() => {}) }, { timeoutMs: 30 }) });
    const r = await runMeta({}, READY, f as never, rt);
    expect(r).toEqual({ state: "blocked", reason: "Authorization failed; nothing sent.", requestSent: false });
    expect(f).not.toHaveBeenCalled();
  });
  it("key/flag checks still come first and request validation errors are unchanged", async () => {
    expect(await runMeta({}, { META_MODEL_API_KEY: "", META_MODEL_ENABLED: "true" }, reply(lane("x")) as never, runtimeFor("token-acme-analyst"))).toMatchObject({ state: "blocked", reason: "Meta API server credential is not configured." });
    expect(await runMeta(claim("root"), READY, reply(lane("x")) as never)).toMatchObject({ state: "blocked", reason: "Invalid request: Unknown role" });
  });
});

describe("7. unauthorized identifiers never reach a prompt or a client-visible error", () => {
  it("across every failure above and across rejected model output, no hidden id, source, metric label or tenant name appears in the result or the logs", async () => {
    const { err, info } = quiet();
    const hiddenBravo = [...HIDDEN_STRINGS, BRAVO, "bravo", METRIC_LABELS.cac, "F-cac"];
    const outputs: [string, unknown][] = [
      ["leak of another tenant's source", lane(`Check ${bravoRecords[0]!.source}.`)],
      ["leak of another tenant's id", lane(`See ${bravoRecords[1]!.id}.`)],
      ["unauthorized ref", lane("Mix may matter.", ["F-cac"])],
      ["tenant field in model output", { ...lane("Mix may matter."), tenantId: BRAVO }],
    ];
    const results: unknown[] = [];
    for (const [, out] of outputs) results.push(await runMeta({}, READY, reply(out) as never, runtimeFor("token-acme-analyst")));
    for (const bad of [null, "token-unknown", { tenantId: BRAVO, actorId: "bravo-admin" }]) results.push(await runMeta({}, READY, reply(lane("x")) as never, runtimeFor(bad)));
    expect(results.filter((r) => (r as { state: string }).state === "ok")).toEqual([]);
    const wire = (JSON.stringify(results) + [...err.mock.calls, ...info.mock.calls].flat().map(String).join(" ")).toLowerCase();
    for (const s of hiddenBravo) expect(wire, s).not.toContain(s.toLowerCase());
  });
  it("the demo's restricted roles still get prompts and rejections that name nothing outside their scope (golden-compatible)", async () => {
    quiet();
    const f = reply(lane("Marketing leads rose sharply.", ["F-revenue"]));
    const r = await runMeta(claim("finance"), READY, f as never);
    expect(r.state).toBe("rejected");
    for (const s of ["leads", "mkt", "crm", "f-leads"]) expect(JSON.stringify(r).toLowerCase()).not.toContain(s);
  });
});
