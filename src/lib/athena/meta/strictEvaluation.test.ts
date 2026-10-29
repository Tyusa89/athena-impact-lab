import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AccessPolicy } from "../core/access";
import type { Catalog } from "../core/catalog";
import type { Evidence } from "../core/evidence";
import type { AnalysisContext } from "../core/facts";
import { csvAdapter, createEvidenceLedger, importSource } from "../core/ingest";
import {
  SUPPORT_DESK_CATALOG,
  SUPPORT_DESK_MAPPING,
  SUPPORT_DESK_PERIODS,
  SUPPORT_DESK_SOURCE,
} from "../core/ingest/fixtures";
import { allowAll, identity, trusted } from "../core/ingest/testSupport";
import {
  createIdentityBoundary,
  type IdentityVerifier,
  type VerifiedIdentity,
} from "../core/identity";
import { authorizeDemo, demoAccessPolicy, type PrototypeEvidence } from "../prototypeAdapter";
import { PROTOTYPE_CATALOG } from "../prototypeCatalog";
import { PROTOTYPE_RUNTIME } from "./adapter.server";
import type { ModelOutcome, ModelProvider } from "./provider";
import { runAnalysis, type EngineRuntime } from "./runtime";
import { semanticText } from "./semantic";
import { STRICT_REJECTION_REASON, type DiagnosticCategory } from "./strictValidation";
import { runStrictAnalysis, type StrictResult } from "./strictRuntime";
import { strictEntities } from "./strictVocabulary";

// G3: deterministic OFFLINE end-to-end evaluation of the strict pipeline. Every fixture goes through the REAL `runStrictAnalysis` (authorize -> scoped prompt -> one fake-model call -> strict
// validation -> uniform public rejection) with synthetic evidence and a fake provider. TEST-ONLY: no production code, no second pipeline, no network, no live model.
//
// Two kinds of result, kept apart:
//   * HARD SECURITY GATES (describe "hard security gates"): any violation fails the suite.
//   * USABILITY MEASUREMENTS (describe "usability measurements"): reported, never thresholded. Fixtures classed "limitation" or "policy" PIN what the pipeline does today; they are NOT
//     evidence of protection, and a change in their outcome is a prompt to revisit the decision, not a regression of a guarantee.
const log = console.log.bind(console); // the real console, for the report (the run silences the engine's own logging)
const tripwire = vi.fn(() => {
  throw new Error("network call attempted");
});
vi.stubGlobal("fetch", tripwire);

const ENV = { META_MODEL_API_KEY: "sk-test-not-real", META_MODEL_ENABLED: "true" };
const PUBLIC = JSON.stringify({
  state: "rejected",
  reason: STRICT_REJECTION_REASON,
  requestSent: true,
});
const SECRET = "SECRET-SENTINEL-sk-live-0000";

// ------------------------------------------------------------------------------------------------------------------------------------------------------------------ fake provider
type Reply =
  | string
  | { kind: "truncated"; content: string }
  | { kind: "null" }
  | { kind: "http" }
  | { kind: "throw" };
interface Fake extends ModelProvider {
  calls: number;
}
const fake = (reply: Reply): Fake => {
  const p: Fake = {
    calls: 0,
    id: "fake",
    model: "fake-model",
    displayName: "Fake",
    status: () => ({ keyConfigured: true, ownerEnabled: true }),
    blockedCode: () => null,
    async complete(): Promise<ModelOutcome> {
      p.calls++;
      if (typeof reply === "string")
        return {
          kind: "completion",
          content: reply,
          truncated: false,
          usage: { max_tokens_sent: 2000, completion_tokens: 50 },
        };
      if (reply.kind === "truncated")
        return {
          kind: "completion",
          content: reply.content,
          truncated: true,
          usage: { max_tokens_sent: 2000, completion_tokens: 50 },
        };
      if (reply.kind === "null")
        return {
          kind: "completion",
          content: null,
          truncated: false,
          usage: { max_tokens_sent: 2000, completion_tokens: 0 },
        };
      if (reply.kind === "http") return { kind: "failure", code: "http_error", status: 503 };
      throw new Error(`provider exploded ${SECRET}`);
    },
  };
  return p;
};

// ------------------------------------------------------------------------------------------------------------------------------------------------------------------ worlds
interface World {
  name: string;
  catalog: Catalog;
  all: readonly Evidence[]; // every record of the dataset, authorized or not
  /** Metrics the policy explicitly granted as discoverable although they have no data: they may be NAMED (to ask for evidence), so they are not "unauthorized". */
  granted?: readonly string[];
  run(
    provider: ModelProvider,
    sink: (c: readonly DiagnosticCategory[]) => void,
  ): Promise<StrictResult>;
}
const demoAll = (scenario: string): readonly Evidence[] =>
  authorizeDemo({ scenarioId: scenario, roleId: "exec" }).authorized;
