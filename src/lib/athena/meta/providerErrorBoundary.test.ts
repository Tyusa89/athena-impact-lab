import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ROLES, SCENARIOS } from "../data";
import { PROTOTYPE_RUNTIME, metaStatus, runMeta, type EngineRuntime } from "./adapter.server";
import { authorizedRecords } from "./contract";
import { MAX_OUTPUT_TOKENS } from "./limits";
import { BLOCK_CODES, FAILURE_CODES, SAFE_ERROR_NAMES, SAFE_FINISH_REASONS, type ModelProvider, type ModelRequest, type ProviderCall } from "./provider";
import { blockCodeOf, cleanUsage, describeBlock, describeFailure, safeFailure, safeFinishReason, safeLabel, safeModel, safeThrownName } from "./providerBoundary";

// C1: provider-controlled text must never reach a client or a log. Every provider here is hostile and local; no network.
const CREDENTIAL = "sk-live-HOSTILE-KEY-9d8c71";
const READY = { META_MODEL_API_KEY: CREDENTIAL, META_MODEL_ENABLED: "true" };
const req = (roleId = "finance", scenarioId = "baseline") => ({ scenarioId, roleId, ownerConfirmed: true });
const noFetch = (() => { throw new Error("no transport"); }) as unknown as typeof fetch;

// What a hostile provider would love to smuggle out.
const hiddenRecord = SCENARIOS[0]!.records.find((r) => r.workspace === "ws-marketing")!; // invisible to the finance role
const HOSTILE = {
  credential: CREDENTIAL,
  prompt: "You analyse SYNTHETIC business facts for a fictional company. VERIFIED_FACTS (JSON): [{\"fact_id\":\"F-revenue\"}] PERIODS (JSON)",
  hiddenId: hiddenRecord.id,
  hiddenSource: hiddenRecord.source,
  script: "<script>alert('xss')</script>",
  logForge: "\n[2026-10-25T00:00:00Z] ERROR admin password reset OK\r\n",
  ansi: "\u001b[31mRED\u001b[0m ‮reversed",
  tenant: "tenant-bravo-SECRET",
  long: "A".repeat(100_000),
};
const MARKERS = [CREDENTIAL, "SYNTHETIC business facts", "VERIFIED_FACTS", hiddenRecord.id, hiddenRecord.source, "<script>", "alert(", "[ERROR]", "password reset", "\u001b", "‮", "tenant-bravo", "AAAAAAAAAAAAAAAAAAAA", "RED"];
const poison = (extra = "") => Object.values(HOSTILE).join(" | ") + extra;

class Capture {
  spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
  text() { return this.spies.flatMap((s) => s.mock.calls).flat().map((x) => (x instanceof Error ? `${x.name} ${x.message} ${x.stack}` : typeof x === "string" ? x : JSON.stringify(x))).join("\n"); }
  calls() { return this.spies.flatMap((s) => s.mock.calls); }
}
let cap: Capture;
beforeEach(() => { cap = new Capture(); });
afterEach(() => vi.restoreAllMocks());

const completionOf = (content: string) => ({ kind: "completion", content, truncated: false, usage: { max_tokens_sent: MAX_OUTPUT_TOKENS } });
function hostile(over: Partial<ModelProvider> = {}): ModelProvider & { calls: { request: ModelRequest; call: ProviderCall }[] } {
  const calls: { request: ModelRequest; call: ProviderCall }[] = [];
  const inner = over.complete ?? (async () => completionOf("{}") as never);
  return {
    id: "hostile", model: "hostile-model-1", displayName: "Hostile Co",
    status: () => ({ keyConfigured: true, ownerEnabled: true }),
    blockedCode: () => null,
    ...over,
    complete: (request, call) => { calls.push({ request, call }); return inner(request, call); }, // records every call, however `complete` is overridden
    calls,
  };
}
const run = async (p: ModelProvider, role = "finance") => runMeta(req(role), READY, noFetch, { ...PROTOTYPE_RUNTIME, provider: p } as EngineRuntime);
/** The entire client-visible surface plus every diagnostic, as one string. */
const surface = (result: unknown) => JSON.stringify(result) + "\n" + cap.text();
const expectClean = (result: unknown) => { const s = surface(result); for (const m of MARKERS) expect(s, `leaked ${JSON.stringify(m)}`).not.toContain(m); };

