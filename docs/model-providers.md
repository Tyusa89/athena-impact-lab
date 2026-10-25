# Model providers (PR C)

The engine talks to a model only through `ModelProvider` (`src/lib/athena/meta/provider.ts`). Muse Spark 1.3 is the default provider
(`meta/providers/muse.ts`); nothing else is integrated.

## Contract
A provider is a **transport**. It receives a frozen `ModelRequest` (messages the engine built from *authorized* evidence only, the output
cap, the JSON Schema) and a `ProviderCall` (`env`, the injected `fetch`, an abort `signal`), and returns a `ModelOutcome`: either
`{kind:"completion", content, truncated, usage}` or `{kind:"failure", reason}`. It also reports `status(env)` and `blockedReason(env)`.

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
