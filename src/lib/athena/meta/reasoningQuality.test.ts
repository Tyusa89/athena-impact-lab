import { describe, expect, it, vi } from "vitest";
import {
  EXPECTED_DIRECTIONS,
  TEST_METRICS,
  runReasoningTest,
  testPolicy,
  type Report,
} from "../../../../scripts/metaReasoningTest";
import {
  evaluateFindings,
  evaluateReasoning,
  informativeTokens,
  type QualityOutput,
} from "../../../../scripts/reasoningQuality";
import type { AccessPolicy } from "../core/access";
import { demoAccessPolicy, demoIdentity, type PrototypeEvidence } from "../prototypeAdapter";
import { PROTOTYPE_CATALOG } from "../prototypeCatalog";
import { PROTOTYPE_RUNTIME } from "./adapter.server";
import type { ModelOutcome, ModelProvider, ModelRequest } from "./provider";
import { SCOPED_SYSTEM } from "./scopedPrompt";
import { runStrictAnalysis } from "./strictRuntime";
import type { DiagnosticCategory } from "./strictValidation";

// G4.5: offline regression tests for the runner-scope fix, the revised reasoning instructions, the vocabulary boundary and the model-lane quality evaluation. Synthetic data and fake providers only;
// the vitest global fetch is a tripwire. No test sends a request to Meta.
const tripwire = vi.fn(() => {
  throw new Error("network call attempted");
});
vi.stubGlobal("fetch", tripwire);

const SCENARIO = { scenarioId: "baseline", roleId: "marketing", ownerConfirmed: true } as const;
const fake = (content: string, seen: ModelRequest[] = []): ModelProvider => ({
  id: "t",
  model: "t",
  displayName: "T",
  status: () => ({ keyConfigured: true, ownerEnabled: true }),
  blockedCode: () => null,
  async complete(req): Promise<ModelOutcome> {
    seen.push(req);
    return { kind: "completion", content, truncated: false, usage: { max_tokens_sent: 2000 } };
  },
});
type I = { text: string; refs: string[] };
const interp = (text: string, refs = ["F-leads", "F-conversion_rate"]) => ({
  text,
  verified: false,
  refs,
});
const rec = (text: string, refs = ["F-leads", "F-conversion_rate"]) => ({
  text,
  requires_human_approval: true,
  refs,
});
const reply = (o: { i?: object[]; g?: string[]; r?: object[] }) =>
  JSON.stringify({
    interpretations: o.i ?? [],
    missing_evidence: o.g ?? [],
    recommendations: o.r ?? [],
  });

/** The policy the G4.1 runner used: records limited to the three metrics, but the policy's discovery grant DROPPED. Test-only reconstruction of the defect. */
const g41Policy = (): AccessPolicy<PrototypeEvidence> => ({
  evidenceScope: (ctx) => {
    const base = demoAccessPolicy.evidenceScope(ctx);
    return {
      tenantId: base.tenantId,
      permits: (e) => base.permits(e) && (TEST_METRICS as readonly string[]).includes(e.metric),
    };
  },
});
async function strict(content: string, policy: AccessPolicy<PrototypeEvidence> = testPolicy()) {
  const cats: DiagnosticCategory[] = [];
  const seen: ModelRequest[] = [];
  const r = await runStrictAnalysis(
    SCENARIO,
    { META_MODEL_API_KEY: "x", META_MODEL_ENABLED: "true" },
    tripwire as unknown as typeof fetch,
    { ...PROTOTYPE_RUNTIME, policy: policy as AccessPolicy, provider: fake(content, seen) },
    { onDiagnostics: (c) => cats.push(...c) },
  );
  return { r, cats: [...new Set(cats)], seen };
}
const outcomeOf = async (content: string, policy?: AccessPolicy<PrototypeEvidence>) => {
  const { r, cats } = await strict(content, policy);
  return { state: r.state, cats };
};
const q = (o: Partial<QualityOutput>): QualityOutput => ({
  interpretations: [],
  missing_evidence: [],
  recommendations: [],
  ...o,
});
const FACTS = ["F-leads", "F-conversion_rate", "F-cac"];