describe("C1: failure outcomes carry categories, never provider text", () => {
  const textFields = ["reason", "message", "error", "detail", "details", "description", "stack", "body", "response", "text", "info", "hint"];
  it.each(textFields)("a failure with the hostile text in `%s` is shown with fixed wording only", async (field) => {
    const p = hostile({ complete: async () => ({ kind: "failure", code: "unknown", [field]: poison() }) as never });
    const res = await run(p);
    expect(res).toEqual({ state: "error", reason: "Hostile Co request failed (not retried).", requestSent: true });
    expectClean(res);
    expect(p.calls).toHaveLength(1);
  });
  it("the legacy shape (a bare `reason`, no category) is not trusted either", async () => {
    const res = await run(hostile({ complete: async () => ({ kind: "failure", reason: poison() }) as never }));
    expect(res).toEqual({ state: "error", reason: "Hostile Co request failed (not retried).", requestSent: true });
    expectClean(res);
  });
  it.each([
    ["a secret as the category", poison()], ["an unknown category", "rate_limited"], ["a number", 7], ["null", null], ["an object", { toString: () => poison() }], ["an array", [poison()]], ["a proto key", "__proto__"], ["a near miss", "HTTP_ERROR"],
  ])("category given as %s becomes unknown", async (_n, code) => {
    const res = await run(hostile({ complete: async () => ({ kind: "failure", code }) as never }));
    expect(res).toEqual({ state: "error", reason: "Hostile Co request failed (not retried).", requestSent: true });
    expectClean(res);
  });
  it.each(FAILURE_CODES)("every known category has fixed engine wording: %s", async (code) => {
    const res = await run(hostile({ complete: async () => ({ kind: "failure", code, status: 503, errorName: "TypeError" }) as never }));
    const want = { http_error: "Hostile Co returned HTTP 503 (not retried).", network_error: "Network error (not retried): TypeError", malformed_response: "Response body is not JSON.", unavailable: "Hostile Co is unavailable (not retried).", unknown: "Hostile Co request failed (not retried)." }[code];
    expect(res).toEqual({ state: "error", reason: want, requestSent: true });
  });
  it.each([
    ["a status with text", `500; ${poison()}`], ["a status string", "500"], ["out of range low", 99], ["out of range high", 600], ["a float", 500.5], ["NaN", Number.NaN], ["Infinity", Infinity], ["negative", -500], ["a huge number", 1e21], ["an object", { valueOf: () => 500 }], ["an array", [500]], ["null", null],
  ])("an http_error status given as %s is dropped, not displayed", async (_n, status) => {
    const res = await run(hostile({ complete: async () => ({ kind: "failure", code: "http_error", status }) as never }));
    expect(res).toEqual({ state: "error", reason: "Hostile Co returned an HTTP error (not retried).", requestSent: true });
    expectClean(res);
  });
  it.each([200, 404, 429, 500, 503, 599, 100])("a valid status %i is shown as a number", async (status) => {
    const res = await run(hostile({ complete: async () => ({ kind: "failure", code: "http_error", status }) as never }));
    expect(res).toMatchObject({ reason: `Hostile Co returned HTTP ${status} (not retried).` });
  });
  it.each([
    ["a secret", poison()], ["a lookalike", "typeerror"], ["a script", "<script>"], ["an object", { name: poison() }], ["a number", 5], ["null", null], ["prototype pollution", "__proto__"],
  ])("a network_error class name given as %s is shown as unknown", async (_n, errorName) => {
    const res = await run(hostile({ complete: async () => ({ kind: "failure", code: "network_error", errorName }) as never }));
    expect(res).toEqual({ state: "error", reason: "Network error (not retried): unknown", requestSent: true });
    expectClean(res);
  });
  it.each(SAFE_ERROR_NAMES)("a known class name %s is shown", async (errorName) => {
    expect(await run(hostile({ complete: async () => ({ kind: "failure", code: "network_error", errorName }) as never }))).toMatchObject({ reason: `Network error (not retried): ${errorName}` });
  });
  it("metadata on the wrong category is ignored (status on a network error, class name on an http error)", async () => {
    expect(await run(hostile({ complete: async () => ({ kind: "failure", code: "network_error", status: 500, errorName: "TypeError" }) as never }))).toMatchObject({ reason: "Network error (not retried): TypeError" });
    expect(await run(hostile({ complete: async () => ({ kind: "failure", code: "http_error", errorName: poison() }) as never }))).toMatchObject({ reason: "Hostile Co returned an HTTP error (not retried)." });
  });
  it("getters, Proxies and toJSON on the failure object cannot smuggle text or crash the engine", async () => {
    const trap = { kind: "failure", get code() { return "unknown"; }, get reason() { throw new Error(poison()); }, toJSON() { return poison(); }, toString() { return poison(); } };
    const proxy = new Proxy({ kind: "failure", code: "unknown" }, { get: (t, k) => (k === "code" ? "unknown" : k === "kind" ? "failure" : typeof k === "string" ? poison() : undefined) });
    for (const o of [trap, proxy]) {
      const res = await run(hostile({ complete: async () => o as never }));
      expect(res).toMatchObject({ state: "error" });
      expectClean(res);
    }
  });
  it("the server log for a failure holds only the provider id, a category and a status number", async () => {
    await run(hostile({ complete: async () => ({ kind: "failure", code: "http_error", status: 502, reason: poison() }) as never }));
    expect(cap.calls()).toEqual([["Model provider error", JSON.stringify({ provider: "hostile", code: "http_error", status: 502 })]]);
  });
});

