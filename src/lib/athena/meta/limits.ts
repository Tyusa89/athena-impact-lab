// Engine-owned limits. They belong to the engine's policy, not to any model provider: every provider is held to the same budgets.
// Pure + client-safe.

/** Estimated input ceiling; a larger prompt is never sent. */
export const MAX_INPUT_TOKENS = 3000;
/** Hard output cap handed to every provider as the request's `maxOutputTokens`. Includes hidden reasoning tokens where a provider has them. */
export const MAX_OUTPUT_TOKENS = 2000;
/** One deadline for the whole provider call (request and full response). Enforced by the engine, not by the provider. */
export const REQUEST_TIMEOUT_MS = 30_000;
/** Shape limits of the model's output lanes. */
export const LIMITS = { interpretations: 3, missing: 4, recommendations: 3, text: 200, refs: 4 } as const;
