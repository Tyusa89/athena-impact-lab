import { describe, expect, it, vi } from "vitest";
import { ROLES, SCENARIOS } from "../data";
import { computeFacts, describeChange } from "../engine";
import { factsBlockReason, runMeta } from "./adapter.server";
import { LIMITS, MAX_INPUT_TOKENS, OutputSchema, RESPONSE_FORMAT, authorizedRecords, buildMessages, estimateTokens, validateOutput } from "./contract";
import { renderFindings } from "./findings";
import { buildVerifiedFacts, uncoveredRecordIds } from "./numericGrounding";

// Phase 2B-1 three-lane contract. No network: fetch is always a local fake.
const READY = { META_MODEL_API_KEY: "test-key", META_MODEL_ENABLED: "true" };
const req = (roleId = "exec", scenarioId = "baseline") => ({ scenarioId, roleId, ownerConfirmed: true });
const mockFetch = (content: unknown) =>
  vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) }, finish_reason: "stop" }], usage: { prompt_tokens: 900, completion_tokens: 200 } }), { status: 200 }));
const lanes = (interp: string, refs: string[], rec = "Review the channel mix.") => ({
  interpretations: [{ text: interp, verified: false as const, refs }],
  missing_evidence: ["No attribution data by channel."],
  recommendations: [{ text: rec, requires_human_approval: true as const, refs }],
});
const run = (o: unknown, role = "exec", scenario = "baseline") => runMeta(req(role, scenario), READY, mockFetch(o) as never);
const rejected = async (o: unknown, role = "exec") => {
  const r = await run(o, role);
  return r.state === "rejected" ? r.errors.join(" | ") : `NOT REJECTED: ${r.state}`;
};

describe("verified findings are server-rendered, deterministic and independent of the model", () => {
  it("equal the engine's own computeFacts + describeChange for the authorized records", async () => {
    const r = await run(lanes("Demand may be shifting.", ["F-revenue"]));
    expect(r.state).toBe("ok");
    if (r.state !== "ok") return;
    const expected = computeFacts(authorizedRecords(req())).map((f) => ({ fact_id: `F-${f.metric}`, text: expect.stringContaining(describeChange(f)), supporting_ids: f.evidenceIds }));
    expect(r.findings).toMatchObject(expected);
    expect(r.findings.find((f) => f.fact_id === "F-revenue")!.text).toBe("Recognized revenue decreased: $1,240,000 → $1,018,000 (-17.9% relative)");
  });
  it("are identical whatever the model says, including contradictory prose", async () => {
    const a = await run(lanes("Demand may be shifting.", ["F-revenue"]));
    const b = await run(lanes("Revenue rose sharply and everything is improving.", ["F-revenue"]));
    expect(a.state === "ok" && b.state === "ok").toBe(true);
    if (a.state === "ok" && b.state === "ok") expect(b.findings).toEqual(a.findings);
  });
  it("never include model text, and model text never appears in the findings lane", async () => {
    const r = await run(lanes("UNIQUE-MODEL-SENTENCE may matter.", ["F-revenue"]));
    if (r.state !== "ok") throw new Error("expected ok");
    expect(JSON.stringify(r.findings)).not.toContain("UNIQUE-MODEL-SENTENCE");
    expect(r.output.interpretations[0]!.verified).toBe(false);
  });
  it("only cover the role's authorized metrics (finance sees revenue only; marketing sees no revenue)", async () => {
    const f = await run(lanes("Demand may be shifting.", ["F-revenue"]), "finance");
    if (f.state !== "ok") throw new Error("expected ok");
    expect(f.findings.map((x) => x.metric)).toEqual(["revenue"]);
    const m = await run(lanes("Mix may be shifting.", ["F-leads"]), "marketing");
    if (m.state !== "ok") throw new Error("expected ok");
    expect(m.findings.map((x) => x.metric)).not.toContain("revenue");
    expect(JSON.stringify(m.findings)).not.toMatch(/VH-FIN|VH-OPS/);
  });
  it("renderFindings is stable across calls and handles flat metrics", () => {
    const recs = authorizedRecords(req());
    expect(renderFindings(recs)).toEqual(renderFindings(recs));
    for (const s of SCENARIOS) for (const role of ROLES) for (const f of renderFindings(authorizedRecords(req(role.id, s.id)))) {
      expect(f.text).toMatch(/ (increased|decreased|was flat): /);
      expect(f.supporting_ids).toHaveLength(2);
    }
  });
});

