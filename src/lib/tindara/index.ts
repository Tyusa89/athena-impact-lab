// TINDARA — the public TypeScript entry point of the standalone reasoning engine (C1 Phase 0).
//
// Tindara is the product name for the engine that this repository developed as "Athena Engine". Phase 0 establishes the PUBLIC SURFACE only:
// internal module paths and symbol names are deliberately unchanged, so nothing here is a rename or a migration. Importing this module is the
// supported way to consume the engine; importing `../athena/**` directly is not.
//
// WHAT THIS MODULE IS. A hand-written allowlist of the reusable core and the generic reasoning interfaces. A consumer builds its own
// `EngineRuntime` (identity adapter, evidence store, access policy, catalog, periods, and — only for the model path — a provider) and calls
// `runImpactAnalysis` (deterministic) or `runAnalysis` (model-assisted). Every authorization, tenant-isolation, discoverability and validation
// rule runs inside the engine, unchanged by this file: it re-exports, and defines no behaviour of its own.
//
// WHAT IS DELIBERATELY NOT EXPORTED, and why:
//   * The prototype/demo composition — `PROTOTYPE_RUNTIME`, the demo catalog, scenarios, roles, workspaces, `authorizeDemo` and the
//     SIMULATED identity verifier that accepts any claimed role. A consumer must supply its own identity adapter; the demo's cannot be
//     reached through this module, by design (see ./publicSurface.test.ts, which fails if it ever becomes reachable).
//   * The prototype-facing facades (`contract.ts`, `adapter.server.ts`, `findings.ts`, `numericGrounding.ts`, `semanticGuards.ts`), which
//     default their analysis context to the demo's.
//   * Concrete model providers. The provider CONTRACT is exported; no implementation is. A deployment supplies its own transport, so
//     importing Tindara can never cause a call to any model vendor.
//   * The STRICT reasoning path (`runStrictAnalysis`, `validateStrictOutput`, the scoped prompt). It is not promoted, nothing live calls it,
//     and Phase 0 keeps it that way: strict/legacy separation is preserved by leaving it off the public surface entirely.
//   * Test and demonstration fixtures (`core/fixtures.ts`, `core/ingest/fixtures/**`, and the ingestion tests' own support module).
//
// NOT IMPLEMENTED IN PHASE 0 (see docs/tindara-public-api.md): production authentication, durable storage, and an external REST API.
// `createIdentityBoundary` is the slot where a real verifier goes; `createEvidenceLedger` is an IN-MEMORY reference implementation; and there
// is no HTTP surface in this repository. Until a real verifier exists, a deployment that sets `allowSimulatedIdentity: true` has no
// authentication at all.
//
// FOUR LIMITS OF THIS BOUNDARY, recorded so they are not mistaken for guarantees:
//   * THIS IS AN IN-REPOSITORY MODULE, NOT A PACKAGE. There is no build, no `package.json` `exports` map and no version: "public" means
//     "the supported import path inside this repository". Nothing prevents a co-located consumer from deep-importing `../athena/**` instead;
//     only review and the boundary tests do. Packaging is future C1 work.
//   * ASSURANCE IS SELF-DECLARED BY THE ADAPTER. `IdentityVerifier.assurance` is a value the verifier states about itself, so a consumer-supplied
//     verifier can return `assurance: "verified"` while validating nothing. `allowSimulatedIdentity: false` enforces only that the adapter
//     CLAIMED "verified"; it cannot check that a credential was really validated. Real identity assurance is Phase 1 and must be enforced
//     outside this module.
//   * THE IMPORT-CLOSURE TESTS ARE STATIC SCANS. They follow relative and `@/`-aliased specifiers and literal dynamic imports; they cannot
//     follow a computed specifier, a re-export through a bare package, or a module added under a path their entry list does not cover.
//   * TYPE-ONLY EXPORTS DO NOT EXIST AT RUNTIME, so they cannot be enumerated from the imported namespace. They are pinned by parsing this
//     file's `export type { ... }` blocks instead (see ./publicSurface.test.ts).
//
// Two symbols are deliberately absent although they are part of the engine's internals: `SemanticScopeOptions` (the options bag of
// `semanticScope`, which is itself not exported, so the type has no public use) and `validateAuthorizedOutput` with its `ValidateProfile`
// (see the output-contract section below). `EngineRuntime` IS exported, as a type.

// ----------------------------------------------------------------------------------------------------------- identity (the authentication slot)
export { AuthorizationError, createIdentityBoundary, IDENTITY_TIMEOUT_MS } from "../athena/core/identity";
export type { Assurance, IdentityBoundary, IdentityVerifier, TrustedContext, VerifiedIdentity } from "../athena/core/identity";

// ----------------------------------------------------------------------------------------------------------- authorization and tenant isolation
export { assertAuthorized, authorizeEvidence, isAuthorizedEvidence } from "../athena/core/access";
export type { AccessPolicy, AuthorizationResult, AuthorizedEvidence, EvidenceScope, EvidenceStore } from "../athena/core/access";

