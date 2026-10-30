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
| Output contract & shapes | `OutputSchema`, `OUTPUT_JSON_SCHEMA`, `prepareMessages`, `renderFindings`, `buildVerifiedFacts`, `validateQuestion` |
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
- **`validateAuthorizedOutput` and its `ValidateProfile`** (removed in the PR #29 review, MEDIUM-2). The profile can switch on strict-profile
  behaviour (`refConsistency`, `strictCausal`), so exporting it would place part of the strict profile on the Phase 0 surface. The validator
  **still runs inside `runAnalysis` on every reply, unchanged** — only the ability to call it directly with a chosen profile is withheld. The
  implementation was not modified; the generic module still exports it for the engine's own use. `OutputSchema`, `OUTPUT_JSON_SCHEMA` and the
  result *shapes* remain exported, so a consumer can still type and inspect a result.
- **`SemanticScopeOptions`**, because `semanticScope` itself is not exported, leaving the type no public use.
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

A fifth check pins the **type-only** export surface by parsing the entry point's `export type { … }` blocks, because erased types cannot be
enumerated from the imported namespace at runtime (LOW-5).

`src/lib/tindara/browserBoundary.test.ts` adds the **transitive client-bundle check** (PR #29 review, MEDIUM-1). The pre-existing guard in
`meta/authorization.test.ts` text-scans each client file for forbidden module names, which catches a *direct* import and misses an *indirect*
one through an intermediary. The new check walks the dependency graph from the browser entry points (`src/router.tsx`, the generated route
tree, and every file under `src/routes` and `src/components`), following relative and `@/`-aliased specifiers, side-effect imports,
re-exports, and literal dynamic imports. `import type` / `export type` are skipped because TypeScript erases them. Both guards are kept:
neither replaces the other.

The one modelled boundary: a TanStack `createServerFn` module (`*.functions.ts`) reaches its server code through `await import(…)` inside a
handler, and the plugin strips handler bodies from the client bundle, so dynamic imports are not followed out of those modules — their static
imports still are. The two files that act as such a boundary are pinned, so adding a third is a reviewed change.

The checker is a pure function over an injected reader, so the same code is exercised against synthetic graphs and the real repository. Its
mutation tests prove it fails for a **direct** import, an **indirect** three-hop import where no client file mentions `tindara` at all, a
relative (non-aliased) path, a literal dynamic import, a server-only module, the strict path, and the evidence ledger — and that a clean graph
and a type-only import produce no violation. A mutation on the **real** graph (laundering the entry point through `athena/approvals.ts`, which
the UI genuinely reaches) is also detected, with the unmutated graph asserted clean so the detection cannot be a baseline artefact.

These complement the pre-existing boundary tests, which still pass unchanged: `core/importBoundary.test.ts`, `meta/engineBoundary.test.ts`
and `meta/providers/importBoundary.test.ts`.

### Static reachability is not bundle inclusion — measured

Two different properties, established by two different layers:

| Layer | Establishes | When it runs |
|---|---|---|
| **Static reachability** | over-approximation: what a client entry *could* pull in | always |
| **Bundle emission** | ground truth after tree shaking, read from sourcemap `sources` | whenever a build exists, or `TINDARA_VERIFY_BUNDLE=1` |

Run both with one command: **`bun run verify:bundle`** (`vite build --sourcemap && vitest run src/lib/tindara/browserBoundary.test.ts`).
Once bundle verification is expected, it **fails closed** — absent, unreadable, malformed or **stale** artifacts are failures, never skips.
Verified by probe: deleting the sourcemaps fails with *"no sourcemaps were emitted"*; corrupting one fails with *"Sourcemap malformed (not
JSON)"*; touching a source file fails with *"Build artifacts are STALE"*. The staleness comparison excludes `routeTree.gen.ts` (the router
plugin rewrites it during the build) and test files (never bundled). With no build and no flag the section is skipped, but
`assertFreshArtifacts` is itself unit-tested against synthetic input, so the fail-closed logic stays regression-covered either way.

The transitive scan found `core/access.ts`, `core/identity.ts` and `prototypeAdapter.ts` statically reachable, by paths no client file names:

```
src/routes/index.tsx         → athena/engine.ts → core/facts.ts       → core/access.ts
src/components/MetaPanel.tsx → meta/contract.ts → prototypeAdapter.ts → core/identity.ts
```

