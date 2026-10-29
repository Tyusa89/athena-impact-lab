import { readFileSync, readdirSync, statSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authorizeEvidence, type AccessPolicy, type AuthorizationResult } from "../core/access";
import { validateCatalog, assertCatalog, type Catalog } from "../core/catalog";
import type { Evidence } from "../core/evidence";
import {
  SUPPORT_DESK_CATALOG,
  SUPPORT_DESK_MAPPING,
  SUPPORT_DESK_PERIODS,
  SUPPORT_DESK_SOURCE,
} from "../core/ingest/fixtures";
import { csvAdapter, importSource } from "../core/ingest";
import { allowAll, identity, trusted } from "../core/ingest/testSupport";
import type { AnalysisContext } from "../core/facts";
import {
  authorizeDemo,
  demoAccessPolicy,
  demoIdentity,
  type PrototypeEvidence,
} from "../prototypeAdapter";
import { PROTOTYPE_CATALOG } from "../prototypeCatalog";
import { PROTOTYPE_RUNTIME } from "./adapter.server";
import { validateAuthorizedOutput } from "./analysis";
import type { ModelProvider } from "./provider";
import { checkSemantics, mentionedEntities, semanticScope } from "./semantic";
import { STRICT_REJECTION_REASON, validateStrictOutput } from "./strictValidation";
import { runStrictAnalysis } from "./strictRuntime";
import { strictEntities } from "./strictVocabulary";

// H2.3: strict vocabulary. Plain department words are accepted; every restricted metric (in any inflection or spelling), data-bearing or non-generic department word, record id, source label
// and claim stays rejected. Offline: no provider is called except the fake ones below.
const tripwire = vi.fn(() => {
  throw new Error("network call attempted");
});
vi.stubGlobal("fetch", tripwire);
afterEach(() => tripwire.mockClear());

const DEMO: AnalysisContext = PROTOTYPE_RUNTIME.analysis;
const DESK: AnalysisContext = { catalog: SUPPORT_DESK_CATALOG, periods: SUPPORT_DESK_PERIODS };
type Lane = "interpretations" | "missing_evidence" | "recommendations";
const LANES: Lane[] = ["interpretations", "missing_evidence", "recommendations"];
const body = (text: string, lane: Lane, refs: string[]) =>
  JSON.stringify({
    interpretations: lane === "interpretations" ? [{ text, verified: false, refs }] : [],
    missing_evidence: lane === "missing_evidence" ? [text] : [],
    recommendations:
      lane === "recommendations" ? [{ text, requires_human_approval: true, refs }] : [],
  });

