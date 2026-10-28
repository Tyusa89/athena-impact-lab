// G4.1: an ISOLATED, LOCAL-ONLY runner for the first founder-controlled Meta reasoning test. It is a thin composition of existing pieces: the real `runStrictAnalysis` (scoped prompt,
// strict validation, uniform rejection), the real `museSpark` provider, and the synthetic demo evidence restricted to leads, conversion rate and CAC. It adds no reasoning logic of its own.
//
// It is NOT part of the application: no route, no server function, no build entry imports it, and it reads no deployed configuration. DRY-RUN is the default and makes no network
// request. LIVE mode needs --live, the existing key and enable variables, AND a per-run confirmation phrase in the environment. At most ONE outbound request is allowed, to the Meta endpoint only.
import { PROTOTYPE_RUNTIME } from "../src/lib/athena/meta/adapter.server";
import type { AccessPolicy } from "../src/lib/athena/core/access";
import { demoAccessPolicy, type PrototypeEvidence } from "../src/lib/athena/prototypeAdapter";
import type {
  ModelOutcome,
  ModelProvider,
  ModelUsage,
  ProviderEnv,
} from "../src/lib/athena/meta/provider";
import { META_ENDPOINT, META_MODEL, museSpark } from "../src/lib/athena/meta/providers/muse";
import { authorizeRequest } from "../src/lib/athena/meta/runtime";
import { renderFindings } from "../src/lib/athena/meta/render";
import { runStrictAnalysis, type StrictResult } from "../src/lib/athena/meta/strictRuntime";
import type { DiagnosticCategory } from "../src/lib/athena/meta/strictValidation";
import {
  evaluateFindings,
  evaluateReasoning,
  type FindingsEvaluation,
  type ReasoningEvaluation,
} from "./reasoningQuality";

/** Set in the shell for ONE live run; never written anywhere by this runner. */
export const CONFIRM_ENV = "G41_LIVE_CONFIRM";
export const CONFIRM_PHRASE = "I-AUTHORIZE-ONE-PAID-META-CALL";
/** The only destination an outbound request may reach. */
export const ALLOWED_URL = META_ENDPOINT;
export const MAX_OUTBOUND_REQUESTS = 1;
/** The synthetic scope: only these metrics have records the caller may use; everything else is withheld. */
export const TEST_METRICS = ["leads", "conversion_rate", "cac"] as const;
/** The directions the synthetic baseline scenario was built with; the findings evaluation compares Athena's own rendered findings with these. */
export const EXPECTED_DIRECTIONS = { leads: "up", conversion_rate: "down", cac: "up" } as const;
const SCENARIO = { scenarioId: "baseline", roleId: "marketing", ownerConfirmed: true } as const;

/** A fixed, synthetic reply for the dry run: specific unverified hypotheses that link the cited facts, concrete missing evidence, and actionable human-approved investigations. It does not restate
 * the observed movements (Athena renders those itself) and contains no numbers. */
export const DRY_RUN_REPLY = JSON.stringify({
  interpretations: [
    {
      text: "A shift toward lower-intent lead sources may be adding volume that dilutes the conversion rate.",
      verified: false,
      refs: ["F-leads", "F-conversion_rate"],
    },
    {
      text: "Slower sales follow-up on a larger intake of leads may leave more acquisition cost spent on prospects who never close.",
      verified: false,
      refs: ["F-leads", "F-cac"],
    },
  ],
  missing_evidence: [
    "Lead counts and conversion by source, so lower-intent sources can be separated from the rest.",
    "Lead quality scores by source for both periods, which Athena does not currently have.",
    "Time from lead creation to first sales contact, split by source.",
  ],
  recommendations: [
    {
      text: "Segment leads and conversion by source to test whether lower-intent sources account for the gap.",
      requires_human_approval: true,
      refs: ["F-leads", "F-conversion_rate"],
    },
    {
      text: "Break down acquisition cost by lead source and compare it with conversion for the same sources.",
      requires_human_approval: true,
      refs: ["F-cac", "F-leads", "F-conversion_rate"],
    },
  ],
});

