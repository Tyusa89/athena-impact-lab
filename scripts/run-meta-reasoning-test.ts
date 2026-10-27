// CLI for the G4.1 local reasoning test. Usage (see docs/meta-reasoning-test.md):
//   bun scripts/run-meta-reasoning-test.ts [--show-response]            dry run (default): fake model, no network
//   bun scripts/run-meta-reasoning-test.ts --live [--show-response]     ONE live Meta request, only with the key, the enable flag and the per-run confirmation in the environment
// Nothing is written to disk or a database, no recommendation is executed, and the confirmation is read from the environment of this process only.
import { formatReport, runReasoningTest } from "./metaReasoningTest";

const args = new Set(process.argv.slice(2));
const unknown = [...args].filter((a) => a !== "--live" && a !== "--show-response");
if (unknown.length) {
  console.error(`Unknown argument(s): ${unknown.join(" ")}\nUse: [--live] [--show-response]`);
  process.exit(2);
}
const live = args.has("--live");
const env = {
  META_MODEL_API_KEY: process.env["META_MODEL_API_KEY"],
  META_MODEL_ENABLED: process.env["META_MODEL_ENABLED"],
  G41_LIVE_CONFIRM: process.env["G41_LIVE_CONFIRM"],
};
// The engine logs token counts and category codes while it runs; this report prints the same facts once, so its own logging is muted for the duration of the run.
const [info, error] = [console.info, console.error];
console.info = console.error = () => {};
let report;
try {
  report = await runReasoningTest(
    {
      mode: live ? "live" : "dry-run",
      env,
      ...(live ? { fetchImpl: fetch } : {}),
      showResponse: args.has("--show-response"),
    },
    { liveFlag: live, inCi: !!process.env["CI"] },
  );
} finally {
  console.info = info;
  console.error = error;
}
console.log(formatReport(report));
process.exit(
  !report.ok ? 2 : report.allSafetyChecksPassed && report.outcome === "accepted" ? 0 : 1,
);