interface Scope {
  name: string;
  ctx: AnalysisContext;
  auth: AuthorizationResult<Evidence>;
  refs: string[];
}
const demoMetricPolicy = (
  metrics: string[],
  grant?: string[],
): AccessPolicy<PrototypeEvidence> => ({
  evidenceScope: (ctx) => {
    const b = demoAccessPolicy.evidenceScope(ctx);
    return {
      tenantId: b.tenantId,
      permits: (e) => b.permits(e) && metrics.includes(e.metric),
      discoverableMetrics: grant ?? [], // F2: the strict path requires a DECLARED grant; no grant means a declared empty one
    };
  },
});
const demoScope = (
  name: string,
  role: string,
  pol: AccessPolicy<PrototypeEvidence> | undefined,
  refs: string[],
): Scope => {
  const base = authorizeDemo({ scenarioId: "baseline", roleId: role });
  if (!pol)
    return { name, ctx: DEMO, auth: base as unknown as AuthorizationResult<Evidence>, refs };
  const ctx = demoIdentity.authenticateSync({ kind: "simulated-demo-role-claim", roleId: role });
  return {
    name,
    ctx: DEMO,
    auth: authorizeEvidence(demoIdentity, ctx, pol as AccessPolicy<Evidence>, [
      ...base.authorized,
      ...base.withheld,
    ]),
    refs,
  };
};
const deskRecords = (): readonly Evidence[] => {
  const r = importSource({
    identity,
    ctx: trusted("tenant-vocab-h23"),
    policy: allowAll,
    adapter: csvAdapter,
    input: readFileSync("src/lib/athena/core/ingest/fixtures/customer-support.csv", "utf8"),
    source: SUPPORT_DESK_SOURCE,
    spec: SUPPORT_DESK_MAPPING,
    catalog: SUPPORT_DESK_CATALOG,
  });
  if (!r.ok) throw new Error("import");
  return r.accepted;
};
const deskScope = (
  name: string,
  domains: string[],
  refs: string[],
  grant: string[] = [],
): Scope => ({
  name,
  ctx: DESK,
  refs,
  auth: authorizeEvidence(
    identity,
    trusted("tenant-vocab-h23"),
    {
      evidenceScope: (c) => ({
        tenantId: c.tenantId,
        permits: (e) => domains.includes(e.department),
        discoverableMetrics: grant,
      }),
    },
    deskRecords(),
  ),
});
const LEADS_ONLY = demoScope("leads-only", "marketing", demoMetricPolicy(["leads"]), ["F-leads"]); // Marketing open (leads); Sales, Operations, Finance hidden; same-department mql_rate, cac hidden
const FINANCE = demoScope("finance", "finance", undefined, ["F-revenue"]); // only Finance open
const DESK_SUPPORT = deskScope("desk-support", ["Support"], ["F-tickets_opened"]); // CustomerExperience hidden
const DESK_CX = deskScope("desk-cx", ["CustomerExperience"], ["F-csat"]); // Support hidden

const verdict = (sc: Scope, text: string, lane: Lane) =>
  validateStrictOutput(
    body(text, lane, sc.refs),
    sc.auth.authorized,
    sc.auth.withheld,
    sc.ctx,
    sc.auth.discoverableMetrics,
  );
const accepted = (sc: Scope, text: string, lane: Lane) => verdict(sc, text, lane).ok;

describe("generic business language is accepted in all three lanes", () => {
  const CASES: [Scope, string][] = [
    [LEADS_ONLY, "Review the sales strategy."],
    [LEADS_ONLY, "We should discuss the budget."],
    [LEADS_ONLY, "Operations may need additional coordination."],
    [LEADS_ONLY, "Marketing and sales should communicate."],
    [FINANCE, "Review the sales strategy."],
    [FINANCE, "Operations may need additional coordination."],
    [FINANCE, "Marketing and sales should communicate."],
    [FINANCE, "Review the marketing campaign plan."],
    [DESK_SUPPORT, "Consider improving the customer experience."],
    [DESK_SUPPORT, "The customer experience team may want to coordinate."],
    [DESK_CX, "Support may need additional coordination."],
    [DESK_CX, "The service desk may want to coordinate."],
  ];
  it.each(CASES.flatMap(([sc, t]) => LANES.map((l) => [sc.name, t, l, sc] as const)))(
    "%s · %s · %s",
    (_n, t, l, sc) => {
      expect(verdict(sc, t, l).ok, t).toBe(true);
    },
  );
  it("declared generic words of every hidden department are accepted, in any case, spacing or width", () => {
    for (const [d, words] of [
      [
        "Sales",
        [
          "sales",
          "SALES",
          "Sales",
          "ＳＡＬＥＳ",
          "sa​les",
          "sales team",
          "sales-team",
          "salespeople",
        ],
      ],
      ["Finance", ["budget", "budgets", "BUDGET", "financial", "accounting", "Ｂｕｄｇｅｔ"]],
      ["Operations", ["operations", "operational", "OPERATIONS"]],
    ] as const) {
      for (const w of words)
        for (const l of LANES)
          expect(
            accepted(LEADS_ONLY, `We should talk about ${w} soon.`, l),
            `${d}: ${w} (${l})`,
          ).toBe(true);
    }
  });
  it("what the caller may discover is, as before, mentionable and consistent claims are accepted", () => {
    expect(accepted(LEADS_ONLY, "Lead volume rose.", "interpretations")).toBe(true);
    expect(
      accepted(
        LEADS_ONLY,
        "Lead volume may be worth reviewing alongside channel data.",
        "recommendations",
      ),
    ).toBe(true);
    expect(accepted(LEADS_ONLY, "Lead source mix by period would help.", "missing_evidence")).toBe(
      true,
    );
    expect(accepted(LEADS_ONLY, "Lead volume fell.", "interpretations")).toBe(false); // contradicts the verified finding
  });
});