// ----------------------------------------------------------------------------------------------------------- evidence, facts and the analysis context
export type { Evidence, EvidenceLike } from "../athena/core/evidence";
export { computeAuthorizedFacts, computeFacts, describeChange, validateRecords } from "../athena/core/facts";
export type { AnalysisContext, CoreFact, CoreRecord, Direction, PeriodPair } from "../athena/core/facts";

// ----------------------------------------------------------------------------------------------------------- catalog (the business vocabulary; data, not code)
export { assertCatalog, domainDef, goodDirection, metricDef, metricDomain, metricLabel, requireMetric, validateCatalog } from "../athena/core/catalog";
export type { Aggregation, Catalog, DomainDef, DomainIdOf, MetricDef, MetricKeyOf, Polarity } from "../athena/core/catalog";

// ----------------------------------------------------------------------------------------------------------- ingestion primitives (pure; no transport, no durable storage)
export { createEvidenceLedger, csvAdapter, importSource, isImportResult, isIsoDate, parseCsv, sha256Hex, validateMapping } from "../athena/core/ingest";
export { DEFAULT_IMPORT_LIMITS, REJECTION_CODES, STRUCTURAL_CODES } from "../athena/core/ingest";
export type {
  CommitOutcome, EvidenceLedger, FieldRole, ImportBatch, ImportLimits, ImportOptions, ImportPolicy, ImportRequest, ImportResult, ImportStatus,
  MappingSpec, PeriodSpec, Provenance, RawRow, RawTable, RejectedRecord, RejectionCode, RejectionReason, SourceAdapter, SourceDescriptor,
  SourceReadResult, StructuralCode, StructuralError,
} from "../athena/core/ingest";

// ----------------------------------------------------------------------------------------------------------- the runtime seam
export { authorizeRequest, authorizedFactsBlockReason, factsBlockReason, metaStatus } from "../athena/meta/runtime";
export type { EngineRuntime, MetaResult, MetaStatus, Prepared, ResolvedRequest, Usage } from "../athena/meta/runtime";

// ----------------------------------------------------------------------------------------------------------- deterministic reasoning (no model, no key, no network)
export { runImpactAnalysis } from "../athena/meta/runtime";
export type { ImpactResult } from "../athena/meta/runtime";
export { assertRelationshipModel, buildImpactMap, CAUSAL_WORDS, NO_RELATIONSHIP_NOTICE, NOTICES, renderImpactMapMarkdown, validateRelationshipModel } from "../athena/meta/impact";
export type {
  ImpactAction, ImpactHypothesis, ImpactMap, ImpactOptions, ProvenanceRef, RelationshipAssessment, RelationshipModel, RelationshipRule,
  RelationshipStatus, VerifiedChange,
} from "../athena/meta/impact";

// ----------------------------------------------------------------------------------------------------------- model-assisted reasoning (the caller supplies the provider)
export { runAnalysis } from "../athena/meta/runtime";

// ----------------------------------------------------------------------------------------------------------- the model-output contract (shapes, not the validator)
// `validateAuthorizedOutput` and its `ValidateProfile` are NOT exported (MEDIUM-2): the profile can switch on strict-profile behaviour
// (`refConsistency`, `strictCausal`), so exporting it would let a consumer invoke part of the strict profile from the Phase 0 surface. The
// validator still runs INSIDE `runAnalysis` on every reply, unchanged; only the ability to call it directly with a chosen profile is withheld.
export { DEFAULT_PROMPT_SUBJECT, estimateTokens, OutputSchema, prepareMessages } from "../athena/meta/analysis";
export type { MetaOutput, ModelOutput, ValidationResult } from "../athena/meta/analysis";
export { OUTPUT_JSON_SCHEMA } from "../athena/meta/outputSchema";
export { buildAuthorizedFacts, buildVerifiedFacts, factIdFor } from "../athena/meta/grounding";
export type { VerifiedFact } from "../athena/meta/grounding";
export { renderFindings } from "../athena/meta/render";
export type { VerifiedFinding } from "../athena/meta/render";
export { QUESTION_MAX, QUESTION_MIN, QUESTION_REJECTIONS, validateQuestion } from "../athena/meta/question";
export type { QuestionRejection, QuestionResult } from "../athena/meta/question";

// ----------------------------------------------------------------------------------------------------------- provider CONTRACT only (no implementation ships)
export { BLOCK_CODES, FAILURE_CODES } from "../athena/meta/provider";
export type {
  BlockCode, FailureCode, ModelMessage, ModelOutcome, ModelProvider, ModelRequest, ModelUsage, ProviderCall, ProviderEnv, ProviderStatus,
} from "../athena/meta/provider";

// ----------------------------------------------------------------------------------------------------------- engine-owned limits and documented limitations
export { LIMITS, MAX_INPUT_TOKENS, MAX_OUTPUT_TOKENS, REQUEST_TIMEOUT_MS } from "../athena/meta/limits";
export { RESIDUAL_LIMITATIONS } from "../athena/meta/semantic";
