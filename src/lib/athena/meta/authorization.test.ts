import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthorizationError, authorizeEvidence, type AccessPolicy, type TrustedContext } from "../core/access";
import { createIdentityBoundary, type VerifiedIdentity } from "../core/identity";
import { computeAuthorizedFacts } from "../core/facts";
import { DEMO_TENANT_ID, METRIC_LABELS, ROLES, SCENARIOS, build, type EvidenceRecord } from "../data";
import { PROTOTYPE_CONTEXT, DEMO_QUESTION, filterVisible } from "../engine";
import { authorizeDemo, demoAccessPolicy, demoActorId, demoEvidenceStore, demoIdentity, resolveDemoRequest, type PrototypeEvidence } from "../prototypeAdapter";
import { PROTOTYPE_RUNTIME, authorizedFactsBlockReason, runMeta, type EngineRuntime } from "./adapter.server";
import { authorizedRecords, prepareMessages, validateAuthorizedOutput } from "./contract";
import { buildAuthorizedFacts } from "./numericGrounding";

// Server-side authorization for the live path. No network: fetch is always a local fake.
const READY = { META_MODEL_API_KEY: "test-key", META_MODEL_ENABLED: "true" };
const req = (roleId = "exec", scenarioId = "baseline", extra: Record<string, unknown> = {}) => ({ scenarioId, roleId, ownerConfirmed: true, ...extra });
const okBody = (content: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) }, finish_reason: "stop" }], usage: { prompt_tokens: 900, completion_tokens: 200 } }), { status: 200 });
const fakeFetch = (content: unknown) => vi.fn(async (..._a: unknown[]) => okBody(content));
const lane = (text: string, refs = ["F-revenue"]) => ({ interpretations: [{ text, verified: false as const, refs }], missing_evidence: [] as string[], recommendations: [] as unknown[] });
const sent = (f: ReturnType<typeof fakeFetch>) => JSON.parse((f.mock.calls[0]![1] as { body: string }).body) as { messages: { content: string }[] };

afterEach(() => vi.restoreAllMocks());

// ---------------------------------------------------------------- a second tenant, sharing the same store
const ACME = "tenant-acme", BRAVO = "tenant-bravo";
const owned = (tenantId: string, prefix: string, rows: Parameters<typeof build>[1], source?: string) =>
  build(prefix, rows).map((r) => ({ ...r, tenantId, ...(source ? { source: `${source} ${r.metric}` } : {}) })) as PrototypeEvidence[];
const acmeRecords = owned(ACME, "AC", [
  ["revenue", "Finance", "ws-finance", "ACME GL Revenue", 1000, 800, "USD"],
  ["leads", "Marketing", "ws-marketing", "ACME CRM Leads", 500, 600, "leads"],
]);
// Bravo has a metric Acme lacks (cac), a distinctive source label, and a record that REUSES one of Acme's ids.
const bravoRecords = [
  ...owned(BRAVO, "BR", [
    ["revenue", "Finance", "ws-finance", "BRAVO-SECRET Ledger", 9000, 9500, "USD"],
    ["cac", "Marketing", "ws-marketing", "BRAVO-SECRET Ads", 90, 120, "USD"],
  ]),
  { ...acmeRecords[0]!, tenantId: BRAVO, source: "BRAVO-SECRET Reused-Id Feed" } as PrototypeEvidence,
];
const everything = [...acmeRecords, ...bravoRecords];
// The test composition root: an adapter that reads the identity out of the credential. Real adapters validate a token instead.
const testIdentity = createIdentityBoundary({ assurance: "verified", verify: (c) => c as VerifiedIdentity | null });
const issueTrustedContext = (tenantId: string, actorId: string) => testIdentity.authenticateSync({ tenantId, actorId });
const acme = (actorId = "acme-analyst") => issueTrustedContext(ACME, actorId);
const allowWorkspaces = (grants: Record<string, string[]>): AccessPolicy<PrototypeEvidence> => ({
  evidenceScope: (c) => ({ tenantId: c.tenantId, permits: (e) => (grants[c.actorId] ?? []).includes(e.workspace) }),
});
const permitAll: AccessPolicy<PrototypeEvidence> = { evidenceScope: (c) => ({ tenantId: c.tenantId, permits: () => true }) };
const runtime = (over: Partial<EngineRuntime> = {}, actorId = "acme-analyst"): EngineRuntime => ({
  resolve: () => ({ ok: true, credential: { tenantId: ACME, actorId }, dataset: "shared" }),
  identity: testIdentity,
  allowSimulatedIdentity: false,
  store: { candidates: () => everything },
  policy: permitAll,
  analysis: PROTOTYPE_CONTEXT,
  question: DEMO_QUESTION,
  ...over,
});
const BRAVO_STRINGS = [...new Set(bravoRecords.flatMap((r) => [r.id, r.source]))].filter((s) => !acmeRecords.some((a) => a.id === s));