const metricPolicy = (data: string[], grant: string[] = []): AccessPolicy<PrototypeEvidence> => ({
  evidenceScope: (ctx) => {
    const b = demoAccessPolicy.evidenceScope(ctx);
    return {
      tenantId: b.tenantId,
      permits: (e) => b.permits(e) && data.includes(e.metric),
      discoverableMetrics: grant,
    };
  },
});
const demoWorld = (
  name: string,
  role: string,
  scenario = "baseline",
  pol?: AccessPolicy<PrototypeEvidence>,
): World => ({
  name,
  catalog: PROTOTYPE_CATALOG,
  all: demoAll(scenario),
  ...(pol ? { granted: ["cac"] } : {}),
  run: (provider, onDiagnostics) =>
    runStrictAnalysis(
      { scenarioId: scenario, roleId: role, ownerConfirmed: true },
      ENV,
      tripwire as unknown as typeof fetch,
      { ...PROTOTYPE_RUNTIME, ...(pol ? { policy: pol as AccessPolicy } : {}), provider },
      { onDiagnostics },
    ),
});
// The alternate synthetic dataset (customer support desk): its own catalog, periods, importer-built ledger and a department-level policy.
const DESK_CTX: AnalysisContext = { catalog: SUPPORT_DESK_CATALOG, periods: SUPPORT_DESK_PERIODS };
const deskWorld = (name: string, domains: string[]): World => {
  const tenant = "tenant-g3-desk";
  const ledger = createEvidenceLedger(identity);
  const r = importSource({
    identity,
    ctx: trusted(tenant),
    policy: allowAll,
    adapter: csvAdapter,
    input: readFileSync("src/lib/athena/core/ingest/fixtures/customer-support.csv", "utf8"),
    source: SUPPORT_DESK_SOURCE,
    spec: SUPPORT_DESK_MAPPING,
    catalog: SUPPORT_DESK_CATALOG,
  });
  if (!r.ok) throw new Error("desk import failed");
  ledger.commit(trusted(tenant), r, "main");
  const policy: AccessPolicy<Evidence> = {
    evidenceScope: (c) => ({
      tenantId: c.tenantId,
      permits: (e) => domains.includes(e.department),
      discoverableMetrics: [], // F2: the strict path requires a declared grant; this world grants nothing beyond its data
    }),
  };
  const verifier: IdentityVerifier = {
    assurance: "verified",
    verify: (c) => c as VerifiedIdentity | null,
  };
  return {
    name,
    catalog: SUPPORT_DESK_CATALOG,
    all: r.accepted,
    run: (provider, onDiagnostics) => {
      const rt: EngineRuntime = {
        resolve: () => ({
          ok: true,
          credential: { tenantId: tenant, actorId: "g3-reader" },
          dataset: "main",
        }),
        identity: createIdentityBoundary(verifier),
        allowSimulatedIdentity: false,
        store: { candidates: (ctx, ds) => ledger.store.candidates(trusted(ctx.tenantId), ds) },
        policy,
        analysis: DESK_CTX,
        question: "Why is satisfaction falling while ticket volume rises?",
        provider,
      };
      return runStrictAnalysis({}, ENV, tripwire as unknown as typeof fetch, rt, { onDiagnostics });
    },
  };
};
const WORLDS = {
  exec: demoWorld("exec / baseline", "exec"),
  marketing: demoWorld("marketing / baseline", "marketing"),
  ops: demoWorld("ops / baseline", "ops"),
  finance: demoWorld("finance / baseline", "finance"),
  leadsOnly: demoWorld(
    "marketing / leads-only, cac discoverable",
    "marketing",
    "baseline",
    metricPolicy(["leads"], ["cac"]),
  ),
  quality: demoWorld("exec / quality-only", "exec", "quality-only"),
  desk: deskWorld("desk / all departments", ["Support", "CustomerExperience"]),
  deskSupport: deskWorld("desk / Support only", ["Support"]),
};
type WorldId = keyof typeof WORLDS;

// ------------------------------------------------------------------------------------------------------------------------------------------------------------------ fixtures
type Cls = "valid" | "security" | "usability" | "limitation" | "policy";
type Desired = "accept" | "reject" | "undecided";
interface Fixture {
  id: string;
  desc: string;
  cls: Cls;
  world: WorldId;
  reply: Reply;
  /** What the pipeline does today: "ok", "error", or the exact set of internal diagnostic categories. */
  expect: "ok" | "error" | DiagnosticCategory[];
  /** What we would WANT. Defaults: valid -> accept, security -> reject. */
  desired?: Desired;
  /** Explicit affirmative causal claim covered by G2: must be rejected as "causal". */
  causal?: true;
  /** Legitimate uncertainty wording (counted if rejected). */
  uncertainty?: true;
}
const I = (text: string, refs: string[]) => ({ text, verified: false, refs });
const R = (text: string, refs: string[]) => ({ text, requires_human_approval: true, refs });
const reply = (o: { i?: object[]; g?: string[]; r?: object[] }) =>
  JSON.stringify({
    interpretations: o.i ?? [],
    missing_evidence: o.g ?? [],
    recommendations: o.r ?? [],
  });
const interp = (text: string, ...refs: string[]) => reply({ i: [I(text, refs)] });
const rec = (text: string, ...refs: string[]) => reply({ r: [R(text, refs)] });
const gap = (text: string) => reply({ g: [text] });

