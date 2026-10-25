// Meta Muse Spark provider adapter: the only module that knows Meta's endpoint, request format, activation variables and response shape.
// Verified from dev.meta.ai docs (Oct 2026): OpenAI-compatible Chat Completions at
// POST https://api.meta.ai/v1/chat/completions, Bearer auth, model "muse-spark-1.3",
// structured output via response_format { type: "json_schema", json_schema: { name, schema } },
// response.choices[0].message.content, choices[0].finish_reason ("length" = hit token cap),
// response.usage token counts (reasoning tokens count as output).
// Verified (dev.meta.ai/docs/reasoning): `max_tokens` is the Chat Completions output cap; reasoning tokens count
// toward it and are billed as output (usage.completion_tokens_details.reasoning_tokens). `reasoning_effort`
// accepts minimal|low|medium|high; "none" returns HTTP 400 for Muse Spark; default effort is not documented.
// NOT verified: pricing.
// Imports only the neutral provider contract and engine limits: no evidence, tenant, identity or catalog code.
import { MAX_OUTPUT_TOKENS } from "../limits";
import { OUTPUT_JSON_SCHEMA } from "../outputSchema";
import type { ModelOutcome, ModelProvider, ModelRequest, ModelUsage, ProviderCall, ProviderEnv } from "../provider";

export const META_ENDPOINT = "https://api.meta.ai/v1/chat/completions";
export const META_MODEL = "muse-spark-1.3";
export const REASONING_EFFORT = "minimal" as const;
/** OpenAI-style structured-output envelope around the neutral schema. */
export const RESPONSE_FORMAT = { type: "json_schema", json_schema: OUTPUT_JSON_SCHEMA } as const;

/** Build the outbound body. Exported for tests; the cap is clamped to the engine's hard output limit. */
export function buildBody(messages: unknown, maxOutputTokens: number = MAX_OUTPUT_TOKENS, schema: { name: string; schema: object } = OUTPUT_JSON_SCHEMA) {
  return { model: META_MODEL, messages, max_tokens: Math.min(maxOutputTokens, MAX_OUTPUT_TOKENS), reasoning_effort: REASONING_EFFORT, response_format: { type: "json_schema", json_schema: schema }, stream: false };
}

export function readUsage(body: { usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } } }, finish?: string, maxTokensSent: number = MAX_OUTPUT_TOKENS): ModelUsage {
  const u = body.usage ?? {};
  const r = u.completion_tokens_details?.reasoning_tokens;
  const out: ModelUsage = { max_tokens_sent: maxTokensSent };
  if (u.prompt_tokens !== undefined) out.prompt_tokens = u.prompt_tokens;
  if (u.completion_tokens !== undefined) out.completion_tokens = u.completion_tokens;
  if (u.total_tokens !== undefined) out.total_tokens = u.total_tokens;
  if (r !== undefined) { out.reasoning_tokens = r; if (u.completion_tokens !== undefined) out.visible_output_tokens = u.completion_tokens - r; }
  if (finish) out.finish_reason = finish;
  return out;
}

interface MuseBody {
  choices?: { message?: { content?: unknown }; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } };
}

/** Environment variables the Muse Spark adapter reads. */
export type MuseEnv = { META_MODEL_API_KEY?: string | undefined; META_MODEL_ENABLED?: string | undefined };

const keyOf = (env: ProviderEnv) => env["META_MODEL_API_KEY"];

export const museSpark: ModelProvider = {
  id: "muse-spark",
  model: META_MODEL,
  status(env) {
    const key = keyOf(env);
    return { keyConfigured: !!key && key.trim().length > 0, ownerEnabled: env["META_MODEL_ENABLED"] === "true" };
  },
  blockedReason(env) {
    const st = this.status(env);
    if (!st.keyConfigured) return "META_MODEL_API_KEY is not configured on the server.";
    if (!st.ownerEnabled) return "Owner activation flag META_MODEL_ENABLED is not 'true'.";
    return null;
  },
  async complete(request: ModelRequest, call: ProviderCall): Promise<ModelOutcome> {
    const body = buildBody(request.messages, request.maxOutputTokens, request.responseSchema);
    let res: Response | undefined;
    let raw = "";
    try {
      res = await call.fetch(META_ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${keyOf(call.env)}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: call.signal,
      });
      if (res.ok) raw = await res.text();
    } catch (e) {
      void res?.body?.cancel().catch(() => {});
      return { kind: "failure", reason: `Network error (not retried): ${e instanceof Error ? e.name : "unknown"}` };
    }
    if (!res.ok) {
      console.error("Meta API error status", res.status);
      return { kind: "failure", reason: `Meta API returned HTTP ${res.status} (not retried).` };
    }
    let parsed: MuseBody;
    try { parsed = JSON.parse(raw); } catch { return { kind: "failure", reason: "Response body is not JSON." }; }
    const choice = parsed.choices?.[0];
    const content = choice?.message?.content;
    return {
      kind: "completion",
      content: typeof content === "string" ? content : null,
      truncated: choice?.finish_reason === "length",
      usage: readUsage(parsed, choice?.finish_reason, body.max_tokens),
    };
  },
};