// The reply Muse Spark 1.3 actually returned in the first live test (G4.3), kept as a synthetic fixture. It contains no data.
const G43_REPLY = JSON.stringify({
  interpretations: [
    {
      refs: ["F-leads", "F-conversion_rate"],
      text: "Lead volume dynamics may co-move with sales conversion patterns requiring joint review.",
      verified: false,
    },
    {
      refs: ["F-leads", "F-cac"],
      text: "Lead volume dynamics may co-move with acquisition cost dynamics within marketing context.",
      verified: false,
    },
    {
      refs: ["F-conversion_rate", "F-cac"],
      text: "Sales conversion patterns may co-move with acquisition cost dynamics across funnel stages.",
      verified: false,
    },
  ],
  missing_evidence: [],
  recommendations: [
    {
      refs: ["F-leads", "F-conversion_rate"],
      requires_human_approval: true,
      text: "Please review lead quality criteria together with sales follow-up processes for alignment.",
    },
    {
      refs: ["F-cac", "F-leads"],
      requires_human_approval: true,
      text: "Please review marketing channel mix with attention to efficiency and audience relevance.",
    },
    {
      refs: ["F-conversion_rate", "F-cac"],
      requires_human_approval: true,
      text: "Please review funnel diagnostics to align spending decisions with sales capacity.",
    },
  ],
});

describe("G4.3 rejection mechanism (exact reproduction)", () => {
  it("with the G4.1 runner scope the reply is rejected as `domain`, and only because of 'lead quality'", async () => {
    expect(await outcomeOf(G43_REPLY, g41Policy())).toEqual({
      state: "rejected",
      cats: ["domain"],
    });
    const swapped = G43_REPLY.replace("lead quality criteria", "lead criteria");
    expect((await outcomeOf(swapped, g41Policy())).cats).not.toContain("domain");
  });
  it("the cause is the dropped discovery grant: the prompt then lists no unavailable metric, so 'lead quality' is an unauthorized metric", async () => {
    const { seen } = await strict(G43_REPLY, g41Policy());
    expect(JSON.stringify(seen[0]!.messages)).toContain("UNAVAILABLE_METRICS (JSON): []");
  });
  it("with the corrected runner scope the same reply passes validation (it is only weak, see the quality tests)", async () => {
    expect(await outcomeOf(G43_REPLY)).toEqual({ state: "ok", cats: [] });
  });
});

describe("runner scope: the policy's discovery grant is preserved, facts stay limited to three metrics", () => {
  it("passes the demo policy's discoverable metrics through unchanged and permits records for the three test metrics only", async () => {
    const ctx = await demoIdentity.authenticate({
      kind: "simulated-demo-role-claim",
      roleId: "marketing",
    });
    const base = demoAccessPolicy.evidenceScope(ctx);
    const scope = testPolicy().evidenceScope(ctx);
    expect(scope.discoverableMetrics).toEqual(base.discoverableMetrics);
    expect(scope.discoverableMetrics).toEqual([
      "leads",
      "mql_rate",
      "conversion_rate",
      "closed_deals",
      "cac",
    ]);
    const sample = (m: string) =>
      ({
        workspace: base.permits({ workspace: "ws-marketing" } as PrototypeEvidence)
          ? "ws-marketing"
          : "",
        metric: m,
      }) as PrototypeEvidence;
    for (const m of ["leads", "conversion_rate", "cac"])
      expect(scope.permits({ ...sample(m), workspace: "ws-marketing" })).toBe(true);
    for (const m of ["mql_rate", "closed_deals", "revenue", "fulfillment_days", "backorder_rate"])
      expect(scope.permits({ ...sample(m), workspace: "ws-marketing" })).toBe(false);
  });
  it("the prompt carries exactly three facts and lists the other discoverable metrics as unavailable, by name only", async () => {
    const { seen } = await strict(reply({}));
    const user = seen[0]!.messages.find((m) => m.role === "user")!.content;
    const facts = JSON.parse(/VERIFIED_FACTS \(JSON\): (.*)\n/.exec(user)![1]!) as {
      metric: string;
    }[];
    expect(facts.map((f) => f.metric).sort()).toEqual([...TEST_METRICS].sort());
    const unavailable = JSON.parse(
      /UNAVAILABLE_METRICS \(JSON\): (.*)$/.exec(user)![1]!,
    ) as object[];
    expect(unavailable).toEqual([
      { metric: "mql_rate", status: "no_verified_data" },
      { metric: "closed_deals", status: "no_verified_data" },
    ]);
    expect(user).not.toMatch(/revenue|fulfil|backorder|F-mql|F-closed|VH-|SYN-/i);
  });
  it("metric values for an unavailable metric never reach the model, and a claim about one is rejected as unavailable", async () => {
    const { seen } = await strict(reply({}));
    const sent = JSON.stringify(seen[0]!.messages);
    expect(sent).not.toMatch(/mql_rate[^}]*"(?:prior|current)"/);
    expect(await outcomeOf(reply({ i: [interp("Lead quality was weaker this period.")] }))).toEqual(
      { state: "rejected", cats: ["unavailable"] },
    );
  });
});