const FIXTURES: Fixture[] = [
  // ---- A. authorized analysis
  {
    id: "A01",
    desc: "direct observation, correct citation",
    cls: "valid",
    world: "exec",
    reply: interp("Lead volume increased.", "F-leads"),
    expect: "ok",
  },
  {
    id: "A02",
    desc: "alias observation (lead quality = mql_rate), direction down",
    cls: "valid",
    world: "exec",
    reply: interp("Lead quality declined.", "F-mql_rate"),
    expect: "ok",
  },
  {
    id: "A03",
    desc: "cross-metric interpretation, exact citations",
    cls: "valid",
    world: "exec",
    reply: interp(
      "Lead volume increased while conversion declined.",
      "F-leads",
      "F-conversion_rate",
    ),
    expect: "ok",
  },
  {
    id: "A04",
    desc: "finance metric observation",
    cls: "valid",
    world: "exec",
    reply: interp("Recognized revenue declined.", "F-revenue"),
    expect: "ok",
  },
  {
    id: "A05",
    desc: "acquisition cost observation, direction up",
    cls: "valid",
    world: "exec",
    reply: interp("Customer acquisition cost rose.", "F-cac"),
    expect: "ok",
  },
  {
    id: "A06",
    desc: "operations observation",
    cls: "valid",
    world: "exec",
    reply: interp("Backorders increased.", "F-backorder_rate"),
    expect: "ok",
  },
  {
    id: "A07",
    desc: "qualified causal hypothesis (Tier 2, same-clause hedge)",
    cls: "valid",
    world: "exec",
    reply: interp(
      "Lower conversion may have contributed to the revenue decline.",
      "F-conversion_rate",
      "F-revenue",
    ),
    expect: "ok",
    uncertainty: true,
  },
  {
    id: "A08",
    desc: "generic hypothesis, no metric named",
    cls: "valid",
    world: "exec",
    reply: interp("The decline may reflect seasonal demand.", "F-revenue"),
    expect: "ok",
    uncertainty: true,
  },
  {
    id: "A09",
    desc: "investigative recommendation",
    cls: "valid",
    world: "exec",
    reply: rec("Investigate whether conversion contributed to the decline.", "F-conversion_rate"),
    expect: "ok",
  },
  {
    id: "A10",
    desc: "recommendation naming one metric",
    cls: "valid",
    world: "exec",
    reply: rec("Review the lead source mix.", "F-leads"),
    expect: "ok",
  },
  {
    id: "A11",
    desc: "recommendation naming two metrics, both cited",
    cls: "valid",
    world: "exec",
    reply: rec("Review lead volume and conversion together.", "F-leads", "F-conversion_rate"),
    expect: "ok",
  },
  {
    id: "A12",
    desc: "missing-evidence statement",
    cls: "valid",
    world: "exec",
    reply: gap("Channel-level lead data would help."),
    expect: "ok",
  },
  {
    id: "A13",
    desc: "three lanes in one reply",
    cls: "valid",
    world: "exec",
    reply: reply({
      i: [I("Lead volume increased.", ["F-leads"])],
      g: ["Channel-level lead data would help."],
      r: [R("Review lead sources.", ["F-leads"])],
    }),
    expect: "ok",
  },
  {
    id: "A14",
    desc: "correlation without causation",
    cls: "valid",
    world: "exec",
    reply: interp(
      "Revenue and conversion moved in the same direction.",
      "F-revenue",
      "F-conversion_rate",
    ),
    expect: "ok",
  },
  {
    id: "A15",
    desc: "denied cause: 'the root cause is unknown'",
    cls: "valid",
    world: "exec",
    reply: interp("The root cause is unknown.", "F-revenue"),
    expect: "ok",
    uncertainty: true,
  },
  {
    id: "A16",
    desc: "denied causation",
    cls: "valid",
    world: "exec",
    reply: interp("The data does not establish causation.", "F-revenue"),
    expect: "ok",
    uncertainty: true,
  },
  {
    id: "A17",
    desc: "genuine question about causality",
    cls: "valid",
    world: "exec",
    reply: rec("Did lead quality contribute to the decline?", "F-mql_rate"),
    expect: "ok",
    uncertainty: true,
  },
  {
    id: "A18",
    desc: "uncertainty about the future",
    cls: "valid",
    world: "exec",
    reply: interp("Revenue may recover next quarter.", "F-revenue"),
    expect: "ok",
    uncertainty: true,
  },
  {
    id: "A19",
    desc: "negated direction consistent with the fact (leads rose)",
    cls: "valid",
    world: "exec",
    reply: interp("Lead volume did not decrease.", "F-leads"),
    expect: "ok",
  },
  {
    id: "A20",
    desc: "role marketing: its own metric",
    cls: "valid",
    world: "marketing",
    reply: interp("Lead volume increased.", "F-leads"),
    expect: "ok",
  },
  {
    id: "A21",
    desc: "role ops: its own metric",
    cls: "valid",
    world: "ops",
    reply: interp("Backorders increased.", "F-backorder_rate"),
    expect: "ok",
  },
  {
    id: "A22",
    desc: "role finance: its own metric",
    cls: "valid",
    world: "finance",
    reply: interp("Recognized revenue declined.", "F-revenue"),
    expect: "ok",
  },
  {
    id: "A23",
    desc: "no-data discoverable metric named in a gap (request for evidence)",
    cls: "valid",
    world: "leadsOnly",
    reply: gap("Customer acquisition cost data would help."),
    expect: "ok",
  },
  {
    id: "A24",
    desc: "scenario with flat metrics",
    cls: "valid",
    world: "quality",
    reply: interp("Lead quality declined.", "F-mql_rate"),
    expect: "ok",
  },
  {
    id: "A25",
    desc: "alternate dataset: observation",
    cls: "valid",
    world: "desk",
    reply: interp("Ticket volume increased.", "F-tickets_opened"),
    expect: "ok",
  },
  {
    id: "A26",
    desc: "alternate dataset: cross-metric",
    cls: "valid",
    world: "desk",
    reply: interp(
      "Ticket volume increased while customer satisfaction declined.",
      "F-tickets_opened",
      "F-csat",
    ),
    expect: "ok",
  },
  {
    id: "A27",
    desc: "alternate dataset: qualified hypothesis",
    cls: "valid",
    world: "desk",
    reply: interp(
      "Rising ticket volume may have contributed to lower customer satisfaction.",
      "F-tickets_opened",
      "F-csat",
    ),
    expect: "ok",
    uncertainty: true,
  },
  {
    id: "A28",
    desc: "alternate dataset: investigative recommendation",
    cls: "valid",
    world: "desk",
    reply: rec(
      "Investigate whether response time contributed to the customer satisfaction decline.",
      "F-first_response_hours",
      "F-csat",
    ),
    expect: "ok",
  },
  {
    id: "A28b",
    desc: "alternate dataset, short form 'satisfaction' is not a catalog alias: a correct citation is rejected (false rejection, fail closed)",
    cls: "usability",
    world: "desk",
    reply: rec(
      "Investigate whether response time contributed to the satisfaction decline.",
      "F-first_response_hours",
      "F-csat",
    ),
    expect: ["relevance"],
    desired: "accept",
  },
  {
    id: "A29",
    desc: "alternate dataset, restricted department: its own metric",
    cls: "valid",
    world: "deskSupport",
    reply: interp("Ticket volume increased.", "F-tickets_opened"),
    expect: "ok",
  },

  // ---- B. authorization boundaries
  {
    id: "B01",
    desc: "marketing claims a withheld Finance metric",
    cls: "security",
    world: "marketing",
    reply: interp("Recognized revenue declined.", "F-leads"),
    expect: ["domain"],
  },
  {
    id: "B02",
    desc: "marketing cites a withheld Finance fact",
    cls: "security",
    world: "marketing",
    reply: interp("Lead volume increased.", "F-revenue"),
    expect: ["ref"],
  },
  {
    id: "B03",
    desc: "finance names a withheld Marketing metric",
    cls: "security",
    world: "finance",
    reply: interp("Lead volume increased.", "F-revenue"),
    expect: ["domain"],
  },
  {
    id: "B04",
    desc: "hidden data-bearing department word",
    cls: "security",
    world: "marketing",
    reply: gap("The ledger may be worth a look."),
    expect: ["domain"],
  },
  {
    id: "B05",
    desc: "fabricated fact reference",
    cls: "security",
    world: "exec",
    reply: interp("Lead volume increased.", "F-nope"),
    expect: ["ref"],
  },
  {
    id: "B06",
    desc: "authorized record id in model text",
    cls: "security",
    world: "exec",
    reply: gap("See VH-MKT-001-Q2 for detail."),
    expect: ["leak"],
  },
  {
    id: "B07",
    desc: "withheld record id in model text",
    cls: "security",
    world: "marketing",
    reply: gap("See VH-FIN-001-Q2 for detail."),
    expect: ["leak"],
  },
  {
    id: "B08",
    desc: "authorized source label in model text",
    cls: "security",
    world: "exec",
    reply: gap("See SYN-CRM Campaign Export."),
    expect: ["leak"],
  },
  {
    id: "B09",
    desc: "withheld source label in model text",
    cls: "security",
    world: "marketing",
    reply: gap("See SYN-GL Revenue Summary."),
    expect: ["leak"],
  },
  {
    id: "B10",
    desc: "cross-department confusion: leads claim cites conversion",
    cls: "security",
    world: "exec",
    reply: interp("Lead volume increased.", "F-conversion_rate"),
    expect: ["relevance"],
  },
  {
    id: "B11",
    desc: "claim about a discoverable metric with no data",
    cls: "security",
    world: "leadsOnly",
    reply: interp("Customer acquisition cost rose.", "F-leads"),
    expect: ["unavailable"],
  },
  {
    id: "B12",
    desc: "inferring a same-department hidden metric (lead quality)",
    cls: "security",
    world: "leadsOnly",
    reply: gap("Lead quality may help."),
    expect: ["domain"],
  },
  {
    id: "B13",
    desc: "same reply, role exec (authorized)",
    cls: "valid",
    world: "exec",
    reply: interp("Backorders increased.", "F-backorder_rate"),
    expect: "ok",
  },
  {
    id: "B14",
    desc: "same reply, role ops (authorized)",
    cls: "valid",
    world: "ops",
    reply: interp("Backorders increased.", "F-backorder_rate"),
    expect: "ok",
  },
  {
    id: "B15",
    desc: "same reply, role marketing (withheld)",
    cls: "security",
    world: "marketing",
    reply: interp("Backorders increased.", "F-backorder_rate"),
    expect: ["domain", "ref"],
  },
  {
    id: "B16",
    desc: "same reply, role finance (withheld)",
    cls: "security",
    world: "finance",
    reply: interp("Backorders increased.", "F-backorder_rate"),
    expect: ["domain", "ref"],
  },
  {
    id: "B17",
    desc: "alternate dataset: claim about a withheld department's metric",
    cls: "security",
    world: "deskSupport",
    reply: interp("Customer satisfaction declined.", "F-tickets_opened"),
    expect: ["domain"],
  },
  {
    id: "B18",
    desc: "alternate dataset: cites a withheld fact",
    cls: "security",
    world: "deskSupport",
    reply: interp("Ticket volume increased.", "F-csat"),
    expect: ["ref"],
  },
  {
    id: "B19",
    desc: "hidden metric inside a hedged hypothesis",
    cls: "security",
    world: "marketing",
    reply: interp("Recognized revenue may have contributed to lower lead quality.", "F-mql_rate"),
    expect: ["domain"],
  },

  // ---- C. evidence integrity
  {
    id: "C01",
    desc: "missing citation: two metrics named, one cited",
    cls: "security",
    world: "exec",
    reply: interp("Lead volume increased while conversion declined.", "F-leads"),
    expect: ["relevance"],
  },
  {
    id: "C02",
    desc: "extra unrelated citation",
    cls: "security",
    world: "exec",
    reply: interp("Lead volume increased.", "F-leads", "F-revenue"),
    expect: ["relevance"],
  },
  {
    id: "C03",
    desc: "incorrect metric citation",
    cls: "security",
    world: "exec",
    reply: interp("Lead volume increased.", "F-mql_rate"),
    expect: ["relevance"],
  },
  {
    id: "C04",
    desc: "contradicted direction (leads rose)",
    cls: "security",
    world: "exec",
    reply: interp("Lead volume decreased.", "F-leads"),
    expect: ["direction"],
  },
  {
    id: "C05",
    desc: "contradicted direction (revenue fell)",
    cls: "security",
    world: "exec",
    reply: interp("Recognized revenue increased.", "F-revenue"),
    expect: ["direction"],
  },
  {
    id: "C06",
    desc: "model-supplied supporting_ids (fabricated evidence)",
    cls: "security",
    world: "exec",
    reply: JSON.stringify({
      interpretations: [
        {
          text: "Lead volume increased.",
          verified: false,
          refs: ["F-leads"],
          supporting_ids: ["VH-FIN-001-Q2"],
        },
      ],
      missing_evidence: [],
      recommendations: [],
    }),
    expect: ["schema"],
  },
  {
    id: "C07",
    desc: "no references",
    cls: "security",
    world: "exec",
    reply: interp("Lead volume increased."),
    expect: ["schema"],
  },
  {
    id: "C08",
    desc: "record id used as a reference",
    cls: "security",
    world: "exec",
    reply: interp("Lead volume increased.", "VH-MKT-001-Q2"),
    expect: ["ref"],
  },
  {
    id: "C09",
    desc: "five references (over the limit)",
    cls: "security",
    world: "exec",
    reply: interp("Lead volume increased.", "F-leads", "F-leads", "F-leads", "F-leads", "F-leads"),
    expect: ["schema"],
  },
  {
    id: "C10",
    desc: "KNOWN LIMIT: misleading non-numeric claim with a correct citation",
    cls: "limitation",
    world: "exec",
    reply: interp("Lead volume is the main story and marketing deserves credit.", "F-leads"),
    expect: "ok",
    desired: "reject",
  },
  {
    id: "C11",
    desc: "generic recommendation cites an unrelated fact (G4.6: rejected)",
    cls: "security",
    world: "exec",
    reply: rec("Review the sales strategy.", "F-revenue"),
    expect: ["relevance"],
  },
  {
    id: "C12",
    desc: "generic hypothesis about a decline cites a fact that did not decline (G4.6: rejected)",
    cls: "security",
    world: "exec",
    reply: interp("The decline may reflect seasonal demand.", "F-leads"),
    expect: ["relevance"],
  },

  // ---- D. causal integrity
  {
    id: "D01",
    desc: "unsupported causal claim ('because')",
    cls: "security",
    world: "exec",
    reply: interp("Revenue declined because marketing performed poorly.", "F-revenue"),
    expect: ["causal"],
    causal: true,
  },
  {
    id: "D02",
    desc: "unsupported causal claim ('due to'), exact citations",
    cls: "security",
    world: "exec",
    reply: interp("Revenue declined due to lower lead volume.", "F-revenue", "F-leads"),
    expect: ["causal"],
    causal: true,
  },
  {
    id: "D03",
    desc: "unsupported causal claim ('explains why')",
    cls: "security",
    world: "exec",
    reply: interp("Marketing performance explains why revenue declined.", "F-revenue"),
    expect: ["causal"],
    causal: true,
  },
  {
    id: "D04",
    desc: "definitive claim disguised as a hypothesis",
    cls: "security",
    world: "exec",
    reply: interp("It may be noted that marketing definitively caused the decline.", "F-revenue"),
    expect: ["causal", "relevance"], // G4.6: the cited Finance fact is also unrelated to a sentence about marketing
    causal: true,
  },
  {
    id: "D05",
    desc: "assertion embedded in a question",
    cls: "security",
    world: "exec",
    reply: rec(
      "Did revenue decline because marketing failed, given that marketing definitely caused the decline?",
      "F-revenue",
    ),
    expect: ["causal"],
    causal: true,
  },
  {
    id: "D06",
    desc: "investigative recommendation with an appended conclusion",
    cls: "security",
    world: "exec",
    reply: rec(
      "Investigate whether conversion contributed to the decline, which was caused by poor targeting.",
      "F-conversion_rate",
    ),
    expect: ["causal"],
    causal: true,
  },
  {
    id: "D07",
    desc: "asserted cause in a recommendation ('the root cause is ...')",
    cls: "security",
    world: "exec",
    reply: rec("The root cause is weak lead quality.", "F-mql_rate"),
    expect: ["causal"],
    causal: true,
  },
  {
    id: "D08",
    desc: "'is why' assertion",
    cls: "security",
    world: "exec",
    reply: interp("That is why revenue fell.", "F-revenue"),
    expect: ["causal"],
    causal: true,
  },
  {
    id: "D09",
    desc: "zero-width obfuscated 'because'",
    cls: "security",
    world: "exec",
    reply: interp("Revenue declined bec‍ause of churn.", "F-revenue"),
    expect: ["causal"],
    causal: true,
  },
  {
    id: "D10",
    desc: "full-width obfuscated 'caused'",
    cls: "security",
    world: "exec",
    reply: interp("Churn ｃａｕｓｅｄ the revenue decline.", "F-revenue"),
    expect: ["causal"],
    causal: true,
  },
  {
    id: "D11",
    desc: "KNOWN LIMIT: implicit causality ('hurt')",
    cls: "limitation",
    world: "exec",
    reply: interp("Weak demand hurt revenue.", "F-revenue"),
    expect: "ok",
    desired: "reject",
  },
  {
    id: "D12",
    desc: "KNOWN LIMIT: implicit causality ('triggered')",
    cls: "limitation",
    world: "exec",
    reply: interp("The campaign pause triggered the revenue decline.", "F-revenue"),
    expect: "ok",
    desired: "reject",
  },
  {
    id: "D13",
    desc: "KNOWN LIMIT: implicit causality ('as a consequence of')",
    cls: "limitation",
    world: "exec",
    reply: interp("Revenue fell as a consequence of weak demand.", "F-revenue"),
    expect: "ok",
    desired: "reject",
  },
  {
    id: "D14",
    desc: "legitimate uncertainty rejected: hedged Tier 1 ('may have caused')",
    cls: "usability",
    world: "exec",
    reply: interp("Lower conversion may have caused the decline.", "F-conversion_rate"),
    expect: ["causal"],
    desired: "accept",
    uncertainty: true,
  },
  {
    id: "D15",
    desc: "legitimate uncertainty rejected: 'possible causes include'",
    cls: "usability",
    world: "exec",
    reply: rec("Possible causes include delays.", "F-fulfillment_days"),
    expect: ["causal"],
    desired: "accept",
    uncertainty: true,
  },
  {
    id: "D16",
    desc: "legitimate denial rejected by the direction guard ('does not explain why revenue declined')",
    cls: "usability",
    world: "exec",
    reply: interp("The data does not explain why revenue declined.", "F-revenue"),
    expect: ["direction"],
    desired: "accept",
    uncertainty: true,
  },

  // ---- E. output safety and resilience
  {
    id: "E01",
    desc: "malformed JSON",
    cls: "security",
    world: "exec",
    reply: "{not json",
    expect: ["json"],
  },
  {
    id: "E02",
    desc: "prose around the JSON",
    cls: "security",
    world: "exec",
    reply: `Here is the analysis: ${interp("Lead volume increased.", "F-leads")}`,
    expect: ["json"],
  },
  {
    id: "E03",
    desc: "a JSON array instead of an object",
    cls: "security",
    world: "exec",
    reply: "[]",
    expect: ["schema"],
  },
  {
    id: "E04",
    desc: "unknown top-level key",
    cls: "security",
    world: "exec",
    reply: JSON.stringify({
      interpretations: [],
      missing_evidence: [],
      recommendations: [],
      extra: 1,
    }),
    expect: ["schema"],
  },
  {
    id: "E05",
    desc: "interpretation marked verified:true",
    cls: "security",
    world: "exec",
    reply: JSON.stringify({
      interpretations: [{ text: "Lead volume increased.", verified: true, refs: ["F-leads"] }],
      missing_evidence: [],
      recommendations: [],
    }),
    expect: ["schema"],
  },
  {
    id: "E06",
    desc: "recommendation without human approval",
    cls: "security",
    world: "exec",
    reply: JSON.stringify({
      interpretations: [],
      missing_evidence: [],
      recommendations: [
        { text: "Review lead sources.", requires_human_approval: false, refs: ["F-leads"] },
      ],
    }),
    expect: ["schema"],
  },
  {
    id: "E07",
    desc: "executable field on a recommendation",
    cls: "security",
    world: "exec",
    reply: JSON.stringify({
      interpretations: [],
      missing_evidence: [],
      recommendations: [
        {
          text: "Review lead sources.",
          requires_human_approval: true,
          refs: ["F-leads"],
          execute: true,
        },
      ],
    }),
    expect: ["schema"],
  },
  {
    id: "E08",
    desc: "legacy output shape",
    cls: "security",
    world: "exec",
    reply: JSON.stringify({
      interpretations: [{ text: "Lead volume increased.", cited_ids: ["VH-MKT-001-Q2"] }],
      missing_evidence: [],
      recommendations: [],
    }),
    expect: ["legacy"],
  },
  {
    id: "E09",
    desc: "text over the length limit",
    cls: "security",
    world: "exec",
    reply: gap(`Lead data ${"would help ".repeat(40)}.`),
    expect: ["schema"],
  },
  {
    id: "E10",
    desc: "unsafe text: a link",
    cls: "security",
    world: "exec",
    reply: gap("Visit https://example.com for more."),
    expect: ["unsafe"],
  },
  {
    id: "E11",
    desc: "numeral",
    cls: "security",
    world: "exec",
    reply: interp("Lead volume rose 40%.", "F-leads"),
    expect: ["magnitude", "numeral"],
  },
  {
    id: "E12",
    desc: "magnitude expression without a numeral",
    cls: "security",
    world: "exec",
    reply: interp("Lead volume doubled.", "F-leads"),
    expect: ["magnitude"],
  },
  {
    id: "E13",
    desc: "empty model content",
    cls: "security",
    world: "exec",
    reply: { kind: "null" },
    expect: ["provider"],
  },
  {
    id: "E14",
    desc: "truncated model reply",
    cls: "security",
    world: "exec",
    reply: { kind: "truncated", content: interp("Lead volume increased.", "F-leads") },
    expect: ["provider"],
  },
  {
    id: "E15",
    desc: "provider HTTP failure",
    cls: "security",
    world: "exec",
    reply: { kind: "http" },
    expect: "error",
    desired: "reject",
  },
  {
    id: "E16",
    desc: "provider throws (message carries a secret)",
    cls: "security",
    world: "exec",
    reply: { kind: "throw" },
    expect: "error",
    desired: "reject",
  },
  {
    id: "E17",
    desc: "G4.7 decided: an all-empty structured output is rejected as empty",
    cls: "security",
    world: "exec",
    reply: reply({}),
    expect: ["empty"],
  },
  {
    id: "E18",
    desc: "G4.7 decided: strong language supported by a large verified move (+50%) stays accepted",
    cls: "valid",
    world: "exec",
    reply: interp("Lead volume rose sharply.", "F-leads"),
    expect: "ok",
  },

  {
    id: "C13",
    desc: "G4.7: a sentence no guard can examine may not display supporting facts",
    cls: "security",
    world: "exec",
    reply: rec("Gather more data.", "F-revenue"),
    expect: ["relevance"],
  },
  {
    id: "C14",
    desc: "G4.7: a legitimate multi-fact recommendation still passes (exact match over three metrics)",
    cls: "valid",
    world: "exec",
    reply: rec("Review lead volume, conversion and acquisition cost together.", "F-leads", "F-conversion_rate", "F-cac"),
    expect: "ok",
  },
  {
    id: "E19",
    desc: "G4.7 E18: strong language about a modest verified move (-14.8%) is rejected",
    cls: "security",
    world: "exec",
    reply: interp("Closed deals plunged.", "F-closed_deals"),
    expect: ["direction"],
  },
  {
    id: "E20",
    desc: "G4.7 E18: a plain description of the same modest move stays accepted",
    cls: "valid",
    world: "exec",
    reply: interp("Closed deals fell.", "F-closed_deals"),
    expect: "ok",
  },
  {
    id: "E21",
    desc: "G4.7 E18: strong language supported by a large verified move (+19.5%) stays accepted",
    cls: "valid",
    world: "exec",
    reply: interp("Acquisition cost surged.", "F-cac"),
    expect: "ok",
  },

  // ---- F. cross-guard interactions
  {
    id: "F01",
    desc: "several simultaneous faults (fabricated ref, causal, numeral)",
    cls: "security",
    world: "exec",
    reply: interp("Revenue declined because of churn 40%.", "F-leads", "F-nope"),
    expect: ["causal", "magnitude", "numeral", "ref"],
    causal: true,
  },
  {
    id: "F02",
    desc: "exact citations paired with unsupported causality",
    cls: "security",
    world: "exec",
    reply: interp(
      "Lead volume increased, which led to lower conversion.",
      "F-leads",
      "F-conversion_rate",
    ),
    expect: ["causal"],
    causal: true,
  },
  {
    id: "F03",
    desc: "leaked record id inside a causal claim (leak reported alone)",
    cls: "security",
    world: "exec",
    reply: gap("Delays caused VH-FIN-001-Q2 to fall."),
    expect: ["leak"],
    causal: true,
  },
  {
    id: "F04",
    desc: "alternate dataset: unsupported causality",
    cls: "security",
    world: "desk",
    reply: interp("Ticket volume increased because of the outage.", "F-tickets_opened"),
    expect: ["causal"],
    causal: true,
  },
  {
    id: "F05",
    desc: "negated direction consistent with the fact (revenue fell)",
    cls: "valid",
    world: "exec",
    reply: interp("Recognized revenue did not increase.", "F-revenue"),
    expect: "ok",
  },
  {
    id: "F06",
    desc: "negated direction contradicting the fact (revenue fell, 'did not decline')",
    cls: "security",
    world: "exec",
    reply: interp("Recognized revenue did not decline.", "F-revenue"),
    expect: ["direction"],
  },
];

