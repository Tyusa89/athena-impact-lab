# Tindara — public integration boundary (C1 Phase 0)

**Tindara** is the standalone, system-independent reasoning engine developed in this repository as "Athena Engine". Phase 0 establishes its
**public TypeScript entry point**. It adds no capability: it draws a supported boundary around what already existed, and proves with tests
that the boundary cannot quietly leak the prototype.

> **Status: Phase 0 of the approved C1 plan.** Production authentication, durable storage and an external REST API are **NOT IMPLEMENTED**.
> See [Not implemented](#not-implemented) before planning anything on top of this.

Entry point: `src/lib/tindara/index.ts`. Importing `src/lib/athena/**` directly is not supported.

Phase 0 deliberately performed **no internal renaming and no repository migration**: module paths and symbol names under `src/lib/athena/`
are unchanged, and the prototype (the Athena Impact Lab demo UI) keeps working exactly as before through its own composition.

## What a consumer does

A consumer supplies an `EngineRuntime` and calls a reasoning entry point. Nothing is read from a request except through its own `resolve`.

```ts
import { createIdentityBoundary, runImpactAnalysis } from "<tindara>";

const runtime = {
  resolve,                                      // your request shape -> { credential, dataset, question? }
  identity: createIdentityBoundary(myVerifier), // YOUR verifier; assurance: "verified"
  allowSimulatedIdentity: false,                // production MUST be false
  store: myEvidenceStore,                       // candidates(ctx, dataset); not trusted to have filtered
  policy: myAccessPolicy,                       // permits() + explicit discoverableMetrics
  analysis: { catalog: myCatalog, periods },    // your business vocabulary and reporting window
  question: "…",                                // default question (server configuration)
};

const result = await runImpactAnalysis(request, runtime, myRelationshipModel);
```

The deterministic path needs **no model provider, no API key and no network**. `src/lib/tindara/consumer.test.ts` is a working example and is
constrained by test to import nothing but the public entry point.

### The request contract

A consumer's request may carry a **credential**, a **dataset selector**, and an optional **question**. It may never carry a tenant, actor,
role, workspace, permission, metric scope, fact, citation or catalog — those are server-side configuration or are derived from the verified
credential. The engine enforces this by construction: client input is read only inside `resolve`, and the tenant comes from the verifier.

### Execution order (unchanged by Phase 0)

```
resolve(input) → validateQuestion(untrusted) → identity.authenticate(credential)
  → refuse assurance:"simulated" unless allowSimulatedIdentity
  → authorizeEvidence(...)        ← tenant isolation enforced here, not by the store or the policy
  → require ≥1 authorized record and full fact coverage
  → deterministic impact map, or (model path) one provider call then validation from scratch
```

## What the entry point exposes

| Group | Contents |
|---|---|
| Identity slot | `createIdentityBoundary`, `AuthorizationError`, `IDENTITY_TIMEOUT_MS`, `IdentityVerifier`, `TrustedContext`, `Assurance`, … |
| Authorization | `authorizeEvidence`, `assertAuthorized`, `isAuthorizedEvidence`, `AccessPolicy`, `EvidenceScope`, `EvidenceStore`, `AuthorizedEvidence` |
| Evidence & facts | `Evidence`, `EvidenceLike`, `AnalysisContext`, `computeFacts`, `validateRecords`, `describeChange`, … |
| Catalog | `validateCatalog`, `assertCatalog`, `Catalog`, `MetricDef`, `DomainDef`, `metricLabel`, `goodDirection`, … |
| Ingestion primitives | `parseCsv`, `csvAdapter`, `importSource`, `validateMapping`, `createEvidenceLedger`, `sha256Hex`, `ImportPolicy`, … |
| Runtime seam | `EngineRuntime`, `authorizeRequest`, `metaStatus`, `factsBlockReason`, `MetaResult`, `ResolvedRequest` |
| Deterministic reasoning | `runImpactAnalysis`, `buildImpactMap`, `renderImpactMapMarkdown`, `RelationshipModel`, `validateRelationshipModel`, `ImpactMap` |
| Model-assisted reasoning | `runAnalysis` (requires a caller-supplied provider) |
| Output contract & validation | `OutputSchema`, `OUTPUT_JSON_SCHEMA`, `validateAuthorizedOutput`, `prepareMessages`, `renderFindings`, `buildVerifiedFacts`, `validateQuestion` |
| Provider contract | `ModelProvider`, `ModelRequest`, `ModelOutcome`, `FAILURE_CODES`, `BLOCK_CODES` — **types and codes only** |
| Limits & limitations | `MAX_INPUT_TOKENS`, `MAX_OUTPUT_TOKENS`, `REQUEST_TIMEOUT_MS`, `LIMITS`, `RESIDUAL_LIMITATIONS` |

## What it deliberately does not expose, and why

- **The prototype/demo composition** — the demo runtime, catalog, scenarios, roles, workspaces, and the **simulated identity verifier that
  accepts any claimed role**. A consumer must bring its own identity adapter; the demo's is unreachable through this module.
- **The prototype-facing facades**, which default their analysis context to the demo's business.
- **Concrete model providers.** The provider *contract* is exported; no implementation is. Importing Tindara therefore cannot cause a call to
  any model vendor.
- **The strict reasoning path** (`runStrictAnalysis`, `validateStrictOutput`, the scoped prompt). It is not promoted and nothing live calls it;
  leaving it off the public surface is how Phase 0 preserves strict/legacy separation. *This is a reviewable decision, not a permanent one.*
- **Fixtures and test support.**

### These exclusions are enforced by tests, not by convention

`src/lib/tindara/publicSurface.test.ts` applies four independent checks:

1. every import specifier in the entry point is on an allowlist;
2. the entry point's code (comments stripped) mentions no prototype, demo or strict identifier;
3. its **runtime export list is pinned** — adding or removing an export fails the suite until the list is updated deliberately;
4. the **transitive module closure** reachable from the entry point contains no prototype adapter, facade, concrete provider, strict-path
   module, fixture, server transport or UI file.

Check 3 catches a direct re-export; check 4 catches one arriving through a chain of internal imports. Verified by probe: adding
`export { PROTOTYPE_RUNTIME } from "../athena/meta/adapter.server"` fails **12** assertions across all four checks.

These complement the pre-existing boundary tests, which still pass unchanged: `core/importBoundary.test.ts`, `meta/engineBoundary.test.ts`
and `meta/providers/importBoundary.test.ts`.

## Not implemented

| Capability | Status |
|---|---|
| **Production authentication** | **Not implemented.** `createIdentityBoundary` is the slot; no real verifier exists in this repository. A deployment that sets `allowSimulatedIdentity: true` has **no authentication at all** — any caller can claim any identity the verifier accepts. |
| **Durable storage** | **Not implemented.** `createEvidenceLedger` is an **in-memory** reference implementation. Its rules (tenant partitioning, idempotency, duplicate/conflict rejection) are the contract a durable replacement must keep. |
| **External REST API / webhooks / async jobs** | **Not implemented.** No HTTP surface, no queue, no scheduler. The only transports in the repository are the prototype's TanStack server functions. |
| **Rate limiting, idempotency keys, audit log** | **Not implemented.** |
| **Multi-tenancy in practice** | Interfaces are tenant-aware and tenant isolation is enforced in `authorizeEvidence`; only one tenant exists in this repository. |
| **Action execution** | **Intentionally absent.** Proposed actions carry `requires_human_approval: true` and `executable: false`. No executor exists, and any future one must live outside this engine and re-authorize independently. |

## Current limitations of the engine itself

- **One dataset and two comparison periods per call.**
- **Semantic guards are English-language heuristics** driven by catalog aliases. A tenant writing in another language gets weaker semantic
  checking; the numeral, leak, citation and authorization checks are language-independent. See `RESIDUAL_LIMITATIONS`.
- **A catalog is trusted operator configuration.** `validateCatalog` checks its shape and consistency, not whether it is appropriate to show a
  given caller. Accepting a catalog from an external client would widen the vocabulary the model may name.
- **Mention-level citation consistency is not semantic proof.** Interpretations remain `verified: false`.
- The strict profile's own open limitations (LOW-1…LOW-4) are tracked in [`strict-evaluation.md`](./strict-evaluation.md).

## Related documents

- [`engine-runtime.md`](./engine-runtime.md) — the generic runtime and its remaining prototype coupling.
- [`model-output-scope.md`](./model-output-scope.md) — what the model may say and how output is validated.
- [`identity-boundary.md`](./identity-boundary.md) — what the identity boundary does and does not do.
- [`ingestion.md`](./ingestion.md) — the ingestion contract.
- [`strict-evaluation.md`](./strict-evaluation.md) — the strict profile's offline evaluation and open questions.