describe("prototype adapter: the 12 scenario/role combinations are unchanged", () => {
  it("authorizes exactly the records the workspace filter always selected, in the same order", () => {
    for (const sc of SCENARIOS) for (const r of ROLES) {
      const viaAuth = authorizeDemo({ scenarioId: sc.id, roleId: r.id }).authorized.map((e) => e.id);
      expect(viaAuth, `${sc.id}/${r.id}`).toEqual(filterVisible(sc.records, r.workspaces).map((e) => e.id));
    }
  });
  it("the authorized set equals what the pre-refactor golden snapshot recorded", () => {
    const golden = JSON.parse(readFileSync("src/lib/athena/golden/combos.json", "utf8")).combos as Record<string, { authorizedIds: string[] }>;
    for (const sc of SCENARIOS) for (const r of ROLES) expect(authorizedRecords({ scenarioId: sc.id, roleId: r.id }).map((e) => e.id)).toEqual(golden[`${sc.id}/${r.id}`]!.authorizedIds);
  });
  it("every bundled record carries the demo tenant and the demo policy never grants another tenant", () => {
    for (const sc of SCENARIOS) for (const rec of sc.records) expect(rec.tenantId).toBe(DEMO_TENANT_ID);
    const foreign = issueTrustedContext("tenant-other", demoActorId("exec"));
    expect(authorizeEvidenceFor(foreign).authorized).toHaveLength(0);
  });
  it("the demo policy grants nothing to an unknown actor, an empty actor, a look-alike actor, or any other tenant", () => {
    const rec = SCENARIOS[0]!.records[0] as PrototypeEvidence;
    const permitted = (tenant: string, actor: string) => demoAccessPolicy.evidenceScope(issueTrustedContext(tenant, actor)).permits(rec);
    expect(permitted(DEMO_TENANT_ID, demoActorId("exec"))).toBe(true); // control
    for (const actor of ["nobody", "demo-role:nobody", "demo-role:", "Demo-Role:exec", "exec", "demo-role:constructor", "demo-role:__proto__"]) expect(permitted(DEMO_TENANT_ID, actor), actor).toBe(false);
    for (const tenant of ["tenant-other", "TENANT-VERDANT-HOLLOW-DEMO", `${DEMO_TENANT_ID}-2`]) expect(permitted(tenant, demoActorId("exec")), tenant).toBe(false);
  });
  it("keeps the original errors for an unknown scenario or role", () => {
    expect(() => authorizedRecords({ scenarioId: "nope", roleId: "exec" })).toThrow("Scenario not in synthetic allowlist");
    expect(() => authorizedRecords({ scenarioId: "baseline", roleId: "root" })).toThrow("Unknown role");
  });
  it("the live path still produces the same prompt for every combination (compared with the pre-refactor prompt text)", async () => {
    const golden = JSON.parse(readFileSync("src/lib/athena/golden/combos.json", "utf8")).combos as Record<string, { messages: unknown; blockReason: string | null }>;
    for (const sc of SCENARIOS) for (const r of ROLES) {
      const g = golden[`${sc.id}/${r.id}`]!;
      const first = buildAuthorizedFacts(authorizeDemo({ scenarioId: sc.id, roleId: r.id }).authorized)[0];
      const f = fakeFetch(lane("Mix may matter.", [first ? first.fact_id : "F-none"]));
      vi.spyOn(console, "info").mockImplementation(() => {});
      const res = await runMeta(req(r.id, sc.id), READY, f as never);
      if (g.blockReason) { expect(res.state).toBe("blocked"); continue; }
      expect(res.state, `${sc.id}/${r.id}`).toBe("ok");
      expect(sent(f).messages).toEqual(g.messages);
    }
  });
});
function authorizeEvidenceFor(ctx: TrustedContext) {
  return require_authorize(ctx);
}
function require_authorize(ctx: TrustedContext) {
  return authorizeEvidence(testIdentity, ctx, demoAccessPolicy, demoEvidenceStore.candidates(ctx, "baseline"));
}

