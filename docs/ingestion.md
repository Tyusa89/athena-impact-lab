# Data ingestion foundation (PR D)

Synthetic data only. No production upload, connector, database or authentication. Lives in `src/lib/athena/core/ingest/` (pure, dependency-free,
covered by the core import-boundary test): it never imports the intelligence engine, a model provider or the prototype.

## Pipeline
```
source system --SourceAdapter--> RawTable --importSource(MappingSpec, Catalog, TrustedContext, ImportPolicy)--> ImportResult
   --EvidenceLedger.commit--> EvidenceStore --authorizeEvidence--> AuthorizedEvidence --> existing fact engine
   (computeAuthorizedFacts -> server-rendered findings and derived citations -> provider -> validated lanes)
```
* **Contract** (`types.ts`): `SourceDescriptor`, `SourceAdapter<Input>` (turns a source into a table of strings; the CSV adapter is the only one),
  `MappingSpec` (which header plays which role; explicit metric-name and unit-alias tables; the two reporting periods), `ImportBatch` + `Provenance`,
  `RejectedRecord` with closed `RejectionCode`s, structural errors with closed `StructuralCode`s, `ImportLimits`.
* **Tenant binding**: evidence is stamped with the trusted context's tenant. The context must be one the identity boundary issued, and an `ImportPolicy`
  must return exactly `true` for (context, source), or `importSource` throws the generic `AuthorizationError` before reading anything. A tenant-like
  column (`tenant`, `tenant_id`, `org_id`, ...) refuses the whole file unless the mapping lists it as ignored, and even then its values are never read.
* **Normalization** (`normalize.ts`), all fail closed: metric via an explicit name table (one-to-one, case-exact) or the catalog key; domain, when
  mapped, must equal the catalog's domain for the metric; unit must equal the catalog unit (after an explicit alias table); value is a strict decimal
  (no thousands separators, exponent, sign prefix or NaN; at most 15 digits; |v| <= 1e12); period must be one of the two declared labels; an optional
  end date must be a real ISO date equal to that period's end. Nothing is defaulted, repaired or inferred. Control, bidi and zero-width characters in any used field reject the row.
* **Duplicates and conflicts**: every row sharing a (metric, period) with another row (identical or not), and every repeated record id, is rejected.
  A rejected row still blocks a valid row with the same key, and any row with a syntactically valid id reserves that id even if it is rejected for an unrelated field (malformed ids and rows with the wrong cell count reserve nothing). No row silently wins.
* **Modes**: `all_or_nothing` (default: any rejected row means no evidence from the batch) or `accept_valid`. Rejections report the line, a field role and a
  closed code, never the cell content. Ingestion writes nothing to the console and calls no network or model.
* **Ledger** (`ledger.ts`, in-memory reference): commits only results produced by `importSource`, only under their own tenant; refuses a later batch that
  duplicates or conflicts with existing (tenant, dataset, metric, period) facts or reuses an id (all or nothing); re-importing identical content is an idempotent
  no-op; its `store` returns only the asking tenant's evidence. The engine still filters again in `authorizeEvidence`.
* **Limits** (defaults): 1 MiB, 10 000 rows, 32 columns, 512 characters per field; enforced in the CSV reader and re-checked for any adapter.
* **Provenance**: batch id (derived from tenant, source and content), SHA-256 of the parsed table, source, adapter, and the physical line of every record.

## How imported evidence reaches the engine
Committed evidence is ordinary `Evidence` (`core/evidence.ts`). From there the existing path is unchanged: `authorizeEvidence` -> `computeAuthorizedFacts`
(catalog-driven) -> `renderFindings` / `prepareMessages` / `validateAuthorizedOutput` -> provider. CSV data and providers cannot create findings or citations;
those are rendered by the engine from facts. One engine fix was needed to prove independence: `runMeta`'s coverage guard (`factsBlockReason`) ignored the
runtime's own catalog and periods and used the prototype's; it now takes `runtime.analysis`. Behaviour for the prototype is unchanged (default argument).

## Limitations before real customer ingestion
* In-memory ledger only; no durable store, transactions, concurrency control, retention or deletion.
* No upload transport, size negotiation, malware scanning, encoding detection (UTF-8 text only) or streaming of large files.
* `ImportPolicy` and the identity boundary are interfaces; real authentication and import authorization are still required. Simulated identities are not authentication.
* No audit log of imports; no PII classification or redaction (notes and source labels are free text); no encryption at rest.
* Two-period comparison only; no currency or unit conversion, time zones, restatements, schema versions or late-arriving corrections.
* Numbers are IEEE doubles limited to 15 digits, not decimals.
* Rejected rows report only line and code, which protects data but makes operator debugging harder; a safe operator-facing reconciliation view is not built.
* `runMeta` and `contract.ts` are still typed for the prototype's evidence; dataset B runs through them with type casts in tests. The behaviour is generic; the types are not yet.
* The runtime's `question` is server text shown to the model for every role (as noted in PR B); choose a scope-neutral question per deployment.