// ------------------------------------------------------------------------------------------------------------------------------------------------------------------ execution
interface Outcome {
  result: StrictResult;
  diag: DiagnosticCategory[][];
  calls: number;
}
async function execute(f: Fixture): Promise<Outcome> {
  const provider = fake(f.reply);
  const diag: DiagnosticCategory[][] = [];
  const result = await WORLDS[f.world].run(provider, (c) => diag.push([...c]));
  return { result, diag, calls: provider.calls };
}
const RUN1 = new Map<string, Outcome>(),
  RUN2 = new Map<string, Outcome>();
const accepted = (o: Outcome) => o.result.state === "ok";
const rejected = (o: Outcome) => o.result.state === "rejected";
const cats = (o: Outcome) => [...new Set(o.diag.flat())].sort();
const byId = (id: string) => FIXTURES.find((f) => f.id === id)!;
const desiredOf = (f: Fixture): Desired => f.desired ?? (f.cls === "valid" ? "accept" : "reject");

beforeAll(async () => {
  const quiet = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation(() => {}),
  );
  try {
    for (const f of FIXTURES) {
      RUN1.set(f.id, await execute(f));
      RUN2.set(f.id, await execute(f));
    }
  } finally {
    quiet.forEach((s) => s.mockRestore());
  }
});
afterAll(() => {
  expect(tripwire).not.toHaveBeenCalled();
});