describe("vocabulary boundary: authorized, discoverable-unavailable and unauthorized metrics", () => {
  it("authorized metrics may be named and cited consistently", async () => {
    expect(
      (
        await outcomeOf(
          reply({
            i: [interp("Lead volume may be tied to the conversion rate through lead source mix.")],
          }),
        )
      ).state,
    ).toBe("ok");
  });
  it("a discoverable metric without data may be named neutrally: as missing evidence and as the thing an investigation should obtain", async () => {
    const r = await outcomeOf(
      reply({
        i: [interp("A shift toward lower-intent lead sources may dilute the conversion rate.")],
        g: [
          "Lead quality scores by source for both periods, which Athena does not currently have.",
        ],
        r: [
          rec(
            "Obtain lead quality scores by source and compare them with conversion for the same sources.",
            ["F-conversion_rate"],
          ),
        ],
      }),
    );
    expect(r).toEqual({ state: "ok", cats: [] });
  });
  it("it may not be described, quantified or compared as if measured", async () => {
    for (const t of [
      "Lead quality fell.",
      "Lead quality is weaker than before.",
      "Lead quality dropped by half.",
      "Lead quality is at twenty percent.",
    ]) {
      const r = await outcomeOf(reply({ i: [interp(t)] }));
      expect(r.state, t).toBe("rejected");
    }
  });
  it("unauthorized metrics and departments stay rejected, named or claimed, in every lane", async () => {
    for (const t of [
      "Recognized revenue declined.",
      "Revenue may relate to lead flow.",
      "Fulfillment times may matter.",
      "Backorders may rise.",
    ]) {
      expect((await outcomeOf(reply({ i: [interp(t)] }))).cats, t).toContain("domain");
      expect((await outcomeOf(reply({ g: [t] }))).cats, t).toEqual(["domain"]);
      expect((await outcomeOf(reply({ r: [rec(t)] }))).cats, t).toContain("domain");
    }
  });
  it("a role WITHOUT the grant still gets the strict outcome: the grant is the only thing that opens 'lead quality'", async () => {
    expect(
      (await outcomeOf(reply({ g: ["Lead quality scores by source."] }), g41Policy())).cats,
    ).toEqual(["domain"]);
    expect((await outcomeOf(reply({ g: ["Lead quality scores by source."] }))).state).toBe("ok");
  });
});

