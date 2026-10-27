import { describe, expect, it, vi } from "vitest";
import { demoAccessPolicy } from "../prototypeAdapter";
import { PROTOTYPE_RUNTIME } from "./adapter.server";
import type { ModelProvider } from "./provider";
import { STRICT_REJECTION_REASON } from "./strictValidation";

// A validator FAULT is a rejection like any other: never a pass, never a distinguishable error, and nothing the fault says reaches the response or the sink.
const state = vi.hoisted(() => ({ fault: false }));
vi.mock("./strictValidation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./strictValidation")>();
  return { ...actual, validateStrictOutput: (...a: Parameters<typeof actual.validateStrictOutput>) => { if (state.fault) throw new Error("boom VH-FIN-001-Q2 Recognized revenue"); return actual.validateStrictOutput(...a); } };
});
import { runStrictAnalysis } from "./strictRuntime";

const provider = (): ModelProvider => ({ id: "fake", model: "fake-model", displayName: "Fake", status: () => ({ keyConfigured: true, ownerEnabled: true }), blockedCode: () => null,
  async complete() { return { kind: "completion", content: JSON.stringify({ interpretations: [{ text: "Lead volume rose.", verified: false, refs: ["F-leads"] }], missing_evidence: [], recommendations: [] }), truncated: false, usage: { max_tokens_sent: 2000 } }; } });
const go = async () => {
  const diag: string[][] = [];
  const r = await runStrictAnalysis({ scenarioId: "baseline", roleId: "marketing", ownerConfirmed: true }, { META_MODEL_API_KEY: "sk-test-not-real", META_MODEL_ENABLED: "true" }, fetch, { ...PROTOTYPE_RUNTIME, policy: demoAccessPolicy as never, provider: provider() }, { onDiagnostics: (c) => diag.push([...c]) });
  return { r, diag };
};

describe("strict runtime: a validator fault", () => {
  it("passes when the validator is healthy (control)", async () => {
    state.fault = false;
    expect((await go()).r.state).toBe("ok");
  });
  it("is the same public rejection, reported internally as 'unknown', with no fault text anywhere", async () => {
    state.fault = true;
    vi.spyOn(console, "info").mockImplementation(() => {});
    const { r, diag } = await go();
    state.fault = false;
    expect(JSON.stringify(r)).toBe(JSON.stringify({ state: "rejected", reason: STRICT_REJECTION_REASON, requestSent: true }));
    expect(diag).toEqual([["unknown"]]);
    expect(JSON.stringify([r, diag])).not.toMatch(/boom|VH-|Recognized/);
  });
});