describe("restricted metrics stay rejected, directional or neutral, in all three lanes", () => {
  const METRIC_TEXTS = [
    "Sales conversion rate declined.",
    "Customer acquisition cost increased.",
    "Recognized revenue fell.",
    "Backorder rate improved.",
    "Lead quality fell.",
    "Sales conversion rate may be worth a look.",
    "Customer acquisition cost may be worth a look.",
    "Recognized revenue may be worth a look.",
    "Backorder rate may be worth a look.",
    "Lead quality may be worth a look.",
    "Closed deals may help.",
    "Fulfillment time may help.",
    "Conversion may help.",
    "CAC may help.",
    "MQL rate may help.",
    "Revenue may help.",
  ];
  it.each(METRIC_TEXTS.flatMap((t) => LANES.map((l) => [t, l] as const)))("%s · %s", (t, l) => {
    expect(accepted(LEADS_ONLY, t, l), t).toBe(false);
  });
  it("the same holds in the support dataset", () => {
    for (const l of LANES) {
      expect(accepted(DESK_SUPPORT, "Customer satisfaction fell.", l)).toBe(false);
      expect(accepted(DESK_SUPPORT, "Customer satisfaction may be worth a look.", l)).toBe(false);
      expect(accepted(DESK_SUPPORT, "CSAT may help.", l)).toBe(false);
      expect(accepted(DESK_CX, "Ticket volume may be worth a look.", l)).toBe(false);
      expect(accepted(DESK_CX, "Resolution time rose.", l)).toBe(false);
    }
  });
  it("generic words next to a restricted metric never rescue it", () => {
    for (const t of [
      "Marketing and sales should review revenue.",
      "Review the budget and recognized revenue.",
      "Sales and conversion rate may help.",
      "The sales team and closed deals may help.",
      "Budget, revenue and operations may help.",
      "Finance should look at recognized revenue.",
    ]) {
      for (const l of LANES) expect(accepted(LEADS_ONLY, t, l), `${l}: ${t}`).toBe(false);
    }
  });
  it("a hidden metric whose name contains a generic word is still a metric", () => {
    for (const l of LANES)
      for (const t of [
        "Marketing qualified leads may help.",
        "Sales conversion may help.",
        "The sales conversion rate may help.",
      ])
        expect(accepted(FINANCE, t, l), t).toBe(false);
    expect(
      strictEntities("marketing qualified leads", PROTOTYPE_CATALOG).map(
        (e) => `${e.kind}:${e.key}`,
      ),
    ).toEqual(["metric:mql_rate"]); // the longest phrase wins: no separate "marketing"
  });
});

const LEADS_GRANT = demoScope("leads+cac", "marketing", demoMetricPolicy(["leads"], ["cac"]), [
  "F-leads",
]);
const rejectedEverywhere = (sc: Scope, texts: string[]) => {
  for (const t of texts)
    for (const l of LANES) expect(accepted(sc, t, l), `${sc.name} · ${l} · ${t}`).toBe(false);
};
const acceptedEverywhere = (sc: Scope, texts: string[]) => {
  for (const t of texts)
    for (const l of LANES) expect(accepted(sc, t, l), `${sc.name} · ${l} · ${t}`).toBe(true);
};