describe("validation guards that must not weaken", () => {
  it("rejects invented values and magnitudes in every lane", async () => {
    for (const t of [
      "Leads rose to 6300 this quarter.",
      "Conversion fell by forty percent.",
      "Acquisition cost doubled.",
    ]) {
      expect((await outcomeOf(reply({ i: [interp(t)] }))).state, t).toBe("rejected");
      expect((await outcomeOf(reply({ g: [t] }))).state, t).toBe("rejected");
    }
    // Interpretations are checked on every sentence that names a metric; gaps and actions only where a movement word is present (existing design: process wording passes).
    expect(
      (
        await outcomeOf(
          reply({ i: [interp("About half of leads were unqualified.", ["F-leads"])] }),
        )
      ).cats,
    ).toEqual(["magnitude"]);
  });
  it("rejects a fabricated or contradicting observation about an authorized metric", async () => {
    expect(
      (
        await outcomeOf(
          reply({
            i: [interp("The conversion rate rose over the period.", ["F-conversion_rate"])],
          }),
        )
      ).cats,
    ).toContain("direction");
    expect(
      (await outcomeOf(reply({ i: [interp("Acquisition cost fell over the period.", ["F-cac"])] })))
        .cats,
    ).toContain("direction");
  });
  it("rejects causal overclaiming but allows a hedged, investigative framing", async () => {
    for (const t of [
      "More leads caused the conversion rate to fall.",
      "The conversion rate fell because of lower lead volume.",
      "This proves the lead mix is the reason.",
    ]) {
      expect((await outcomeOf(reply({ i: [interp(t)] }))).cats, t).toContain("causal");
    }
    expect(
      (
        await outcomeOf(
          reply({
            r: [rec("Investigate whether lead source mix relates to the conversion rate.")],
          }),
        )
      ).state,
    ).toBe("ok");
  });
  it("requires exact citation consistency: a named metric must be cited, and a cited fact must be named", async () => {
    expect(
      (
        await outcomeOf(
          reply({ i: [interp("Lead volume may relate to the conversion rate.", ["F-leads"])] }),
        )
      ).cats,
    ).toEqual(["relevance"]);
    expect(
      (
        await outcomeOf(
          reply({
            i: [
              interp("Lead volume may relate to the conversion rate.", [
                "F-leads",
                "F-conversion_rate",
                "F-cac",
              ]),
            ],
          }),
        )
      ).cats,
    ).toEqual(["relevance"]);
    expect(
      (
        await outcomeOf(
          reply({
            i: [interp("Lead volume may relate to the conversion rate.", ["F-leads", "F-nothing"])],
          }),
        )
      ).cats,
    ).toContain("ref");
  });
  it("still rejects record ids, source labels, links, and legacy shapes", async () => {
    expect(
      (
        await outcomeOf(
          reply({
            i: [
              interp("Check record VH-MKT-001-Q3 for the conversion rate.", ["F-conversion_rate"]),
            ],
          }),
        )
      ).cats,
    ).toContain("leak");
    expect(
      (await outcomeOf(reply({ g: ["Export from SYN-CRM Campaign Export by source."] }))).cats,
    ).toContain("leak");
    expect(
      (await outcomeOf(reply({ r: [rec("Open https://example.com/report for the lead flow.")] })))
        .cats,
    ).toContain("unsafe");
    expect(
      (
        await outcomeOf(
          JSON.stringify({
            observations: [],
            interpretations: [],
            recommendations: [],
            missing_evidence: [],
          }),
        )
      ).cats,
    ).toEqual(["legacy"]);
  });
  it("accepts an empty missing_evidence array: it is a quality problem, never a security rejection", async () => {
    const r = await outcomeOf(
      reply({
        i: [interp("A shift toward lower-intent lead sources may dilute the conversion rate.")],
        r: [rec("Segment leads and conversion by source to test the mix.")],
      }),
    );
    expect(r).toEqual({ state: "ok", cats: [] });
  });
});

describe("reasoning instructions (scoped system prompt)", () => {
  const sys = SCOPED_SYSTEM("SYNTHETIC business facts for a fictional company");
  it("asks for specific hypotheses, concrete missing evidence, actionable investigations and appropriate uncertainty", () => {
    expect(sys).toMatch(/specific, testable hypothesis/);
    expect(sys).toMatch(/concrete business mechanism/);
    expect(sys).toMatch(/Hedge it once/);
    expect(sys).toMatch(/at least one when any hypothesis is open/);
    expect(sys).toMatch(/actionable investigation/);
    expect(sys).toMatch(/vague verbs such as review, monitor or consider/);
  });
  it("keeps the findings lane as the source of directions and numbers: no numbers, no restating", () => {
    expect(sys).toMatch(/NEVER write any digit or number/);
    expect(sys).toMatch(/Athena already shows the verified changes and their direction/);
    expect(sys).toMatch(/instead of repeating it/);
  });
  it("keeps every boundary and names no metric, department or dataset term", () => {
    expect(sys).toMatch(
      /discuss any metric or department that is not in VERIFIED_FACTS or UNAVAILABLE_METRICS/,
    );
    expect(sys).toMatch(/must not say what it did or how it compares/);
    expect(sys).toMatch(
      /never assert or imply a measured value, trend or comparison for anything outside VERIFIED_FACTS/,
    );
    const names = [
      ...PROTOTYPE_CATALOG.metrics.flatMap((m) => [m.key, ...m.aliases]),
      ...PROTOTYPE_CATALOG.domains.flatMap((d) => d.aliases),
    ];
    for (const n of names)
      expect(sys.toLowerCase(), n).not.toMatch(new RegExp(`\\b${n.replace(/_/g, "[ _]")}\\b`));
    expect(sys).toMatch(
      /BE TERSE: at most 3 interpretations, 4 missing_evidence, 3 recommendations/,
    );
  });
});