describe("client input is never trusted", () => {
  it("tenant, workspace, permission and record fields in the request are ignored: the prompt is identical", async () => {
    const plain = fakeFetch(lane("Mix may matter.")), crafted = fakeFetch(lane("Mix may matter."));
    vi.spyOn(console, "info").mockImplementation(() => {});
    await runMeta(req("finance"), READY, plain as never);
    await runMeta(req("finance", "baseline", { tenantId: "tenant-other", tenant_id: "x", actorId: "demo-role:exec", workspaces: ["ws-marketing", "ws-sales", "ws-ops", "ws-finance"], permissions: ["*"], role: "exec", records: [{ id: "EVIL-1" }], isAdmin: true }), READY, crafted as never);
    expect(sent(crafted)).toEqual(sent(plain));
  });
  it("the tenant of the context is fixed by the server's identity adapter, whatever the request says", () => {
    const r = resolveDemoRequest(req("exec", "baseline", { tenantId: "tenant-other", actorId: "x" }));
    expect(r.ok).toBe(true);
    const ctx = r.ok ? demoIdentity.authenticateSync(r.credential) : null;
    expect(ctx?.tenantId).toBe(DEMO_TENANT_ID);
    expect(ctx?.actorId).toBe(demoActorId("exec"));
  });
  it("an unknown or inherited role name, or a missing confirmation, is refused before any evidence is read", async () => {
    const f = fakeFetch(lane("x"));
    const store = vi.fn(() => []);
    const rt = { ...PROTOTYPE_RUNTIME, store: { candidates: store } } as EngineRuntime;
    for (const bad of [req("root"), req("constructor"), req("__proto__"), req("toString"), { ...req("exec"), ownerConfirmed: false }, { scenarioId: "baseline" }, null, "exec"]) {
      const r = await runMeta(bad, READY, f as never, rt);
      expect(r.state).toBe("blocked");
    }
    expect(store).not.toHaveBeenCalled();
    expect(f).not.toHaveBeenCalled();
  });
  it("model output cannot carry tenant, role or permission fields: any such key is rejected", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    for (const extra of [{ tenantId: "tenant-other" }, { tenant_id: "x" }, { role: "exec" }, { permissions: ["*"] }, { workspaces: ["ws-finance"] }, { authorized: true }]) {
      const r = await runMeta(req("marketing"), READY, fakeFetch({ ...lane("Mix may matter.", ["F-leads"]), ...extra }) as never);
      expect(r.state).toBe("rejected");
      if (r.state === "rejected") expect(r.categories).toEqual(["schema"]);
    }
    const nested = await runMeta(req("marketing"), READY, fakeFetch({ interpretations: [{ text: "Mix may matter.", verified: false, refs: ["F-leads"], tenantId: "tenant-other" }], missing_evidence: [], recommendations: [] }) as never);
    expect(nested.state).toBe("rejected");
  });
});

describe("cross-role access: unauthorized data never reaches the model or the client", () => {
  const restricted = ROLES.filter((r) => r.id !== "exec");
  it.each(SCENARIOS.flatMap((s) => restricted.map((r) => ({ s: s.id, r: r.id }))))("$s / $r: the prompt contains no hidden id, source, metric label, fact id or department", async ({ s, r }) => {
    const sc = SCENARIOS.find((x) => x.id === s)!;
    const auth = authorizeDemo({ scenarioId: s, roleId: r }).authorized;
    const allowed = new Set(auth.map((e) => e.id));
    const hidden = sc.records.filter((x) => !allowed.has(x.id));
    const have = new Set(auth.map((e) => e.metric));
    const depts = new Set(auth.map((e) => e.department));
    const f = fakeFetch(lane("Mix may matter.", [`F-${auth[0]!.metric}`]));
    vi.spyOn(console, "info").mockImplementation(() => {});
    await runMeta(req(r, s), READY, f as never);
    // The fixed demo question ("...sales declining while marketing leads are rising?") is server text, identical for every role and part of the
    // pre-refactor prompt; the data portion (periods + verified facts) is what carries evidence, so that is what is checked.
    const wire = JSON.stringify(sent(f).messages.map((m) => m.content.replace(/^Question:.*\n/, ""))).toLowerCase();
    const forbidden = [
      ...hidden.flatMap((x) => [x.id, x.source, ...(x.note ? [x.note] : [])]),
      ...[...new Set(hidden.map((x) => x.metric))].filter((m) => !have.has(m)).flatMap((m) => [`F-${m}`, METRIC_LABELS[m]]),
      ...["Marketing", "Sales", "Operations", "Finance"].filter((d) => !depts.has(d as never)),
    ];
    expect(forbidden.filter((x) => x && wire.includes(x.toLowerCase()))).toEqual([]);
  });
  it("a role asking about another role's metric gets a rejection that names nothing", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const r = await runMeta(req("finance"), READY, fakeFetch(lane("Marketing leads rose sharply.", ["F-revenue"])) as never);
    expect(r.state).toBe("rejected");
    const wire = JSON.stringify(r).toLowerCase();
    for (const s of ["leads", "marketing", "mkt", "crm", "f-leads"]) expect(wire).not.toContain(s);
  });
});

