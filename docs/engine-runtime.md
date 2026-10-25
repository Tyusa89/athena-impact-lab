# Generic engine runtime (PR E)

The Business Impact Engine owns the intelligence and verification capabilities. The Athena prototype, EcoNest and future applications are **consumers**:
they build an `EngineRuntime` and call `runAnalysis`. Nothing in the generic modules imports them.

## Layout (`src/lib/athena/meta/`)
| Generic (no prototype, no concrete provider) | Prototype-facing facade (same names as before; defaults to the prototype) |
|---|---|
| `runtime.ts` (`EngineRuntime`, `runAnalysis`, `metaStatus`, `ResolvedRequest`) | `adapter.server.ts` (`runMeta`, `PROTOTYPE_RUNTIME`, Muse Spark chosen here) |
| `analysis.ts` (output schema, `buildMessages`, `validateOutput`, `prepareMessages`, `validateAuthorizedOutput`) | `contract.ts` (+ Muse constants, demo `authorizedRecords`) |
| `grounding.ts` (verified facts, numeral policy) | `numericGrounding.ts` |
| `render.ts` (server-rendered findings) | `findings.ts` |
| `semantic.ts` (direction / magnitude / domain guards) | `semanticGuards.ts` |
| `question.ts`, `provider.ts`, `providerBoundary.ts`, `limits.ts`, `outputSchema.ts` | |

Generic functions take the `AnalysisContext` (catalog + reporting periods) explicitly; none has a prototype default. A test (`engineBoundary.test.ts`) fails if a generic
module imports `../data`, `../engine`, `../prototype*`, a concrete provider or a facade, or mentions the demo's identifiers.

## Types
The live path is typed with the neutral `Evidence` (`core/evidence.ts`), `AuthorizedEvidence<E extends Evidence>`, `EvidenceStore<Evidence>` and `AccessPolicy<Evidence>`;
read-only helpers use `EvidenceLike` (any `Evidence`, or a prototype record). The prototype's `EvidenceRecord` / `MetricKey` / `Department` no longer appear in it.
Both synthetic datasets run through `runAnalysis` with no casts.

## The analysis question
`EngineRuntime.question` is the DEFAULT question (trusted server configuration; the prototype keeps `DEMO_QUESTION`, so golden prompts are byte-identical).
A request may carry its own through `ResolvedRequest.question`. That value is **untrusted**: it is validated (`question.ts`) before any identity check or evidence read
and is never echoed back or logged. Accepted: one line, 8-300 characters after NFKC normalization, only letters, marks, digits, spaces and `. , ; : ? ! ' " ( ) / % & -`,
at least two words. Refused: anything else, and text that imitates the prompt's own structure (`VERIFIED_FACTS`, `PERIODS`, `Question:`, `system:`/`assistant:` ..., fact ids, "JSON").
Rejection is a fixed `Invalid analysis question (<code>).` with a closed code.
**This validation is a first line of defence, not the guarantee.** A well-formed question can still be persuasive ("ignore previous instructions ..."). What makes it harmless is
structural: evidence is selected by authorization before the question is read, the question sits in a fixed data slot, and every model reply is validated from scratch
(strict schema, server-derived citations, leak check, numeral and semantic guards, approval-gated actions). Tests prove an obedient provider is rejected for each such question.

## Remaining prototype coupling (honest list)
* The facades above still default to the prototype and exist for compatibility; consumers should import the generic modules.
* `meta.functions.ts`, `MetaPanel` and the status wiring are Muse/prototype specific (env names `META_MODEL_*`, "Meta API" wording, `META_MODEL` display).
* `MetaResult`, `MetaStatus`, `MetaOutput` and log lines keep "Meta" naming; some model-facing and validation messages say "Athena" (e.g. "Athena displays every number itself"): golden-bound text.
* The system prompt's default subject is "SYNTHETIC business facts for a fictional company" (override with `EngineRuntime.promptSubject`).
* `engine.ts` (the local deterministic demo analysis), `data.ts` and `EvidenceRecord` are prototype-only and not on the live path.
* The semantic guards are English-language heuristics driven by catalog aliases; a dataset whose users write in another language gets weaker semantic checking (the numeral, leak, citation and authorization checks are language-independent).
* A question may name things outside the caller's scope; that discloses only the caller's own words, and the engine rejects model text about them. The prototype's default question still names "sales" and "marketing leads" for every role.
* One dataset and two comparison periods per call.