`core/facts.ts` imports the *value* `assertAuthorized`, and `MetaPanel` reaches `prototypeAdapter` through the `meta/contract` facade.
**But none of them is emitted.** `vite build --sourcemap` produces four client chunks, and their `sources` arrays contain exactly:

```
athena/approvals.ts   athena/core/catalog.ts   athena/core/facts.ts   athena/data.ts
athena/engine.ts      athena/meta.functions.ts athena/meta/providers/muse.ts
athena/meta/requestGate.ts  athena/prototypeCatalog.ts  athena/provider.ts
athena/workbench/{graphLayout,view,workbench.functions}.ts
```

`core/access.ts`, `core/identity.ts`, `prototypeAdapter.ts` and `meta/contract.ts` are **absent** — rollup eliminates them because no retained
path uses the imported symbols. So this is neither a leak nor an exemption: the strict forbidden-module rule covers server-only modules and
currently holds with **zero** grandfathered entries, and these three are pinned separately as a *measured* "statically reachable, not emitted"
baseline so the gap cannot widen unreviewed.

### Verified absent from the emitted client assets

| Marker | Result |
|---|---|
| `process.env`, `sk-`, `Bearer`, `api_key` | absent — no client code reads an environment |
| `Authorization failed`, `AuthorizationError` | absent — no identity implementation |
| `simulated-demo-role-claim`, `demo-role:`, `SERVER_ROLE_WORKSPACES` | absent — no identity verifier, no role allowlist |
| `did not pass validation`, `UNAVAILABLE_METRICS`, `VERIFIED_FACTS` | absent — no strict path, no scoped prompt |
| `already_imported`, `conflicts_with_existing` | absent — no ledger/importer |
| `authorizeEvidence`, `createIdentityBoundary`, `runStrictAnalysis` | absent |
| any `.server.ts` module | absent |

Two **permitted** occurrences, both UI label text rather than values: `META_MODEL_API_KEY` and `META_MODEL_ENABLED` appear inside MetaPanel's
status strings ("Server key META_MODEL_API_KEY configured"). The env-var *name* is not the value, and `process.env` being absent is what proves
no client code reads an environment. The only URLs in the bundle are `fonts.googleapis.com` and `react.dev/errors/`; the Meta endpoint constant
is not emitted.

`meta.functions.ts` and `workbench.functions.ts` *are* emitted — as client RPC stubs. Their handler bodies, and everything the handlers
dynamically import, are stripped, which the absence of `process.env` and of every `.server.ts` module confirms.

**What the browser legitimately does hold:** `data.ts` (the bundled **synthetic** demo dataset) and the local deterministic demo engine, because
the prototype's default analysis runs in the browser by design. That means client-side role filtering is cosmetic — which the README already
states ("Role filtering is simulated, not authorization"). No real or privileged evidence exists in this repository.

### Investigated: what the `meta/contract` facade contributes

`MetaPanel.tsx:6` imports one string constant — `META_MODEL`, the model name it displays — from the `meta/contract` facade. That facade
re-exports a great deal more: `export * from "./analysis"` (the whole validator), plus `SERVER_ROLE_WORKSPACES`,
`SYNTHETIC_SCENARIO_ALLOWLIST`, `workspacesForRole` and `RequestSchema` from the prototype adapter, and it imports `authorizeDemo`,
`PROTOTYPE_CONTEXT` and `prototypeDiscoverable`. So a one-symbol convenience import makes the validator, the demo role allowlist, the
authorization core and `zod` all *statically reachable* from the browser.

**Measured contribution: nothing.** Only `providers/muse.ts` — the constant's actual origin — is emitted. Confirmed on the build output:

| Checked | Result |
|---|---|
| `meta/contract.ts`, `meta/analysis.ts`, `semantic.ts`, `grounding.ts`, `refConsistency.ts`, `causalPolicy.ts`, `semanticGuards.ts`, `textSafety.ts` | **not emitted** |
| Only `meta/*` modules emitted | `providers/muse.ts`, `requestGate.ts` |
| `Semantic guard`, `refsConsistent`, `requires_human_approval`, `ZodError`, `safeParse`, `META_ENDPOINT` | absent from client JS |
| `zod` as a bundled module path | absent |
| Secrets / privileged logic / extra dependencies introduced | **none** |

