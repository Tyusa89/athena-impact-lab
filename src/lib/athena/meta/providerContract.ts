// Reusable contract tests for ANY ModelProvider adapter (not a test file itself: import `describeProviderContract` from a *.test.ts).
// A new adapter proves it honours the neutral contract by supplying a factory that builds the provider over a MOCKED transport for each scenario.
// No live API calls: the transport is always the fake the factory returns.
import { describe, expect, it } from "vitest";
import type { ModelOutcome, ModelProvider, ModelRequest, ProviderEnv } from "./provider";

export type ContractScenario = "ok" | "http-error" | "malformed-body" | "no-content" | "truncated" | "network-error" | "hangs";
export interface ContractHarness {
  provider: ModelProvider;
  /** A configured environment (credential present, owner activation on). */
  env: ProviderEnv;
  /** The fake transport the provider was built over. */
  fetch: typeof fetch;
  /** How many times the provider used the transport. */
  transportCalls(): number;
  /** Every string that must never appear in a user-visible failure reason: the credential, the prompt and any response text. */
  secrets: string[];
}
export const CONTRACT_PROMPT = "PROMPT-MARKER-7f3a";
export const contractRequest = (over: Partial<ModelRequest> = {}): ModelRequest => ({
  messages: [{ role: "system", content: "You analyse facts." }, { role: "user", content: CONTRACT_PROMPT }],
  maxOutputTokens: 2000,
  responseSchema: { name: "ContractSchema", schema: { type: "object" } },
  ...over,
});

export function describeProviderContract(name: string, make: (scenario: ContractScenario) => ContractHarness, options: { ceiling?: number } = {}) {
  const ceiling = options.ceiling ?? 2000;
  const run = async (scenario: ContractScenario, request = contractRequest(), signal = new AbortController().signal) => {
    const h = make(scenario);
    const outcome = await h.provider.complete(request, { env: h.env, fetch: h.fetch, signal });
    return { h, outcome };
  };
  describe(`provider contract: ${name}`, () => {
    it("identifies itself", () => {
      const { provider } = make("ok");
      expect(provider.id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
      expect(provider.model.length).toBeGreaterThan(0);
    });
    it("reports status and blocked reasons without ever returning the credential", () => {
      const h = make("ok");
      expect(h.provider.status(h.env)).toEqual({ keyConfigured: true, ownerEnabled: true });
      expect(h.provider.blockedReason(h.env)).toBeNull();
      const none = h.provider.blockedReason({});
      expect(typeof none).toBe("string");
      expect(h.provider.status({})).toEqual({ keyConfigured: false, ownerEnabled: false });
      for (const s of h.secrets) expect(JSON.stringify([none, h.provider.status(h.env)])).not.toContain(s);
    });
    it("a successful call returns a completion with text, a truncation flag and well-formed usage", async () => {
      const { outcome, h } = await run("ok");
      expect(outcome.kind).toBe("completion");
      if (outcome.kind !== "completion") return;
      expect(typeof outcome.content).toBe("string");
      expect(outcome.truncated).toBe(false);
      expect(outcome.usage.max_tokens_sent).toBeLessThanOrEqual(ceiling);
      for (const [k, v] of Object.entries(outcome.usage)) if (k !== "finish_reason") expect(Number.isFinite(v), k).toBe(true);
      expect(h.transportCalls()).toBe(1); // exactly one request, no retry
    });
    it("never sends a larger output cap than the engine allows", async () => {
      const { outcome } = await run("ok", contractRequest({ maxOutputTokens: 10_000_000 }));
      expect(outcome.kind === "completion" && outcome.usage.max_tokens_sent).toBeLessThanOrEqual(ceiling);
    });
    it("a reply with no text is a completion with content null, not an exception", async () => {
      const { outcome } = await run("no-content");
      expect(outcome).toMatchObject({ kind: "completion", content: null });
    });
    it("a reply cut off at the output cap is flagged truncated", async () => {
      const { outcome } = await run("truncated");
      expect(outcome).toMatchObject({ kind: "completion", truncated: true });
    });
    it.each<ContractScenario>(["http-error", "malformed-body", "network-error"])("%s is a failure value (never thrown), tried once, and its reason leaks nothing", async (scenario) => {
      const { outcome, h } = await run(scenario);
      expect(outcome.kind).toBe("failure");
      const reason = (outcome as Extract<ModelOutcome, { kind: "failure" }>).reason;
      expect(typeof reason).toBe("string");
      expect(reason.length).toBeGreaterThan(0);
      expect(reason.length).toBeLessThan(300);
      for (const s of h.secrets) expect(reason).not.toContain(s);
      expect(h.transportCalls()).toBe(1); // no retry after a failure
    });
    it("honours the abort signal: a call that never answers ends once it is aborted", async () => {
      const h = make("hangs");
      const ctrl = new AbortController();
      const started = h.provider.complete(contractRequest(), { env: h.env, fetch: h.fetch, signal: ctrl.signal });
      setTimeout(() => ctrl.abort(), 20);
      const settled = await Promise.race([started.then((o) => o, (e) => ({ thrown: e })), new Promise((r) => setTimeout(() => r("STILL-RUNNING"), 2000))]);
      expect(settled).not.toBe("STILL-RUNNING");
      expect(h.transportCalls()).toBe(1);
    });
    it("does not mutate the request it was given", async () => {
      const req = contractRequest();
      const before = JSON.stringify(req);
      await run("ok", req);
      expect(JSON.stringify(req)).toBe(before);
    });
  });
}
