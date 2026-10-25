import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_OUTPUT_TOKENS } from "../limits";
import { OUTPUT_JSON_SCHEMA } from "../outputSchema";
import { CONTRACT_PROMPT, contractRequest, describeProviderContract, type ContractHarness, type ContractScenario } from "../providerContract";
import type { ModelRequest, ProviderEnv } from "../provider";
import { META_ENDPOINT, META_MODEL, REASONING_EFFORT, RESPONSE_FORMAT, buildBody, museSpark, readUsage } from "./muse";

// The Muse Spark adapter against a MOCKED transport. No live API calls.
const KEY = "sk-test-KEY-123456";
const ENV: ProviderEnv = { META_MODEL_API_KEY: KEY, META_MODEL_ENABLED: "true" };
const RESPONSE_TEXT = "RESPONSE-TEXT-marker-91b2";
const goodBody = (extra: object = {}) => ({ choices: [{ message: { content: JSON.stringify({ note: RESPONSE_TEXT }) }, finish_reason: "stop" }], usage: { prompt_tokens: 900, completion_tokens: 200, total_tokens: 1100, completion_tokens_details: { reasoning_tokens: 50 } }, ...extra });

function harness(scenario: ContractScenario): ContractHarness {
  let calls = 0;
  const f = (async (_url: string, init?: RequestInit) => {
    calls++;
    switch (scenario) {
      case "ok": return new Response(JSON.stringify(goodBody()), { status: 200 });
      case "http-error": return new Response(`upstream said: ${KEY} ${CONTRACT_PROMPT} ${RESPONSE_TEXT}`, { status: 500 });
      case "malformed-body": return new Response(`not json ${KEY} ${CONTRACT_PROMPT} ${RESPONSE_TEXT}`, { status: 200 });
      case "no-content": return new Response(JSON.stringify({ choices: [{ message: {}, finish_reason: "stop" }], usage: {} }), { status: 200 });
      case "truncated": return new Response(JSON.stringify(goodBody({ choices: [{ message: { content: "{" }, finish_reason: "length" }] })), { status: 200 });
      case "network-error": throw Object.assign(new TypeError(`connect failed for ${KEY} ${CONTRACT_PROMPT}`), { name: "TypeError" });
      case "hangs": return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    }
  }) as unknown as typeof fetch;
  return { provider: museSpark, env: ENV, fetch: f, transportCalls: () => calls, secrets: [KEY, CONTRACT_PROMPT, RESPONSE_TEXT] };
}
vi.spyOn(console, "error").mockImplementation(() => {});

describeProviderContract("muse-spark", harness, { ceiling: MAX_OUTPUT_TOKENS });

describe("muse-spark: request formatting", () => {
  afterEach(() => vi.restoreAllMocks());
  const capture = async (req: ModelRequest = contractRequest()) => {
    const f = vi.fn(async (..._a: unknown[]) => new Response(JSON.stringify(goodBody()), { status: 200 }));
    await museSpark.complete(req, { env: ENV, fetch: f as never, signal: new AbortController().signal });
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    return { url, init, body: JSON.parse(init.body as string) };
  };
  it("posts once to the Muse endpoint with bearer auth and the documented body", async () => {
    const { url, init, body } = await capture();
    expect(url).toBe(META_ENDPOINT);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" });
    expect(body).toEqual({ model: META_MODEL, messages: contractRequest().messages, max_tokens: 2000, reasoning_effort: REASONING_EFFORT, response_format: { type: "json_schema", json_schema: { name: "ContractSchema", schema: { type: "object" } } }, stream: false });
  });
  it("the credential is only ever in the Authorization header", async () => {
    const { init } = await capture();
    expect((init.body as string)).not.toContain(KEY);
  });
  it("uses the engine's schema in the structured-output envelope; for the real schema that is exactly RESPONSE_FORMAT", async () => {
    const { body } = await capture(contractRequest({ responseSchema: OUTPUT_JSON_SCHEMA }));
    expect(body.response_format).toEqual(RESPONSE_FORMAT);
  });
  it("clamps the cap to the engine limit but allows a smaller one", async () => {
    expect((await capture(contractRequest({ maxOutputTokens: 9_999_999 }))).body.max_tokens).toBe(MAX_OUTPUT_TOKENS);
    expect((await capture(contractRequest({ maxOutputTokens: 500 }))).body.max_tokens).toBe(500);
  });
  it("buildBody keeps its documented defaults", () => {
    expect(buildBody("m")).toEqual({ model: META_MODEL, messages: "m", max_tokens: MAX_OUTPUT_TOKENS, reasoning_effort: "minimal", response_format: RESPONSE_FORMAT, stream: false });
  });
  it("passes the engine's abort signal to the transport", async () => {
    const ctrl = new AbortController();
    const f = vi.fn(async (..._a: unknown[]) => new Response(JSON.stringify(goodBody()), { status: 200 }));
    await museSpark.complete(contractRequest(), { env: ENV, fetch: f as never, signal: ctrl.signal });
    expect((f.mock.calls[0]![1] as RequestInit).signal).toBe(ctrl.signal);
  });
});

