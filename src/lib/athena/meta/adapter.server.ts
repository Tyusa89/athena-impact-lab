// Server-only Meta adapter. Exactly one request, no retries, hard token budget.
// Never executes approvals/actions: it only returns validated text.
import { SCENARIOS, type EvidenceRecord } from "../data";
import { DEMO_QUESTION } from "../engine";
import {
  META_ENDPOINT, META_MODEL, MAX_INPUT_TOKENS, MAX_OUTPUT_TOKENS, REASONING_EFFORT, REQUEST_TIMEOUT_MS, RESPONSE_FORMAT,
  RequestSchema, authorizedRecords, buildMessages, estimateTokens, validateOutput, type MetaOutput,
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
  | { state: "rejected"; errors: string[]; requestSent: true; usage?: Usage | undefined }
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
export function factsBlockReason(records: EvidenceRecord[]): string | null {
  const facts = buildVerifiedFacts(records);
  const uncovered = uncoveredRecordIds(records, facts);
  if (facts.length === 0) return "Authorized evidence yields no verified facts; nothing sent.";
  if (uncovered.length > 0) return `Authorized evidence cannot be fully represented as verified facts (${uncovered.length} record(s) unpaired); nothing sent.`;
  return null;
}

export async function runMeta(input: unknown, env: MetaEnv, fetchImpl: typeof fetch): Promise<MetaResult> {
  const st = metaStatus(env);
  if (!st.keyConfigured) return { state: "blocked", reason: "META_MODEL_API_KEY is not configured on the server.", requestSent: false };
  if (!st.ownerEnabled) return { state: "blocked", reason: "Owner activation flag META_MODEL_ENABLED is not 'true'.", requestSent: false };
  const req = RequestSchema.safeParse(input);
  if (!req.success) return { state: "blocked", reason: `Invalid request: ${req.error.issues.map((i) => i.message).join("; ")}`, requestSent: false };

  const records = authorizedRecords(req.data); // permission filtering BEFORE prompt
  if (records.length === 0) return { state: "blocked", reason: "No records in authorized workspaces; nothing to send.", requestSent: false };
  const unfit = factsBlockReason(records);
  if (unfit) return { state: "blocked", reason: unfit, requestSent: false };
  const messages = buildMessages(DEMO_QUESTION, records);
  const est = estimateTokens(JSON.stringify(messages));
  if (est > MAX_INPUT_TOKENS) return { state: "blocked", reason: `Estimated input ${est} tokens exceeds budget ${MAX_INPUT_TOKENS}.`, requestSent: false };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetchImpl(META_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.META_MODEL_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(buildBody(messages)),
      signal: ctrl.signal,
    });
  } catch (e) {
    return { state: "error", reason: `Network error (not retried): ${e instanceof Error ? e.name : "unknown"}`, requestSent: true };
  } finally { clearTimeout(timer); }

  if (!res.ok) {
    console.error("Meta API error status", res.status);
    return { state: "error", reason: `Meta API returned HTTP ${res.status} (not retried).`, requestSent: true };
  }
  let body: { choices?: { message?: { content?: unknown }; finish_reason?: string }[]; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } } };
  try { body = await res.json(); } catch { return { state: "error", reason: "Response body is not JSON.", requestSent: true }; }
  const choice = body.choices?.[0];
  const usage = readUsage(body, choice?.finish_reason);
  // Redacted diagnostic log: token accounting only, never key, prompt or content.
  console.info("Meta usage", JSON.stringify(usage));
  if ((usage.completion_tokens ?? 0) > MAX_OUTPUT_TOKENS) return { state: "rejected", errors: ["Output token budget exceeded"], requestSent: true, usage };
  if (choice?.finish_reason === "length") return { state: "rejected", errors: [`Output truncated at token cap (max_tokens=${MAX_OUTPUT_TOKENS}; reasoning tokens ${usage.reasoning_tokens ?? "not reported"})`], requestSent: true, usage };
  if (typeof choice?.message?.content !== "string") return { state: "rejected", errors: ["Missing message content"], requestSent: true, usage };

  const all = SCENARIOS.find((s) => s.id === req.data.scenarioId)!.records;
  const v = validateOutput(choice.message.content, records, all);
  if (!v.ok) return { state: "rejected", errors: v.errors, requestSent: true, usage };
  return { state: "ok", findings: v.findings, output: v.output, requestSent: true, usage, authorizedIds: records.map((r) => r.id) };
}
