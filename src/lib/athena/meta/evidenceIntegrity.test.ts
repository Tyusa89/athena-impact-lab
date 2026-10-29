import { describe, expect, it, vi } from "vitest";
import { evaluateReasoning } from "../../../../scripts/reasoningQuality";
import { AuthorizationError, authorizeEvidence, type AccessPolicy } from "../core/access";
import {
  authorizeDemo,
  demoAccessPolicy,
  demoIdentity,
  type PrototypeEvidence,
} from "../prototypeAdapter";
import { PROTOTYPE_CATALOG } from "../prototypeCatalog";
import { PROTOTYPE_RUNTIME } from "./adapter.server";
import { OutputSchema } from "./analysis";
import { buildAuthorizedFacts, type VerifiedFact } from "./grounding";
import type { ModelOutcome, ModelProvider } from "./provider";
import { refsConsistent } from "./refConsistency";
import { buildScopedMessages } from "./scopedPrompt";
import { checkSemantics, semanticScope as genericScope } from "./semantic";
import { semanticScope as facadeScope } from "./semanticGuards";
import { runStrictAnalysis } from "./strictRuntime";
import { validateStrictOutput, type DiagnosticCategory } from "./strictValidation";

// G4.6/G4.7: offline regression tests for evidence-integrity hardening: generic citation integrity (C11/C12), flat-direction consistency (F5), explicit discoverability (F2), G4.7 citation
// precision, E17 empty-response rejection and E18 size-judged strong language. Synthetic data and fake providers only; the vitest global fetch is a tripwire. No test sends a request to Meta.
const tripwire = vi.fn(() => {
  throw new Error("network call attempted");
});
vi.stubGlobal("fetch", tripwire);

const ENV = { META_MODEL_API_KEY: "sk-test-not-real", META_MODEL_ENABLED: "true" };
interface Fake extends ModelProvider {
  calls: number;
}
const fake = (content: string): Fake => ({
  id: "t",
  model: "t",
  displayName: "T",
  calls: 0,
  status: () => ({ keyConfigured: true, ownerEnabled: true }),
  blockedCode: () => null,
  async complete(): Promise<ModelOutcome> {
    this.calls++;
    return { kind: "completion", content, truncated: false, usage: { max_tokens_sent: 2000 } };
  },
});
const reply = (o: { i?: object[]; g?: string[]; r?: object[] }) =>
  JSON.stringify({
    interpretations: o.i ?? [],
    missing_evidence: o.g ?? [],
    recommendations: o.r ?? [],
  });
const I = (text: string, ...refs: string[]) => ({ text, verified: false, refs });
const R = (text: string, ...refs: string[]) => ({ text, requires_human_approval: true, refs });

async function run(
  content: string,
  over: { role?: string; scenario?: string; policy?: AccessPolicy<PrototypeEvidence> } = {},
) {
  const provider = fake(content);
  const cats: DiagnosticCategory[] = [];
  const result = await runStrictAnalysis(
    { scenarioId: over.scenario ?? "baseline", roleId: over.role ?? "exec", ownerConfirmed: true },
    ENV,
    tripwire as unknown as typeof fetch,
    {
      ...PROTOTYPE_RUNTIME,
      ...(over.policy ? { policy: over.policy as AccessPolicy } : {}),
      provider,
    },
    { onDiagnostics: (c) => cats.push(...c) },
  );
  return { result, provider, cats: [...new Set(cats)].sort() };
}
const verdict = async (content: string, over: Parameters<typeof run>[1] = {}) => {
  const r = await run(content, over);
  return { state: r.result.state, cats: r.cats };
};