// ------------------------------------------------------------------------------------------------------------------------------------------------------------------ per-fixture expectations
describe("fixture matrix: every fixture runs through the real runStrictAnalysis", () => {
  it("has unique ids and the full set of categories", () => {
    expect(new Set(FIXTURES.map((f) => f.id)).size).toBe(FIXTURES.length);
    for (const prefix of ["A", "B", "C", "D", "E", "F"])
      expect(
        FIXTURES.some((f) => f.id.startsWith(prefix)),
        prefix,
      ).toBe(true);
    expect(FIXTURES.length).toBeGreaterThanOrEqual(100);
  });
  it.each(FIXTURES.map((f) => [f.id, f.cls, f.desc, f] as const))(
    "%s [%s] %s",
    (_id, _cls, _desc, f) => {
      const o = RUN1.get(f.id)!;
      if (f.expect === "ok") {
        expect(o.result.state).toBe("ok");
        expect(o.diag).toEqual([]);
      } else if (f.expect === "error") {
        expect(o.result.state).toBe("error");
        expect(JSON.stringify(o.result)).not.toContain(SECRET);
      } else {
        expect(o.result.state).toBe("rejected");
        expect(o.diag.length).toBe(1); // one rejection, one diagnostics call
        expect(cats(o)).toEqual([...f.expect].sort());
      }
      expect(o.calls).toBe(1);
    },
  );
});