describe("citations are derived server-side from referenced facts", () => {
  it("interpretations and recommendations get the exact supporting record ids of their refs", async () => {
    const r = await run(lanes("Mix may be shifting.", ["F-leads", "F-conversion_rate"]));
    if (r.state !== "ok") throw new Error("expected ok");
    const leads = r.findings.find((f) => f.fact_id === "F-leads")!.supporting_ids;
    const conv = r.findings.find((f) => f.fact_id === "F-conversion_rate")!.supporting_ids;
    expect(r.output.interpretations[0]!.supporting_ids).toEqual([...leads, ...conv]);
    expect(r.output.recommendations[0]!.supporting_ids).toEqual([...leads, ...conv]);
  });
  it("duplicate refs are collapsed", async () => {
    const r = await run(lanes("Mix may be shifting.", ["F-leads", "F-leads"]));
    if (r.state !== "ok") throw new Error("expected ok");
    expect(r.output.interpretations[0]!.refs).toEqual(["F-leads"]);
    expect(r.output.interpretations[0]!.supporting_ids).toHaveLength(2);
  });
  it("the model cannot supply its own citations", async () => {
    const o = lanes("Mix may be shifting.", ["F-leads"]) as any;
    o.interpretations[0].cited_ids = ["VH-MKT-001-Q2"];
    expect(await rejected(o)).toContain("Legacy response format rejected");
  });
});

describe("legacy (v1) response formats are rejected", () => {
  const legacyObs = { observations: [{ text: "Revenue fell between periods.", cited_ids: ["VH-FIN-001-Q3"], claims: [] }], hypotheses: [], missing_evidence: [], recommendations: [] };
  it("the full v1 shape, with or without claims", async () => {
    expect(await rejected(legacyObs)).toContain("Legacy response format rejected");
    expect(await rejected({ ...legacyObs, observations: [{ text: "Revenue fell.", cited_ids: ["VH-FIN-001-Q3"] }] })).toContain("Legacy response format rejected");
  });
  it("v1 hypotheses alone, or mixed into a v2 payload", async () => {
    const mixed = { ...lanes("Mix may be shifting.", ["F-leads"]), hypotheses: [{ text: "x", verified: false, cited_ids: ["VH-FIN-001-Q3"] }] };
    expect(await rejected(mixed)).toContain("Legacy response format rejected");
    expect(await rejected({ hypotheses: [], interpretations: [], missing_evidence: [], recommendations: [] })).toContain("Legacy response format rejected");
  });
  it("numeric claims on a v2 item", async () => {
    const o = lanes("Mix may be shifting.", ["F-leads"]) as any;
    o.recommendations[0].claims = [{ fact_id: "F-leads", metric: "leads", kind: "level", period: "current", value: 6300, unit: "leads" }];
    expect(await rejected(o)).toContain("Legacy response format rejected");
  });
  it("v1 and v2 fixtures are distinguished at the schema level too", () => {
    expect(OutputSchema.safeParse(legacyObs).success).toBe(false);
    expect(OutputSchema.safeParse({ interpretations: [], missing_evidence: [], recommendations: [] }).success).toBe(true);
  });
  it("a legacy rejection is a single request and is never retried", async () => {
    const f = mockFetch(legacyObs);
    const r = await runMeta(req(), READY, f as never);
    expect(r.state).toBe("rejected");
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe("wrong-subject and magnitude-by-number attacks are rejected (model text has no numerals)", () => {
  it.each([
    ["verified number on the wrong metric", "Conversion fell 17.9%.", ["F-conversion_rate"]],
    ["one verified value shared by two subjects", "Revenue and lead quality both fell 17.9%.", ["F-revenue", "F-mql_rate"]],
    ["invented percentage", "Revenue fell 40%.", ["F-revenue"]],
    ["a coincidental record value", "Revenue is 5.4.", ["F-revenue"]],
    ["a currency amount, even the real one", "Revenue is $1,018,000.", ["F-revenue"]],
  ])("%s", async (_n, text, refs) => {
    expect(await rejected(lanes(text, refs))).toContain("not allowed in model text");
  });
});

describe("unauthorized and malformed references are rejected", () => {
  it("finance cannot reference a marketing fact", async () => {
    expect(await rejected(lanes("Leads may matter.", ["F-leads"]), "finance")).toContain("Unknown or unauthorized fact reference: F-leads");
  });
  it("marketing cannot reference a finance fact", async () => {
    expect(await rejected(lanes("Revenue may matter.", ["F-revenue"]), "marketing")).toContain("Unknown or unauthorized fact reference: F-revenue");
  });
  it("one unauthorized ref among authorized ones rejects the item", async () => {
    expect(await rejected(lanes("Mix may matter.", ["F-revenue", "F-leads"]), "finance")).toContain("F-leads");
  });
  it("a record id is not a fact reference", async () => {
    expect(await rejected(lanes("Revenue may matter.", ["VH-FIN-001-Q3"]))).toContain("Unknown or unauthorized fact reference");
  });
  it("unknown fact ids, empty refs and too many refs fail", async () => {
    expect(await rejected(lanes("x may matter.", ["F-nope"]))).toContain("F-nope");
    expect((await run(lanes("x may matter.", []))).state).toBe("rejected");
    expect((await run(lanes("x may matter.", Array(LIMITS.refs + 1).fill("F-revenue")))).state).toBe("rejected");
  });
  it("a hidden record id or source label in text is still a cross-workspace leak", async () => {
    const hidden = SCENARIOS[0]!.records.find((r) => r.workspace === "ws-marketing")!;
    expect(await rejected(lanes(`See ${hidden.id} for context.`, ["F-revenue"]), "finance")).toContain("Cross-workspace leak");
    expect(await rejected(lanes(`Check ${hidden.source} data.`, ["F-revenue"]), "finance")).toContain("Cross-workspace leak");
  });
});

describe("lane safeguards preserved", () => {
  it("interpretations must be verified:false and recommendations must require human approval", async () => {
    const a = lanes("Mix may matter.", ["F-leads"]) as any; a.interpretations[0].verified = true;
    const b = lanes("Mix may matter.", ["F-leads"]) as any; b.recommendations[0].requires_human_approval = false;
    expect((await run(a)).state).toBe("rejected");
    expect((await run(b)).state).toBe("rejected");
  });
  it("causal-proof language is rejected in every lane; investigative wording only in actions and gaps", async () => {
    expect(await rejected(lanes("Delays caused the decline.", ["F-revenue"]))).toContain("Causal-proof");
    expect((await run(lanes("Mix may matter.", ["F-revenue"], "Investigate fulfillment delays and backorder causes promptly"))).state).toBe("ok");
    expect(await rejected(lanes("Possible causes include delays.", ["F-revenue"]))).toContain("Causal-proof");
  });
  it("extra keys are rejected (schema strictness)", async () => {
    expect((await run({ ...lanes("Mix may matter.", ["F-leads"]), execute: true })).state).toBe("rejected");
    const o = lanes("Mix may matter.", ["F-leads"]) as any; o.interpretations[0].confidence = 0.9;
    expect((await run(o)).state).toBe("rejected");
  });
  it("truncated output is still rejected", async () => {
    const t = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(lanes("ok.", ["F-leads"])) }, finish_reason: "length" }] })));
    expect((await runMeta(req(), READY, t as never)).state).toBe("rejected");
  });
  it("validateOutput stays a pure function returning findings with ok results only", () => {
    const authorized = authorizedRecords(req("finance"));
    const all = SCENARIOS[0]!.records;
    const good = validateOutput(JSON.stringify(lanes("Demand may shift.", ["F-revenue"])), authorized, all);
    expect(good.ok && good.findings.length).toBe(1);
    const bad = validateOutput("{}", authorized, all);
    expect(bad.ok).toBe(false);
    expect("findings" in bad).toBe(false);
  });
});

