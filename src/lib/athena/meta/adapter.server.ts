// Server-only analysis pipeline. Provider-neutral: it authenticates, authorizes, builds the prompt from authorized evidence only, makes
// exactly ONE request through a ModelProvider (no retries, engine-owned deadline, hard token budgets) and validates what comes back.
// Never executes approvals/actions: it only returns validated text. Provider specifics live in ./providers/*.
import { AuthorizationError, assertAuthorized, authorizeEvidence, type AccessPolicy, type AuthorizedEvidence, type EvidenceStore, type IdentityBoundary } from "../core/access";
import type { AnalysisContext } from "../core/facts";
import type { EvidenceRecord } from "../data";
import { DEMO_QUESTION, PROTOTYPE_CONTEXT } from "../engine";
import { demoAccessPolicy, demoEvidenceStore, demoIdentity, resolveDemoRequest, type PrototypeEvidence, type ResolvedRequest } from "../prototypeAdapter";
import { estimateTokens, prepareMessages, validateAuthorizedOutput, type MetaOutput } from "./contract";
import type { VerifiedFinding } from "./findings";
import { MAX_INPUT_TOKENS, MAX_OUTPUT_TOKENS, REQUEST_TIMEOUT_MS } from "./limits";
import { buildVerifiedFacts, uncoveredRecordIds } from "./numericGrounding";
import { OUTPUT_JSON_SCHEMA } from "./outputSchema";
import { blockCodeOf, cleanUsage, describeBlock, describeFailure, safeFailure, safeId, safeLabel, safeModel, safeStatus, safeThrownName } from "./providerBoundary";
import type { ModelOutcome, ModelProvider, ModelRequest, ModelUsage, ProviderEnv } from "./provider";
import { museSpark } from "./providers/muse";

/** Environment handed to the configured provider (opaque to the engine). Kept as an alias of the default provider's variables for existing callers. */
export type { MuseEnv as MetaEnv } from "./providers/muse";

export type MetaStatus = { keyConfigured: boolean; ownerEnabled: boolean; ready: boolean; model: string; maxInputTokens: number; maxOutputTokens: number };

export function metaStatus(env: ProviderEnv, provider: ModelProvider = museSpark): MetaStatus {
  const { keyConfigured, ownerEnabled } = safeStatus(provider, env);
  return { keyConfigured, ownerEnabled, ready: keyConfigured && ownerEnabled, model: safeModel(provider), maxInputTokens: MAX_INPUT_TOKENS, maxOutputTokens: MAX_OUTPUT_TOKENS };
}

// Kept for existing imports; the request format and response parsing now belong to the Muse Spark adapter.
export { buildBody, readUsage } from "./providers/muse";

export type MetaResult =
  | { state: "blocked"; reason: string; requestSent: false }
  | { state: "error"; reason: string; requestSent: boolean; usage?: Usage | undefined }
  | { state: "rejected"; errors: string[]; categories?: string[] | undefined; requestSent: true; usage?: Usage | undefined }
  // findings: verified, Athena-rendered on the server from authorized facts (no model text). output: unverified model lanes.
  | { state: "ok"; findings: VerifiedFinding[]; output: MetaOutput; requestSent: true; usage?: Usage | undefined; authorizedIds: string[] };
export type Usage = ModelUsage;

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
  /** Validate an UNVERIFIED request and extract the credential it carries plus a dataset selector. The only place client input is read.
   * It issues no identity: the credential is handed, unread, to `identity` for verification. */
  resolve(input: unknown): ResolvedRequest;
  /** The designated identity adapter: the only source of trusted contexts for this runtime. */
  identity: IdentityBoundary;
  /** A context whose assurance is "simulated" (nothing authenticated; the demo role picker) is refused unless this is true. A production runtime sets it false. */
  allowSimulatedIdentity: boolean;
  store: EvidenceStore<PrototypeEvidence>;
  policy: AccessPolicy<PrototypeEvidence>;
  analysis: AnalysisContext;
  question: string;
  /** The model provider. Replaceable: the pipeline sees only the neutral `ModelProvider` contract. */
  provider: ModelProvider;
}
export const PROTOTYPE_RUNTIME: EngineRuntime = { resolve: resolveDemoRequest, identity: demoIdentity, allowSimulatedIdentity: true, store: demoEvidenceStore, policy: demoAccessPolicy, analysis: PROTOTYPE_CONTEXT, question: DEMO_QUESTION, provider: museSpark };

const deepFreeze = <T>(x: T): T => { if (typeof x === "object" && x !== null && !Object.isFrozen(x)) { Object.freeze(x); for (const v of Object.values(x)) deepFreeze(v); } return x; };

export async function runMeta(input: unknown, env: ProviderEnv, fetchImpl: typeof fetch, runtime: EngineRuntime = PROTOTYPE_RUNTIME): Promise<MetaResult> {
  const provider = runtime.provider;
  const label = safeLabel(provider); // static, validated, and read before any request exists
  const notReady = blockCodeOf(provider, env); // missing credential, owner activation off, or anything unexpected: nothing else runs
  if (notReady) return { state: "blocked", reason: describeBlock(notReady, label), requestSent: false };
  const req = runtime.resolve(input);
  if (!req.ok) return { state: "blocked", reason: req.reason, requestSent: false };

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
  const unfit = authorizedFactsBlockReason(records);
  if (unfit) return { state: "blocked", reason: unfit, requestSent: false };
  const messages = prepareMessages(runtime.question, records, runtime.analysis);
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