describe("ambiguous phrases fail closed", () => {
  it("a generic department word next to a data-bearing noun is a reference to data about it", () => {
    rejectedEverywhere(LEADS_ONLY, [
      "Review the sales numbers.",
      "Sales performance may help.",
      "The sales team performance may help.",
      "The budget variance is unclear.",
      "Operations capacity may matter.",
      "Budget forecasts may help.",
      "Operations throughput may help.",
      "Finance totals may help.",
      "The sales rate may help.",
      "Sales targets may help.",
    ]);
    rejectedEverywhere(DESK_CX, [
      "Support volume may help.",
      "The service desk backlog numbers may help.",
    ]);
  });
  it("the data-noun window is two words on either side", () => {
    rejectedEverywhere(LEADS_ONLY, [
      "Review budget and variance later.",
      "Review the variance and budget later.",
      "Sales or targets may help.",
      "Revisit the quota for sales.",
      "Ask about sales and totals.",
    ]);
    acceptedEverywhere(LEADS_ONLY, ["Review budget ownership and owners later."]);
  });
  it("department words that name something carrying data are not generic", () => {
    rejectedEverywhere(LEADS_ONLY, [
      "The pipeline may help.",
      "The sales pipeline may help.",
      "Inventory may help.",
      "The ledger may help.",
      "The warehouse may help.",
      "Supply chain delays may help.",
      "Suppliers may help.",
    ]);
    rejectedEverywhere(FINANCE, [
      "Ad spend may help.",
      "Paid social may help.",
      "Paid media may help.",
    ]);
    acceptedEverywhere(FINANCE, ["Marketing may help.", "The campaign plan may help."]);
  });
  it("a directional claim about a hidden department is rejected whatever the wording", () => {
    rejectedEverywhere(LEADS_ONLY, [
      "Sales declined.",
      "Operations slowed.",
      "Sales are rising.",
      "Finance weakened.",
      "The budget fell.",
    ]);
    rejectedEverywhere(FINANCE, ["Marketing weakened.", "Operations slowed.", "Sales declined."]);
    rejectedEverywhere(DESK_SUPPORT, ["The customer experience deteriorated."]);
  });
  it("change or comparison language in the clause turns a generic department word into a statement about it", () => {
    rejectedEverywhere(LEADS_ONLY, [
      "Operations slowed.",
      "Sales lagged behind.",
      "Finance worsened.",
      "The budget grew.",
      "Sales are higher than expected.",
      "Operations recovered quickly.",
      "Sales and operations deteriorated.",
      "Sales outperformed the plan.",
      "The budget has doubled.",
    ]);
    rejectedEverywhere(FINANCE, [
      "Marketing outperformed.",
      "Sales lost ground.",
      "Operations are slower than before.",
    ]);
    rejectedEverywhere(DESK_SUPPORT, [
      "The customer experience deteriorated.",
      "The customer experience is weaker.",
    ]);
    acceptedEverywhere(LEADS_ONLY, [
      "Consider improving sales coordination.",
      "Sales and operations should follow up with each other.",
    ]); // imperatives and ordinary phrasing stay fine
  });
  it("a generic word that is also part of a restricted metric phrase is that metric", () => {
    rejectedEverywhere(FINANCE, [
      "Marketing qualified leads may help.",
      "Sales conversion may help.",
      "The sales conversion rate may help.",
    ]);
    expect(
      strictEntities("marketing qualified leads", PROTOTYPE_CATALOG).map(
        (e) => `${e.kind}:${e.key}`,
      ),
    ).toEqual(["metric:mql_rate"]);
  });
});