describe("muse-spark: response parsing", () => {
  const complete = async (response: Response | (() => Promise<Response>)) => museSpark.complete(contractRequest(), { env: ENV, fetch: (async () => (typeof response === "function" ? response() : response)) as never, signal: new AbortController().signal });
  it("extracts content, stop reason and normalised usage including reasoning tokens", async () => {
    expect(await complete(new Response(JSON.stringify(goodBody()), { status: 200 }))).toEqual({
      kind: "completion", content: JSON.stringify({ note: RESPONSE_TEXT }), truncated: false,
      usage: { prompt_tokens: 900, completion_tokens: 200, total_tokens: 1100, reasoning_tokens: 50, visible_output_tokens: 150, finish_reason: "stop", max_tokens_sent: MAX_OUTPUT_TOKENS },
    });
  });
  it("readUsage omits what the provider did not report", () => {
    expect(readUsage({})).toEqual({ max_tokens_sent: MAX_OUTPUT_TOKENS });
    expect(readUsage({ usage: { completion_tokens: 5 } }, "stop")).toEqual({ max_tokens_sent: MAX_OUTPUT_TOKENS, completion_tokens: 5, finish_reason: "stop" });
  });
  it("non-string content is treated as no content", async () => {
    for (const content of [null, 5, { a: 1 }, ["x"], undefined]) {
      expect(await complete(new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }] }), { status: 200 }))).toMatchObject({ kind: "completion", content: null });
    }
  });
  it("only a 'length' stop reason marks truncation", async () => {
    for (const [reason, want] of [["length", true], ["stop", false], ["content_filter", false], [undefined, false]] as const)
      expect(await complete(new Response(JSON.stringify({ choices: [{ message: { content: "x" }, finish_reason: reason }] }), { status: 200 }))).toMatchObject({ truncated: want });
  });
  it("HTTP errors name only the status; the body is never echoed, and only the status is logged", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const o = await complete(new Response(`secret ${KEY}`, { status: 429 }));
    expect(o).toEqual({ kind: "failure", reason: "Meta API returned HTTP 429 (not retried)." });
    expect(JSON.stringify(errSpy.mock.calls)).not.toContain(KEY);
    expect(errSpy).toHaveBeenCalledWith("Meta API error status", 429);
    errSpy.mockRestore();
  });
  it("a body that cannot be read, or a transport that throws, is a failure naming only the error type", async () => {
    expect(await complete(() => Promise.reject(Object.assign(new Error(KEY), { name: "AbortError" })))).toEqual({ kind: "failure", reason: "Network error (not retried): AbortError" });
    expect(await complete(() => Promise.reject("weird"))).toEqual({ kind: "failure", reason: "Network error (not retried): unknown" });
    const broken = new Response(new ReadableStream({ start(c) { c.error(new Error(KEY)); } }), { status: 200 });
    const o = await complete(broken);
    expect(o.kind).toBe("failure");
    expect(JSON.stringify(o)).not.toContain(KEY);
  });
  it("malformed JSON is a failure with a fixed message", async () => {
    expect(await complete(new Response("{nope", { status: 200 }))).toEqual({ kind: "failure", reason: "Response body is not JSON." });
  });
});

describe("muse-spark: configuration", () => {
  it.each([
    [{ META_MODEL_API_KEY: KEY, META_MODEL_ENABLED: "true" }, { keyConfigured: true, ownerEnabled: true }, null],
    [{ META_MODEL_API_KEY: KEY }, { keyConfigured: true, ownerEnabled: false }, "Owner activation flag META_MODEL_ENABLED is not 'true'."],
    [{ META_MODEL_API_KEY: KEY, META_MODEL_ENABLED: "TRUE" }, { keyConfigured: true, ownerEnabled: false }, "Owner activation flag META_MODEL_ENABLED is not 'true'."],
    [{ META_MODEL_API_KEY: "   ", META_MODEL_ENABLED: "true" }, { keyConfigured: false, ownerEnabled: true }, "META_MODEL_API_KEY is not configured on the server."],
    [{ META_MODEL_ENABLED: "true" }, { keyConfigured: false, ownerEnabled: true }, "META_MODEL_API_KEY is not configured on the server."],
    [{}, { keyConfigured: false, ownerEnabled: false }, "META_MODEL_API_KEY is not configured on the server."],
  ] as const)("env %j", (env, status, blocked) => {
    expect(museSpark.status(env)).toEqual(status);
    expect(museSpark.blockedReason(env)).toBe(blocked);
  });
  it("identifies as the default Muse Spark provider", () => {
    expect([museSpark.id, museSpark.model]).toEqual(["muse-spark", "muse-spark-1.3"]);
  });
});