So it introduces no secret, no privileged logic and no unwanted dependency. Two benign survivors: the string `muse-spark-1.3` (the model name
the UI shows) and the field names `supporting_ids` / `interpretations`, which are MetaPanel's JSX reading the server's response, not validator
code.

**Remaining limitation** (recorded, not fixed — fixing it is out of this PR's scope): it is *tree shaking*, not module structure, that keeps
all of the above out of the browser. That is a thin margin to depend on, and a future bundler or config change could alter it. Having
`MetaPanel` import `META_MODEL` from `./providers/muse` directly, and the facade's other consumers import the generic modules, would remove
the reliance. The bundle-level test above is what makes a regression here visible rather than silent.

## Not implemented

| Capability | Status |
|---|---|
| **Production authentication** | **Not implemented.** `createIdentityBoundary` is the slot; no real verifier exists in this repository. A deployment that sets `allowSimulatedIdentity: true` has **no authentication at all** — any caller can claim any identity the verifier accepts. |
| **Durable storage** | **Not implemented.** `createEvidenceLedger` is an **in-memory** reference implementation. Its rules (tenant partitioning, idempotency, duplicate/conflict rejection) are the contract a durable replacement must keep. |
| **External REST API / webhooks / async jobs** | **Not implemented.** No HTTP surface, no queue, no scheduler. The only transports in the repository are the prototype's TanStack server functions. |
| **Rate limiting, idempotency keys, audit log** | **Not implemented.** |
| **Multi-tenancy in practice** | Interfaces are tenant-aware and tenant isolation is enforced in `authorizeEvidence`; only one tenant exists in this repository. |
| **Action execution** | **Intentionally absent.** Proposed actions carry `requires_human_approval: true` and `executable: false`. No executor exists, and any future one must live outside this engine and re-authorize independently. |

## Limits of this boundary (PR #29 review, LOW-1 … LOW-5)

Recorded so they are not mistaken for guarantees. None of these is fixed by Phase 0.

1. **This is an in-repository module, not an installable package.** There is no build, no `package.json` `exports` map and no version:
   "public" means "the supported import path *inside this repository*". Nothing mechanically stops a co-located consumer from deep-importing
   `src/lib/athena/**` instead — only review and the boundary tests do. Packaging and versioning are future C1 work.
2. **`EngineRuntime` is exported, as a type** (pinned in the type-only list). **`SemanticScopeOptions` is not**, because `semanticScope` is not
   exported either, so the type has no public use. Neither appears in the runtime export list, because types are erased.
3. **Identity assurance is self-declared by the adapter.** `IdentityVerifier.assurance` is a value the verifier states *about itself*, so a
   consumer-supplied verifier can return `assurance: "verified"` while validating nothing. `allowSimulatedIdentity: false` enforces only that
   the adapter **claimed** `"verified"` — it cannot check that a credential was really validated. **Real identity assurance is Phase 1 and must
   be implemented and enforced outside this module.** Until then, treat `"verified"` as an unverified assertion by the deployment's own code.
4. **The import-closure tests are static scans** that over-approximate (a reachable module may still be dropped by the bundler — hence the
   second, bundle-level layer), with known blind spots now pinned as tests: a computed specifier (`import(someVar)`), a re-export laundered
   through a bare package, a path alias other than `@/`, and any client entry outside the globs the test walks. A new top-level client entry
   (or a new alias in `vite.config.ts`) would need the entry list updated; nothing detects that automatically.
5. **Type-only exports are now pinned** by parsing `export type { … }` blocks, which is a source-level pin, not a type-system one: it detects a
   changed export *list* but not a changed type *shape*. A breaking change to an exported interface would still pass.

## Phase status

| Capability | Phase | Status |
|---|---|---|
| Public entry point, boundary tests, docs | **C1 Phase 0** | **implemented (this PR)** |
| Real identity verifier, production auth enforcement | C1 Phase 1 | not started |
| Durable evidence ledger | C1 Phase 2 | not started |
| Read-only reasoning REST API | C1 Phase 3 | not started |
| Evidence ingress API | C1 Phase 4 | not started |
| Model path enabled per tenant; strict promotion | C1 Phase 5 | not started |
| Installable package + versioning | future | not started |
| Action execution | — | intentionally absent, no phase assigned |

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