describe("inflections of restricted aliases are recognized (a gap the legacy matcher has)", () => {
  it("the legacy matcher misses them; the strict matcher finds them", () => {
    for (const t of ["revenues", "lead volumes", "recognized revenues"]) {
      expect(mentionedEntities(`Review ${t} next.`, PROTOTYPE_CATALOG), t).toEqual([]);
      expect(
        strictEntities(`review ${t} next.`, PROTOTYPE_CATALOG).some((e) => e.kind === "metric"),
        t,
      ).toBe(true);
    }
    for (const t of ["response times", "customer satisfactions", "ticket"]) {
      expect(mentionedEntities(`Review ${t} next.`, SUPPORT_DESK_CATALOG), t).toEqual([]);
      expect(
        strictEntities(`review ${t} next.`, SUPPORT_DESK_CATALOG).some((e) => e.kind === "metric"),
        t,
      ).toBe(true);
    }
  });
  it("plural, possessive and singular forms of hidden metrics are rejected in every lane", () => {
    rejectedEverywhere(LEADS_ONLY, [
      "Review revenues next.",
      "Revenue's trend may help.",
      "Recognized revenues may help.",
      "The deal may help.",
      "A closed deal may help.",
      "Closings may help.",
      "Backorders may help.",
      "Conversions may help.",
      "Fulfillments may help.",
    ]);
    rejectedEverywhere(FINANCE, [
      "Each lead may help.",
      "Lead volumes may help.",
      "Lead counts may help.",
      "New leads may help.",
      "Qualified leads may help.",
    ]);
    rejectedEverywhere(DESK_CX, [
      "Response times may help.",
      "Resolution times may help.",
      "Ticket volumes may help.",
      "A ticket may help.",
      "Tickets may help.",
      "Time to resolve may help.",
    ]);
    rejectedEverywhere(DESK_SUPPORT, [
      "Customer satisfactions may help.",
      "CSATs may help.",
      "CSAT's trend may help.",
    ]);
  });
  it("inflections of what the caller may discover stay mentionable", () => {
    acceptedEverywhere(FINANCE, ["Revenues may help.", "Recognized revenue's trend may help."]);
    acceptedEverywhere(DESK_CX, ["Customer satisfactions may help."]);
  });
  it("inflections of generic department words are generic too", () => {
    acceptedEverywhere(LEADS_ONLY, [
      "The sales teams may help.",
      "Budgets may help.",
      "Operational planning may help.",
    ]);
  });
});

describe("case, punctuation, spacing, hyphens and Unicode normalization", () => {
  it("restricted references stay rejected in every spelling", () => {
    rejectedEverywhere(LEADS_ONLY, [
      "RECOGNIZED REVENUE may help.",
      "Recognized-Revenue may help.",
      "recognized_revenue may help.",
      "Recognized   revenue may help.",
      "Recognized revenue may help.",
      "recogn​ized revenue may help.",
      "ＲＥＣＯＧＮＩＺＥＤ　ＲＥＶＥＮＵＥ may help.",
      "(revenue) may help.",
      "Revenue, in particular, may help.",
      "REVENUE!",
      "re­venue may help.",
      "Sales — conversion rate — may help.",
      "Customer\tacquisition\ncost may help.",
    ]);
  });
  it("generic words with punctuation, case and width variants stay accepted", () => {
    acceptedEverywhere(LEADS_ONLY, [
      "(Sales) and (budget) should meet.",
      "Sales, budget and operations should meet.",
      "SALES should meet BUDGET owners.",
      "ＳＡＬＥＳ should meet.",
      "Sa​les should meet.",
      "Operations -- and sales -- should meet.",
    ]);
  });
});

describe("unauthorized data stays rejected even beside generic words", () => {
  it("record ids, source labels and quantities", () => {
    rejectedEverywhere(LEADS_ONLY, [
      "Review the sales strategy and VH-FIN-001-Q2.",
      "Review VH-FIN-001-Q2 for context.",
      "See SYN-GL Revenue Summary for the budget.",
      "Review VH-MKT-001-Q2 and SYN-CRM Campaign Export.",
      "Sales rose 12 percent.",
      "Sales reached twelve percent.",
      "Marketing leads reached 4200 today.",
      "Review the sales strategy doubled.",
    ]);
  });
  it("links and commands beside generic words", () => {
    rejectedEverywhere(LEADS_ONLY, [
      "Review the sales strategy at https://evil.example now.",
      "Review the budget; run curl -s thing now.",
    ]);
  });
});