describe("model-lane quality evaluation (separate from the findings lane)", () => {
  const out = (s: string) => JSON.parse(s) as QualityOutput;
  it("scores the G4.3 live reply as weak, and an empty missing_evidence as the lowest score for that dimension", () => {
    const e = evaluateReasoning(out(G43_REPLY), FACTS);
    expect(e.verdict).toBe("weak");
    expect(e.hypothesisSpecificity).toBe(0);
    expect(e.missingEvidenceQuality).toBe(0);
    expect(e.actionableInvestigation).toBe(0);
    expect(e.relevance).toBe(2);
  });
  it("scores the revised dry-run style reply as useful", async () => {
    const r = (await runReasoningTest({ mode: "dry-run", env: {} })) as Report;
    expect(r.reasoning).toEqual({
      hypothesisSpecificity: 2,
      relevance: 2,
      missingEvidenceQuality: 2,
      actionableInvestigation: 2,
      appropriateUncertainty: 2,
      total: 10,
      max: 10,
      verdict: "useful",
    });
  });
  it("separates specific from generic recommendations by structure, not by a single keyword", () => {
    const generic = [
      "Please review the funnel.",
      "Monitor lead performance closely.",
      "Review marketing channel mix with attention to efficiency and audience relevance.",
      "Investigate the situation.",
    ];
    for (const t of generic)
      expect(
        evaluateReasoning(q({ recommendations: [{ text: t, refs: ["F-leads"] }] }), FACTS)
          .actionableInvestigation,
        t,
      ).toBe(0);
    const specific = [
      "Segment leads and conversion by source to test whether lower-intent sources account for the gap.",
      "Compare time to first sales contact across lead sources.",
    ];
    for (const t of specific)
      expect(
        evaluateReasoning(q({ recommendations: [{ text: t, refs: ["F-leads"] }] }), FACTS)
          .actionableInvestigation,
        t,
      ).toBe(2);
    // a concrete verb alone is not enough
    expect(
      evaluateReasoning(q({ recommendations: [{ text: "Compare it.", refs: ["F-leads"] }] }), FACTS)
        .actionableInvestigation,
    ).toBe(0);
    // a mention of 'review' inside a concrete action does not disqualify it
    expect(
      evaluateReasoning(
        q({
          recommendations: [
            {
              text: "Compare conversion by lead source, then review the weakest segments.",
              refs: ["F-leads"],
            },
          ],
        }),
        FACTS,
      ).actionableInvestigation,
    ).toBe(2);
  });
  it("scores hypotheses on the facts they link and the content they carry, not on hedging words alone", () => {
    const hedgeOnly: I = {
      text: "Lead volume may possibly co-move with conversion, which could potentially matter.",
      refs: ["F-leads", "F-conversion_rate"],
    };
    const oneRef: I = {
      text: "A shift toward lower-intent lead sources may add volume that converts poorly.",
      refs: ["F-leads"],
    };
    const good: I = {
      text: "A shift toward lower-intent lead sources may dilute the conversion rate.",
      refs: ["F-leads", "F-conversion_rate"],
    };
    expect(
      evaluateReasoning(q({ interpretations: [hedgeOnly] }), FACTS).hypothesisSpecificity,
    ).toBe(0);
    expect(evaluateReasoning(q({ interpretations: [oneRef] }), FACTS).hypothesisSpecificity).toBe(
      0,
    );
    expect(evaluateReasoning(q({ interpretations: [good] }), FACTS).hypothesisSpecificity).toBe(2);
    expect(
      evaluateReasoning(q({ interpretations: [good, hedgeOnly] }), FACTS).hypothesisSpecificity,
    ).toBe(1);
    expect(
      informativeTokens(
        "Lead volume dynamics may co-move with conversion patterns requiring joint review.",
      ),
    ).toEqual([]);
  });
  it("scores missing evidence: empty is lowest, a list unrelated to the hypotheses is partial, a list that tests them is highest", () => {
    const base = {
      interpretations: [
        {
          text: "A shift toward lower-intent lead sources may dilute the conversion rate.",
          refs: ["F-leads", "F-conversion_rate"],
        },
      ],
    };
    expect(
      evaluateReasoning(q({ ...base, missing_evidence: [] }), FACTS).missingEvidenceQuality,
    ).toBe(0);
    expect(
      evaluateReasoning(q({ ...base, missing_evidence: ["More data would help."] }), FACTS)
        .missingEvidenceQuality,
    ).toBe(1);
    expect(
      evaluateReasoning(
        q({ ...base, missing_evidence: ["Weather records for the quarter."] }),
        FACTS,
      ).missingEvidenceQuality,
    ).toBe(1);
    expect(
      evaluateReasoning(
        q({
          ...base,
          missing_evidence: [
            "Lead counts and conversion by source, so lower-intent sources can be separated.",
          ],
        }),
        FACTS,
      ).missingEvidenceQuality,
    ).toBe(2);
  });
  it("scores relevance by how many authorized facts the reasoning actually cites", () => {
    const one = q({ interpretations: [{ text: "x", refs: ["F-leads"] }] });
    const two = q({ interpretations: [{ text: "x", refs: ["F-leads", "F-cac"] }] });
    const three = q({
      interpretations: [{ text: "x", refs: ["F-leads", "F-cac"] }],
      recommendations: [{ text: "y", refs: ["F-conversion_rate"] }],
    });
    expect([one, two, three].map((o) => evaluateReasoning(o, FACTS).relevance)).toEqual([0, 1, 2]);
  });
  it("scores uncertainty: hedged once is right; unhedged assertions and hedge-stacking are not", () => {
    const u = (t: string) =>
      evaluateReasoning(q({ interpretations: [{ text: t, refs: ["F-leads", "F-cac"] }] }), FACTS)
        .appropriateUncertainty;
    expect(u("A larger intake may leave more spend on prospects who never close.")).toBe(2);
    expect(u("A larger intake leaves more spend on prospects who never close.")).toBe(0);
    expect(
      u("A larger intake might possibly perhaps leave more spend on prospects who never close."),
    ).toBe(0);
  });
  it("a low quality score never rejects anything: an accepted weak reply stays accepted", async () => {
    const r = (await runReasoningTest({
      mode: "dry-run",
      env: {},
      provider: fake(G43_REPLY),
    })) as Report;
    expect(r.outcome).toBe("accepted");
    expect(r.reasoning?.verdict).toBe("weak");
  });
});

