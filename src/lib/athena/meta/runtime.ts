// Server-only analysis pipeline. PROVIDER-, DATASET- and PROTOTYPE-NEUTRAL: it authenticates, authorizes, builds the prompt from authorized evidence only,
// makes exactly ONE request through a ModelProvider (no retries, engine-owned deadline, hard token budgets) and validates what comes back.
// Everything it needs (identity adapter, evidence store, policy, catalog and periods, default question, provider) arrives in the `EngineRuntime`; it imports
// nothing from the prototype and no concrete provider. The prototype composition (and the Muse Spark default) live in ./adapter.server.
// Never executes approvals/actions: it only returns validated text.
import { AuthorizationError, assertAuthorized, authorizeEvidence, type AccessPolicy, type AuthorizedEvidence, type EvidenceStore, type IdentityBoundary } from "../core/access";
import type { Evidence, EvidenceLike } from "../core/evidence";
import type { AnalysisContext } from "../core/facts";
import { DEFAULT_PROMPT_SUBJECT, estimateTokens, prepareMessages, validateAuthorizedOutput, type MetaOutput } from "./analysis";
import { buildVerifiedFacts, uncoveredRecordIds } from "./grounding";
import { MAX_INPUT_TOKENS, MAX_OUTPUT_TOKENS, REQUEST_TIMEOUT_MS } from "./limits";
import { OUTPUT_JSON_SCHEMA } from "./outputSchema";
import { blockCodeOf, cleanUsage, describeBlock, describeFailure, safeFailure, safeId, safeLabel, safeModel, safeStatus, safeThrownName } from "./providerBoundary";
import type { ModelOutcome, ModelProvider, ModelRequest, ModelUsage, ProviderEnv } from "./provider";
import { validateQuestion } from "./question";
import type { VerifiedFinding } from "./render";

export type MetaStatus = { keyConfigured: boolean; ownerEnabled: boolean; ready: boolean; model: string; maxInputTokens: number; maxOutputTokens: number };

export function metaStatus(env: ProviderEnv, provider: ModelProvider): MetaStatus {
  const { keyConfigured, ownerEnabled } = safeStatus(provider, env);
  return { keyConfigured, ownerEnabled, ready: keyConfigured && ownerEnabled, model: safeModel(provider), maxInputTokens: MAX_INPUT_TOKENS, maxOutputTokens: MAX_OUTPUT_TOKENS };
}

export type MetaResult =
  | { state: "blocked"; reason: string; requestSent: false }
  | { state: "error"; reason: string; requestSent: boolean; usage?: Usage | undefined }
  | { state: "rejected"; errors: string[]; categories?: string[] | undefined; requestSent: true; usage?: Usage | undefined }
  // findings: verified, Athena-rendered on the server from authorized facts (no model text). output: unverified model lanes.
  | { state: "ok"; findings: VerifiedFinding[]; output: MetaOutput; requestSent: true; usage?: Usage | undefined; authorizedIds: string[] };
export type Usage = ModelUsage;

/** Facts-only prompting is allowed only when every authorized record is represented by a verified fact. Otherwise nothing is sent. */
export function factsBlockReason(records: readonly EvidenceLike[], ctx: AnalysisContext): string | null {
  const facts = buildVerifiedFacts(records, ctx);
  const uncovered = uncoveredRecordIds(records, facts);
  if (facts.length === 0) return "Authorized evidence yields no verified facts; nothing sent.";
  if (uncovered.length > 0) return `Authorized evidence cannot be fully represented as verified facts (${uncovered.length} record(s) unpaired); nothing sent.`;
  return null;
}

/** Everything the live path needs from the deployment: how a request becomes a trusted context, which evidence exists, who may see it,
 * and the business vocabulary. The default is the prototype's; a real deployment supplies its own (server-side) implementations. */
/** `factsBlockReason` for the live path: refuses evidence that did not come from `authorizeEvidence`. */
export function authorizedFactsBlockReason<E extends Evidence>(records: AuthorizedEvidence<E>, ctx: AnalysisContext): string | null {
  assertAuthorized(records);
  return factsBlockReason(records, ctx);
}