describe("C1: thrown provider errors cannot leak message, stack, name or custom properties", () => {
  const boom = (make: () => unknown) => hostile({ complete: async () => { throw make(); } });
  const cases: [string, () => unknown, string][] = [
    ["a message", () => new Error(poison()), "Error"],
    ["a hostile name", () => Object.assign(new Error("x"), { name: poison() }), "unknown"],
    ["a hostile stack", () => Object.assign(new Error("x"), { stack: poison() }), "Error"],
    ["custom properties", () => Object.assign(new Error("x"), { detail: poison(), response: poison(), config: { headers: { Authorization: `Bearer ${CREDENTIAL}` } } }), "Error"],
    ["a toString/toJSON override", () => Object.assign(new Error("x"), { toString: () => poison(), toJSON: () => poison() }), "Error"],
    ["a cause", () => new Error("x", { cause: new Error(poison()) }), "Error"],
    ["an aggregate", () => new AggregateError([new Error(poison())], poison()), "unknown"],
    ["a known class with a hostile message", () => new TypeError(poison()), "TypeError"],
    ["a string", () => poison(), "unknown"],
    ["a plain object", () => ({ name: "TypeError", message: poison() }), "TypeError"],
    ["an object with a hostile name", () => ({ name: poison() }), "unknown"],
    ["a name getter that throws", () => ({ get name(): string { throw new Error(poison()); } }), "unknown"],
    ["a Proxy that throws on every access", () => new Proxy({}, { get() { throw new Error(poison()); } }), "unknown"],
    ["null", () => null, "unknown"],
    ["undefined", () => undefined, "unknown"],
    ["a number", () => 42, "unknown"],
    ["a symbol", () => Symbol(poison()), "unknown"],
  ];
  it.each(cases)("%s", async (_n, make, name) => {
    const p = boom(make);
    const res = await run(p);
    expect(res).toEqual({ state: "error", reason: `Provider error (not retried): ${name}`, requestSent: true });
    expectClean(res);
    expect(cap.calls()).toEqual([["Model provider error", JSON.stringify({ provider: "hostile", code: "thrown" })]]);
    expect(p.calls).toHaveLength(1);
  });
  it("a provider that rejects after the deadline, with a hostile error, surfaces nothing", async () => {
    vi.useFakeTimers();
    const p = hostile({ complete: () => new Promise((_, rej) => setTimeout(() => rej(new Error(poison())), 40_000)) });
    const pending = run(p);
    await vi.advanceTimersByTimeAsync(31_000);
    const res = await pending;
    await vi.advanceTimersByTimeAsync(20_000);
    vi.useRealTimers();
    expect(res).toMatchObject({ state: "error", reason: expect.stringContaining("timed out") });
    expectClean(res);
  });
});