export type Mode = "dry-run" | "live";
export interface RunOptions {
  mode: Mode;
  /** The process environment (or a stand-in). Only the Meta key/enable variables and the confirmation variable are read, and none is ever printed. */
  env: ProviderEnv;
  /** The transport for LIVE mode. Dry-run never uses it. */
  fetchImpl?: typeof fetch;
  /** Explicitly requested, local-only inspection of the model's reply (synthetic data only). */
  showResponse?: boolean;
  /** Test seam for DRY-RUN only (a different fake reply or a misbehaving fake provider). Live mode ignores it and always uses `museSpark`; the CLI never passes it. */
  provider?: ModelProvider;
}
export type Prerequisite =
  "live-flag" | "not-in-ci" | "confirmation" | "credential" | "activation" | "transport";
export type PrerequisiteFailure = { ok: false; kind: "prerequisites"; missing: Prerequisite[] };
export interface SafetyCheck {
  name: string;
  pass: boolean;
}
export interface Report {
  ok: true;
  kind: "report";
  mode: Mode;
  model: string;
  liveModelTarget: string;
  endpointHost: string;
  outboundRequests: number;
  blockedRequests: number;
  outcome: "accepted" | "rejected" | "error" | "blocked";
  diagnostics: DiagnosticCategory[];
  usage: Record<string, number | string> | "n/a (dry-run)" | "n/a";
  checks: SafetyCheck[];
  allSafetyChecksPassed: boolean;
  /** Deterministic lane: Athena's own rendered findings (independent of the model, and available even when the reply is rejected). */
  findings: FindingsEvaluation | null;
  /** Model lane: heuristic quality of an ACCEPTED reply; null when the reply was not accepted. A low score never rejects anything. */
  reasoning: ReasoningEvaluation | null;
  /** Only when explicitly requested with showResponse. Synthetic data; never contains credentials. */
  response?: string | null;
}

/** The synthetic scope: the demo marketing role, with only the three test metrics' RECORDS permitted. The policy's own metric-discovery grant (`discoverableMetrics`: the NAMES of the
 * metrics of the departments the role holds, no values) is passed through unchanged, so the scoped prompt can list a discoverable metric without data under UNAVAILABLE_METRICS and the
 * validator treats it as discoverable-but-unavailable (it may be named, e.g. as missing evidence, but nothing may be claimed about it) instead of as an unauthorized metric. */
export const testPolicy = (): AccessPolicy<PrototypeEvidence> => ({
  evidenceScope: (ctx) => {
    const base = demoAccessPolicy.evidenceScope(ctx);
    return {
      tenantId: base.tenantId,
      permits: (e) => base.permits(e) && (TEST_METRICS as readonly string[]).includes(e.metric),
      ...(base.discoverableMetrics ? { discoverableMetrics: base.discoverableMetrics } : {}),
    };
  },
});

/** The transport the provider gets: one request to the allowlisted endpoint, nothing else. A second request or any other destination is refused (and counted), never forwarded. */
export function guardedFetch(real: typeof fetch) {
  const state = { forwarded: 0, blocked: 0 };
  const guarded = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    const method = (init?.method ?? "GET").toUpperCase();
    if (url !== ALLOWED_URL || method !== "POST" || state.forwarded >= MAX_OUTBOUND_REQUESTS) {
      state.blocked++;
      throw new Error("outbound request blocked by the runner");
    }
    state.forwarded++;
    return real(input, init);
  }) as typeof fetch;
  return { fetch: guarded, state };
}

const dryRunProvider = (reply: string): ModelProvider => ({
  id: "dry-run-fake",
  model: "dry-run-fake",
  displayName: "Dry run",
  status: () => ({ keyConfigured: true, ownerEnabled: true }),
  blockedCode: () => null,
  async complete(): Promise<ModelOutcome> {
    return {
      kind: "completion",
      content: reply,
      truncated: false,
      usage: { max_tokens_sent: 2000 },
    };
  },
});

/** Wraps a provider so the runner can show token usage and (only on request) the reply. Records in memory; logs nothing. */
function capturing(inner: ModelProvider) {
  const seen: { calls: number; content: string | null; usage: ModelUsage | null } = {
    calls: 0,
    content: null,
    usage: null,
  };
  const wrapped: ModelProvider = {
    ...inner,
    async complete(request, call) {
      seen.calls++;
      const out = await inner.complete(request, call);
      if (out.kind === "completion") {
        seen.content = out.content;
        seen.usage = out.usage;
      }
      return out;
    },
  };
  return { wrapped, seen };
}

