# Phase F: business impact validation

Synthetic data only. No model, no network, no secrets. Everything below is reproducible: `docs/business-impact-demo.md` is generated from the engine (a test fails if it is stale).

## What was added
* `meta/impact.ts`: a **deterministic Business Impact Map** (`buildImpactMap`) built only from `AuthorizedEvidence`, the catalog and an **operator-declared relationship model**.
  Generic (no prototype, no provider; covered by the engine-boundary test).
* `runImpactAnalysis` (`meta/runtime.ts`): the same resolve -> validate question -> authenticate -> authorize -> full-coverage steps as the model path (now a shared
  `authorizeRequest`), then the map. **No provider, key or fetch is involved.** `runPrototypeImpact` (`adapter.server.ts`) wires it to the demo.
* `impactModels.ts`: relationship models for the two datasets (business operations: 8 rules; customer support: 4 rules).
* The existing three-lane model path, prompts, goldens and prototype are untouched.

## The map's lanes (and what each may claim)
| Section | Status | Basis |
|---|---|---|
| Verified changes | verified | engine facts (same numbers as the model path's findings), each with its two record ids and the record sources (and import batch/line when imported) |
| Relationships | verified **co-movement**, or "pattern not present", or "insufficient evidence" | two verified facts moving as a declared rule expects. `claims_causation: false` always. A flat metric is not a movement |
| Hypotheses | **unverified** | operator-written, hedged implication, shown only for an observed relationship, never above Medium plausibility |
| Missing evidence | n/a | what would be needed to say more; metrics a relationship needs but the caller has no verified data for; "longer history than two periods" |
| Proposed actions | suggestion | tied to a hypothesis; `requires_human_approval: true`, `executable: false` |
A relationship is considered only if **both** metrics belong to domains the caller is authorized for; otherwise it is omitted with no trace (no name, no placeholder).

## What the engine can genuinely establish from this evidence
* **Verified metric changes** with exact figures, direction and provenance, for every authorized metric (baseline: leads +50%, MQL rate -38.2%, conversion -43.2%, closed deals -14.8%, fulfillment +151.6%, backorders +325%, revenue -17.9%, acquisition cost +19.5%; support: tickets +20%, first response flat, resolution +32.7%, CSAT -4.3%).
* **Which declared relationships the data actually show.** Baseline: all 8 show co-movement. Scenario B (quality-only): the Operations stories are *not* supported (fulfillment and backorders were flat) and the acquisition-cost relationship cannot be assessed (no data). Scenario C (ops-only): the Marketing-to-Sales story is *not* supported (lead quality was flat) while the Operations story is. Support: volume and resolution time rose and satisfaction fell (supported); first-response time was flat, so "slower first responses" is *not* a supported explanation.
* **That the same question gets a different, honest answer when the evidence differs**, and a restricted role gets only its own scope (Finance sees one verified change and no relationship; Marketing sees only Marketing/Sales relationships).

## What remains hypothesis or unknown
* **Why** anything changed. Two periods per metric cannot support causation, correlation strength, lag, magnitude attribution ("how much of the revenue drop is due to X"), segmentation (channel, SKU, rep) or seasonality. The "Paid social share rose 22% -> 51%" and "Supplier delay" notes are free text, not evidence, and are not used.
* Every implication is a hypothesis from the operator's model, not something learned from the data. The model decides which stories are *looked for*; the data decide only whether the pattern is present. A story nobody declared is never found.
* Whether a relationship is meaningful (e.g. a leading indicator vs coincidence) is unknown; the map lists the evidence that would be needed.

## Evidence behind each verified finding
Each verified change and relationship lists its record ids (prior and current) and source labels; tests check that every id is among the caller's authorized ids, that the sources are exactly those records' sources, that the text equals the engine's own `describeChange`, and that the verified changes equal the findings the model path renders.

## Across datasets
The same code produces maps for the prototype's business-operations catalog and the separate customer-support catalog (imported from CSV, with provenance). Cross-tenant tests (leaky store, permit-everything policy) show neither map contains the other's evidence.

## Remaining limitations before a customer-facing demonstration
* The relationship models are **hand-written for the synthetic data**. A customer needs their own, reviewed by a domain expert; wrong rules produce misleading "supported" statements (still co-movement only, still hedged).
* Two periods only; one fact per metric. No trend, no statistical test, no confidence.
* Direction coupling only (`same`/`opposite`); no thresholds on magnitude, no lag, no multi-metric conditions.
* The semantic question-to-focus matching uses catalog aliases (English keyword matching): paraphrases are not recognized, in which case all authorized relationships are shown.
* The map is not wired into the UI or the model path; the model's interpretations and this map are separate artifacts today.
* Domain-level scope: a role authorized for some records of a domain may see other metric labels of that domain when reported as "no verified data" (catalog names, not data).
* Rule texts are trusted operator configuration (validated for hedging and cause wording, not for factual correctness).
* The prototype's remaining coupling and the engine's other limitations are in `docs/engine-runtime.md` and `docs/ingestion.md`.
