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
- a generic recommendation or hypothesis citing an unrelated fact (C11, C12);
- implicit causal wording: "hurt", "triggered", "as a consequence of" (D11-D13).

`policy` fixtures record an unresolved product decision, not a verdict: an all-empty structured output is accepted (E17), and qualitative magnitude ("rose sharply") is accepted (E18). Neither was changed.

`usability` fixtures are legitimate wording that is currently rejected (fail closed): hedged Tier 1 causal wording (D14), "possible causes include" (D15), a denial rejected by the direction guard (D16), and a natural short form that is not a catalog alias, "satisfaction" for customer satisfaction (A28b).

## Limits of this evaluation
- Fixtures are synthetic and written by hand; a measured rate describes those fixtures only.
- The model is a fake, so this evaluates the validators and plumbing, not model behaviour.
- Gate 3 re-uses the production vocabulary matcher, so it checks the rule, not the vocabulary.
- Mention-level consistency and wording-based causal detection are not semantic verification; that is unchanged.
