# Athena Impact Lab

Build an isolated, unpublished prototype named 'Athena Business Impact Engine — Hackathon Lab' for EcoNest. IMPORTANT: This is a standalone synthetic-data demonstration, NOT an edit or integration with the existing EcoNest Main or Launchpad projects. Do not connect production databases, Supabase projects, authentication, Stripe, live APIs, or deploy/publish. Do not request or embed credentials. Create an attractive interactive TypeScript/React dashboard that demonstrates cross-department business reasoning for Sales, Marketing, Finance, Operations. Use an explicitly labeled fictional company and synthetic datasets with coherent numbers. Demo question: 'Why are sales declining while marketing leads are rising?' Show an evidence-linked chain: marketing leads up, lead quality down, sales conversion down, inventory fulfillment delays, revenue impact. Provide department evidence cards with record IDs, dates and source labels, separate Observed facts vs Hypotheses vs Recommended actions, confidence/limitations and alternative explanations, and human approval required for proposed actions. Include an explanation of workspace/role-based visibility as simulated only, and ensure hidden records cannot appear in output when simulated permissions are toggled. Add scenario selector, test cases, and a clear badge 'SIMULATED DATA — NOT CONNECTED TO ECONEST'. Architect an interface for a future Meta model provider but do not make live Meta API calls, fake model responses, or claim Muse Spark is integrated. Implement a deterministic demo analysis engine grounded strictly in the synthetic records and make the UI polished and responsive. Prioritize a working first version.

## Current status (supersedes the original brief above where they differ)

- **Local deterministic analysis** (default): rules engine over synthetic records, runs in the browser, no network or API calls.
- **Optional live Meta API analysis** (`muse-spark-1.3`): off by default. Runs only on the server, once, with no retries and hard token caps, and only when `META_MODEL_API_KEY` and `META_MODEL_ENABLED=true` are set on the server *and* the user confirms each run. It is a paid call. Output is schema- and citation-validated against permission-filtered records and is never executable.
- **Role filtering is simulated, not authorization.** There is no sign-in; anyone can claim any demo role.
- Responses from the Meta call are discarded if the role, scenario or request changed while they were in flight.
- Still synthetic only: no EcoNest/Pendia connection, database, auth or deployment.

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
