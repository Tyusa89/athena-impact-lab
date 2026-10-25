// Prototype-facing facade over ./analysis. The generic pipeline (./analysis) requires an explicit analysis context; this module keeps the original
// signatures by defaulting it to the bundled prototype's, and re-exports the prototype's request shape, the default provider's constants (the UI shows the
// model name; tests pin the request format) and the demo's authorization helper. The live pipeline (./runtime) uses none of these defaults.
import type { AuthorizedEvidence } from "../core/access";
import type { Evidence, EvidenceLike } from "../core/evidence";
import type { AnalysisContext } from "../core/facts";
import { PROTOTYPE_CONTEXT } from "../engine";
import { authorizeDemo, type MetaRequest, type PrototypeEvidence } from "../prototypeAdapter";
import * as a from "./analysis";

export * from "./analysis";
// Engine limits (provider-neutral) live in ./limits; re-exported so existing imports keep working.
export { LIMITS, MAX_INPUT_TOKENS, MAX_OUTPUT_TOKENS, REQUEST_TIMEOUT_MS } from "./limits";
// COMPATIBILITY re-exports of the default provider's constants. New code should import them from ./providers/muse.
export { META_ENDPOINT, META_MODEL, REASONING_EFFORT, RESPONSE_FORMAT } from "./providers/muse";
export { OUTPUT_JSON_SCHEMA } from "./outputSchema";
// The demo's allowlist, roles, workspaces and request shape live in the prototype adapter; re-exported here for existing imports.
export { SERVER_ROLE_WORKSPACES, SYNTHETIC_SCENARIO_ALLOWLIST, workspacesForRole, RequestSchema, type MetaRequest } from "../prototypeAdapter";

/** Server-side reconstruction: records come only from the server's own evidence store, authorized for a trusted context BEFORE prompt building. */
export function authorizedRecords(req: Pick<MetaRequest, "scenarioId" | "roleId">): AuthorizedEvidence<PrototypeEvidence> {
  return authorizeDemo(req).authorized;
}
export const buildMessages = (question: string, records: readonly EvidenceLike[], ctx: AnalysisContext = PROTOTYPE_CONTEXT) => a.buildMessages(question, records, ctx);
export const validateOutput = (raw: string, authorized: readonly EvidenceLike[], allRecords: readonly EvidenceLike[], ctx: AnalysisContext = PROTOTYPE_CONTEXT) => a.validateOutput(raw, authorized, allRecords, ctx);
export const prepareMessages = <E extends Evidence>(question: string, authorized: AuthorizedEvidence<E>, ctx: AnalysisContext = PROTOTYPE_CONTEXT) => a.prepareMessages(question, authorized, ctx);
export const validateAuthorizedOutput = <E extends Evidence>(raw: string, authorized: AuthorizedEvidence<E>, withheld: readonly E[], ctx: AnalysisContext = PROTOTYPE_CONTEXT) => a.validateAuthorizedOutput(raw, authorized, withheld, ctx);
