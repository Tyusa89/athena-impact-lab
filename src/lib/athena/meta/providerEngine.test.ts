import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIdentityBoundary, type IdentityVerifier, type VerifiedIdentity } from "../core/identity";
import type { AccessPolicy } from "../core/access";
import { METRIC_LABELS, ROLES, SCENARIOS, build } from "../data";
import { DEMO_QUESTION, PROTOTYPE_CONTEXT } from "../engine";
import type { PrototypeEvidence } from "../prototypeAdapter";
import { PROTOTYPE_RUNTIME, metaStatus, runMeta, type EngineRuntime } from "./adapter.server";
import { authorizedRecords, buildMessages } from "./contract";
import { MAX_INPUT_TOKENS, MAX_OUTPUT_TOKENS, REQUEST_TIMEOUT_MS } from "./limits";
import { OUTPUT_JSON_SCHEMA } from "./outputSchema";
import type { ModelOutcome, ModelProvider, ModelRequest, ProviderCall } from "./provider";
import { museSpark } from "./providers/muse";

// The engine against replaceable providers. No network and no real provider: every provider here is a local fake.
const READY = { META_MODEL_API_KEY: "test-key", META_MODEL_ENABLED: "true" };
const req = (roleId = "exec", scenarioId = "baseline") => ({ scenarioId, roleId, ownerConfirmed: true });
const goodOutput = (text = "Demand mix may matter.", refs = ["F-revenue"]) => JSON.stringify({ interpretations: [{ text, verified: false, refs }], missing_evidence: ["No channel attribution."], recommendations: [{ text: "Review the channel mix.", requires_human_approval: true, refs }] });
const usage = (over: object = {}) => ({ prompt_tokens: 900, completion_tokens: 200, max_tokens_sent: MAX_OUTPUT_TOKENS, ...over });

interface Spy { calls: { request: ModelRequest; call: ProviderCall }[] }
/** A provider that is NOT Muse Spark: it never touches a transport and returns whatever the test says. */
function fake(answer: (request: ModelRequest, call: ProviderCall) => unknown | Promise<unknown>, spy: Spy = { calls: [] }, over: Partial<ModelProvider> = {}): ModelProvider & Spy {
  return {
    id: "fake-provider", model: "fake-model-1", displayName: "Fake Provider",
    status: () => ({ keyConfigured: true, ownerEnabled: true }),
    blockedCode: () => null,
    async complete(request, call) { spy.calls.push({ request, call }); return (await answer(request, call)) as ModelOutcome; },
    ...over, calls: spy.calls,
  };
}
const withProvider = (provider: ModelProvider, over: Partial<EngineRuntime> = {}): EngineRuntime => ({ ...PROTOTYPE_RUNTIME, provider, ...over });
const completion = (content: string | null, over: object = {}) => ({ kind: "completion", content, truncated: false, usage: usage(), ...over });
const noFetch = (() => { throw new Error("the engine must not hand a provider a live transport it did not ask for"); }) as unknown as typeof fetch;