describe("cross-tenant access through the live path", () => {
  const quiet = () => { vi.spyOn(console, "info").mockImplementation(() => {}); vi.spyOn(console, "error").mockImplementation(() => {}); };
  it("the prompt is built from the caller's tenant only, even when the store and the policy both over-share", async () => {
    quiet();
    const f = fakeFetch(lane("Mix may matter.", ["F-revenue", "F-leads"]));
    const r = await runMeta({}, READY, f as never, runtime());
    expect(r.state).toBe("ok");
    const wire = JSON.stringify(sent(f));
    for (const s of BRAVO_STRINGS) expect(wire.toLowerCase(), s).not.toContain(s.toLowerCase());
    expect(wire).not.toContain("F-cac"); // a metric only the other tenant has
    expect(wire).not.toContain(METRIC_LABELS.cac);
    expect(wire).toContain("AC-FIN-001-Q3");
    if (r.state === "ok") {
      expect(r.authorizedIds.sort()).toEqual(acmeRecords.map((x) => x.id).sort());
      expect(JSON.stringify(r).toLowerCase()).not.toContain("bravo");
      expect(r.findings.map((x) => x.fact_id).sort()).toEqual(["F-leads", "F-revenue"]);
    }
  });
  it.each([
    ["the other tenant's source label", `Check ${bravoRecords[0]!.source} for context.`],
    ["the other tenant's record id", `See ${bravoRecords[1]!.id} for context.`],
    ["the other tenant's source, zero-width obfuscated", `Check ${bravoRecords[0]!.source.replace("-", "​-")}.`],
    ["a source from a record that REUSES an authorized id", `Check ${bravoRecords.at(-1)!.source} for context.`],
  ])("model text naming %s is rejected as a leak, and the rejection names nothing", async (_n, text) => {
    quiet();
    const r = await runMeta({}, READY, fakeFetch(lane(text)) as never, runtime());
    expect(r.state).toBe("rejected");
    if (r.state === "rejected") {
      expect(r.categories).toEqual(["leak"]);
      const wire = JSON.stringify(r).toLowerCase();
      for (const s of BRAVO_STRINGS) expect(wire).not.toContain(s.toLowerCase());
      expect(wire).not.toContain("bravo");
    }
  });
  it("an unauthorized fact reference (the other tenant's metric) is rejected without naming it", async () => {
    quiet();
    const r = await runMeta({}, READY, fakeFetch(lane("Mix may matter.", ["F-cac"])) as never, runtime());
    expect(r.state).toBe("rejected");
    if (r.state === "rejected") expect(JSON.stringify(r).toLowerCase()).not.toContain("cac");
  });
  it("a policy that grants nothing sends nothing", async () => {
    const f = fakeFetch(lane("x"));
    const r = await runMeta({}, READY, f as never, runtime({ policy: allowWorkspaces({}) }));
    expect(r).toMatchObject({ state: "blocked", requestSent: false });
    expect(f).not.toHaveBeenCalled();
  });
  it("an actor the policy has never heard of (empty scope) sends nothing", async () => {
    const f = fakeFetch(lane("x"));
    const r = await runMeta({}, READY, f as never, runtime({ policy: allowWorkspaces({ someoneElse: ["ws-finance"] }) }));
    expect(r).toMatchObject({ state: "blocked", requestSent: false });
    expect(f).not.toHaveBeenCalled();
  });
  it("mixed authority inside the tenant: one workspace granted, the other's metric stays out of the prompt", async () => {
    quiet();
    const f = fakeFetch(lane("Mix may matter.", ["F-revenue"]));
    const r = await runMeta({}, READY, f as never, runtime({ policy: allowWorkspaces({ "acme-analyst": ["ws-finance"] }) }));
    expect(r.state).toBe("ok");
    const wire = JSON.stringify(sent(f));
    expect(wire).toContain("F-revenue");
    expect(wire).not.toContain("F-leads");
    expect(wire).not.toContain("ACME CRM");
    const leak = await runMeta({}, READY, fakeFetch(lane("Check ACME CRM Leads.")) as never, runtime({ policy: allowWorkspaces({ "acme-analyst": ["ws-finance"] }) }));
    expect(leak.state === "rejected" && leak.categories).toEqual(["leak"]);
  });
  it("two actors of one tenant with different grants get different, correctly scoped prompts", async () => {
    quiet();
    const policy = allowWorkspaces({ fin: ["ws-finance"], mkt: ["ws-marketing"] });
    const bodies: string[] = [];
    for (const actor of ["fin", "mkt"]) {
      const f = fakeFetch(lane("Mix may matter.", [actor === "fin" ? "F-revenue" : "F-leads"]));
      await runMeta({}, READY, f as never, runtime({ policy }, actor));
      bodies.push(JSON.stringify(sent(f)));
    }
    expect(bodies[0]).toContain("F-revenue"); expect(bodies[0]).not.toContain("F-leads");
    expect(bodies[1]).toContain("F-leads"); expect(bodies[1]).not.toContain("F-revenue");
  });
});