describe("C1: blocked-status categories", () => {
  it.each([
    ["credential_missing", "Hostile Co server credential is not configured."],
    ["not_activated", "Hostile Co has not been activated by the owner."],
    ["unavailable", "Hostile Co is unavailable."],
  ] as const)("%s -> fixed wording, nothing sent", async (code, text) => {
    const p = hostile({ blockedCode: () => code });
    expect(await run(p)).toEqual({ state: "blocked", reason: text, requestSent: false });
    expect(p.calls).toHaveLength(0);
  });
  it.each([
    ["the hostile text", () => poison()], ["a near-miss category", () => "CREDENTIAL_MISSING"], ["a number", () => 1], ["true", () => true], ["undefined", () => undefined], ["an object", () => ({ toString: () => poison() })],
    ["a legacy reason object", () => ({ reason: poison() })], ["a promise", () => Promise.resolve(poison())], ["a throw", () => { throw new Error(poison()); }], ["a proxy that throws", () => new Proxy({}, { get() { throw new Error(poison()); } })],
  ])("a blocked answer of %s blocks as 'unavailable' (fail closed) and shows nothing from the provider", async (_n, answer) => {
    const p = hostile({ blockedCode: answer as never });
    const res = await run(p);
    expect(res).toEqual({ state: "blocked", reason: "Hostile Co is unavailable.", requestSent: false });
    expectClean(res);
    expect(p.calls).toHaveLength(0);
  });
  it("the old `blockedReason` free-text method is not consulted at all", async () => {
    const p = hostile({ blockedCode: () => null, ...({ blockedReason: () => poison() } as object) });
    const res = await run(p);
    expect(res.state).toBe("rejected"); // ready, so the call went ahead (the stub's "{}" is not valid output)
    expect(p.calls).toHaveLength(1);
    expectClean(res);
  });
  it("describeBlock covers every category", () => {
    for (const c of BLOCK_CODES) expect(describeBlock(c, "X").length).toBeGreaterThan(0);
  });
});

describe("C1: static labels and status are validated and replaced when unsafe", () => {
  it.each([
    ["a hostile label", poison()], ["a multi-line label", "Meta API\n[ERROR] forged"], ["an ANSI label", "\u001b[31mMeta"], ["a long label", "A".repeat(33)], ["an empty label", ""], ["a script label", "<b>x</b>"], ["a non-string", 5],
  ])("displayName given as %s falls back to 'The model provider'", async (_n, displayName) => {
    const p = hostile({ displayName: displayName as never, blockedCode: () => "unavailable" });
    const res = await run(p);
    expect(res).toEqual({ state: "blocked", reason: "The model provider is unavailable.", requestSent: false });
    expectClean(res);
  });
  it("a displayName getter that throws or changes between reads cannot break or poison a response", async () => {
    let reads = 0;
    const flaky = hostile({ blockedCode: () => "unavailable" });
    Object.defineProperty(flaky, "displayName", { get() { reads++; if (reads > 1) throw new Error(poison()); return "Flaky"; } });
    expect(await run(flaky)).toEqual({ state: "blocked", reason: "Flaky is unavailable.", requestSent: false });
    const throwing = hostile({ blockedCode: () => "unavailable" });
    Object.defineProperty(throwing, "displayName", { get() { throw new Error(poison()); } });
    const res = await run(throwing);
    expect(res).toEqual({ state: "blocked", reason: "The model provider is unavailable.", requestSent: false });
    expectClean(res);
  });
  it("the status shown to the client has a validated model name and booleans only", () => {
    for (const model of [poison(), "x\ny", "a".repeat(65), "", 7, "<script>"]) {
      const s = metaStatus(READY, hostile({ model: model as never }));
      expect(s.model).toBe("unknown");
      expect(JSON.stringify(s)).not.toContain(CREDENTIAL);
    }
    expect(metaStatus(READY, hostile({ model: "good-model_1.3:x/y" })).model).toBe("good-model_1.3:x/y");
    expect(metaStatus(READY, hostile({ status: () => ({ keyConfigured: "yes", ownerEnabled: 1, secret: CREDENTIAL }) as never }))).toMatchObject({ keyConfigured: false, ownerEnabled: false, ready: false });
    expect(JSON.stringify(metaStatus(READY, hostile({ status: () => ({ keyConfigured: true, ownerEnabled: true, apiKey: CREDENTIAL }) as never })))).not.toContain(CREDENTIAL);
    expect(metaStatus(READY, hostile({ status: () => { throw new Error(poison()); } }))).toMatchObject({ keyConfigured: false, ownerEnabled: false, ready: false });
  });
  it("a hostile provider id appears in logs only after validation", async () => {
    await run(hostile({ id: poison(), complete: async () => ({ kind: "failure", code: "unknown" }) as never }));
    expect(cap.calls()).toEqual([["Model provider error", JSON.stringify({ provider: "unknown", code: "unknown" })]]);
  });
});