export interface EngineRuntime {
  /** Validate an UNVERIFIED request and extract the credential it carries plus a dataset selector. The only place client input is read.
   * It issues no identity: the credential is handed, unread, to `identity` for verification. */
  resolve(input: unknown): ResolvedRequest;
  /** The designated identity adapter: the only source of trusted contexts for this runtime. */
  identity: IdentityBoundary;
  /** A context whose assurance is "simulated" (nothing authenticated; the demo role picker) is refused unless this is true. A production runtime sets it false. */
  allowSimulatedIdentity: boolean;
  store: EvidenceStore<Evidence>;
  policy: AccessPolicy<Evidence>;
  /** The business vocabulary (catalog) and reporting periods this deployment analyses. */
  analysis: AnalysisContext;
  /** The DEFAULT analysis question, used when a request supplies none. Server configuration: trusted, not validated per request. */
  question: string;
  /** What the model is told it is looking at (a plain phrase). Defaults to the neutral "SYNTHETIC business facts for a fictional company". */
  promptSubject?: string;
  /** The model provider. Replaceable: the pipeline sees only the neutral `ModelProvider` contract. */
  provider: ModelProvider;
}
const deepFreeze = <T>(x: T): T => { if (typeof x === "object" && x !== null && !Object.isFrozen(x)) { Object.freeze(x); for (const v of Object.values(x)) deepFreeze(v); } return x; };

export type ResolvedRequest =
  | { ok: true; credential: unknown; dataset: string; /** An UNTRUSTED analysis question from the request, if it carried one. */ question?: unknown }
  | { ok: false; reason: string };

