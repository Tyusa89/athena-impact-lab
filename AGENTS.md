<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

- Athena logic lives in src/lib/athena (data, deterministic engine, provider interface); records are permission-filtered before any output is computed; signals are observations only and hypotheses stay unverified; approvals are a pure local reducer.
- The prototype stays isolated: synthetic data only, no database or auth, and no EcoNest/Pendia connection. The deterministic analysis is local and makes no network calls; the only possible external call is the optional, off-by-default, server-side Meta request described below.
- Async Meta responses are shown only for the role, scenario and request they were issued for (src/lib/athena/meta/requestGate.ts, used by MetaPanel); any role/scenario/workspace change discards in-flight results.

- Meta model integration lives in src/lib/athena/meta (pure contract + server-only adapter) and is called only via src/lib/athena/meta.functions.ts; it requires server env META_MODEL_API_KEY plus META_MODEL_ENABLED=true plus per-run user confirmation; record scope comes only from the server-owned SERVER_ROLE_WORKSPACES map keyed by a submitted demo role id (client workspace lists are ignored; demo filtering, not authorization); it sends one request with no retries, and every output is schema- and citation-validated against permission-filtered records — so nothing reaches the model or the UI without the gates.
- Numerical grounding (src/lib/athena/meta/numericGrounding.ts): the server computes verified facts (id `F-<metric>`) from authorized records with the engine's computeFacts and sends them as VERIFIED_FACTS. Each number the model states must be a structured `claims` entry checked against that exact fact (metric, period, kind, value, unit, direction) and the item must cite the fact's supporting record IDs; digits in free text must equal a claim value. Anything unverifiable is rejected (fail closed). The `claims` field is optional in the output schema (defaults to []) but required in the response format sent to the model.
