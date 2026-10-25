// Provider-neutral model interface. Pure types, no vendor, no I/O, no knowledge of evidence, tenants, identity or the catalog.
//
// What a provider is: a transport. It receives a finished request (messages the engine built from AUTHORIZED evidence only) and
// returns text plus token accounting. It never sees records, citations, tenants, identities or the evidence store, so it cannot
// widen what is sent, and nothing it returns is trusted: the engine extracts only `content` and validates it from scratch
// (strict schema, numeral policy, semantic guards, leak check). Verified findings and citations are rendered by the engine from the
// server's own facts; a provider cannot supply, alter or add to them.
//
// What the engine guarantees to every provider: exactly one `complete` call per request, no retry, one deadline over the whole call
// (enforced by the engine even if the provider ignores the abort signal), the same input and output budgets, and a frozen request.

export interface ModelMessage {
  readonly role: "system" | "user";
  readonly content: string;
}

export interface ModelRequest {
  readonly messages: readonly ModelMessage[];
  /** Hard output cap, including any hidden reasoning tokens. A provider must not send a larger cap. */
  readonly maxOutputTokens: number;
  /** The JSON Schema the reply must satisfy. A provider wraps it in its own structured-output envelope. */
  readonly responseSchema: { readonly name: string; readonly schema: object };
}

/** Token accounting, normalized by the adapter. Fields a provider cannot report are omitted. */
export interface ModelUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  reasoning_tokens?: number;
  visible_output_tokens?: number;
  /** Provider's stop reason, as reported (opaque to the engine). */
  finish_reason?: string;
  /** The output cap the provider actually sent. */
  max_tokens_sent: number;
}

/** Environment the provider may read its configuration from (API key, activation flag, ...). Opaque to the engine. */
export type ProviderEnv = Readonly<Record<string, string | undefined>>;

export interface ProviderCall {
  readonly env: ProviderEnv;
  /** The only network primitive a provider gets, so tests and deployments control transport. */
  readonly fetch: typeof fetch;
  /** Aborted by the engine when the deadline passes. A provider should pass it to its transport. */
  readonly signal: AbortSignal;
}

/**
 * Closed sets of SAFE failure and blocked categories. A provider reports a category, never prose: the engine maps each category to a fixed
 * message it owns, so nothing a provider (or the upstream service behind it) says can reach a client or a log. Anything outside these sets
 * is treated as `unknown` / `unavailable`.
 */
export const FAILURE_CODES = ["http_error", "network_error", "malformed_response", "unavailable", "unknown"] as const;
export type FailureCode = (typeof FAILURE_CODES)[number];
export const BLOCK_CODES = ["credential_missing", "not_activated", "unavailable"] as const;
export type BlockCode = (typeof BLOCK_CODES)[number];
/** JavaScript error class names a provider may report as non-sensitive metadata on a network error. Others are shown as "unknown". */
export const SAFE_ERROR_NAMES = ["AbortError", "TimeoutError", "NetworkError", "TypeError", "RangeError", "SyntaxError", "Error"] as const;
/** Stop reasons the engine will pass through in usage accounting. Others are shown as "other". */
export const SAFE_FINISH_REASONS = ["stop", "length", "content_filter", "tool_calls", "function_call", "end_turn", "max_tokens", "stop_sequence", "refusal", "error"] as const;

/**
 * What a provider returns. Failures are values, not exceptions, and carry ONLY a category and optional non-sensitive metadata: an HTTP status
 * (an integer 100-599) and an error class name from `SAFE_ERROR_NAMES`. Any other field, including free text such as `reason` or `message`, is ignored.
 */
export type ModelOutcome =
  | {
      kind: "completion";
      /** The model's text, or null when the reply carried none. */
      content: string | null;
      /** True when the provider stopped because it hit the output cap. */
      truncated: boolean;
      usage: ModelUsage;
    }
  | { kind: "failure"; code: FailureCode; status?: number; errorName?: string };

export interface ProviderStatus {
  keyConfigured: boolean;
  ownerEnabled: boolean;
}

export interface ModelProvider {
  /** Stable machine id, e.g. "muse-spark". */
  readonly id: string;
  /** Human-readable model name shown in the UI. Static; validated by the engine (letters, digits and `. _ : / -`, at most 64 characters). */
  readonly model: string;
  /** Static label used in fixed engine messages, e.g. "Meta API". Validated by the engine (letters, digits, space, `.` and `-`, at most 32 characters). */
  readonly displayName: string;
  /** Whether the server holds the provider's credential and the owner has activated the provider. Never returns the credential. */
  status(env: ProviderEnv): ProviderStatus;
  /** Why a request cannot be sent right now, as a category from `BLOCK_CODES`, or exactly `null` when it can. The engine owns the wording. */
  blockedCode(env: ProviderEnv): BlockCode | null;
  /** Make exactly ONE request. Must not retry. */
  complete(request: ModelRequest, call: ProviderCall): Promise<ModelOutcome>;
}