beforeEach(() => { vi.spyOn(console, "info").mockImplementation(() => {}); vi.spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("a second provider plugs in without touching the engine", () => {
  it("returns the same server-rendered findings and derived citations as Muse Spark would, for every role and scenario", async () => {
    for (const sc of SCENARIOS) for (const r of ROLES) {
      const auth = authorizedRecords({ scenarioId: sc.id, roleId: r.id });
      const first = auth.length ? `F-${auth[0]!.metric}` : "F-none";
      const p = fake(() => completion(goodOutput("Mix may matter.", [first])));
      const res = await runMeta(req(r.id, sc.id), READY, noFetch, withProvider(p));
      if (res.state === "blocked") continue;
      expect(res.state, `${sc.id}/${r.id}`).toBe("ok");
      const viaMuse = await runMeta(req(r.id, sc.id), READY, (async () => new Response(JSON.stringify({ choices: [{ message: { content: goodOutput("Mix may matter.", [first]) }, finish_reason: "stop" }], usage: { prompt_tokens: 900, completion_tokens: 200 } }), { status: 200 })) as never);
      if (res.state === "ok" && viaMuse.state === "ok") {
        expect(res.findings).toEqual(viaMuse.findings);
        expect(res.output).toEqual(viaMuse.output);
        expect(res.authorizedIds).toEqual(viaMuse.authorizedIds);
      }
    }
  });
  it("is told its own model name in status, with the engine's budgets", () => {
    expect(metaStatus(READY, fake(() => null, undefined, { model: "other-model" }))).toMatchObject({ ready: true, model: "other-model", maxInputTokens: MAX_INPUT_TOKENS, maxOutputTokens: MAX_OUTPUT_TOKENS });
    expect(metaStatus(READY).model).toBe("muse-spark-1.3"); // default stays Muse Spark
    expect(PROTOTYPE_RUNTIME.provider).toBe(museSpark);
  });
  it("uses that provider's blocked category with engine-owned wording, and sends nothing when it is not ready", async () => {
    for (const [code, text] of [["credential_missing", "Fake Provider server credential is not configured."], ["not_activated", "Fake Provider has not been activated by the owner."], ["unavailable", "Fake Provider is unavailable."]] as const) {
      const p = fake(() => completion(goodOutput()), undefined, { blockedCode: () => code });
      expect(await runMeta(req(), READY, noFetch, withProvider(p))).toEqual({ state: "blocked", reason: text, requestSent: false });
      expect(p.calls).toHaveLength(0);
    }
  });
});

describe("what a provider is given", () => {
  it("only a frozen request (messages, output cap, schema) and a call context (env, fetch, signal): no evidence, identity, tenant or store", async () => {
    const p = fake(() => completion(goodOutput()));
    await runMeta(req("finance"), READY, noFetch, withProvider(p));
    const { request, call } = p.calls[0]!;
    expect(Object.keys(request).sort()).toEqual(["maxOutputTokens", "messages", "responseSchema"]);
    expect(Object.keys(call).sort()).toEqual(["env", "fetch", "signal"]);
    expect(request.maxOutputTokens).toBe(MAX_OUTPUT_TOKENS);
    expect(request.responseSchema).toEqual(OUTPUT_JSON_SCHEMA);
    expect(Object.isFrozen(request) && Object.isFrozen(request.messages) && request.messages.every(Object.isFrozen)).toBe(true);
    expect(() => { (request.messages as unknown as { content: string }[])[0]!.content = "EVIL"; }).toThrow(TypeError);
    expect(() => { (request as { maxOutputTokens: number }).maxOutputTokens = 10 ** 9; }).toThrow(TypeError);
  });
  it("the prompt equals the one built from the caller's authorized records (provider swap does not change the prompt)", async () => {
    for (const r of ROLES) {
      const p = fake(() => completion(goodOutput("Mix.", [`F-${authorizedRecords({ scenarioId: "baseline", roleId: r.id })[0]!.metric}`])));
      await runMeta(req(r.id), READY, noFetch, withProvider(p));
      expect(p.calls[0]!.request.messages).toEqual(buildMessages(DEMO_QUESTION, authorizedRecords({ scenarioId: "baseline", roleId: r.id })));
    }
  });
  it("the golden prompt for every combination reaches the provider unchanged", async () => {
    const golden = JSON.parse(readFileSync("src/lib/athena/golden/combos.json", "utf8")).combos as Record<string, { messages: unknown; blockReason: string | null }>;
    for (const sc of SCENARIOS) for (const r of ROLES) {
      const g = golden[`${sc.id}/${r.id}`]!;
      if (g.blockReason) continue;
      const p = fake(() => completion(null));
      await runMeta(req(r.id, sc.id), READY, noFetch, withProvider(p));
      expect(p.calls[0]!.request.messages, `${sc.id}/${r.id}`).toEqual(g.messages);
    }
  });
  it("a restricted role's request contains no hidden id, source, metric label, fact id or department (data portion)", async () => {
    for (const sc of SCENARIOS) for (const r of ROLES.filter((x) => x.id !== "exec")) {
      const auth = authorizedRecords({ scenarioId: sc.id, roleId: r.id });
      const allowed = new Set(auth.map((e) => e.id));
      const hidden = sc.records.filter((x) => !allowed.has(x.id));
      const have = new Set(auth.map((e) => e.metric));
      const depts = new Set(auth.map((e) => e.department));
      const p = fake(() => completion(null));
      await runMeta(req(r.id, sc.id), READY, noFetch, withProvider(p));
      const wire = JSON.stringify(p.calls[0]!.request.messages.map((m) => m.content.replace(/^Question:.*\n/, ""))).toLowerCase();
      const forbidden = [...hidden.flatMap((x) => [x.id, x.source, ...(x.note ? [x.note] : [])]), ...[...new Set(hidden.map((x) => x.metric))].filter((m) => !have.has(m)).flatMap((m) => [`F-${m}`, METRIC_LABELS[m]]), ...["Marketing", "Sales", "Operations", "Finance"].filter((d) => !depts.has(d as never))];
      expect(forbidden.filter((x) => x && wire.includes(x.toLowerCase())), `${sc.id}/${r.id}`).toEqual([]);
    }
  });
  it("another tenant's evidence in the shared store never reaches a provider", async () => {
    const ACME = "tenant-acme", BRAVO = "tenant-bravo";
    const own = (t: string, prefix: string, rows: Parameters<typeof build>[1]) => build(prefix, rows).map((r) => ({ ...r, tenantId: t })) as PrototypeEvidence[];
    const acme = own(ACME, "AC", [["revenue", "Finance", "ws-finance", "ACME GL Revenue", 1000, 800, "USD"]]);
    const bravo = own(BRAVO, "BR", [["revenue", "Finance", "ws-finance", "BRAVO-SECRET Ledger", 9000, 9500, "USD"], ["cac", "Marketing", "ws-marketing", "BRAVO-SECRET Ads", 90, 120, "USD"]]);
    const verifier: IdentityVerifier = { assurance: "verified", verify: (c) => c as VerifiedIdentity | null };
    const policy: AccessPolicy<PrototypeEvidence> = { evidenceScope: (c) => ({ tenantId: c.tenantId, permits: () => true }) }; // over-shares on purpose
    const p = fake(() => completion(goodOutput()));
    const rt: EngineRuntime = { resolve: () => ({ ok: true, credential: { tenantId: ACME, actorId: "analyst" }, dataset: "d" }), identity: createIdentityBoundary(verifier), allowSimulatedIdentity: false, store: { candidates: () => [...acme, ...bravo] }, policy, analysis: PROTOTYPE_CONTEXT, question: DEMO_QUESTION, provider: p };
    expect((await runMeta({}, READY, noFetch, rt)).state).toBe("ok");
    const wire = JSON.stringify(p.calls[0]!.request);
    for (const s of ["BR-", "BRAVO", "F-cac", METRIC_LABELS.cac]) expect(wire).not.toContain(s);
    expect(wire).toContain("AC-FIN-001-Q3");
  });
  it("a provider is never reached when authentication or authorization fails", async () => {
    const p = fake(() => completion(goodOutput()));
    const down = createIdentityBoundary({ assurance: "verified", verify: () => { throw new Error("idp down"); } });
    expect(await runMeta(req(), READY, noFetch, withProvider(p, { identity: down }))).toMatchObject({ state: "blocked", reason: "Authorization failed; nothing sent." });
    expect(await runMeta(req("root"), READY, noFetch, withProvider(p))).toMatchObject({ state: "blocked" });
    expect(await runMeta(req(), READY, noFetch, withProvider(p, { allowSimulatedIdentity: false }))).toMatchObject({ state: "blocked" });
    expect(p.calls).toHaveLength(0);
  });
  it("an over-budget prompt is never sent to any provider", async () => {
    const p = fake(() => completion(goodOutput()));
    const huge = { ...PROTOTYPE_RUNTIME, question: "x".repeat(MAX_INPUT_TOKENS * 4), provider: p } as EngineRuntime;
    expect(await runMeta(req(), READY, noFetch, huge)).toMatchObject({ state: "blocked", reason: expect.stringContaining("exceeds budget") });
    expect(p.calls).toHaveLength(0);
  });
});

describe("a provider cannot generate verified facts, citations or authority", () => {
  const baseline = async () => { const p = fake(() => completion(goodOutput())); return runMeta(req(), READY, noFetch, withProvider(p)); };
  it("extra fields on the provider's result are ignored: findings and authorized ids come from the server", async () => {
    const honest = await baseline();
    const hostile = fake(() => ({ ...completion(goodOutput()), findings: [{ fact_id: "F-evil", text: "Revenue increased 900%" }], authorizedIds: ["EVIL-1"], verified: true, supporting_ids: ["EVIL-1"], citations: ["EVIL-1"], output: { interpretations: [] }, state: "ok" }));
    const res = await runMeta(req(), READY, noFetch, withProvider(hostile));
    expect(res.state).toBe("ok");
    if (res.state === "ok" && honest.state === "ok") {
      expect(res.findings).toEqual(honest.findings);
      expect(res.authorizedIds).toEqual(honest.authorizedIds);
      expect(res.output).toEqual(honest.output);
      expect(JSON.stringify(res)).not.toContain("EVIL");
    }
  });
  it.each([
    ["claims a lane is verified", JSON.stringify({ interpretations: [{ text: "Mix may matter.", verified: true, refs: ["F-revenue"] }], missing_evidence: [], recommendations: [] })],
    ["supplies its own citations", JSON.stringify({ interpretations: [{ text: "Mix may matter.", verified: false, refs: ["F-revenue"], supporting_ids: ["VH-FIN-001-Q3"] }], missing_evidence: [], recommendations: [] })],
    ["supplies legacy cited_ids", JSON.stringify({ interpretations: [{ text: "Mix may matter.", verified: false, refs: ["F-revenue"], cited_ids: ["VH-FIN-001-Q3"] }], missing_evidence: [], recommendations: [] })],
    ["brings its own verified findings", JSON.stringify({ findings: [{ fact_id: "F-revenue", text: "Revenue rose" }], interpretations: [], missing_evidence: [], recommendations: [] })],
    ["marks an action as not needing approval", JSON.stringify({ interpretations: [], missing_evidence: [], recommendations: [{ text: "Cut spend.", requires_human_approval: false, refs: ["F-revenue"] }] })],
    ["cites a fact it was never given", goodOutput("Mix may matter.", ["F-not-a-fact"])],
    ["invents a number", goodOutput("Revenue fell 40%.")],
    ["contradicts the verified direction", goodOutput("Revenue rose.")],
    ["claims causation", goodOutput("Delays caused the decline.")],
    ["is not JSON at all", "Revenue fell because of supply issues."],
  ])("output that %s is rejected, never shown", async (_n, content) => {
    const res = await runMeta(req(), READY, noFetch, withProvider(fake(() => completion(content))));
    expect(res.state).toBe("rejected");
    expect(res).not.toHaveProperty("output");
    expect(res).not.toHaveProperty("findings");
  });
  it("a hidden identifier in provider text is rejected as a leak, without echoing it", async () => {
    const hidden = SCENARIOS[0]!.records.find((r) => r.workspace === "ws-marketing")!;
    const res = await runMeta(req("finance"), READY, noFetch, withProvider(fake(() => completion(goodOutput(`See ${hidden.id} and ${hidden.source}.`)))));
    expect(res.state).toBe("rejected");
    expect(JSON.stringify(res)).not.toContain(hidden.id);
    expect(JSON.stringify(res)).not.toContain(hidden.source);
  });
  it("proposed actions stay non-executable: they carry requires_human_approval:true and nothing else", async () => {
    const res = await runMeta(req(), READY, noFetch, withProvider(fake(() => completion(goodOutput()))));
    expect(res.state === "ok" && res.output.recommendations.every((r) => r.requires_human_approval === true)).toBe(true);
    expect(res.state === "ok" && res.output.interpretations.every((i) => i.verified === false)).toBe(true);
  });
});

describe("budgets, one request, deadline and no retry hold for every provider", () => {
  it.each([
    ["a failure", () => ({ kind: "failure", code: "unknown" })],
    ["a rejected completion", () => completion("not json")],
    ["a truncated completion", () => completion("{", { truncated: true })],
    ["a thrown error", () => { throw new Error("kaboom"); }],
    ["garbage", () => "nonsense"],
    ["null", () => null],
  ])("%s is attempted exactly once and never retried", async (_n, answer) => {
    const p = fake(answer);
    await runMeta(req(), READY, noFetch, withProvider(p));
    expect(p.calls).toHaveLength(1);
  });
  it("a successful run calls the provider once", async () => {
    const p = fake(() => completion(goodOutput()));
    await runMeta(req(), READY, noFetch, withProvider(p));
    expect(p.calls).toHaveLength(1);
  });
  it("a provider that ignores the abort signal and never answers is ended by the engine at the deadline", async () => {
    vi.useFakeTimers();
    const p = fake(() => new Promise(() => {}));
    const pending = runMeta(req(), READY, noFetch, withProvider(p));
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 5);
    const res = await pending;
    expect(res).toEqual({ state: "error", reason: `Request timed out after ${REQUEST_TIMEOUT_MS} ms (not retried).`, requestSent: true });
    expect(p.calls[0]!.call.signal.aborted).toBe(true);
    expect(p.calls).toHaveLength(1);
  });
  it("an answer that arrives after the deadline is ignored", async () => {
    vi.useFakeTimers();
    const p = fake(() => new Promise((r) => setTimeout(() => r(completion(goodOutput())), REQUEST_TIMEOUT_MS + 1000)));
    const pending = runMeta(req(), READY, noFetch, withProvider(p));
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 5);
    expect(await pending).toMatchObject({ state: "error", reason: expect.stringContaining("timed out") });
    await vi.advanceTimersByTimeAsync(2000); // the late answer settles; nothing blows up
  });
  it("the signal is not aborted on a normal run", async () => {
    const p = fake(() => completion(goodOutput()));
    await runMeta(req(), READY, noFetch, withProvider(p));
    expect(p.calls[0]!.call.signal.aborted).toBe(false);
  });
  it("a provider that throws is reported by a known error class only: its message never reaches the user or the log", async () => {
    const errSpy = vi.spyOn(console, "error"), infoSpy = vi.spyOn(console, "info");
    const p = fake(() => { throw Object.assign(new TypeError("api key sk-live-123 and prompt text"), { name: "ProviderBoom" }); });
    const res = await runMeta(req(), READY, noFetch, withProvider(p));
    expect(res).toEqual({ state: "error", reason: "Provider error (not retried): unknown", requestSent: true });
    expect(JSON.stringify([res, ...errSpy.mock.calls, ...infoSpy.mock.calls])).not.toMatch(/sk-live|prompt text|ProviderBoom/);
  });
  it.each([["null", null], ["a string", "ok"], ["an unknown kind", { kind: "weird" }], ["a failure with no reason", { kind: "failure" }]])("an invalid provider result (%s) is an error, not a crash", async (_n, answer) => {
    const res = await runMeta(req(), READY, noFetch, withProvider(fake(() => answer)));
    expect(res.state).toBe("error");
  });
  it("output-token budget: a provider reporting more than the cap is rejected", async () => {
    const res = await runMeta(req(), READY, noFetch, withProvider(fake(() => completion(goodOutput(), { usage: usage({ completion_tokens: MAX_OUTPUT_TOKENS + 1 }) }))));
    expect(res).toMatchObject({ state: "rejected", errors: ["Output token budget exceeded"] });
  });
  it("truncation is rejected, and a missing text is rejected, with the engine's wording", async () => {
    expect(await runMeta(req(), READY, noFetch, withProvider(fake(() => completion("{", { truncated: true, usage: usage({ reasoning_tokens: 1900 }) }))))).toMatchObject({ state: "rejected", errors: [`Output truncated at token cap (max_tokens=${MAX_OUTPUT_TOKENS}; reasoning tokens 1900)`] });
    expect(await runMeta(req(), READY, noFetch, withProvider(fake(() => completion(null))))).toMatchObject({ state: "rejected", errors: ["Missing message content"] });
    for (const content of [5, {}, ["x"]]) expect(await runMeta(req(), READY, noFetch, withProvider(fake(() => completion(content as never))))).toMatchObject({ state: "rejected", errors: ["Missing message content"] });
  });
  it("usage is sanitised: unknown fields, strings, negatives and NaN are dropped and the cap shown is the engine's", async () => {
    const res = await runMeta(req(), READY, noFetch, withProvider(fake(() => completion(goodOutput(), { usage: { prompt_tokens: "900", completion_tokens: 200, total_tokens: -5, reasoning_tokens: Number.NaN, visible_output_tokens: 10, finish_reason: "stop", max_tokens_sent: 10 ** 9, secret: "sk-x", extra: { a: 1 } } }))));
    expect(res.state).toBe("ok");
    expect(res.state === "ok" && res.usage).toEqual({ max_tokens_sent: MAX_OUTPUT_TOKENS, completion_tokens: 200, visible_output_tokens: 10, finish_reason: "stop" });
  });
});