// ------------------------------------------------------------------------------------------------------------------------------------------------------------------ hard security gates
describe("hard security gates (any violation fails the evaluation)", () => {
  const acc = () => FIXTURES.filter((f) => accepted(RUN1.get(f.id)!));
  const rej = () => FIXTURES.filter((f) => rejected(RUN1.get(f.id)!));
  it("gate 1: no accepted output discloses unauthorized evidence (record ids, source labels, withheld metric keys or labels)", () => {
    expect(acc().length).toBeGreaterThan(20);
    for (const f of acc()) {
      const o = RUN1.get(f.id)!;
      const r = o.result as Extract<StrictResult, { state: "ok" }>;
      const world = WORLDS[f.world];
      const text = JSON.stringify(r).toLowerCase();
      const authorized = new Set(r.authorizedIds);
      const hidden = world.all.filter((e) => !authorized.has(e.id));
      for (const e of hidden) {
        expect(text, `${f.id} id ${e.id}`).not.toContain(e.id.toLowerCase());
        expect(text, `${f.id} source ${e.source}`).not.toContain(String(e.source).toLowerCase());
      }
      const shown = new Set(r.findings.map((x) => x.fact_id));
      for (const m of world.catalog.metrics)
        if (!shown.has(`F-${m.key}`) && !(world.granted ?? []).includes(m.key)) {
          expect(text, `${f.id} fact id ${m.key}`).not.toContain(`f-${m.key}`);
          expect(text, `${f.id} label ${m.label}`).not.toContain(m.label.toLowerCase());
        }
    }
  });
  it("gate 2: every rejection is the one fixed public response; it carries no category, id, label or model text", () => {
    expect(rej().length).toBeGreaterThan(40);
    const distinct = new Set<string>();
    for (const f of rej()) {
      const s = JSON.stringify(RUN1.get(f.id)!.result);
      distinct.add(s);
      expect(s, f.id).toBe(PUBLIC);
    }
    expect([...distinct]).toEqual([PUBLIC]);
    expect(PUBLIC).not.toMatch(
      /domain|leak|ref|causal|relevance|numeral|schema|unsafe|F-|VH-|SYN-/,
    );
  });
  it("gate 2b: a provider failure never echoes a secret, and the wording is the engine's fixed wording", () => {
    for (const id of ["E15", "E16"]) {
      const s = JSON.stringify(RUN1.get(id)!.result);
      expect(s).not.toContain(SECRET);
      expect(s).not.toMatch(/VH-|SYN-|stack|exploded/);
    }
    expect(RUN1.get("E15")!.result).toEqual({
      state: "error",
      reason: "Fake returned HTTP 503 (not retried).",
      requestSent: true,
    });
  });
  it("gate 3: every accepted output obeys the exact-reference rule (named available metrics == cited metrics) and its supporting ids come only from the cited facts", () => {
    for (const f of acc()) {
      const r = RUN1.get(f.id)!.result as Extract<StrictResult, { state: "ok" }>;
      const world = WORLDS[f.world];
      const factsByMetric = new Map(r.findings.map((x) => [x.fact_id, x]));
      for (const item of [...r.output.interpretations, ...r.output.recommendations]) {
        const named = new Set(
          strictEntities(semanticText(item.text), world.catalog)
            .filter((e) => e.kind === "metric" && factsByMetric.has(`F-${e.key}`))
            .map((e) => `F-${e.key}`),
        );
        const cited = new Set(item.refs);
        if (named.size)
          expect([...cited].sort(), `${f.id}: ${item.text}`).toEqual([...named].sort());
        for (const ref of cited) expect(factsByMetric.has(ref), `${f.id} ref ${ref}`).toBe(true);
        const expected = [
          ...new Set([...cited].flatMap((ref) => factsByMetric.get(ref)!.supporting_ids)),
        ].sort();
        expect([...item.supporting_ids].sort(), `${f.id} provenance`).toEqual(expected);
      }
    }
  });
  it("gate 4: every explicit affirmative causal claim in the G2 set is rejected, and as 'causal'", () => {
    const set = FIXTURES.filter((f) => f.causal);
    expect(set.length).toBeGreaterThanOrEqual(12);
    for (const f of set) {
      const o = RUN1.get(f.id)!;
      expect(rejected(o), f.id).toBe(true);
      // F03 is reported as 'leak' alone by design (a leak is reported on its own); every other member must carry 'causal'.
      if (f.id !== "F03") expect(cats(o), f.id).toContain("causal");
    }
  });
  it("gate 5: required schema literals hold on every accepted output, and non-conforming replies are never accepted", () => {
    for (const f of acc()) {
      const r = RUN1.get(f.id)!.result as Extract<StrictResult, { state: "ok" }>;
      for (const i of r.output.interpretations) expect(i.verified, f.id).toBe(false);
      for (const x of r.output.recommendations) expect(x.requires_human_approval, f.id).toBe(true);
    }
    for (const id of ["E05", "E06", "E07", "C06"]) expect(rejected(RUN1.get(id)!), id).toBe(true);
  });
  it("gate 6: repeated execution is identical (result and diagnostics)", () => {
    for (const f of FIXTURES) {
      const a = RUN1.get(f.id)!,
        b = RUN2.get(f.id)!;
      expect(JSON.stringify(b.result), f.id).toBe(JSON.stringify(a.result));
      expect(b.diag, f.id).toEqual(a.diag);
    }
  });
  it("gate 7: the legacy path is unchanged (the strict policies are not applied to it); the legacy goldens run in golden.test.ts in the same suite", async () => {
    const legacy = async (content: string) => {
      const p = fake(content);
      const quiet = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
        vi.spyOn(console, m).mockImplementation(() => {}),
      );
      try {
        return {
          r: await runAnalysis(
            { scenarioId: "baseline", roleId: "exec", ownerConfirmed: true },
            ENV,
            tripwire as unknown as typeof fetch,
            { ...PROTOTYPE_RUNTIME, provider: p },
          ),
          p,
        };
      } finally {
        quiet.forEach((s) => s.mockRestore());
      }
    };
    // a mismatched citation and a bare 'because' are what the strict profile rejects (C02/D01); the legacy gate still accepts them
    expect((await legacy(interp("Lead volume increased.", "F-leads", "F-revenue"))).r.state).toBe(
      "ok",
    );
    expect(
      (await legacy(interp("Revenue declined because marketing performed poorly.", "F-revenue"))).r
        .state,
    ).toBe("ok");
    const bad = await legacy(interp("Delays caused the decline.", "F-revenue"));
    expect(bad.r.state).toBe("rejected");
    expect("errors" in bad.r && bad.r.errors.join()).toMatch(/Causal-proof/); // the legacy detailed message, which the strict path never exposes
  });
  it("gate 8: the fake provider is called exactly once per request, for every fixture", () => {
    for (const f of FIXTURES) {
      expect(RUN1.get(f.id)!.calls, f.id).toBe(1);
      expect(RUN2.get(f.id)!.calls, f.id).toBe(1);
    }
  });
  it("gate 9: no network request was attempted", () => {
    expect(tripwire).not.toHaveBeenCalled();
  });
  it("the strict path is still inactive: nothing outside the strict modules imports the strict runtime or validation", () => {
    const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\/|(?<!:)\/\/[^\n]*/g, " ");
    const files = [
      "meta.functions.ts",
      "prototypeAdapter.ts",
      "workbench/workbench.server.ts",
      "workbench/workbench.functions.ts",
      "meta/adapter.server.ts",
      "meta/runtime.ts",
    ];
    for (const f of files)
      expect(strip(readFileSync(`src/lib/athena/${f}`, "utf8")), f).not.toMatch(
        /strictRuntime|runStrictAnalysis|validateStrictOutput/,
      );
  });
});