describe("bypass attempts and failures are refused with a generic result", () => {
  const quiet = () => { vi.spyOn(console, "info").mockImplementation(() => {}); vi.spyOn(console, "error").mockImplementation(() => {}); };
  const blocked = async (rt: EngineRuntime) => {
    quiet();
    const f = fakeFetch(lane("x"));
    const r = await runMeta({}, READY, f as never, rt);
    expect(f).not.toHaveBeenCalled();
    return r;
  };
  it("a resolver cannot inject a context: a forged ctx field is ignored and, with no credential, nothing is authenticated", async () => {
    const real = acme();
    for (const forged of [{ tenantId: ACME, actorId: "acme-analyst" }, { ...real }, JSON.parse(JSON.stringify(real)), Object.create(real), real]) {
      const r = await blocked(runtime({ resolve: () => ({ ok: true, ctx: forged, dataset: "x" }) as never }));
      expect(r).toEqual({ state: "blocked", reason: "Authorization failed; nothing sent.", requestSent: false });
    }
  });
  it("a policy scoped to another tenant sends nothing", async () => {
    const wrong: AccessPolicy<PrototypeEvidence> = { evidenceScope: () => ({ tenantId: BRAVO, permits: () => true }) };
    expect(await blocked(runtime({ policy: wrong }))).toMatchObject({ state: "blocked", reason: "Authorization failed; nothing sent." });
  });
  it("a policy or store that throws sends nothing and its message reaches neither the client nor the log", async () => {
    quiet();
    const secret = "db password hunter2 for tenant-bravo BRAVO-SECRET";
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    for (const rt of [
      runtime({ policy: { evidenceScope: () => { throw new Error(secret); } } }),
      runtime({ policy: { evidenceScope: (c) => ({ tenantId: c.tenantId, permits: () => { throw new Error(secret); } }) } }),
      runtime({ store: { candidates: () => { throw new Error(secret); } } }),
    ]) {
      const r = await runMeta({}, READY, fakeFetch(lane("x")) as never, rt);
      expect(r).toEqual({ state: "blocked", reason: "Authorization failed; nothing sent.", requestSent: false });
    }
    const logged = [...errSpy.mock.calls, ...infoSpy.mock.calls].flat().map((x) => (x instanceof Error ? `${x.name} ${x.message} ${x.stack}` : JSON.stringify(x) + String(x))).join(" ").toLowerCase();
    expect(logged).not.toMatch(/hunter2|bravo|secret/);
    expect(errSpy).toHaveBeenCalledWith("Evidence store error"); // proves the log is actually captured, so the check above is not vacuous
  });
  it("records without a tenant, or from another tenant, are never authorized even if the policy would permit them", async () => {
    const noTenant = { ...acmeRecords[0]!, id: "NT-1", tenantId: undefined } as never;
    const r = authorizeEvidenceFor2([noTenant, ...bravoRecords]);
    expect(r.authorized).toHaveLength(0);
    expect(r.withheld).toHaveLength(bravoRecords.length + 1);
  });
  it("the stages that prepare facts, prompts and validation refuse anything that did not come from authorizeEvidence", () => {
    const real = authorizeDemo({ scenarioId: "baseline", roleId: "exec" });
    const copies: [string, readonly PrototypeEvidence[]][] = [["spread", [...real.authorized]], ["filter", real.authorized.filter(() => true)], ["raw scenario records", SCENARIOS[0]!.records as PrototypeEvidence[]], ["withheld list", real.withheld]];
    for (const [name, bad] of copies) {
      expect(() => prepareMessages("q", bad as never), name).toThrow(AuthorizationError);
      expect(() => buildAuthorizedFacts(bad as never), name).toThrow(AuthorizationError);
      expect(() => computeAuthorizedFacts(bad as never, PROTOTYPE_CONTEXT), name).toThrow(AuthorizationError);
      expect(() => validateAuthorizedOutput("{}", bad as never, []), name).toThrow(AuthorizationError);
    }
    for (const [name, bad] of copies) expect(() => authorizedFactsBlockReason(bad as never), name).toThrow(AuthorizationError);
    expect(authorizedFactsBlockReason(real.authorized)).toBeNull();
    expect(() => prepareMessages("q", real.authorized)).not.toThrow();
    expect(buildAuthorizedFacts(real.authorized).length).toBeGreaterThan(0);
  });
  it("hidden records can be neither promoted nor edited through the withheld list", () => {
    const real = authorizeDemo({ scenarioId: "baseline", roleId: "finance" });
    expect(Object.isFrozen(real.withheld)).toBe(true);
    expect(() => (real.withheld as PrototypeEvidence[]).pop()).toThrow(TypeError);
    expect(real.authorized.every((e) => e.department === "Finance")).toBe(true);
  });
});
function authorizeEvidenceFor2(candidates: PrototypeEvidence[]) {
  return authorizeEvidence(testIdentity, acme(), permitAll, candidates);
}

