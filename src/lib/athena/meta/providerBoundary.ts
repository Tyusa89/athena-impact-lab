// The engine's boundary against provider-controlled text. Pure; no I/O.
//
// Everything a provider says passes through here before it can reach a client or a log. The rule: a provider may select from CLOSED sets
// (failure and blocked categories, error class names, stop reasons) and report numbers; the engine owns every word shown to a user.
// Free text from a provider (`reason`, `message`, stack, custom properties, an upstream response body) is never read.
//
// The few STATIC strings a provider does declare (id, model, displayName) are read before the request is built or sent, validated against
// a strict pattern, and replaced with a fixed fallback if they do not match, so they cannot carry a response, a prompt or a multi-line payload.
// A provider is in-process server code that already holds its credential; this boundary protects against upstream content, bugs and
// untrusted data flowing through a provider, not against a deliberately malicious provider implementation (which could exfiltrate by other means).
import { BLOCK_CODES, FAILURE_CODES, SAFE_ERROR_NAMES, SAFE_FINISH_REASONS, type BlockCode, type FailureCode, type ModelProvider, type ModelUsage, type ProviderEnv, type ProviderStatus } from "./provider";

export const FALLBACK_LABEL = "The model provider";
const LABEL_RE = /^[A-Za-z][A-Za-z0-9 .-]{0,31}$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** Read a provider property defensively: a getter that throws, or a value of the wrong type or shape, yields the fallback. */
function read(provider: ModelProvider, key: "displayName" | "model" | "id", re: RegExp, fallback: string): string {
  try {
    const v = provider[key];
    return typeof v === "string" && re.test(v) ? v : fallback;
  } catch {
    return fallback;
  }
}
export const safeLabel = (p: ModelProvider) => read(p, "displayName", LABEL_RE, FALLBACK_LABEL);
export const safeModel = (p: ModelProvider) => read(p, "model", MODEL_RE, "unknown");
export const safeId = (p: ModelProvider) => read(p, "id", ID_RE, "unknown");

/** `status()` reduced to two booleans. A provider that throws or answers oddly is reported as not configured. */
export function safeStatus(p: ModelProvider, env: ProviderEnv): ProviderStatus {
  try {
    const s = p.status(env) as Partial<ProviderStatus> | null;
    return { keyConfigured: s?.keyConfigured === true, ownerEnabled: s?.ownerEnabled === true };
  } catch {
    return { keyConfigured: false, ownerEnabled: false };
  }
}

/** The provider's blocked category. Exactly `null` means ready; anything else that is not a known category (including a throw) means blocked as unavailable (fail closed). */
export function blockCodeOf(p: ModelProvider, env: ProviderEnv): BlockCode | null {
  try {
    const c: unknown = p.blockedCode(env);
    if (c === null) return null;
    return (BLOCK_CODES as readonly unknown[]).includes(c) ? (c as BlockCode) : "unavailable";
  } catch {
    return "unavailable";
  }
}
/** Fixed wording for a blocked category. */
export function describeBlock(code: BlockCode, label: string): string {
  switch (code) {
    case "credential_missing": return `${label} server credential is not configured.`;
    case "not_activated": return `${label} has not been activated by the owner.`;
    case "unavailable": return `${label} is unavailable.`;
  }
}

const isStatus = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 100 && n <= 599;
/** Safe, comparable view of a failure outcome: only a known category and, optionally, an HTTP status or a known error class name. */
export interface SafeFailure { code: FailureCode; status?: number; errorName?: string }
export function safeFailure(outcome: unknown): SafeFailure {
  const o = (typeof outcome === "object" && outcome !== null ? outcome : {}) as Record<string, unknown>;
  const code: FailureCode = (FAILURE_CODES as readonly unknown[]).includes(o["code"]) ? (o["code"] as FailureCode) : "unknown";
  const out: SafeFailure = { code };
  if (code === "http_error" && isStatus(o["status"])) out.status = o["status"];
  if (code === "network_error") out.errorName = safeErrorName(o["errorName"]);
  return out;
}
/** An error class name from the closed set, else "unknown". Never reads a message, stack or other property. */
export function safeErrorName(name: unknown): string {
  return (SAFE_ERROR_NAMES as readonly unknown[]).includes(name) ? (name as string) : "unknown";
}
/** The class name of a thrown value, from the closed set. Reads only `name`, defensively (a getter or Proxy that throws yields "unknown"). */
export function safeThrownName(e: unknown): string {
  try {
    return safeErrorName(typeof e === "object" && e !== null ? (e as { name?: unknown }).name : undefined);
  } catch {
    return "unknown";
  }
}
/** Fixed wording for a failure. */
export function describeFailure(f: SafeFailure, label: string): string {
  switch (f.code) {
    case "http_error": return f.status !== undefined ? `${label} returned HTTP ${f.status} (not retried).` : `${label} returned an HTTP error (not retried).`;
    case "network_error": return `Network error (not retried): ${f.errorName ?? "unknown"}`;
    case "malformed_response": return "Response body is not JSON.";
    case "unavailable": return `${label} is unavailable (not retried).`;
    case "unknown": return `${label} request failed (not retried).`;
  }
}

export const safeFinishReason = (x: unknown): string => ((SAFE_FINISH_REASONS as readonly unknown[]).includes(x) ? (x as string) : "other");
const num = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x >= 0;
/** Token accounting from a provider's usage: known numeric fields and a closed-set stop reason only. The cap shown is the engine's. */
export function cleanUsage(u: unknown, maxTokensSent: number): ModelUsage {
  const src = (typeof u === "object" && u !== null ? u : {}) as Record<string, unknown>;
  const out: ModelUsage = { max_tokens_sent: maxTokensSent };
  for (const k of ["prompt_tokens", "completion_tokens", "total_tokens", "reasoning_tokens", "visible_output_tokens"] as const) if (num(src[k])) out[k] = src[k] as number;
  if (src["finish_reason"] !== undefined) out.finish_reason = safeFinishReason(src["finish_reason"]);
  return out;
}