export async function runAnalysis(input: unknown, env: ProviderEnv, fetchImpl: typeof fetch, runtime: EngineRuntime): Promise<MetaResult> {
  const provider = runtime.provider;
  const label = safeLabel(provider); // static, validated, and read before any request exists
  const notReady = blockCodeOf(provider, env); // missing credential, owner activation off, or anything unexpected: nothing else runs
  if (notReady) return { state: "blocked", reason: describeBlock(notReady, label), requestSent: false };
  const req = runtime.resolve(input);
  if (!req.ok) return { state: "blocked", reason: req.reason, requestSent: false };
  // The question is untrusted input: validated before any evidence is touched, and never echoed back. Absent => the runtime's default.
  let question = runtime.question;
  if (req.question !== undefined) {
    const q = validateQuestion(req.question);
    if (!q.ok) return { state: "blocked", reason: `Invalid analysis question (${q.code}).`, requestSent: false };
    question = q.question;
  }

  // Authorization BEFORE anything else touches the evidence. Tenant isolation is enforced inside authorizeEvidence, not by the store or policy.
  let records, withheld;
  try {
    const ctx = await runtime.identity.authenticate(req.credential); // fails closed if verification is unavailable, malformed or slow
    if (ctx.assurance === "simulated" && !runtime.allowSimulatedIdentity) throw new AuthorizationError();
    ({ authorized: records, withheld } = authorizeEvidence(runtime.identity, ctx, runtime.policy, runtime.store.candidates(ctx, req.dataset)));
  } catch (e) {
    if (!(e instanceof AuthorizationError)) console.error("Evidence store error"); // category only: never the message, ids or labels
    return { state: "blocked", reason: "Authorization failed; nothing sent.", requestSent: false };
  }
  if (records.length === 0) return { state: "blocked", reason: "No records in authorized workspaces; nothing to send.", requestSent: false };
  const unfit = authorizedFactsBlockReason(records, runtime.analysis); // the runtime's own catalog and periods, not the prototype's
  if (unfit) return { state: "blocked", reason: unfit, requestSent: false };
  let messages;
  try {
    messages = prepareMessages(question, records, runtime.analysis, runtime.promptSubject ?? DEFAULT_PROMPT_SUBJECT);
  } catch {
    return { state: "blocked", reason: "Engine configuration error; nothing sent.", requestSent: false }; // e.g. an invalid prompt subject or catalog: fail closed, say nothing about it
  }
  const est = estimateTokens(JSON.stringify(messages));
  if (est > MAX_INPUT_TOKENS) return { state: "blocked", reason: `Estimated input ${est} tokens exceeds budget ${MAX_INPUT_TOKENS}.`, requestSent: false };

  // One deadline covers the whole provider call (request and full response). It is enforced HERE, not only via the abort signal, so a
  // provider that stalls or ignores the signal still ends at REQUEST_TIMEOUT_MS. Exactly one call; never retried, whatever it returns.
  // The provider gets only the finished messages (built from authorized evidence), the output cap and the schema. Nothing else.
  const request: ModelRequest = deepFreeze({ messages: messages.map((m) => ({ role: m.role, content: m.content })), maxOutputTokens: MAX_OUTPUT_TOKENS, responseSchema: OUTPUT_JSON_SCHEMA });
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { ctrl.abort(); reject(new Error("deadline")); }, REQUEST_TIMEOUT_MS);
  });
  deadline.catch(() => {}); // already handled here; still raceable below
  let outcome: ModelOutcome;
  try {
    outcome = await Promise.race([provider.complete(request, { env, fetch: fetchImpl, signal: ctrl.signal }), deadline]);
  } catch (e) {
    const timedOut = ctrl.signal.aborted;
    if (!timedOut) console.error("Model provider error", JSON.stringify({ provider: safeId(provider), code: "thrown" })); // category only
    return { state: "error", reason: timedOut ? `Request timed out after ${REQUEST_TIMEOUT_MS} ms (not retried).` : `Provider error (not retried): ${safeThrownName(e)}`, requestSent: true };
  } finally { clearTimeout(timer); }

  // Nothing a provider returns is trusted: only well-formed text, token counts and a truncation flag are read; the rest is ignored.
  if (typeof outcome !== "object" || outcome === null) return { state: "error", reason: "Provider returned an invalid response (not retried).", requestSent: true };
  if (outcome.kind === "failure") {
    // The client sees fixed engine wording for a CLOSED category (plus an HTTP status or known error class name). Free text from the provider is never read.
    const f = safeFailure(outcome);
    console.error("Model provider error", JSON.stringify({ provider: safeId(provider), code: f.code, ...(f.status !== undefined ? { status: f.status } : {}) })); // safe codes and numbers only
    return { state: "error", reason: describeFailure(f, label), requestSent: true };
  }
  if (outcome.kind !== "completion") return { state: "error", reason: "Provider returned an invalid response (not retried).", requestSent: true };
  const usage = cleanUsage(outcome.usage, MAX_OUTPUT_TOKENS);
  // Redacted diagnostic log: token accounting only, never key, prompt or content.
  console.info("Meta usage", JSON.stringify(usage));
  if ((usage.completion_tokens ?? 0) > MAX_OUTPUT_TOKENS) return { state: "rejected", errors: ["Output token budget exceeded"], requestSent: true, usage };
  if (outcome.truncated === true) return { state: "rejected", errors: [`Output truncated at token cap (max_tokens=${MAX_OUTPUT_TOKENS}; reasoning tokens ${usage.reasoning_tokens ?? "not reported"})`], requestSent: true, usage };
  if (typeof outcome.content !== "string") return { state: "rejected", errors: ["Missing message content"], requestSent: true, usage };

  const v = validateAuthorizedOutput(outcome.content, records, withheld, runtime.analysis);
  if (!v.ok) {
    console.info("Meta validation rejected", JSON.stringify({ categories: v.categories })); // safe codes only: never text, ids or labels
    return { state: "rejected", errors: v.errors, categories: v.categories, requestSent: true, usage };
  }
  return { state: "ok", findings: v.findings, output: v.output, requestSent: true, usage, authorizedIds: records.map((r) => r.id) };
}
