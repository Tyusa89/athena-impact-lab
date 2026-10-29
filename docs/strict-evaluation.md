# Strict pipeline: offline end-to-end evaluation (G3)

`src/lib/athena/meta/strictEvaluation.test.ts` runs every fixture through the real `runStrictAnalysis` (authorize, scoped prompt, one fake-model call, strict validation, uniform public rejection) on synthetic evidence. It is test-only: no production code was changed, there is no second pipeline, no network, no live model and no new dependency. The strict path itself is still inactive (nothing live calls `runStrictAnalysis` or `validateStrictOutput`).

## Method
- **Worlds** (reused demo scenarios, roles and policy factory, plus the customer-support dataset built through the real importer and ledger): exec, marketing, ops and finance roles; marketing restricted to leads with CAC granted as discoverable but without data; the quality-only scenario; the support desk with all departments and with Support only.
- **Fixtures** (101): a table of id, description, class, world, fake model reply and the exact expected outcome (accepted, provider error, or the exact set of internal diagnostic categories). Classes: `valid`, `security`, `usability`, `limitation`, `policy`.
- Each fixture is executed twice (determinism) and the fake provider counts its calls.

## Hard security gates (any violation fails the suite)
1. No accepted output contains a record id, source label, or the fact id or label of a metric the caller may not use (an explicitly granted discoverable metric may be named).
2. Every rejection is the one fixed public response, byte for byte, with no category, id, label or model text; a provider failure never echoes a secret.
3. Every accepted interpretation and recommendation obeys the H2.4b exact-reference rule (checked independently of `refsConsistent`, with the same vocabulary matcher), and its `supporting_ids` equal the records of the cited facts as rendered by the server.
4. Every explicit affirmative causal claim in the G2 set is rejected as `causal`.
5. `verified: false` and `requires_human_approval: true` hold on every accepted output, and replies that violate them are never accepted.
6. Repeated runs are identical.
7. The legacy path is unchanged (it still accepts what the strict profile rejects and keeps its detailed messages); the legacy goldens run in `golden/golden.test.ts` in the same suite.
8. The fake provider is called exactly once per request.
9. No network request is attempted.

## Usability measurements (reported, not thresholded)
The test prints valid-fixture acceptance, the false-positive rejection rate, the not-accepted rate on the security set, the known-limitation acceptance, the count of legitimate-uncertainty rejections, and accepted/rejected/error counts by world. These are measurements of a fixture set I chose, not a readiness score.

## Pinned current behaviour that is NOT protection
`limitation` fixtures (desired: reject, observed: accepted) are pinned so a change is noticed; they are not counted as evidence-integrity protection:
- a misleading non-numeric claim with correct citations (C10);
- ~~a generic recommendation or hypothesis citing an unrelated fact (C11, C12)~~ (resolved in G4.6, see below; the two fixtures are now `security` rejections);
- implicit causal wording: "hurt", "triggered", "as a consequence of" (D11-D13).

`policy` fixtures record an unresolved product decision, not a verdict: an all-empty structured output is accepted (E17), and qualitative magnitude ("rose sharply") is accepted (E18). Neither was changed (G4.6 only characterized them, see below).

`usability` fixtures are legitimate wording that is currently rejected (fail closed): hedged Tier 1 causal wording (D14), "possible causes include" (D15), a denial rejected by the direction guard (D16), and a natural short form that is not a catalog alias, "satisfaction" for customer satisfaction (A28b).

## Limits of this evaluation
- Fixtures are synthetic and written by hand; a measured rate describes those fixtures only.
- The model is a fake, so this evaluates the validators and plumbing, not model behaviour.
- Gate 3 re-uses the production vocabulary matcher, so it checks the rule, not the vocabulary.
- Mention-level consistency and wording-based causal detection are not semantic verification; that is unchanged.

## G4.6: evidence-integrity hardening (offline; the strict path is still not promoted)
Four changes, all in the STRICT profile only. The legacy path, its detailed messages and the goldens are unchanged. `evidenceIntegrity.test.ts` holds the regression tests (13 of them fail if the source changes are reverted; the rest are positive, limit and characterization tests).

**C11/C12: generic citation integrity (`refConsistency.ts`).** A sentence that names no metric still has to cite at least one fact (schema), and `supporting_ids` are derived from whatever it cites, so an unrelated fact used to be shown as supporting evidence. Two deterministic rules now apply to such sentences, and a sentence that triggers neither still passes:
- *Department*: if it names a department (or a metric with no verified fact, whose owner counts) and the caller has at least one verified fact in a named department, at least one cited fact must belong to a named department. "Review the sales strategy" citing only a Finance fact is rejected (`relevance`); citing a Sales fact is accepted. If no fact exists in any named department the rule does not apply, because a related citation is impossible.
- *Direction*: a reference to an unspecified rise or fall ("the decline", "the recent increase") needs a cited fact with that verified direction, per direction mentioned. A mention is exempt only when the negation, condition or question applies to that mention itself ("no sign of the decline", "if the decline continues", "is the decline seasonal?"); a negator elsewhere in the sentence ("no one has explained the decline") does not exempt it.
Not changed, and still limits: wholly generic text ("gather more data") may cite any fact; extra citations beside a related one are tolerated for generic sentences (the metric-named rule keeps exact match, coverage and no extras); an accepted citation shows relatedness by department or direction, not that the fact supports the claim.

**F5: flat-direction consistency (`semantic.ts`).** A flat finding means the relative change is under the catalog threshold, not that nothing moved. A directional claim about a flat metric is now judged against the finding and the raw values: equal values reject any up/down claim; a claim opposite to the raw movement is rejected; forceful language (strong verbs such as surged/soared/plunged, or an intensifier such as sharply/dramatically/significantly) is rejected when the relative change is defined. A truthful description of a small raw movement ("rose slightly" for +1%) is accepted. When the prior value is zero the engine labels the finding flat although the relative change is undefined; only the equality and sign rules apply there. Non-flat findings are untouched.

**F2: explicit discoverability.** Audit: the strict pipeline (`runStrictAnalysis` to `validateStrictOutput`) already used the generic `semanticScope`, which never infers a grant, but (1) a policy that omitted `discoverableMetrics` was indistinguishable from one that granted nothing, which is how the G4.1 runner silently lost its grant; and (2) the prototype facade `semanticGuards.semanticScope` defaulted to a grant derived from the departments of the records present, even for a strict scope. Now: `authorizeEvidence` reports `grantDeclared`; `runStrictAnalysis` refuses to run (blocked, nothing sent) unless the grant was declared (an empty array is a valid declaration); `validateStrictOutput` and `buildScopedMessages` throw if the grant is not an array; the facade throws for a strict scope without an explicit grant and keeps the department-derived default only for the legacy scope. Authorization of records is unchanged.

**E17 and E18: unchanged, characterized.** E17: an all-empty output (every lane empty) is accepted, because the schema allows empty lanes; the G4.5 reasoning score rates it the weakest (0/10) but never gates. E18: qualitative magnitude ("rose sharply", "fell steeply") is accepted for non-flat findings; numeric and quantified magnitude (percent, doubled, a third) stay rejected. The only interaction is F5: the same qualitative wording is rejected against a flat finding.

**Unresolved policy decisions.** (1) E17 and E18 above. (2) Whether a zero-to-nonzero move should be classified flat by the engine at all (`computeFacts` labels it flat because the relative change is undefined); G4.6 works around it in the validator and does not change the classification or what Athena displays. (3) Whether wholly generic sentences should be allowed to cite arbitrary facts, or should carry no `supporting_ids`.