describe("discoverable metrics without verified data", () => {
  it("may be named to ask for evidence; no claim about them; their department-mates stay hidden; generic words still fine", () => {
    acceptedEverywhere(LEADS_GRANT, [
      "Customer acquisition cost data would help.",
      "Customer acquisition cost evidence is missing.",
      "The sales strategy and acquisition cost data would help.",
    ]);
    rejectedEverywhere(LEADS_GRANT, [
      "Customer acquisition cost rose.",
      "Lead quality may help.",
      "Lead quality data would help.",
    ]);
    expect(verdict(LEADS_GRANT, "Customer acquisition cost rose.", "interpretations")).toEqual({
      ok: false,
      diagnostics: ["unavailable"],
    });
  });
});

describe("the generic-vocabulary switch", () => {
  const scope = (o: Record<string, unknown>) =>
    semanticScope([], [], PROTOTYPE_CATALOG, {
      discoverable: ["leads"],
      strictMentions: true,
      ...o,
    } as never);
  const codes = (t: string, s: ReturnType<typeof scope>) =>
    checkSemantics(t, "gap", s, "gap 1").map((i) => i.code);
  it("only the exact boolean true enables it; every other value leaves strict mode as it was", () => {
    expect(codes("Review the sales strategy.", scope({ generalVocabulary: true }))).toEqual([]);
    for (const v of [false, undefined, "true", 1, null, {}, [], "yes", 0])
      expect(
        codes("Review the sales strategy.", scope({ generalVocabulary: v })),
        JSON.stringify(v),
      ).toEqual(["domain"]);
  });
  it("strict mentions without the switch (the H1/H2.2-level behaviour) is unchanged for department words", () => {
    expect(codes("The budget may help.", scope({}))).toEqual(["domain"]);
    expect(codes("Recognized revenue may help.", scope({ generalVocabulary: true }))).toEqual([
      "domain",
    ]);
  });
  it("a scope with no usable discoverable set never gets the exemption", () => {
    const { discoverable: _d, ...noSet } = scope({ generalVocabulary: true });
    void _d;
    expect(codes("Review the sales strategy.", noSet as never)).toEqual(["domain"]);
    expect(
      codes("Review the sales strategy.", {
        ...scope({ generalVocabulary: true }),
        discoverable: ["leads"] as unknown as ReadonlySet<string>,
      }),
    ).toEqual(["domain"]);
  });
  it("a catalog that declares no generic vocabulary gets no exemption even with the switch", () => {
    const plain: Catalog = {
      flatThresholdPct: 3,
      domains: PROTOTYPE_CATALOG.domains.map((d) => ({ id: d.id, aliases: [...d.aliases] })),
      metrics: PROTOTYPE_CATALOG.metrics.map((m) => ({ ...m, aliases: [...m.aliases] })),
    };
    assertCatalog(plain);
    const s = semanticScope([], [], plain, {
      discoverable: ["leads"],
      strictMentions: true,
      generalVocabulary: true,
    });
    expect(
      checkSemantics("Review the sales strategy.", "gap", s, "gap 1").map((i) => i.code),
    ).toEqual(["domain"]);
  });
  it("legacy mode (not strict) is unchanged: department words were never rejected there, and the legacy matcher is untouched", () => {
    const s = semanticScope([], [], PROTOTYPE_CATALOG, {
      discoverable: ["leads"],
      generalVocabulary: true,
    });
    expect(checkSemantics("Review the sales strategy.", "gap", s, "gap 1")).toEqual([]);
    expect(checkSemantics("Review revenues next.", "gap", s, "gap 1")).toEqual([]); // the legacy inflection gap is not changed here (documented)
  });
});

