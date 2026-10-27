# First Meta reasoning test: local runner and runbook (G4.1)

A local, founder-run harness for ONE controlled reasoning test with Meta's model on SYNTHETIC data. It is not part of the application: no route, server function or build entry uses it, and it reads no deployed configuration. This PR adds the harness and its offline dry run. **It does not authorize a live call.**

## What it does
`scripts/run-meta-reasoning-test.ts` calls the existing `runStrictAnalysis` with the existing `museSpark` provider over the demo marketing scenario, with evidence restricted to leads, conversion rate and CAC (leads up, conversion down, CAC up). The scoped prompt carries no question text, no record ids and no other metric. The reply goes through the full strict validator (schema, leak check, direction, strict vocabulary, H2.4b exact citations, G2 causal policy) and anything that fails is reported by closed category only.

It writes nothing to disk or a database, keeps no memory and executes no recommendation (recommendations are text that require human approval).

## 1. Dry run (default, offline, needs no key)
```
bun scripts/run-meta-reasoning-test.ts [--show-response]
```
A fixed fake model reply (observations, a hedged hypothesis, missing evidence, a human-approved investigation) runs through the real strict validator. No request is made, and the real environment is never handed to the provider. `--show-response` prints the synthetic reply locally. Expected: `outcome: accepted`, `outbound requests: 0`, `safety checks: ALL PASSED`.

## 2. Verify before any live test
- The dry run is accepted with all safety checks passed, and `bun run test` passes.
- You have read this page and accept the uncertainties below.
- The key is for a spend limit you accept; one call is at most about 3,000 estimated input tokens and 2,000 output tokens (reasoning tokens count toward the output cap).
- Nothing deployed has the Meta flag on: do **not** set `META_MODEL_ENABLED` in any deployed environment. The existing app panel still calls the legacy, non-strict path.

## 3. Credentials (local only, never committed)
Put the values in your own shell for the one run; do not write them into a file in this repository. The runner never prints them and never persists the confirmation.
```
export META_MODEL_API_KEY=...        # your key
export META_MODEL_ENABLED=true
export G41_LIVE_CONFIRM=I-AUTHORIZE-ONE-PAID-META-CALL   # required for EVERY live run
```

## 4. Authorizing one live call (a separate, explicit step)
Only after review and separate written authorization:
```
bun scripts/run-meta-reasoning-test.ts --live [--show-response]
```
Live mode is refused (exit 2, nothing sent) unless `--live`, the key, `META_MODEL_ENABLED=true` and the confirmation phrase are all present, and it is always refused when `CI` is set. It makes at most ONE request, only a POST to `https://api.meta.ai/v1/chat/completions`; any second request or other destination is blocked and counted. There are no retries; the existing 30-second deadline and token limits apply.

Judge the result: success means one request, `outcome: accepted`, all safety checks passed, and the usefulness signals (it states the three observed movements, separates the hedged hypothesis, names missing evidence, recommends an investigation, and makes no unsupported cause claim). A rejection, truncation, empty reply, timeout or HTTP error is a recorded result: do not retry; unset the variables and review.

## 5. Disabling
Unset `META_MODEL_API_KEY`, `META_MODEL_ENABLED` and `G41_LIVE_CONFIRM` (or close the shell). Without all three, and without `--live`, nothing can be sent. Deleting `scripts/` removes the runner; nothing else depends on it.

## Known uncertainties
- **Live connectivity is unverified.** The provider adapter documents Meta's API shape from Meta's documentation, but this harness has never reached the live service, and whether the real service accepts the exact request (the structured-output envelope has no `strict` flag; `reasoning_effort` is fixed to `minimal`) is not confirmed.
- **Pricing is unverified** (the adapter says so). The only enforced bound is tokens per call.
- **One live call says little about reliability.** A single accepted reply is not evidence of model reliability, and a single rejection is not evidence of unreliability.
- The G3 known limitations still apply (misleading claims with correct citations, implicit causal wording, generic statements citing unrelated facts, several legitimate hedged wordings rejected).
