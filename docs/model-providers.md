# Model providers (PR C)

The engine talks to a model only through `ModelProvider` (`src/lib/athena/meta/provider.ts`). Muse Spark 1.3 is the default provider
(`meta/providers/muse.ts`); nothing else is integrated.

## Contract
A provider is a **transport**. It receives a frozen `ModelRequest` (messages the engine built from *authorized* evidence only, the output
cap, the JSON Schema) and a `ProviderCall` (`env`, the injected `fetch`, an abort `signal`), and returns a `ModelOutcome`: either
`{kind:"completion", content, truncated, usage}` or `{kind:"failure", code, status?, errorName?}`. It also reports `status(env)` and `blockedCode(env)`.

## Error boundary (C1)
A provider never supplies prose for a user or a log. It selects from **closed sets** (`provider.ts`): failure codes `http_error | network_error |
malformed_response | unavailable | unknown`, blocked codes `credential_missing | not_activated | unavailable`, error class names (`SAFE_ERROR_NAMES`)
and stop reasons (`SAFE_FINISH_REASONS`), plus an HTTP status (an integer 100-599). `providerBoundary.ts` maps each to **fixed engine wording**
(e.g. `"<label> returned HTTP 503 (not retried)."`); anything outside the sets becomes `unknown` / `unavailable` (a blocked answer that is not exactly
`null` fails closed). Free-text fields (`reason`, `message`, stack, custom properties, an upstream body) are never read. A thrown error is reported by
a known class name only. Static labels (`id`, `model`, `displayName`) are read before the request exists and validated against strict patterns, else
replaced by a fixed fallback. Server diagnostics carry only the provider id, a category code and a status number.
Residual: a deliberately malicious provider implementation is in-process code that holds the credential and could exfiltrate by other means; this boundary
protects against upstream content, bugs and untrusted data flowing through a well-meaning provider.

It never sees records, citations, tenants, identities or the evidence store. Nothing it returns is trusted: the engine reads only
`content`, `truncated` and well-formed token counts, and validates the text from scratch (strict schema, numeral policy, semantic guards, leak
check). Verified findings and citations are rendered by the engine from its own facts.

## What the engine guarantees to every provider
Exactly one `complete` call per request; no retry after any outcome; one 30 s deadline over the whole call, enforced by the engine even if the
provider ignores the signal; the same input budget (3000 estimated tokens) and output cap (2000); owner activation and credential checks via
the provider's `blockedReason`; a frozen request; usage sanitised (the cap shown is the engine's).

## Adding a provider
1. Create `meta/providers/<name>.ts` implementing `ModelProvider`. Import only `../provider`, `../limits`, `../outputSchema` (a test enforces this).
2. Put all endpoint, header, body and response-parsing code there; use `call.fetch` and `call.signal`; never log or return the credential, the
   prompt or response text; make `reason` safe to show.
3. Add `<name>.test.ts` calling `describeProviderContract` from `meta/providerContract.ts` with a mocked transport for the scenarios it lists.
4. Select it where the runtime is composed (`PROTOTYPE_RUNTIME.provider`). No change to the engine, contract, validation or UI wiring is needed.

## Known remaining coupling (see the PR description)
The activation variable names `META_MODEL_API_KEY` / `META_MODEL_ENABLED`, the `MetaEnv` alias, the "Meta" wording in some log lines and UI strings,
and `MetaPanel`'s display of `META_MODEL` are still Muse-flavoured. They are cosmetic or configuration, not logic.