describe("C1: usage and stop reasons from a provider", () => {
  it.each([[poison()], ["other"], ["STOP"], [5], [{}], [["stop"]], [null]])("a stop reason of %j is shown as 'other'", async (finish) => {
    const res = await run(hostile({ complete: async () => ({ kind: "completion", content: null, truncated: false, usage: { max_tokens_sent: 1, finish_reason: finish } }) as never }));
    expect(res).toMatchObject({ state: "rejected", usage: { finish_reason: "other" } });
    expectClean(res);
  });
  it.each(SAFE_FINISH_REASONS)("a known stop reason %s passes through", (r) => expect(safeFinishReason(r)).toBe(r));
  it("other usage fields are numbers or dropped; unknown fields with text are never copied", () => {
    const u = cleanUsage({ prompt_tokens: 1, completion_tokens: "2", total_tokens: poison(), reasoning_tokens: -1, visible_output_tokens: Number.NaN, finish_reason: "stop", secret: CREDENTIAL, nested: { a: poison() } }, 2000);
    expect(u).toEqual({ max_tokens_sent: 2000, prompt_tokens: 1, finish_reason: "stop" });
  });
  it("usage is logged by the engine from sanitised values only", async () => {
    await run(hostile({ complete: async () => ({ kind: "completion", content: null, truncated: false, usage: { max_tokens_sent: 1, prompt_tokens: 5, finish_reason: poison(), secret: CREDENTIAL } }) as never }));
    expect(cap.text()).not.toContain(CREDENTIAL);
    expect(cap.text()).toContain('"finish_reason":"other"');
    expectClean({});
  });
});

describe("C1: the rest of the pipeline still holds with a hostile provider", () => {
  it("completion text is only ever validated model output: hostile text is rejected without echo", async () => {
    for (const text of [poison(), `Revenue fell. ${poison()}`, JSON.stringify({ interpretations: [{ text: poison(), verified: false, refs: ["F-revenue"] }], missing_evidence: [], recommendations: [] })]) {
      const res = await run(hostile({ complete: async () => completionOf(text) as never }));
      expect(res.state).toBe("rejected");
      expectClean(res);
    }
  });
  it("exactly one call and no retry for every hostile failure, throw and block", async () => {
    const answers: (() => unknown)[] = [() => ({ kind: "failure", code: "http_error", status: 500, reason: poison() }), () => { throw new Error(poison()); }, () => ({ kind: "weird", reason: poison() }), () => poison(), () => null];
    for (const a of answers) { const p = hostile({ complete: async () => a() as never }); await run(p); expect(p.calls).toHaveLength(1); }
  });
  it("authorization failures never reach the provider and say nothing from it", async () => {
    const p = hostile({ complete: async () => ({ kind: "failure", code: "unknown", reason: poison() }) as never });
    const res = await run(p, "root");
    expect(res).toMatchObject({ state: "blocked" });
    expect(p.calls).toHaveLength(0);
    expectClean(res);
  });
  it("the restricted role's own hidden records are the 'hidden id' in these tests (sanity: it is really hidden)", () => {
    expect(authorizedRecords({ scenarioId: "baseline", roleId: "finance" }).some((r) => r.id === hiddenRecord.id)).toBe(false);
    expect(ROLES.find((r) => r.id === "finance")!.workspaces).not.toContain(hiddenRecord.workspace);
  });
});

describe("providerBoundary helpers", () => {
  it("safeFailure, safeThrownName, safeLabel, safeModel, blockCodeOf, describeFailure", () => {
    expect(safeFailure(null)).toEqual({ code: "unknown" });
    expect(safeFailure({ code: "http_error", status: 500, errorName: "TypeError" })).toEqual({ code: "http_error", status: 500 });
    expect(safeFailure({ code: "network_error", errorName: "TypeError", status: 500 })).toEqual({ code: "network_error", errorName: "TypeError" });
    expect(safeThrownName(new TypeError("x"))).toBe("TypeError");
    expect(safeThrownName("TypeError")).toBe("unknown");
    expect(safeLabel(hostile({ displayName: "Ok Label-1.0" }))).toBe("Ok Label-1.0");
    expect(safeModel(hostile({ model: "m" }))).toBe("m");
    expect(blockCodeOf(hostile({ blockedCode: () => null }), {})).toBeNull();
    expect(describeFailure({ code: "http_error", status: 500 }, "P")).toBe("P returned HTTP 500 (not retried).");
  });
});
