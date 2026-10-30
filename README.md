# Athena Impact Lab

Build an isolated, unpublished prototype named 'Athena Business Impact Engine — Hackathon Lab' for EcoNest. IMPORTANT: This is a standalone synthetic-data demonstration, NOT an edit or integration with the existing EcoNest Main or Launchpad projects. Do not connect production databases, Supabase projects, authentication, Stripe, live APIs, or deploy/publish. Do not request or embed credentials. Create an attractive interactive TypeScript/React dashboard that demonstrates cross-department business reasoning for Sales, Marketing, Finance, Operations. Use an explicitly labeled fictional company and synthetic datasets with coherent numbers. Demo question: 'Why are sales declining while marketing leads are rising?' Show an evidence-linked chain: marketing leads up, lead quality down, sales conversion down, inventory fulfillment delays, revenue impact. Provide department evidence cards with record IDs, dates and source labels, separate Observed facts vs Hypotheses vs Recommended actions, confidence/limitations and alternative explanations, and human approval required for proposed actions. Include an explanation of workspace/role-based visibility as simulated only, and ensure hidden records cannot appear in output when simulated permissions are toggled. Add scenario selector, test cases, and a clear badge 'SIMULATED DATA — NOT CONNECTED TO ECONEST'. Architect an interface for a future Meta model provider but do not make live Meta API calls, fake model responses, or claim Muse Spark is integrated. Implement a deterministic demo analysis engine grounded strictly in the synthetic records and make the UI polished and responsive. Prioritize a working first version.

## Current status (supersedes the original brief above where they differ)

- **Local deterministic analysis** (default): rules engine over synthetic records, runs in the browser, no network or API calls.
- **Optional live Meta API analysis** (`muse-spark-1.3`): off by default. Runs only on the server, once, with no retries and hard token caps, and only when `META_MODEL_API_KEY` and `META_MODEL_ENABLED=true` are set on the server *and* the user confirms each run. It is a paid call. Output is schema- and citation-validated against permission-filtered records and is never executable.
- **Role filtering is simulated, not authorization.** There is no sign-in; anyone can claim any demo role.
- Responses from the Meta call are discarded if the role, scenario or request changed while they were in flight.
- Meta output is split into three lanes: **verified findings** (computed and rendered by Athena on the server; no model text), **interpretations** (Muse Spark, always unverified, each pointing at verified facts) and **proposed actions** (Muse Spark, need human approval, never executable). The model may not write numbers; Athena shows them. Narrow semantic guards reject (never rewrite) model text that contradicts a verified finding, states an unsupported magnitude about a metric, or makes a directional claim about a metric/department the role cannot see; error messages are generic and never echo unauthorized identifiers. These are bounded heuristics: remaining gaps (look-alike characters, paraphrases, unlisted verbs, elided subjects, trailing time expressions) are documented in `semanticGuards.ts` and AGENTS.md, and no finite test corpus supports a claim of zero false rejects or bypasses in general use.
- Still synthetic only: no EcoNest/Pendia connection, database, auth or deployment.

## Tindara (the standalone engine)

**Tindara** is the product name for the reasoning engine this repository developed as "Athena Engine". The app above is one *consumer* of it;
EcoNest would be another. Its supported public entry point is `src/lib/tindara/index.ts`, documented in
[`docs/tindara-public-api.md`](docs/tindara-public-api.md).

C1 Phase 0 established that boundary only. **Production authentication, durable storage and an external REST API are not implemented**, and
the demo's simulated identity is deliberately unreachable through the public entry point. Internal module paths and symbol names were not
renamed.

This project was built with [Lovable](https://lovable.dev).

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/1502b1da-7760-4201-bb56-f393029f5e9a).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
