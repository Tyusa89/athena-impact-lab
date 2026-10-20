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
- The prototype stays isolated: synthetic data only, no backend, auth, or live model calls.

- Meta model integration lives in src/lib/athena/meta (pure contract + server-only adapter) and is called only via src/lib/athena/meta.functions.ts; it requires server env META_MODEL_API_KEY plus META_MODEL_ENABLED=true plus per-run user confirmation, sends one request with no retries, and every output is schema- and citation-validated against permission-filtered records — so nothing reaches the model or the UI without the gates.