describe("findings lane: direction recognition is deterministic and independent of the model", () => {
  it("recognizes leads up, conversion rate down and acquisition cost up from Athena's own findings", async () => {
    const r = (await runReasoningTest({ mode: "dry-run", env: {} })) as Report;
    expect(r.findings).toEqual({
      allPresent: true,
      directionsMatch: true,
      perMetric: {
        leads: { present: true, direction: "up", expected: "up" },
        conversion_rate: { present: true, direction: "down", expected: "down" },
        cac: { present: true, direction: "up", expected: "up" },
      },
    });
  });
  it("is available when the model reply is rejected, garbage, or empty", async () => {
    for (const content of ["not json", reply({ g: ["Recognized revenue by month."] }), reply({})]) {
      const r = (await runReasoningTest({
        mode: "dry-run",
        env: {},
        provider: fake(content),
      })) as Report;
      expect(r.findings?.directionsMatch, content).toBe(true);
    }
  });
  it("flags a missing finding or a wrong direction", () => {
    expect(
      evaluateFindings([{ metric: "leads", direction: "up" }], EXPECTED_DIRECTIONS).allPresent,
    ).toBe(false);
    const wrong = evaluateFindings(
      [
        { metric: "leads", direction: "down" },
        { metric: "conversion_rate", direction: "down" },
        { metric: "cac", direction: "up" },
      ],
      EXPECTED_DIRECTIONS,
    );
    expect(wrong).toMatchObject({ allPresent: true, directionsMatch: false });
  });
});
