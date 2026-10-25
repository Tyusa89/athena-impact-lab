// Server-only Meta adapter. Exactly one request, no retries, hard token budget.
// Never executes approvals/actions: it only returns validated text.
import { AuthorizationError, assertAuthorized, authorizeEvidence, type AccessPolicy, type AuthorizedEvidence, type EvidenceStore, type TrustedContext } from "../core/access";
import type { AnalysisContext } from "../core/facts";
import type { EvidenceRecord } from "../data";
import { DEMO_QUESTION, PROTOTYPE_CONTEXT } from "../engine";
import { demoAccessPolicy, demoEvidenceStore, resolveDemoRequest, type PrototypeEvidence, type ResolvedRequest } from "../prototypeAdapter";
import {
  META_ENDPOINT, META_MODEL, MAX_INPUT_TOKENS, MAX_OUTPUT_TOKENS, REASONING_EFFORT, REQUEST_TIMEOUT_MS, RESPONSE_FORMAT,
  estimateTokens, prepareMessages, validateAuthorizedOutput, type MetaOutput,
} from "./contract";
import type { VerifiedFinding } from "./findings";
import { buildVerifiedFacts, uncoveredRecordIds } from "./numericGrounding";

export interface MetaEnv { META_MODEL_API_KEY?: string | undefined; META_MODEL_ENABLED?: string | undefined }

export type MetaStatus = { keyConfigured: boolean; ownerEnabled: boolean; ready: boolean; model: string; maxInputTokens: number; maxOutputTokens: number };

export function metaStatus(env: MetaEnv): MetaStatus {
  const keyConfigured = !!env.META_MODEL_API_KEY && env.META_MODEL_API_KEY.trim().length > 0;
  const ownerEnabled = env.META_MODEL_ENABLED === "true";
  return { keyConfigured, ownerEnabled, ready: keyConfigured && ownerEnabled, model: META_MODEL, maxInputTokens: MAX_INPUT_TOKENS, maxOutputTokens: MAX_OUTPUT_TOKENS };
}

export type MetaResult =
  | { state: "blocked"; reason: string; requestSent: false }
  | { state: "error"; reason: string; requestSent: boolean; usage?: Usage | undefined }
  | { state: "rejected"; errors: string[]; categories?: string[] | undefined; requestSent: true; usage?: Usage | undefined }
  // findings: verified, Athena-rendered on the server from authorized facts (no model text). output: unverified model lanes.
  | { state: "ok"; findings: VerifiedFinding[]; output: MetaOutput; requestSent: true; usage?: Usage | undefined; authorizedIds: string[] };
export type Usage = { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; reasoning_tokens?: number; visible_output_tokens?: number; finish_reason?: string; max_tokens_sent: number };

/** Build the outbound body. Exported for tests; the cap is clamped to the hard server constant. */
export function buildBody(messages: unknown) {
  return { model: META_MODEL, messages, max_tokens: MAX_OUTPUT_TOKENS, reasoning_effort: REASONING_EFFORT, response_format: RESPONSE_FORMAT, stream: false };
}

export function readUsage(body: { usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } } }, finish?: string): Usage {
  const u = body.usage ?? {};
  const r = u.completion_tokens_details?.reasoning_tokens;
  const out: Usage = { max_tokens_sent: MAX_OUTPUT_TOKENS };
  if (u.prompt_tokens !== undefined) out.prompt_tokens = u.prompt_tokens;
  if (u.completion_tokens !== undefined) out.completion_tokens = u.completion_tokens;
  if (u.total_tokens !== undefined) out.total_tokens = u.total_tokens;
  if (r !== undefined) { out.reasoning_tokens = r; if (u.completion_tokens !== undefined) out.visible_output_tokens = u.completion_tokens - r; }
  if (finish) out.finish_reason = finish;
  return out;
}

/** Facts-only prompting is allowed only when every authorized record is represented by a verified fact. Otherwise nothing is sent. */
export function factsBlockReason(records: readonly EvidenceRecord[]): string | null {
  const facts = buildVerifiedFacts(records);
  const uncovered = uncoveredRecordIds(records, facts);
  if (facts.length === 0) return "Authorized evidence yields no verified facts; nothing sent.";
  if (uncovered.length > 0) return `Authorized evidence cannot be fully represented as verified facts (${uncovered.length} record(s) unpaired); nothing sent.`;
  return null;
}

/** Everything the live path needs from the deployment: how a request becomes a trusted context, which evidence exists, who may see it,
 * and the business vocabulary. The default is the prototype's; a real deployment supplies its own (server-side) implementations. */
/** `factsBlockReason` for the live path: refuses evidence that did not come from `authorizeEvidence`. */
export function authorizedFactsBlockReason(records: AuthorizedEvidence<PrototypeEvidence>): string | null {
  assertAuthorized(records);
  return factsBlockReason(records);
}

