// The opt-in STRICT execution path (Phase H2.2): authorize -> scoped prompt (H2.1) -> one model call -> strict validation -> uniform public rejection.
// NOT ACTIVATED: nothing in the live runtime, the server functions, the workbench or the UI calls it, and no request field can reach it or change it. Whoever composes a server
// endpoint from it chooses the profile; a client cannot. It reuses the legacy path's authorization (`authorizeRequest`) and its single model call (`callModel`), so the one-call,
// one-deadline, no-retry and provider-error-boundary guarantees are the same code, not a copy.
import type { Evidence } from "../core/evidence";
import { DEFAULT_PROMPT_SUBJECT, estimateTokens, type MetaOutput } from "./analysis";
import { MAX_INPUT_TOKENS } from "./limits";
import { blockCodeOf, describeBlock, safeLabel } from "./providerBoundary";
import { authorizeRequest, callModel, type EngineRuntime, type MetaResult, type Usage } from "./runtime";
import type { ProviderEnv } from "./provider";
import type { VerifiedFinding } from "./render";
import { buildScopedMessages } from "./scopedPrompt";
import { strictRejection, validateStrictOutput, type DiagnosticCategory, type StrictRejection } from "./strictValidation";

export type StrictResult =
  | Extract<MetaResult, { state: "blocked" | "error" }>
  | StrictRejection
  | { state: "ok"; findings: VerifiedFinding[]; output: MetaOutput; requestSent: true; usage?: Usage | undefined; authorizedIds: string[] };

/** Options come from SERVER code only; `input` (the client's request) is never read for them. */
export interface StrictRunOptions {
  /** Receives the closed diagnostic categories of a rejection (server-side only). Categories are codes, never text, ids or labels. */
  onDiagnostics?: (categories: readonly DiagnosticCategory[]) => void;
}

export async function runStrictAnalysis(input: unknown, env: ProviderEnv, fetchImpl: typeof fetch, runtime: EngineRuntime, opts: StrictRunOptions = {}): Promise<StrictResult> {
  const provider = runtime.provider;
  const label = safeLabel(provider);
  const notReady = blockCodeOf(provider, env);
  if (notReady) return { state: "blocked", reason: describeBlock(notReady, label), requestSent: false };
  const prep = await authorizeRequest(input, runtime);
  if (!prep.ok) return { state: "blocked", reason: prep.reason, requestSent: false };
  const { records, withheld, question, discoverableMetrics } = prep;
  let messages;
  try {
    messages = buildScopedMessages(question, records, runtime.analysis, discoverableMetrics, runtime.promptSubject ?? DEFAULT_PROMPT_SUBJECT);
  } catch {
    return { state: "blocked", reason: "Engine configuration error; nothing sent.", requestSent: false };
  }
  const est = estimateTokens(JSON.stringify(messages));
  if (est > MAX_INPUT_TOKENS) return { state: "blocked", reason: `Estimated input ${est} tokens exceeds budget ${MAX_INPUT_TOKENS}.`, requestSent: false };

  const reject = (cats: readonly DiagnosticCategory[]): StrictRejection => {
    console.info("Strict validation rejected", JSON.stringify({ categories: cats })); // closed codes only: never text, ids or labels
    try { opts.onDiagnostics?.([...cats]); } catch { /* a diagnostics sink can never change the response */ }
    return strictRejection();
  };
  const call = await callModel(provider, label, messages, env, fetchImpl);
  if (!call.ok) return call.result.state === "rejected" ? reject(["provider"]) : call.result; // truncation, budget and empty replies are rejections like any other; transport errors keep the fixed engine wording
  let v;
  try {
    v = validateStrictOutput(call.content, records, withheld, runtime.analysis, discoverableMetrics);
  } catch {
    return reject(["unknown"]); // a validator fault is a rejection, never a pass and never a distinguishable error
  }
  if (!v.ok) return reject(v.diagnostics);
  return { state: "ok", findings: v.findings, output: v.output, requestSent: true, usage: call.usage, authorizedIds: records.map((r: Evidence) => r.id) };
}
