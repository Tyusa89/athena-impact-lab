// Server composition for the prototype: binds the generic, provider-neutral pipeline (./runtime) to the bundled demo (its tenant, roles, scenarios, catalog and
// default question) and to the default Muse Spark provider. This is the ONE place the prototype and the default provider are chosen; the pipeline itself
// imports neither. Applications consume the engine by building their own `EngineRuntime` and calling `runAnalysis`.
import type { AuthorizedEvidence } from "../core/access";
import type { Evidence, EvidenceLike } from "../core/evidence";
import type { AnalysisContext } from "../core/facts";
import { DEMO_QUESTION, PROTOTYPE_CONTEXT } from "../engine";
import { BUSINESS_OPS_MODEL } from "../impactModels";
import type { RelationshipModel } from "./impact";
import { demoAccessPolicy, demoEvidenceStore, demoIdentity, resolveDemoRequest } from "../prototypeAdapter";
import { museSpark } from "./providers/muse";
import * as rt from "./runtime";
import type { ProviderEnv, ModelProvider } from "./provider";

export * from "./runtime";
/** Environment for the default provider (Muse Spark): kept as an alias for existing callers. */
export type { MuseEnv as MetaEnv } from "./providers/muse";
// Kept for existing imports; the request format and response parsing belong to the Muse Spark adapter.
export { buildBody, readUsage } from "./providers/muse";

export const metaStatus = (env: ProviderEnv, provider: ModelProvider = museSpark) => rt.metaStatus(env, provider);
export const factsBlockReason = (records: readonly EvidenceLike[], ctx: AnalysisContext = PROTOTYPE_CONTEXT) => rt.factsBlockReason(records, ctx);
export const authorizedFactsBlockReason = <E extends Evidence>(records: AuthorizedEvidence<E>, ctx: AnalysisContext = PROTOTYPE_CONTEXT) => rt.authorizedFactsBlockReason(records, ctx);

export const PROTOTYPE_RUNTIME: rt.EngineRuntime = {
  resolve: resolveDemoRequest, identity: demoIdentity, allowSimulatedIdentity: true, store: demoEvidenceStore, policy: demoAccessPolicy,
  analysis: PROTOTYPE_CONTEXT, question: DEMO_QUESTION, provider: museSpark,
};
/** The prototype's entry point: the generic pipeline over the demo runtime by default. */
export const runMeta = (input: unknown, env: ProviderEnv, fetchImpl: typeof fetch, runtime: rt.EngineRuntime = PROTOTYPE_RUNTIME) => rt.runAnalysis(input, env, fetchImpl, runtime);

/** The prototype's deterministic Business Impact Map (no model, no key): the generic `runImpactAnalysis` over the demo runtime and the business-operations model. */
export const runPrototypeImpact = (input: unknown, runtime: rt.EngineRuntime = PROTOTYPE_RUNTIME, model: RelationshipModel = BUSINESS_OPS_MODEL) => rt.runImpactAnalysis(input, runtime, model);