describe("structure: the engine is provider-neutral", () => {
  const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\/|(?<!:)\/\/[^\n]*/g, " ");
  it("the pipeline (runtime.ts) has no Muse-specific request, response or configuration code and imports no concrete provider", () => {
    const raw = readFileSync("src/lib/athena/meta/runtime.ts", "utf8");
    const src = strip(raw);
    expect(src.indexOf("export async function runAnalysis")).toBeGreaterThan(0);
    for (const muse of ["api.meta.ai", "Bearer", "response_format", "choices", "finish_reason ===", "reasoning_effort", "META_ENDPOINT", "META_MODEL_API_KEY", "META_MODEL_ENABLED", "Meta API returned", "completion_tokens_details", "museSpark", "providers/muse"]) expect(src, muse).not.toContain(muse);
  });
  it("adapter.server.ts is the one place the prototype and the default provider are chosen", () => {
    const raw = readFileSync("src/lib/athena/meta/adapter.server.ts", "utf8");
    expect(raw.split("\n").filter((l) => /^(import|export) .*providers\/muse/.test(l))).toHaveLength(3); // MetaEnv alias, buildBody/readUsage re-exports, the default provider
    expect(raw.match(/provider: museSpark/g)).toHaveLength(1);
    expect(raw.match(/museSpark/g)).toHaveLength(3); // the import, the default of metaStatus, and the prototype runtime: nowhere else
  });
  it("contract.ts only re-exports the Muse constants for compatibility and does not use them", () => {
    const src = strip(readFileSync("src/lib/athena/meta/contract.ts", "utf8"));
    const body = src.replace(/export \{[^}]*\} from "\.\/providers\/muse";/, "");
    for (const muse of ["META_ENDPOINT", "META_MODEL", "REASONING_EFFORT", "RESPONSE_FORMAT", "api.meta.ai"]) expect(body, muse).not.toContain(muse);
  });
});