describe("catalog declaration of generic terms", () => {
  const cat = (generalTerms: unknown): Catalog => ({
    flatThresholdPct: 3,
    domains: [
      {
        id: "D",
        aliases: ["alpha", "beta pipeline"],
        ...(generalTerms === undefined ? {} : { generalTerms: generalTerms as string[] }),
      },
    ],
    metrics: [
      {
        key: "m",
        label: "M",
        domain: "D",
        unit: "u",
        polarity: "higher_is_better",
        aggregation: "sum",
        aliases: ["mmm"],
      },
    ],
  });
  it("must be a subset of the domain's own aliases, once each, as strings", () => {
    expect(validateCatalog(cat(["alpha"]))).toEqual([]);
    expect(validateCatalog(cat(undefined))).toEqual([]);
    expect(validateCatalog(cat(["mmm"]))).toEqual([
      expect.stringContaining('"mmm" of domain D is not one of its aliases'),
    ]); // a METRIC alias can never be declared generic
    expect(validateCatalog(cat(["gamma"]))).toEqual([
      expect.stringContaining("not one of its aliases"),
    ]);
    expect(validateCatalog(cat(["alpha", "alpha"]))).toEqual([expect.stringContaining("repeated")]);
    expect(validateCatalog(cat("alpha"))).toEqual([
      expect.stringContaining("generalTerms must be an array of strings"),
    ]);
    expect(validateCatalog(cat([1]))).toEqual([
      expect.stringContaining("generalTerms must be an array of strings"),
    ]);
    expect(() => assertCatalog(cat(["mmm"]))).toThrow(/Invalid catalog/);
  });
  it("the bundled catalogs declare only plain department words, and no data-bearing alias", () => {
    for (const c of [PROTOTYPE_CATALOG, SUPPORT_DESK_CATALOG]) {
      expect(validateCatalog(c)).toEqual([]);
      for (const d of c.domains)
        for (const t of d.generalTerms ?? []) expect(d.aliases).toContain(t);
    }
    const declared = PROTOTYPE_CATALOG.domains.flatMap((d) => [...(d.generalTerms ?? [])]);
    for (const dataBearing of [
      "pipeline",
      "sales pipeline",
      "inventory",
      "ledger",
      "warehouse",
      "logistics",
      "supply chain",
      "supplier",
      "suppliers",
      "ad spend",
      "ad spending",
      "paid social",
      "paid media",
    ])
      expect(declared).not.toContain(dataBearing);
    const metricAliases = new Set<string>(
      [...PROTOTYPE_CATALOG.metrics, ...SUPPORT_DESK_CATALOG.metrics].flatMap((m) => [
        ...m.aliases,
      ]),
    );
    for (const t of [
      ...declared,
      ...SUPPORT_DESK_CATALOG.domains.flatMap((d) => [...(d.generalTerms ?? [])]),
    ])
      expect(metricAliases.has(t)).toBe(false);
  });
  it("the catalog stays frozen", () => {
    expect(Object.isFrozen(PROTOTYPE_CATALOG.domains[0]!.generalTerms)).toBe(true);
  });
});

