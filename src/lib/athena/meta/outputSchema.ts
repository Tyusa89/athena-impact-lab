// The provider-neutral JSON Schema of the model's output (the unverified-interpretation and proposed-action lanes). It mirrors
// `OutputSchema` in ./contract. Providers wrap it in whatever structured-output envelope their API uses; the engine validates every
// reply against `OutputSchema` regardless of what a provider claims to have enforced. Pure + client-safe.
import { LIMITS } from "./limits";

const T = { type: "string", maxLength: LIMITS.text } as const;
const R = { type: "array", minItems: 1, maxItems: LIMITS.refs, items: { type: "string" } } as const;

export const OUTPUT_JSON_SCHEMA = {
  name: "AthenaAnalysisV2",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["interpretations", "missing_evidence", "recommendations"],
    properties: {
      interpretations: { type: "array", maxItems: LIMITS.interpretations, items: { type: "object", additionalProperties: false, required: ["text", "verified", "refs"], properties: { text: T, verified: { type: "boolean", enum: [false] }, refs: R } } },
      missing_evidence: { type: "array", maxItems: LIMITS.missing, items: T },
      recommendations: { type: "array", maxItems: LIMITS.recommendations, items: { type: "object", additionalProperties: false, required: ["text", "requires_human_approval", "refs"], properties: { text: T, requires_human_approval: { type: "boolean", enum: [true] }, refs: R } } },
    },
  },
} as const;