describe("C11/C12: generic statements may not cite unrelated facts", () => {
  it("accepts a generic statement that cites a fact in the department it names (positive)", async () => {
    for (const [text, ref] of [
      ["Review the sales strategy.", "F-conversion_rate"],
      ["Review the sales strategy.", "F-closed_deals"],
      ["Review the marketing plan.", "F-leads"],
      ["We should discuss the budget.", "F-revenue"],
    ] as const) {
      expect(await verdict(reply({ r: [R(text, ref)] })), `${text} ${ref}`).toEqual({
        state: "ok",
        cats: [],
      });
    }
  });
  it("accepts a sentence that spans two departments when at least one cited fact is in a named one", async () => {
    expect(
      await verdict(
        reply({
          r: [R("Marketing and sales should communicate.", "F-leads", "F-conversion_rate")],
        }),
      ),
    ).toEqual({ state: "ok", cats: [] });
    expect(
      await verdict(
        reply({
          r: [R("Review marketing and sales handoffs.", "F-leads", "F-cac", "F-conversion_rate")],
        }),
      ),
    ).toEqual({ state: "ok", cats: [] });
  });
  it("rejects a generic statement whose only citations are outside the department it names (C11)", async () => {
    for (const [text, refs] of [
      ["Review the sales strategy.", ["F-revenue"]],
      ["Review the sales strategy.", ["F-revenue", "F-backorder_rate"]],
      ["Review the marketing plan.", ["F-revenue"]],
      ["We should discuss the budget.", ["F-leads"]],
      ["Operations may need additional coordination.", ["F-leads", "F-cac"]],
    ] as const) {
      expect(await verdict(reply({ r: [R(text, ...refs)] })), `${text} ${refs}`).toEqual({
        state: "rejected",
        cats: ["relevance"],
      });
      expect(
        await verdict(reply({ i: [I(text, ...refs)] })),
        `${text} ${refs} (interpretation)`,
      ).toEqual({ state: "rejected", cats: ["relevance"] });
    }
  });
  it("accepts a generic reference to a decline or rise only when a cited fact moved that way, and rejects it otherwise (C12)", async () => {
    // baseline: leads and cac rose; conversion rate and revenue fell
    expect(
      (
        await verdict(
          reply({ i: [I("The decline may reflect seasonal demand.", "F-conversion_rate")] }),
        )
      ).state,
    ).toBe("ok");
    expect(
      (await verdict(reply({ i: [I("The recent increase may reflect promotions.", "F-leads")] })))
        .state,
    ).toBe("ok");
    expect(
      await verdict(reply({ i: [I("The decline may reflect seasonal demand.", "F-leads")] })),
    ).toEqual({ state: "rejected", cats: ["relevance"] });
    expect(await verdict(reply({ i: [I("The drop may be seasonal.", "F-cac")] }))).toEqual({
      state: "rejected",
      cats: ["relevance"],
    });
    expect(
      await verdict(reply({ r: [R("Investigate the recent increase.", "F-conversion_rate")] })),
    ).toEqual({ state: "rejected", cats: ["relevance"] });
  });
  it("needs a supporting fact for EACH direction a generic sentence mentions", async () => {
    const both = "The rise and the decline may be related.";
    expect(await verdict(reply({ i: [I(both, "F-leads")] }))).toEqual({
      state: "rejected",
      cats: ["relevance"],
    });
    expect((await verdict(reply({ i: [I(both, "F-leads", "F-conversion_rate")] }))).state).toBe(
      "ok",
    );
  });
  it("does not read a denied, conditional or interrogative mention as a claimed movement", async () => {
    for (const t of [
      "There was no decline in the period.",
      "Is the decline seasonal?",
      "If the decline continues, escalate.",
    ]) {
      expect((await verdict(reply({ i: [I(t, "F-leads")] }))).state, t).toBe("ok");
    }
  });
  it("an unrelated negation, condition or question elsewhere in the sentence does not exempt the mention (review fix)", async () => {
    // baseline: leads rose, so none of these may cite F-leads for "the decline"
    for (const t of [
      "No one has explained the decline.",
      "No one explained the recent decline.",
      "We never discussed the drop.",
      "Not all teams explained the decline.",
      "Nobody owns this and no one explained the decline.",
      "If asked, explain the decline.",
      "Who owns this? Investigate the decline.",
      "Is anyone free? Explain the decline.",
    ]) {
      expect(await verdict(reply({ i: [I(t, "F-leads")] })), t).toEqual({
        state: "rejected",
        cats: ["relevance"],
      });
      expect(await verdict(reply({ r: [R(t, "F-leads")] })), `${t} (recommendation)`).toEqual({
        state: "rejected",
        cats: ["relevance"],
      });
    }
    // the same sentences are fine when a cited fact actually fell
    expect(
      (await verdict(reply({ i: [I("No one has explained the decline.", "F-conversion_rate")] })))
        .state,
    ).toBe("ok");
  });
  it("a negation, condition or question that governs the mention itself still exempts it", async () => {
    for (const t of [
      "There is no sign of the decline.",
      "This is not the decline we expected.",
      "The decline did not occur.",
      "Without the decline, spending would be flat.",
      "Whether the decline is seasonal is unclear.",
      "If the decline continues, escalate.",
      "Is the decline seasonal?",
    ]) {
      expect((await verdict(reply({ i: [I(t, "F-leads")] }))).state, t).toBe("ok");
    }
  });
  it("accepted citations still derive supporting records from the cited facts alone", async () => {
    const r = await run(
      reply({ r: [R("Review the sales strategy.", "F-conversion_rate", "F-leads")] }),
    );
    expect(r.result.state).toBe("ok");
    if (r.result.state !== "ok") return;
    const facts = buildAuthorizedFacts(
      authorizeDemo({ scenarioId: "baseline", roleId: "exec" }).authorized,
      PROTOTYPE_RUNTIME.analysis,
    );
    const want = ["F-conversion_rate", "F-leads"].flatMap((id) => {
      const f = facts.find((x) => x.fact_id === id)!;
      return [f.prior.id, f.current.id];
    });
    expect(r.result.output.recommendations[0]!.supporting_ids).toEqual(want);
  });
  it("a model cannot supply or widen supporting_ids itself (schema)", () => {
    const smuggled = {
      interpretations: [
        {
          ...I("Review the sales strategy.", "F-conversion_rate"),
          supporting_ids: ["VH-FIN-001-Q2"],
        },
      ],
      missing_evidence: [],
      recommendations: [],
    };
    expect(OutputSchema.safeParse(smuggled).success).toBe(false);
  });
  it("G4.7: wholly generic text may no longer cite any fact, and a role with no related fact is still not asked for the impossible", async () => {
    expect(await verdict(reply({ r: [R("Gather more data.", "F-revenue")] }))).toEqual({
      state: "rejected",
      cats: ["relevance"],
    });
    // the finance role has no Sales fact, so a sentence about sales cannot cite a related one (the schema still requires a ref)
    expect(
      (
        await verdict(reply({ r: [R("Review the sales strategy.", "F-revenue")] }), {
          role: "finance",
        })
      ).state,
    ).toBe("ok");
  });
  it("the metric-named rule is unchanged: exact match, coverage, no extras", () => {
    const facts = buildAuthorizedFacts(
      authorizeDemo({ scenarioId: "baseline", roleId: "exec" }).authorized,
      PROTOTYPE_RUNTIME.analysis,
    );
    const c = PROTOTYPE_CATALOG;
    expect(
      refsConsistent(
        "Lead volume may relate to conversion rate.",
        ["F-leads", "F-conversion_rate"],
        facts,
        c,
      ),
    ).toBe(true);
    expect(
      refsConsistent("Lead volume may relate to conversion rate.", ["F-leads"], facts, c),
    ).toBe(false);
    expect(
      refsConsistent(
        "Lead volume may relate to conversion rate.",
        ["F-leads", "F-conversion_rate", "F-cac"],
        facts,
        c,
      ),
    ).toBe(false);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------------------------ F5
const fact = (prior: number, current: number, pct: number | null): VerifiedFact => ({
  fact_id: "F-leads",
  metric: "leads",
  department: "Marketing",
  unit: "leads",
  prior: { id: "P", value: prior },
  current: { id: "C", value: current },
  change_pct: pct,
  change_pp: null,
  direction: pct === null || Math.abs(pct) < 3 ? "flat" : pct > 0 ? "up" : "down",
});
const issues = (f: VerifiedFact, text: string, strict = true) => {
  const scope = genericScope([], [f], PROTOTYPE_CATALOG, {
    discoverable: ["leads"],
    strictMentions: strict,
  });
  return checkSemantics(text, "interpretation", scope).map((i) => i.code);
};
const EQUAL = fact(100, 100, 0);
const SMALL_UP = fact(100, 101, 1);
const SMALL_DOWN = fact(100, 99, -1);
const FROM_ZERO = fact(0, 5, null);

describe("F5: directional claims against a flat finding and the underlying raw values (strict profile)", () => {
  it("equal values: any up or down claim contradicts, flat wording and negations do not", () => {
    for (const t of [
      "Lead volume rose.",
      "Lead volume fell.",
      "Lead volume rose slightly.",
      "Lead volume increased.",
      "Lead volume rose sharply.",
    ])
      expect(issues(EQUAL, t), t).toEqual(["direction"]);
    for (const t of [
      "Lead volume was flat.",
      "Lead volume was unchanged.",
      "Lead volume did not rise.",
      "Lead volume did not fall.",
    ])
      expect(issues(EQUAL, t), t).toEqual([]);
  });
  it("small positive change: a truthful description of the raw movement is accepted; the opposite and forceful language are not", () => {
    for (const t of [
      "Lead volume rose.",
      "Lead volume rose slightly.",
      "Lead volume grew.",
      "Lead volume increased modestly.",
      "Lead volume was flat.",
    ])
      expect(issues(SMALL_UP, t), t).toEqual([]);
    for (const t of ["Lead volume fell.", "Lead volume declined.", "Lead volume dropped slightly."])
      expect(issues(SMALL_UP, t), t).toEqual(["direction"]);
    for (const t of [
      "Lead volume surged.",
      "Lead volume soared.",
      "Lead volume jumped.",
      "Lead volume rose sharply.",
      "Lead volume grew dramatically.",
      "Lead volume increased significantly.",
    ])
      expect(issues(SMALL_UP, t), t).toEqual(["direction"]);
  });
  it("small negative change mirrors it", () => {
    for (const t of ["Lead volume declined.", "Lead volume dropped slightly.", "Lead volume fell."])
      expect(issues(SMALL_DOWN, t), t).toEqual([]);
    for (const t of ["Lead volume rose.", "Lead volume grew slightly."])
      expect(issues(SMALL_DOWN, t), t).toEqual(["direction"]);
    for (const t of [
      "Lead volume plunged.",
      "Lead volume collapsed.",
      "Lead volume fell sharply.",
      "Lead volume dropped substantially.",
    ])
      expect(issues(SMALL_DOWN, t), t).toEqual(["direction"]);
  });
  it("a zero prior value has no relative size: the flat label says nothing about magnitude, so only equality and sign apply", () => {
    expect(FROM_ZERO.direction).toBe("flat");
    for (const t of ["Lead volume rose.", "Lead volume surged.", "Lead volume rose sharply."])
      expect(issues(FROM_ZERO, t), t).toEqual([]);
    expect(issues(FROM_ZERO, "Lead volume fell.")).toEqual(["direction"]);
    expect(issues(fact(0, 0, null), "Lead volume rose.")).toEqual(["direction"]);
  });
  it("does not change non-flat findings: matching language stays accepted (including qualitative magnitude, E18) and the opposite stays rejected", () => {
    const up = fact(100, 150, 50);
    for (const t of ["Lead volume rose.", "Lead volume surged.", "Lead volume rose sharply."])
      expect(issues(up, t), t).toEqual([]);
    expect(issues(up, "Lead volume fell.")).toEqual(["direction"]);
  });
  it("the legacy profile and its goldens are untouched: it still tolerates up/down wording on a flat finding", () => {
    for (const t of ["Lead volume rose.", "Lead volume surged.", "Lead volume fell."])
      expect(issues(EQUAL, t, false), t).toEqual([]);
  });
  it("end to end: a flat, unchanged metric cannot be described as moving, and a truthful flat statement passes", async () => {
    // "ops-only": lead quality (MQL rate) is 33 -> 33 (flat, equal)
    const over = { scenario: "ops-only" };
    expect(await verdict(reply({ i: [I("Lead quality rose.", "F-mql_rate")] }), over)).toEqual({
      state: "rejected",
      cats: ["direction"],
    });
    expect(
      await verdict(reply({ i: [I("Lead quality rose sharply.", "F-mql_rate")] }), over),
    ).toEqual({ state: "rejected", cats: ["direction"] });
    expect(
      (await verdict(reply({ i: [I("Lead quality was unchanged.", "F-mql_rate")] }), over)).state,
    ).toBe("ok");
  });
});

// ------------------------------------------------------------------------------------------------------------------------------------------------ F2
describe("F2: strict reasoning requires an explicit discoverability grant", () => {
  const undeclared: AccessPolicy<PrototypeEvidence> = {
    evidenceScope: (ctx) => {
      const b = demoAccessPolicy.evidenceScope(ctx);
      return { tenantId: b.tenantId, permits: b.permits };
    },
  };
  const declared = (grant: string[]): AccessPolicy<PrototypeEvidence> => ({
    evidenceScope: (ctx) => {
      const b = demoAccessPolicy.evidenceScope(ctx);
      return { tenantId: b.tenantId, permits: b.permits, discoverableMetrics: grant };
    },
  });
  it("authorization reports whether the grant was declared: absent is not the same as empty", () => {
    const call = (policy: AccessPolicy<PrototypeEvidence>) => {
      const ctx = demoIdentity.authenticateSync({
        kind: "simulated-demo-role-claim",
        roleId: "marketing",
      });
      return authorizeEvidence(demoIdentity, ctx, policy, []);
    };
    expect(call(undeclared)).toMatchObject({ discoverableMetrics: [], grantDeclared: false });
    expect(call(declared([]))).toMatchObject({ discoverableMetrics: [], grantDeclared: true });
    expect(call(declared(["cac"]))).toMatchObject({
      discoverableMetrics: ["cac"],
      grantDeclared: true,
    });
    expect(call(demoAccessPolicy).grantDeclared).toBe(true);
    expect(() => call(declared([""]))).toThrow(AuthorizationError); // a malformed declaration still fails closed
  });
  it("the strict run refuses a policy that never declared a grant: nothing is sent and the model is not called", async () => {
    const r = await run(reply({}), { role: "marketing", policy: undeclared });
    expect(r.result).toMatchObject({
      state: "blocked",
      requestSent: false,
      reason: "Engine configuration error; nothing sent.",
    });
    expect(r.provider.calls).toBe(0);
  });
  it("an explicit EMPTY grant is a valid declaration and runs", async () => {
    const r = await run(reply({ g: ["Lead counts and conversion by source."] }), {
      role: "marketing",
      policy: declared([]),
    });
    expect(r.result.state).toBe("ok");
    expect(r.provider.calls).toBe(1);
  });
  it("the validator and the scoped prompt need an array grant: a missing one throws instead of defaulting", () => {
    const a = authorizeDemo({ scenarioId: "baseline", roleId: "marketing" });
    expect(() =>
      validateStrictOutput(
        reply({}),
        a.authorized,
        a.withheld,
        PROTOTYPE_RUNTIME.analysis,
        undefined as never,
      ),
    ).toThrow(TypeError);
    expect(() =>
      validateStrictOutput(
        reply({}),
        a.authorized,
        a.withheld,
        PROTOTYPE_RUNTIME.analysis,
        "cac" as never,
      ),
    ).toThrow(TypeError);
    expect(() =>
      validateStrictOutput(
        reply({}),
        a.authorized,
        a.withheld,
        PROTOTYPE_RUNTIME.analysis,
        null as never,
      ),
    ).toThrow(TypeError);
    expect(() =>
      buildScopedMessages("", a.authorized, PROTOTYPE_RUNTIME.analysis, undefined as never),
    ).toThrow(TypeError);
    expect(
      validateStrictOutput(
        reply({ g: ["Lead counts and conversion by source."] }),
        a.authorized,
        a.withheld,
        PROTOTYPE_RUNTIME.analysis,
        a.discoverableMetrics,
      ).ok,
    ).toBe(true);
  });
  it("the prototype facade infers a department-derived grant only for the legacy scope; a strict scope must be given one", () => {
    const a = authorizeDemo({ scenarioId: "baseline", roleId: "marketing" });
    const facts = buildAuthorizedFacts(a.authorized, PROTOTYPE_RUNTIME.analysis);
    expect(() =>
      facadeScope(a.authorized, facts, PROTOTYPE_CATALOG, { strictMentions: true }),
    ).toThrow(TypeError);
    expect(() =>
      facadeScope(a.authorized, facts, PROTOTYPE_CATALOG, { strictMentions: "true" as never }),
    ).toThrow(TypeError);
    // null is not an explicit grant either: it must not fall through to the department-derived default (review fix)
    for (const strictMentions of [true, "true" as never, 1 as never, null as never])
      expect(() =>
        facadeScope(a.authorized, facts, PROTOTYPE_CATALOG, {
          discoverable: null as never,
          strictMentions,
        }),
      ).toThrow(TypeError);
    // no facts, so only the grant counts: Marketing records are present, yet nothing is inferred from their department
    expect(
      facadeScope(a.authorized, [], PROTOTYPE_CATALOG, {
        discoverable: [],
        strictMentions: true,
      }).discoverable?.size,
    ).toBe(0);
    expect(
      facadeScope(a.authorized, facts, PROTOTYPE_CATALOG, {
        discoverable: null as never,
      }).discoverable?.has("mql_rate"),
    ).toBe(true); // legacy unchanged
    // legacy (unset or false) keeps the department-derived default, so the goldens and legacy callers are unchanged
    expect(facadeScope(a.authorized, facts, PROTOTYPE_CATALOG).discoverable?.has("mql_rate")).toBe(
      true,
    );
    expect(
      facadeScope(a.authorized, facts, PROTOTYPE_CATALOG, {
        strictMentions: false,
      }).discoverable?.has("mql_rate"),
    ).toBe(true);
  });
  it("record departments never widen a strict grant: Marketing records are present, yet an ungranted Marketing metric stays hidden", async () => {
    const leadsOnly = (grant: string[]): AccessPolicy<PrototypeEvidence> => ({
      evidenceScope: (ctx) => {
        const b = demoAccessPolicy.evidenceScope(ctx);
        return {
          tenantId: b.tenantId,
          permits: (e) => b.permits(e) && e.metric === "leads",
          discoverableMetrics: grant,
        };
      },
    });
    const gap = reply({ g: ["Lead quality scores by source."] });
    expect(await verdict(gap, { role: "marketing", policy: leadsOnly([]) })).toEqual({
      state: "rejected",
      cats: ["domain"],
    });
    expect((await verdict(gap, { role: "marketing", policy: leadsOnly(["mql_rate"]) })).state).toBe(
      "ok",
    );
    // and a granted name opens exactly that name, not its department
    expect(
      (
        await verdict(reply({ g: ["Closed deals by source."] }), {
          role: "marketing",
          policy: leadsOnly(["mql_rate"]),
        })
      ).cats,
    ).toEqual(["domain"]);
  });
  it("existing authorization boundaries hold: records outside the role stay withheld and unreferenceable", async () => {
    const r = await verdict(reply({ i: [I("Lead volume may matter.", "F-revenue")] }), {
      role: "marketing",
    });
    expect(r).toEqual({ state: "rejected", cats: ["ref"] });
  });
});

// ------------------------------------------------------------------------------------------------------------------------------------------------ E17 / E18
describe("E17/E18: decided policies (G4.7) — empty responses are rejected, strong language is judged by size", () => {
  it("E17: an all-empty structured output is rejected by strict validation (the schema still permits empty lanes; the score still rates it the weakest reasoning)", async () => {
    expect(await verdict(reply({}))).toEqual({ state: "rejected", cats: ["empty"] });
    const empty = { interpretations: [], missing_evidence: [], recommendations: [] };
    expect(OutputSchema.safeParse(empty).success).toBe(true);
    expect(evaluateReasoning(empty, ["F-leads", "F-cac", "F-conversion_rate"])).toMatchObject({
      total: 0,
      verdict: "weak",
    });
    // each lane is independently allowed to be empty
    expect((await verdict(reply({ g: ["Lead counts and conversion by source."] }))).state).toBe(
      "ok",
    );
  });
  it("E18: qualitative magnitude supported by a large verified move stays accepted, while numeric and quantified magnitude stay rejected", async () => {
    for (const t of [
      "Lead volume rose sharply.",
      "Lead volume rose dramatically.",
      "Conversion fell steeply.",
    ]) {
      const ref = t.startsWith("Lead") ? "F-leads" : "F-conversion_rate";
      expect((await verdict(reply({ i: [I(t, ref)] }))).state, t).toBe("ok");
    }
    for (const t of [
      "Lead volume rose by forty percent.",
      "Lead volume doubled.",
      "Lead volume rose by a third.",
    ]) {
      expect((await verdict(reply({ i: [I(t, "F-leads")] }))).cats, t).toContain("magnitude");
    }
  });
  it("E18 is not a loophole for flat findings: the same qualitative language is rejected there (F5)", () => {
    expect(issues(SMALL_UP, "Lead volume rose sharply.")).toEqual(["direction"]);
    expect(issues(fact(100, 150, 50), "Lead volume rose sharply.")).toEqual([]);
  });
  it("G4.7 citation precision: a sentence no guard can examine is rejected in both citing lanes, while hooked sentences still pass", async () => {
    for (const t of ["Gather more data.", "Consider scheduling a planning workshop."]) {
      expect(await verdict(reply({ i: [I(t, "F-revenue")] })), `${t} (interpretation)`).toEqual({
        state: "rejected",
        cats: ["relevance"],
      });
      expect(await verdict(reply({ r: [R(t, "F-revenue")] })), `${t} (recommendation)`).toEqual({
        state: "rejected",
        cats: ["relevance"],
      });
    }
    // hooks that still pass: an exempted movement reference, a causal topic, a department
    expect(
      (await verdict(reply({ i: [I("There was no decline in the period.", "F-leads")] }))).state,
    ).toBe("ok");
    expect(
      (await verdict(reply({ i: [I("The root cause is unknown.", "F-revenue")] }))).state,
    ).toBe("ok");
    expect(
      (await verdict(reply({ r: [R("Review the sales strategy.", "F-conversion_rate")] }))).state,
    ).toBe("ok");
  });
  it("G4.7 E18: strong language about a modest non-flat move is rejected; plain descriptions and large moves are accepted", () => {
    const modestUp = fact(100, 106, 6);
    const modestDown = fact(100, 94, -6);
    expect(modestUp.direction).toBe("up");
    expect(modestDown.direction).toBe("down");
    for (const t of [
      "Lead volume surged.",
      "Lead volume rose sharply.",
      "Lead volume grew dramatically.",
    ])
      expect(issues(modestUp, t), t).toEqual(["direction"]);
    for (const t of ["Lead volume plunged.", "Lead volume fell sharply."])
      expect(issues(modestDown, t), t).toEqual(["direction"]);
    for (const t of [
      "Lead volume rose.",
      "Lead volume rose slightly.",
      "Lead volume grew.",
      "Lead volume increased modestly.",
    ])
      expect(issues(modestUp, t), t).toEqual([]);
    for (const t of ["Lead volume fell.", "Lead volume declined.", "Lead volume dropped slightly."])
      expect(issues(modestDown, t), t).toEqual([]);
    // a large verified move supports strong language
    for (const t of ["Lead volume surged.", "Lead volume rose sharply."])
      expect(issues(fact(100, 150, 50), t), t).toEqual([]);
    // the legacy profile is untouched: it still tolerates strong wording on a modest move
    for (const t of ["Lead volume surged.", "Lead volume rose sharply."])
      expect(issues(modestUp, t, false), t).toEqual([]);
  });
  it("G4.7 E18 end to end: a modest verified move cannot be described in forceful terms", async () => {
    // quality-only exec: revenue -4.7%; baseline exec: closed deals -14.8% (just under the 15% bar)
    expect(
      await verdict(reply({ i: [I("Revenue plunged.", "F-revenue")] }), { scenario: "quality-only" }),
    ).toEqual({ state: "rejected", cats: ["direction"] });
    expect(
      (await verdict(reply({ i: [I("Revenue fell.", "F-revenue")] }), { scenario: "quality-only" }))
        .state,
    ).toBe("ok");
    expect(await verdict(reply({ i: [I("Closed deals plunged.", "F-closed_deals")] }))).toEqual({
      state: "rejected",
      cats: ["direction"],
    });
    // just above the bar, strong language stays accepted: acquisition cost +19.5%
    expect((await verdict(reply({ i: [I("Acquisition cost surged.", "F-cac")] }))).state).toBe(
      "ok",
    );
  });
  // G4.7 review follow-up: E18 made the `strong` flag load-bearing for every non-flat metric under the bar, which exposed the +-24-character intensifier window. An intensifier that
  // belongs to a NEIGHBOURING predicate must not condemn this claim. "cac" is a catalog alias, so both halves of these sentences really are bound to their own metric.
  const cacFact = (prior: number, current: number, pct: number | null): VerifiedFact => ({
    ...fact(prior, current, pct),
    fact_id: "F-cac",
    metric: "cac",
    unit: "USD",
  });
  const CAC_BIG_DOWN = cacFact(100, 50, -50); // large: "sharply" is truthful about cac
  const pairIssues = (text: string, leads: VerifiedFact, cac = CAC_BIG_DOWN, strict = true) =>
    checkSemantics(
      text,
      "interpretation",
      genericScope([], [leads, cac], PROTOTYPE_CATALOG, {
        discoverable: ["leads", "cac"],
        strictMentions: strict,
      }),
    ).map((i) => i.code);
  it("G4.7 E18: an intensifier binds to its own predicate, not across a coordinator (regression)", () => {
    const modestUp = fact(100, 106, 6); // non-flat but under the 15% bar
    // each half is truthful on its own
    expect(pairIssues("Lead volume rose.", modestUp)).toEqual([]);
    expect(pairIssues("Cac fell sharply.", modestUp)).toEqual([]);
    // ...so the conjunction must stay accepted too: "sharply" modifies "fell" (cac), not "rose" (leads)
    expect(pairIssues("Lead volume rose and cac fell sharply.", modestUp)).toEqual([]);
    expect(pairIssues("Cac fell sharply and lead volume rose.", modestUp)).toEqual([]);
    expect(pairIssues("Lead volume rose and cac sharply fell.", modestUp)).toEqual([]);
    // the intensifier still binds inside its OWN predicate, on either side of the direction word
    expect(pairIssues("Lead volume rose sharply and cac fell.", modestUp)).toEqual(["direction"]);
    expect(pairIssues("Lead volume sharply rose and cac fell.", modestUp)).toEqual(["direction"]);
    // unchanged: a strong VERB is bound by the word itself, never by the window
    expect(pairIssues("Lead volume surged and cac fell.", modestUp)).toEqual(["direction"]);
    // a coordinator joining an ENTITY CHAIN is not a predicate boundary: both subjects keep the strong claim
    expect(
      pairIssues("Lead volume and cac rose sharply.", modestUp, cacFact(100, 106, 6)),
    ).toEqual(["direction", "direction"]);
    // the legacy profile is untouched either way
    expect(pairIssues("Lead volume rose and cac fell sharply.", modestUp, CAC_BIG_DOWN, false)).toEqual([]);
    expect(pairIssues("Lead volume rose sharply and cac fell.", modestUp, CAC_BIG_DOWN, false)).toEqual([]);
  });
  it("G4.7 E18: the binding rule does not weaken F5, which still rejects a flat finding's OWN forceful wording", () => {
    // the intensifier belongs to the cac predicate, so the flat leads claim is a plain (allowed) description of a small raw rise
    expect(pairIssues("Lead volume rose and cac fell sharply.", SMALL_UP)).toEqual([]);
    // ...but a flat finding with the intensifier in its own predicate is still rejected
    expect(pairIssues("Lead volume rose sharply and cac fell.", SMALL_UP)).toEqual(["direction"]);
    expect(issues(SMALL_UP, "Lead volume rose sharply.")).toEqual(["direction"]);
  });
  it("the G4.5 reasoning score stays a non-gating metric: a weak reply that the validator accepts is still accepted", async () => {
    const weak = reply({
      i: [I("Lead volume may co-move with conversion patterns.", "F-leads", "F-conversion_rate")],
    });
    expect((await verdict(weak)).state).toBe("ok");
  });
});
