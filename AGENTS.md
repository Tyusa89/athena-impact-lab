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
- Three-lane Meta output (src/lib/athena/meta: findings.ts, numericGrounding.ts, contract.ts): (1) verified findings are rendered by Athena on the server from verified facts (engine computeFacts over authorized records, ids `F-<metric>`) and returned with the result — the model never authors them; (2) interpretations are Muse Spark text, always `verified:false`, with `refs` to fact ids; (3) proposed actions are Muse Spark text with `refs`, `requires_human_approval:true`, never executable. The model sends no observations, numeric claims or record citations (v1 shape is rejected); citations are derived server-side from the referenced facts. Model text may contain no numerals at all (strict rule; NFKC-normalized, non-ASCII numerals rejected; record ids, Q1-Q4 and years exempt). The prompt is facts-only (VERIFIED_FACTS + PERIODS); the adapter blocks any run where an authorized record is not covered by a fact. Known gap until the Phase 2B-2 lexicon guards: contradictory or magnitude prose without digits, and prose about unauthorized domains, can still appear inside the unverified lanes (labelled unverified, shown beside the verified findings).