describe("public rejections stay byte-identical and nothing client-side can change the profile", () => {
  const PUBLIC = JSON.stringify({
    state: "rejected",
    reason: STRICT_REJECTION_REASON,
    requestSent: true,
  });
  const ENV = { META_MODEL_API_KEY: "sk-test-not-real", META_MODEL_ENABLED: "true" };
  const provider = (content: string): ModelProvider & { requests: unknown[] } => {
    const p = {
      requests: [] as unknown[],
      id: "fake",
      model: "fake-model",
      displayName: "Fake",
      status: () => ({ keyConfigured: true, ownerEnabled: true }),
      blockedCode: () => null,
      async complete(request: unknown) {
        p.requests.push(request);
        return {
          kind: "completion" as const,
          content,
          truncated: false,
          usage: { max_tokens_sent: 2000 },
        };
      },
    };
    return p;
  };
  const policy = demoMetricPolicy(["leads"]);
  const go = async (text: string, extra: object = {}) => {
    const p = provider(body(text, "interpretations", ["F-leads"]));
    const r = await runStrictAnalysis(
      { scenarioId: "baseline", roleId: "marketing", ownerConfirmed: true, ...extra },
      ENV,
      fetch,
      { ...PROTOTYPE_RUNTIME, policy: policy as AccessPolicy, provider: p },
    );
    return { r, p };
  };
  it("every new rejection class is the same response", async () => {
    const outs = new Set<string>();
    for (const t of [
      "Review revenues next.",
      "The deal may help.",
      "Review the sales numbers.",
      "The pipeline may help.",
      "Sales declined.",
      "Sales conversion may help.",
      "Review the sales strategy and VH-FIN-001-Q2.",
      "Recognized-Revenue may help.",
      "Sales rose 12 percent.",
    ]) {
      const { r } = await go(t);
      expect(r.state, t).toBe("rejected");
      outs.add(JSON.stringify(r));
    }
    expect([...outs]).toEqual([PUBLIC]);
  });
  it("generic business language is accepted end to end and the rest of the contract holds", async () => {
    const { r, p } = await go("Review the sales strategy with marketing.");
    expect(r.state).toBe("ok");
    expect(p.requests).toHaveLength(1);
    if (r.state === "ok") {
      expect(r.findings.map((f) => f.fact_id)).toEqual(["F-leads"]);
      expect(r.output.interpretations[0]).toMatchObject({
        verified: false,
        supporting_ids: ["VH-MKT-001-Q2", "VH-MKT-001-Q3"],
      });
    }
  });
  it("extra request fields cannot enable, disable or widen the vocabulary rules", async () => {
    for (const extra of [
      { generalVocabulary: false },
      { generalVocabulary: true },
      { strictMentions: false },
      { profile: "legacy" },
      { vocabulary: "all" },
      { generalTerms: ["revenue"] },
      { discoverableMetrics: ["revenue"] },
    ]) {
      expect(
        JSON.stringify((await go("Review revenues next.", extra)).r),
        JSON.stringify(extra),
      ).toBe(PUBLIC);
      expect((await go("Review the sales strategy.", extra)).r.state, JSON.stringify(extra)).toBe(
        "ok",
      );
    }
  });
  it("nothing outside the strict validator turns the exemption on, and nothing live imports the strict path", () => {
    const walk = (d: string): string[] =>
      readdirSync(d).flatMap((f) =>
        statSync(`${d}/${f}`).isDirectory() ? walk(`${d}/${f}`) : [`${d}/${f}`],
      );
    const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\/|(?<!:)\/\/[^\n]*/g, " ");
    const prod = walk("src").filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\./.test(f));
    const setters = prod.filter((f) =>
      /generalVocabulary\s*:\s*true/.test(strip(readFileSync(f, "utf8"))),
    );
    expect(setters).toEqual(["src/lib/athena/meta/strictValidation.ts"]);
    const live = prod.filter(
      (f) =>
        !/meta\/strict(Runtime|Validation|Vocabulary)\.ts$|meta\/(scopedPrompt|refConsistency)\.ts$/.test(f) &&
        /strictRuntime|runStrictAnalysis|validateStrictOutput|strictVocabulary|generalVocabulary/.test(
          strip(readFileSync(f, "utf8")),
        ),
    );
    expect(live.filter((f) => f !== "src/lib/athena/meta/semantic.ts")).toEqual([]); // semantic.ts only reads the option; it is not a caller
  });
});

describe("the legacy gate and legacy matching are unchanged", () => {
  it("the legacy validator still accepts what it always accepted (cross-department neutral mentions, an inflection)", () => {
    const a = LEADS_ONLY.auth;
    for (const t of [
      "Review the sales strategy.",
      "The budget may help.",
      "Review revenues next.",
    ]) {
      const v = validateAuthorizedOutput(
        body(t, "missing_evidence", ["F-leads"]),
        a.authorized,
        a.withheld,
        DEMO,
        { discoverable: a.discoverableMetrics },
      );
      expect(v.ok, t).toBe(true);
    }
    const v = validateAuthorizedOutput(
      body("Recognized revenue fell.", "interpretations", ["F-leads"]),
      a.authorized,
      a.withheld,
      DEMO,
      { discoverable: a.discoverableMetrics },
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors.join()).toMatch(/Semantic guard \(domain\)/); // legacy detail still available to the legacy path
  });
});