export interface EngineRuntime {
  /** Turn an UNVERIFIED request into a trusted context and a dataset selector. The only place client input is read. */
  resolve(input: unknown): ResolvedRequest;
  store: EvidenceStore<PrototypeEvidence>;
  policy: AccessPolicy<PrototypeEvidence>;
  analysis: AnalysisContext;
  question: string;
}
export const PROTOTYPE_RUNTIME: EngineRuntime = { resolve: resolveDemoRequest, store: demoEvidenceStore, policy: demoAccessPolicy, analysis: PROTOTYPE_CONTEXT, question: DEMO_QUESTION };

export async function runMeta(input: unknown, env: MetaEnv, fetchImpl: typeof fetch, runtime: EngineRuntime = PROTOTYPE_RUNTIME): Promise<MetaResult> {
  const st = metaStatus(env);
  if (!st.keyConfigured) return { state: "blocked", reason: "META_MODEL_API_KEY is not configured on the server.", requestSent: false };
  if (!st.ownerEnabled) return { state: "blocked", reason: "Owner activation flag META_MODEL_ENABLED is not 'true'.", requestSent: false };
  const req = runtime.resolve(input);
  if (!req.ok) return { state: "blocked", reason: req.reason, requestSent: false };

  // Authorization BEFORE anything else touches the evidence. Tenant isolation is enforced inside authorizeEvidence, not by the store or policy.
  let ctx: TrustedContext, records, withheld;
  try {
    ctx = req.ctx;
    ({ authorized: records, withheld } = authorizeEvidence(ctx, runtime.policy, runtime.store.candidates(ctx, req.dataset)));
  } catch (e) {
    if (!(e instanceof AuthorizationError)) console.error("Evidence store error"); // category only: never the message, ids or labels
    return { state: "blocked", reason: "Authorization failed; nothing sent.", requestSent: false };
  }
  if (records.length === 0) return { state: "blocked", reason: "No records in authorized workspaces; nothing to send.", requestSent: false };
  const unfit = authorizedFactsBlockReason(records);
  if (unfit) return { state: "blocked", reason: unfit, requestSent: false };
  const messages = prepareMessages(runtime.question, records, runtime.analysis);
  const est = estimateTokens(JSON.stringify(messages));
  if (est > MAX_INPUT_TOKENS) return { state: "blocked", reason: `Estimated input ${est} tokens exceeds budget ${MAX_INPUT_TOKENS}.`, requestSent: false };

  // One deadline covers the request AND the full response body. It is enforced here (not only via the abort signal) so a
  // stalled body or a fetch that ignores the signal still ends at REQUEST_TIMEOUT_MS. Exactly one attempt; never retried.
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { ctrl.abort(); reject(new Error("deadline")); }, REQUEST_TIMEOUT_MS);
  });
  deadline.catch(() => {}); // already handled here; still raceable below
  let res: Response | undefined;
  let raw = "";
  try {
    res = await Promise.race([
      fetchImpl(META_ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${env.META_MODEL_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify(buildBody(messages)),
        signal: ctrl.signal,
      }),
      deadline,
    ]);
    if (res.ok) raw = await Promise.race([res.text(), deadline]);
  } catch (e) {
    void res?.body?.cancel().catch(() => {});
    const timedOut = ctrl.signal.aborted;
    return { state: "error", reason: timedOut ? `Request timed out after ${REQUEST_TIMEOUT_MS} ms (not retried).` : `Network error (not retried): ${e instanceof Error ? e.name : "unknown"}`, requestSent: true };
  } finally { clearTimeout(timer); }

  if (!res.ok) {
    console.error("Meta API error status", res.status);
    return { state: "error", reason: `Meta API returned HTTP ${res.status} (not retried).`, requestSent: true };
  }
  let body: { choices?: { message?: { content?: unknown }; finish_reason?: string }[]; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } } };
  try { body = JSON.parse(raw); } catch { return { state: "error", reason: "Response body is not JSON.", requestSent: true }; }
  const choice = body.choices?.[0];
  const usage = readUsage(body, choice?.finish_reason);
  // Redacted diagnostic log: token accounting only, never key, prompt or content.
  console.info("Meta usage", JSON.stringify(usage));
  if ((usage.completion_tokens ?? 0) > MAX_OUTPUT_TOKENS) return { state: "rejected", errors: ["Output token budget exceeded"], requestSent: true, usage };
  if (choice?.finish_reason === "length") return { state: "rejected", errors: [`Output truncated at token cap (max_tokens=${MAX_OUTPUT_TOKENS}; reasoning tokens ${usage.reasoning_tokens ?? "not reported"})`], requestSent: true, usage };
  if (typeof choice?.message?.content !== "string") return { state: "rejected", errors: ["Missing message content"], requestSent: true, usage };

  const v = validateAuthorizedOutput(choice.message.content, records, withheld, runtime.analysis);
  if (!v.ok) {
    console.info("Meta validation rejected", JSON.stringify({ categories: v.categories })); // safe codes only: never text, ids or labels
    return { state: "rejected", errors: v.errors, categories: v.categories, requestSent: true, usage };
  }
  return { state: "ok", findings: v.findings, output: v.output, requestSent: true, usage, authorizedIds: records.map((r) => r.id) };
}