describe("facts-only prompt: evidence sufficiency", () => {
  it("every authorized record is represented by exactly one verified fact, for every scenario and role", () => {
    for (const s of SCENARIOS) for (const role of ROLES) {
      const recs = authorizedRecords(req(role.id, s.id));
      const facts = buildVerifiedFacts(recs);
      expect(uncoveredRecordIds(recs, facts)).toEqual([]);
      const ids = facts.flatMap((f) => [f.prior.id, f.current.id]);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.sort()).toEqual(recs.map((r) => r.id).sort());
    }
  });
  it("facts preserve metric, period, value, unit and department of every record; dates are constant per period", () => {
    for (const s of SCENARIOS) for (const role of ROLES) {
      const recs = authorizedRecords(req(role.id, s.id));
      const byId = new Map(recs.map((r) => [r.id, r]));
      for (const f of buildVerifiedFacts(recs)) for (const side of ["prior", "current"] as const) {
        const r = byId.get(f[side].id)!;
        expect([r.metric, r.period, r.value, r.unit, r.department]).toEqual([f.metric, side, f[side].value, f.unit, f.department]);
      }
      expect(new Set(recs.filter((r) => r.period === "prior").map((r) => r.date)).size).toBeLessThanOrEqual(1);
      expect(new Set(recs.filter((r) => r.period === "current").map((r) => r.date)).size).toBeLessThanOrEqual(1);
    }
  });
  it("the prompt sends facts and period dates, no raw record rows, and keeps provenance ids", () => {
    const recs = authorizedRecords(req());
    const user = buildMessages("q", recs)[1]!.content;
    expect(user).toContain("VERIFIED_FACTS");
    expect(user).toContain("PERIODS");
    expect(user).not.toContain("Records (JSON)");
    for (const r of recs) expect(user).toContain(r.id);
    for (const r of recs) { expect(user).not.toContain(r.source); if (r.note) expect(user).not.toContain(r.note); }
  });
  it("the prompt never includes hidden facts or hidden record ids, for every role and scenario", () => {
    for (const s of SCENARIOS) for (const role of ROLES) {
      const recs = authorizedRecords(req(role.id, s.id));
      const user = buildMessages("q", recs)[1]!.content;
      const allowed = new Set(recs.map((r) => r.id));
      for (const r of s.records) if (!allowed.has(r.id)) expect(user).not.toContain(r.id);
      for (const m of new Set(s.records.map((r) => r.metric))) if (!buildVerifiedFacts(recs).some((f) => f.metric === m)) expect(user).not.toContain(`F-${m}`);
    }
  });
  it("tells the model to write no digits and to reference fact ids", () => {
    const sys = buildMessages("q", authorizedRecords(req()))[0]!.content;
    expect(sys).toMatch(/NEVER write any digit/);
    expect(sys).toMatch(/refs/);
  });
  it("input stays well under the token budget for every role x scenario", () => {
    for (const s of SCENARIOS) for (const role of ROLES) {
      expect(estimateTokens(JSON.stringify(buildMessages("q", authorizedRecords(req(role.id, s.id)))))).toBeLessThan(MAX_INPUT_TOKENS);
    }
  });
  it("the adapter blocks (nothing sent) when evidence cannot be fully represented as facts, and allows complete evidence", () => {
    const r = (id: string, period: "prior" | "current", value: number) => ({ id, department: "Sales" as const, workspace: "ws-sales", date: "d", source: "s", metric: "closed_deals" as const, period, value, unit: "deals" });
    expect(factsBlockReason([])).toMatch(/no verified facts/);
    expect(factsBlockReason([r("A-Q3", "current", 1)])).toMatch(/no verified facts/);
    expect(factsBlockReason([r("A-Q2", "prior", 1), r("A-Q3", "current", 2), { ...r("B-Q3", "current", 3), metric: "leads" as const, unit: "leads" }])).toMatch(/1 record\(s\) unpaired/);
    expect(factsBlockReason([r("A-Q2", "prior", 1), r("A-Q3", "current", 2)])).toBeNull();
    for (const s of SCENARIOS) for (const role of ROLES) expect(factsBlockReason(authorizedRecords(req(role.id, s.id)))).toBeNull();
  });
});