/** Why a LIVE run cannot start. Empty means every prerequisite holds. Never reports a value. */
export function livePrerequisites(
  opts: Pick<RunOptions, "env" | "fetchImpl">,
  liveFlag: boolean,
  inCi: boolean,
): Prerequisite[] {
  const missing: Prerequisite[] = [];
  if (!liveFlag) missing.push("live-flag");
  if (inCi) missing.push("not-in-ci");
  if (opts.env[CONFIRM_ENV] !== CONFIRM_PHRASE) missing.push("confirmation");
  // The existing provider checks, reported together so the founder sees everything that is missing at once.
  const st = museSpark.status(opts.env);
  if (!st.keyConfigured) missing.push("credential");
  if (!st.ownerEnabled) missing.push("activation");
  if (museSpark.blockedCode(opts.env) !== null && st.keyConfigured && st.ownerEnabled)
    missing.push("activation"); // any other block: refuse
  if (!opts.fetchImpl) missing.push("transport");
  return missing;
}

export async function runReasoningTest(
  opts: RunOptions,
  ctx: { liveFlag?: boolean; inCi?: boolean } = {},
): Promise<Report | PrerequisiteFailure> {
  const live = opts.mode === "live";
  if (live) {
    const missing = livePrerequisites(opts, ctx.liveFlag === true, ctx.inCi === true);
    if (missing.length) return { ok: false, kind: "prerequisites", missing };
  }
  const tripwire = (async () => {
    throw new Error("no network in dry-run");
  }) as unknown as typeof fetch;
  // Dry-run runs through the SAME guard, over a transport that cannot reach the network: a provider that tried to send anything would be counted and flagged.
  const guard = guardedFetch(live ? opts.fetchImpl! : tripwire);
  const provider = live ? museSpark : (opts.provider ?? dryRunProvider(DRY_RUN_REPLY));
  const cap = capturing(provider);
  const diag: DiagnosticCategory[][] = [];
  // Dry-run never reads the real environment: a placeholder satisfies the readiness check of the (fake) provider only.
  const env: ProviderEnv = live
    ? opts.env
    : { META_MODEL_API_KEY: "dry-run-placeholder", META_MODEL_ENABLED: "true" };
  const result: StrictResult = await runStrictAnalysis(
    SCENARIO,
    env,
    guard.fetch,
    { ...PROTOTYPE_RUNTIME, policy: testPolicy() as AccessPolicy, provider: cap.wrapped },
    { onDiagnostics: (c) => diag.push([...c]) },
  );

  // The deterministic lane is evaluated on its own, from the same authorization the run used: it needs no model reply, so it is available for a rejected reply too.
  const prep = await authorizeRequest(SCENARIO, {
    ...PROTOTYPE_RUNTIME,
    policy: testPolicy() as AccessPolicy,
  });
  const findings = prep.ok
    ? evaluateFindings(
        renderFindings(prep.records, PROTOTYPE_RUNTIME.analysis),
        EXPECTED_DIRECTIONS,
      )
    : null;
  const outcome =
    result.state === "ok"
      ? "accepted"
      : result.state === "rejected"
        ? "rejected"
        : result.state === "error"
          ? "error"
          : "blocked";
  const diagnostics = [...new Set(diag.flat())].sort() as DiagnosticCategory[];
  const accepted = result.state === "ok" ? result : null;
  const texts = accepted
    ? [
        ...accepted.output.interpretations.map((i) => i.text),
        ...accepted.output.missing_evidence,
        ...accepted.output.recommendations.map((r) => r.text),
      ]
        .join(" ")
        .toLowerCase()
    : "";
  const checks: SafetyCheck[] = [
    {
      name: `at most ${MAX_OUTBOUND_REQUESTS} outbound request`,
      pass: guard.state.forwarded <= MAX_OUTBOUND_REQUESTS && cap.seen.calls <= 1,
    },
    {
      name: "no request to a non-allowlisted destination or after the first was forwarded",
      pass: guard.state.blocked === 0,
    },
    { name: "dry-run made no outbound request", pass: live || guard.state.forwarded === 0 },
    {
      name: "an accepted reply keeps verified:false on interpretations and human approval on recommendations",
      pass:
        !accepted ||
        (accepted.output.interpretations.every((i) => i.verified === false) &&
          accepted.output.recommendations.every((r) => r.requires_human_approval === true)),
    },
    {
      name: "an accepted reply contains no record id, source label or withheld metric",
      pass: !accepted || !/vh-|syn-|revenue|fulfil|backorder/.test(texts),
    },
  ];
  const report: Report = {
    ok: true,
    kind: "report",
    mode: opts.mode,
    model: provider.model,
    liveModelTarget: META_MODEL,
    endpointHost: new URL(ALLOWED_URL).host,
    outboundRequests: guard.state.forwarded,
    blockedRequests: guard.state.blocked,
    outcome,
    diagnostics,
    usage: live
      ? cap.seen.usage
        ? ({ ...cap.seen.usage } as Record<string, number | string>)
        : "n/a"
      : "n/a (dry-run)",
    checks,
    allSafetyChecksPassed: checks.every((c) => c.pass),
    findings,
    reasoning: accepted
      ? evaluateReasoning(
          accepted.output,
          accepted.findings.map((f) => f.fact_id),
        )
      : null,
    ...(opts.showResponse ? { response: cap.seen.content } : {}),
  };
  return report;
}