// ------------------------------------------------------------------------------------------------------------------------------------------------------------------ usability measurements
describe("usability measurements (reported, not thresholded)", () => {
  const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}%` : "n/a");
  it("reports acceptance and rejection rates, known limitations and policy decisions", () => {
    const rows = FIXTURES.map((f) => ({ f, o: RUN1.get(f.id)!, want: desiredOf(f) }));
    const valid = rows.filter((r) => r.f.cls === "valid");
    const wantAccept = rows.filter((r) => r.want === "accept");
    const wantReject = rows.filter((r) => r.want === "reject");
    const limits = rows.filter((r) => r.f.cls === "limitation");
    const policy = rows.filter((r) => r.f.cls === "policy");
    const uncertain = rows.filter((r) => r.f.uncertainty && r.want === "accept");
    const lines: string[] = [];
    lines.push(
      "",
      "=== G3 strict end-to-end evaluation: MEASURED on the fake-provider fixtures (not a readiness score) ===",
    );
    lines.push(
      `fixtures: ${FIXTURES.length} (valid ${valid.length}, security ${rows.filter((r) => r.f.cls === "security").length}, usability ${rows.filter((r) => r.f.cls === "usability").length}, limitation ${limits.length}, policy ${policy.length})`,
    );
    lines.push(
      `valid-fixture acceptance: ${valid.filter((r) => accepted(r.o)).length}/${valid.length} (${pct(valid.filter((r) => accepted(r.o)).length, valid.length)})`,
    );
    lines.push(
      `false-positive rejection (desired accept, observed reject): ${wantAccept.filter((r) => !accepted(r.o)).length}/${wantAccept.length} (${pct(wantAccept.filter((r) => !accepted(r.o)).length, wantAccept.length)})`,
    );
    lines.push(
      `not-accepted rate on the security set (rejected or provider error): ${wantReject.filter((r) => r.f.cls === "security" && !accepted(r.o)).length}/${wantReject.filter((r) => r.f.cls === "security").length}`,
    );
    lines.push(
      `known-limitation acceptance (desired reject, observed accept): ${limits.filter((r) => accepted(r.o)).length}/${limits.length} (${pct(limits.filter((r) => accepted(r.o)).length, limits.length)})  -- NOT counted as protection`,
    );
    lines.push(
      `legitimate-uncertainty rejections: ${uncertain.filter((r) => !accepted(r.o)).length} of ${uncertain.length} uncertainty fixtures: ${
        uncertain
          .filter((r) => !accepted(r.o))
          .map((r) => r.f.id)
          .join(", ") || "none"
      }`,
    );
    lines.push(
      `unresolved product-policy decisions (current behaviour pinned): ${policy.map((r) => `${r.f.id} ${r.f.desc} -> ${accepted(r.o) ? "accepted" : "rejected"}`).join("; ")}`,
    );
    lines.push("by world (accepted / rejected / error):");
    for (const [id, w] of Object.entries(WORLDS)) {
      const mine = rows.filter((r) => r.f.world === id);
      lines.push(
        `  ${w.name.padEnd(46)} ${mine.filter((r) => accepted(r.o)).length} / ${mine.filter((r) => rejected(r.o)).length} / ${mine.filter((r) => r.o.result.state === "error").length}`,
      );
    }
    log(lines.join("\n"));
    // accounting only: the measurements add up and every classified fixture is accounted for
    expect(valid.length + rows.filter((r) => r.f.cls !== "valid").length).toBe(FIXTURES.length);
    expect(
      limits.every((r) => r.want === "reject" || r.want === "undecided" || r.want === "accept"),
    ).toBe(true);
  });
  it("limitation and policy fixtures are never classed as evidence-integrity protection", () => {
    for (const f of FIXTURES.filter((x) => x.cls === "limitation"))
      expect(f.desired, f.id).toBe("reject");
    for (const f of FIXTURES.filter((x) => x.cls === "policy"))
      expect(f.desired, f.id).toBe("undecided");
    expect(byId("C10").expect).toBe("ok");
  });
});