describe("structure: the live path cannot reach raw evidence", () => {
  const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const adapter = strip(readFileSync("src/lib/athena/meta/adapter.server.ts", "utf8"));
  const runMetaBody = adapter.slice(adapter.indexOf("export async function runMeta"));
  it("runMeta uses only the authorization-checked stages", () => {
    for (const raw of ["buildMessages(", "buildVerifiedFacts(", "validateOutput(", "computeFacts(", "renderFindings(", "factsBlockReason(", "filterVisible(", "SCENARIOS", "ROLES", "workspacesForRole", "authorizedRecords("])
      expect(runMetaBody, raw).not.toContain(raw);
    for (const checked of ["authorizeEvidence(", "prepareMessages(", "validateAuthorizedOutput(", "authorizedFactsBlockReason("]) expect(runMetaBody, checked).toContain(checked);
  });
  it("the adapter takes its request, store, policy and vocabulary from the runtime, not from the prototype data module", () => {
    expect(adapter).not.toMatch(/^import (?!type)[^;]*from "\.\.\/data"/m); // type-only imports are fine
    expect(adapter).not.toContain("RequestSchema");
  });
  it("outside core/identity and tests, only the prototype adapter (the composition root) designates an identity adapter", async () => {
    const { readdirSync, statSync } = await import("node:fs");
    const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(`${d}/${f}`).isDirectory() ? walk(`${d}/${f}`) : [`${d}/${f}`]));
    const users = walk("src").filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\./.test(f) && /createIdentityBoundary/.test(readFileSync(f, "utf8")));
    expect(users.sort()).toEqual(["src/lib/athena/core/identity.ts", "src/lib/athena/prototypeAdapter.ts"]);
  });
  it("the browser bundle never imports the authorization or adapter modules", async () => {
    const { readdirSync, statSync } = await import("node:fs");
    const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(`${d}/${f}`).isDirectory() ? walk(`${d}/${f}`) : [`${d}/${f}`]));
    const client = [...walk("src/components"), ...walk("src/routes")].filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\./.test(f));
    for (const f of client) expect(readFileSync(f, "utf8"), f).not.toMatch(/core\/access|core\/identity|prototypeAdapter|createIdentityBoundary/);
  });
});