describe("request format", () => {
  it("response_format is the v2 three-lane schema with no observations, claims or cited_ids", () => {
    const fmt = RESPONSE_FORMAT.json_schema;
    expect(fmt.name).toBe("AthenaAnalysisV2");
    expect(fmt.schema.required).toEqual(["interpretations", "missing_evidence", "recommendations"]);
    expect(JSON.stringify(fmt)).not.toMatch(/observations|hypotheses|claims|cited_ids/);
  });
  it("the body sent still carries the hard cap, minimal reasoning and stream:false", async () => {
    const f = mockFetch(lanes("Mix may matter.", ["F-leads"]));
    await runMeta(req(), READY, f as never);
    const body = JSON.parse((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.max_tokens).toBe(2000);
    expect(body.reasoning_effort).toBe("minimal");
    expect(body.stream).toBe(false);
    expect(body.response_format.json_schema.name).toBe("AthenaAnalysisV2");
  });
});

// Documented semantic limitations. These pin CURRENT behaviour so Phase 2B-2 (lexicon guards) flips them deliberately.
describe("KNOWN LIMITATIONS (not guarded until Phase 2B-2)", () => {
  it("contradictory prose inside an interpretation is accepted, but stays unverified and cannot alter the verified findings", async () => {
    const r = await run(lanes("Revenue rose sharply.", ["F-revenue"]));
    expect(r.state).toBe("ok");
    if (r.state !== "ok") return;
    expect(r.output.interpretations[0]!.verified).toBe(false);
    const rev = r.findings.find((f) => f.fact_id === "F-revenue")!;
    expect(rev.direction).toBe("down");
    expect(rev.text).toContain("decreased");
  });
  it.each([
    ["spelled-out number", "Revenue fell forty percent."],
    ["magnitude word", "Revenue doubled."],
    ["fraction word", "Revenue halved versus the prior period."],
    ["CJK numeral", "Revenue fell 四十."],
  ])("%s is not yet rejected", async (_n, text) => {
    expect((await run(lanes(text, ["F-revenue"]))).state).toBe("ok");
  });
  it("prose about an unauthorized domain is not yet rejected (finance mentioning lead volume)", async () => {
    expect((await run(lanes("Lead volume may be rising while conversion softens.", ["F-revenue"]), "finance")).state).toBe("ok");
  });
});