/** Human-readable output. Contains no credential, no prompt, and no model reply unless the report carries one (explicitly requested). */
export function formatReport(r: Report | PrerequisiteFailure): string {
  if (!r.ok)
    return [
      "LIVE RUN REFUSED: prerequisites not met (nothing was sent):",
      ...r.missing.map((m) => `  - ${DESCRIBE[m]}`),
    ].join("\n");
  const L = [
    `mode: ${r.mode}`,
    `model: ${r.model}${r.mode === "dry-run" ? ` (live target would be ${r.liveModelTarget})` : ""}`,
    `endpoint host: ${r.endpointHost}`,
    `outbound requests: ${r.outboundRequests} (blocked attempts: ${r.blockedRequests})`,
    `outcome: ${r.outcome}`,
    `diagnostic categories: ${r.diagnostics.length ? r.diagnostics.join(", ") : "none"}`,
    `token usage: ${
      typeof r.usage === "string"
        ? r.usage
        : Object.entries(r.usage)
            .map(([k, v]) => `${k}=${v}`)
            .join(" ")
    }`,
    `safety checks: ${r.allSafetyChecksPassed ? "ALL PASSED" : "FAILED"}`,
    ...r.checks.map((c) => `  [${c.pass ? "pass" : "FAIL"}] ${c.name}`),
  ];
  if (r.findings)
    L.push(
      `findings lane (deterministic, independent of the model): ${r.findings.allPresent ? "all present" : "MISSING"}, directions ${r.findings.directionsMatch ? "match" : "DO NOT MATCH"}`,
      ...Object.entries(r.findings.perMetric).map(
        ([m, v]) =>
          `  [${v.present && v.direction === v.expected ? "yes" : "no "}] ${m}: ${v.direction ?? "absent"} (expected ${v.expected})`,
      ),
    );
  if (r.reasoning)
    L.push(
      `model reasoning (heuristic, 0-2 each; for the founder to judge): ${r.reasoning.total}/${r.reasoning.max} ${r.reasoning.verdict}`,
      `  hypothesis specificity: ${r.reasoning.hypothesisSpecificity}`,
      `  relevance to authorized facts: ${r.reasoning.relevance}`,
      `  missing-evidence quality: ${r.reasoning.missingEvidenceQuality}`,
      `  actionable investigation: ${r.reasoning.actionableInvestigation}`,
      `  appropriate uncertainty: ${r.reasoning.appropriateUncertainty}`,
    );
  else L.push("model reasoning: not available (the reply was not accepted)");
  if ("response" in r)
    L.push(
      "--- model response (local inspection, synthetic data) ---",
      r.response ?? "(none)",
      "--- end ---",
    );
  return L.join("\n");
}
const DESCRIBE: Record<Prerequisite, string> = {
  "live-flag": "--live was not passed",
  "not-in-ci": "live mode is refused when CI is set",
  confirmation: `${CONFIRM_ENV} is not set to the confirmation phrase for this run`,
  credential: "META_MODEL_API_KEY is not set",
  activation: 'META_MODEL_ENABLED is not "true"',
  transport: "no transport was provided",
};
