import { describe, expect, it, vi } from "vitest";
import { ROLES, SCENARIOS, type EvidenceRecord } from "../data";
import { runMeta } from "./adapter.server";
import { LIMITS, MAX_INPUT_TOKENS, RESPONSE_FORMAT, authorizedRecords, buildMessages, estimateTokens, validateOutput } from "./contract";
import { buildVerifiedFacts, nonAsciiNumerics, numericTokens, type Claim } from "./numericGrounding";

// No network: fetch is always a local fake.
const READY = { META_MODEL_API_KEY: "test-key", META_MODEL_ENABLED: "true" };
const req = (roleId = "exec", scenarioId = "baseline") => ({ scenarioId, roleId, ownerConfirmed: true });
const reply = (content: unknown) =>
  vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) }, finish_reason: "stop" }], usage: { prompt_tokens: 500, completion_tokens: 200 } }), { status: 200 }));

const recs = (role = "exec", scenario = "baseline") => authorizedRecords(req(role, scenario));
const factOf = (role: string, metric: string) => buildVerifiedFacts(recs(role)).find((f) => f.metric === metric)!;

const output = (text: string, cited: string[], claims: unknown[] | undefined) => ({
  observations: [{ text, cited_ids: cited, ...(claims ? { claims } : {}) }],
  hypotheses: [],
  missing_evidence: [] as string[],
  recommendations: [],
});
const run = async (o: unknown, role = "exec") => runMeta(req(role), READY, reply(o) as never);
const errorsOf = async (o: unknown, role = "exec") => {
  const r = await run(o, role);
  return r.state === "rejected" ? r.errors.join(" | ") : r.state;
};

// Correct building blocks (baseline × exec): revenue 1,240,000 → 1,018,000 USD, −17.9% ; conversion 9.5 → 5.4 %, −4.1 pp.
const rev = () => factOf("exec", "revenue");
const conv = () => factOf("exec", "conversion_rate");
const revLevel = (over: Partial<Claim> = {}): Claim => ({ fact_id: "F-revenue", metric: "revenue", kind: "level", period: "current", value: 1_018_000, unit: "USD", ...over });
const revPct = (over: Partial<Claim> = {}): Claim => ({ fact_id: "F-revenue", metric: "revenue", kind: "change_pct", value: -17.9, unit: "%", direction: "down", ...over });

describe("verified facts", () => {
  it("are computed from authorized records with exact supporting ids", () => {
    const f = rev();
    expect(f).toMatchObject({ fact_id: "F-revenue", metric: "revenue", unit: "USD", change_pct: -17.9, change_pp: null, direction: "down" });
    expect(f.prior).toEqual({ id: "VH-FIN-001-Q2", value: 1_240_000 });
    expect(f.current).toEqual({ id: "VH-FIN-001-Q3", value: 1_018_000 });
    expect(conv()).toMatchObject({ change_pct: -43.2, change_pp: -4.1, direction: "down" });
  });
  it("exist only for the role's authorized metrics (finance sees revenue only)", () => {
    expect(buildVerifiedFacts(recs("finance")).map((f) => f.metric)).toEqual(["revenue"]);
  });
});

describe("correct claims are accepted (end to end)", () => {
  it("level claim for the current period", async () => {
    expect((await run(output("Revenue was $1,018,000 in Q3 2026.", [rev().current.id], [revLevel()]))).state).toBe("ok");
  });
  it("level claim for the prior period", async () => {
    const c = revLevel({ period: "prior", value: 1_240_000 });
    expect((await run(output("Prior revenue was 1,240,000 USD.", [rev().prior.id], [c]))).state).toBe("ok");
  });
  it("relative change claim", async () => {
    expect((await run(output("Revenue fell 17.9%.", [rev().prior.id, rev().current.id], [revPct()]))).state).toBe("ok");
  });
  it("percentage-point change claim", async () => {
    const c: Claim = { fact_id: "F-conversion_rate", metric: "conversion_rate", kind: "change_pp", value: -4.1, unit: "pp", direction: "down" };
    expect((await run(output("Conversion moved 4.1 pp lower.", [conv().prior.id, conv().current.id], [c]))).state).toBe("ok");
  });
  it("record ids and period labels in text are not treated as numeric claims", async () => {
    const r = await run(output(`See ${rev().current.id}: revenue in Q3 2026 declined.`, [rev().current.id], []));
    expect(r.state).toBe("ok");
  });
  it("claims omitted entirely (old shape) still validates and defaults to []", async () => {
    const r = await run(output("Revenue declined between periods.", [rev().current.id], undefined));
    expect(r.state).toBe("ok");
    if (r.state === "ok") expect(r.output.observations[0]!.claims).toEqual([]);
  });
  it("hypotheses and recommendations are grounded the same way", async () => {
    const ids = [rev().prior.id, rev().current.id];
    const o = {
      observations: [],
      hypotheses: [{ text: "Revenue of -17.9% may relate to demand.", verified: false, cited_ids: ids, claims: [revPct()] }],
      missing_evidence: [],
      recommendations: [{ text: "Re-forecast given the 17.9% decline.", requires_human_approval: true, cited_ids: ids, claims: [revPct()] }],
    };
    expect((await run(o)).state).toBe("ok");
    o.recommendations[0]!.claims = [revPct({ value: -19.9 })];
    expect(await errorsOf(o)).toContain("does not match verified");
  });
});

describe("invented or unsupported numbers are rejected", () => {
  it("invented percentage in a claim", async () => {
    expect(await errorsOf(output("Revenue fell 40%.", [rev().prior.id, rev().current.id], [revPct({ value: -40 })]))).toContain("does not match verified -17.9");
  });
  it("number in text with no claim at all (fails closed)", async () => {
    expect(await errorsOf(output("Revenue fell 40%.", [rev().current.id], []))).toContain("Unsupported number 40");
  });
  it("number in text that differs from the claim's value", async () => {
    expect(await errorsOf(output("Revenue fell 25%.", [rev().prior.id, rev().current.id], [revPct()]))).toContain("Unsupported number 25");
  });
  it("numbers in missing_evidence are rejected (no claim structure exists there)", async () => {
    const o = output("Revenue declined.", [rev().current.id], []);
    o.missing_evidence = ["Need 3 more quarters of data."];
    expect(await errorsOf(o)).toContain("Unsupported number 3");
  });
  it("unknown fact id", async () => {
    expect(await errorsOf(output("x.", [rev().current.id], [revLevel({ fact_id: "F-nope" })]))).toContain("unknown or unauthorized fact");
  });
  it("claim with extra keys or non-numeric value fails the schema", async () => {
    expect((await run(output("x.", [rev().current.id], [{ ...revLevel(), note: "hi" }]))).state).toBe("rejected");
    expect((await run(output("x.", [rev().current.id], [{ ...revLevel(), value: "1018000" }]))).state).toBe("rejected");
    expect((await run(output("x.", [rev().current.id], Array(LIMITS.claims + 1).fill(revLevel())))).state).toBe("rejected");
  });
  it("undefined change is not claimable (prior value 0)", () => {
    const zero: EvidenceRecord[] = [
      { id: "Z-Q2", department: "Sales", workspace: "ws-sales", date: "2026-06-30", source: "s", metric: "closed_deals", period: "prior", value: 0, unit: "deals" },
      { id: "Z-Q3", department: "Sales", workspace: "ws-sales", date: "2026-09-30", source: "s", metric: "closed_deals", period: "current", value: 5, unit: "deals" },
    ];
    const c: Claim = { fact_id: "F-closed_deals", metric: "closed_deals", kind: "change_pct", value: 100, unit: "%", direction: "up" };
    const o = JSON.stringify(output("Deals rose.", ["Z-Q2", "Z-Q3"], [c]));
    const v = validateOutput(o, zero, zero);
    expect(v.ok).toBe(false);
  });
});

describe("wrong metric, period, unit, direction", () => {
  const ids = () => [rev().prior.id, rev().current.id];
  it("wrong metric on the claim", async () => {
    expect(await errorsOf(output("x.", ids(), [revLevel({ metric: "leads" })]))).toContain("wrong metric");
  });
  it("right value but attributed to another metric's fact", async () => {
    const c: Claim = { fact_id: "F-leads", metric: "leads", kind: "level", period: "current", value: 1_018_000, unit: "leads" };
    expect(await errorsOf(output("x.", ids(), [c]))).toContain("does not match current 6300");
  });
  it("wrong period (prior value presented as current)", async () => {
    expect(await errorsOf(output("x.", ids(), [revLevel({ value: 1_240_000 })]))).toContain("does not match current 1018000");
    expect(await errorsOf(output("x.", ids(), [revLevel({ period: "prior" })]))).toContain("does not match prior 1240000");
  });
  it("missing period on a level claim, and period on a change claim", async () => {
    const { period: _p, ...noPeriod } = revLevel();
    expect(await errorsOf(output("x.", ids(), [noPeriod]))).toContain("period required");
    expect(await errorsOf(output("x.", ids(), [revPct({ period: "current" })]))).toContain("period not allowed");
  });
  it("mismatched units", async () => {
    expect(await errorsOf(output("x.", ids(), [revLevel({ unit: "%" })]))).toContain("unit % does not match USD");
    expect(await errorsOf(output("x.", ids(), [revPct({ unit: "pp" })]))).toContain("unit pp does not match %");
    expect(await errorsOf(output("x.", ids(), [revPct({ unit: "USD" })]))).toContain("does not match %");
  });
  it("percentage-point change is undefined for non-percent metrics", async () => {
    expect(await errorsOf(output("x.", ids(), [revPct({ kind: "change_pp", unit: "pp" })]))).toContain("change not defined");
  });
  it("incorrect direction, and missing direction on a change claim", async () => {
    expect(await errorsOf(output("Revenue rose 17.9%.", ids(), [revPct({ direction: "up" })]))).toContain("direction up does not match verified down");
    const { direction: _d, ...none } = revPct();
    expect(await errorsOf(output("x.", ids(), [none]))).toContain("direction required");
  });
  it("direction on a level claim is rejected", async () => {
    expect(await errorsOf(output("x.", ids(), [revLevel({ direction: "down" })]))).toContain("direction not allowed");
  });
});

describe("citations must be the fact's exact supporting records", () => {
  it("authorized-but-wrong record cited for the claim", async () => {
    const other = recs("exec").find((r) => r.metric === "leads")!.id;
    expect(await errorsOf(output("Revenue was 1,018,000 USD.", [other], [revLevel()]))).toContain(`must cite supporting record ${rev().current.id}`);
  });
  it("prior record cited for a current-period claim", async () => {
    expect(await errorsOf(output("Revenue was 1,018,000 USD.", [rev().prior.id], [revLevel()]))).toContain(`must cite supporting record ${rev().current.id}`);
  });
  it("change claim must cite both periods", async () => {
    expect(await errorsOf(output("Revenue fell 17.9%.", [rev().current.id], [revPct()]))).toContain(`must cite supporting record ${rev().prior.id}`);
  });
  it("extra citations beyond the supporting records are still allowed", async () => {
    const extra = recs("exec").find((r) => r.metric === "leads")!.id;
    expect((await run(output("Revenue fell 17.9%.", [rev().prior.id, rev().current.id, extra], [revPct()]))).state).toBe("ok");
  });
});

describe("a coincidentally matching value does not validate an unrelated claim", () => {
  it("conversion's current 5.4 presented as revenue", async () => {
    expect(await errorsOf(output("Revenue was 5.4.", [rev().current.id, conv().current.id], [revLevel({ value: 5.4 })]))).toContain("does not match current 1018000");
  });
  it("same number in text, backed by a claim for a different fact, is not enough for the right fact", async () => {
    // 5.4 matches conversion_rate current, but the claim presented is the revenue fact → value check fails.
    expect(await errorsOf(output("Figure 5.4.", [rev().current.id], [revLevel({ value: 5.4 })]))).toContain("Claim F-revenue/level");
  });
  it("coincidental number in text with no claim is rejected even though a record holds it", async () => {
    expect(await errorsOf(output("Conversion is 5.4%.", [conv().current.id], []))).toContain("Unsupported number 5.4");
  });
});

describe("rounding and flat boundaries (engine's rounded values are canonical)", () => {
  const mk = (prior: number, current: number): EvidenceRecord[] => [
    { id: "B-Q2", department: "Sales", workspace: "ws-sales", date: "2026-06-30", source: "s", metric: "closed_deals", period: "prior", value: prior, unit: "deals" },
    { id: "B-Q3", department: "Sales", workspace: "ws-sales", date: "2026-09-30", source: "s", metric: "closed_deals", period: "current", value: current, unit: "deals" },
  ];
  const check = (records: EvidenceRecord[], value: number, direction: Claim["direction"]) => {
    const c: Claim = { fact_id: "F-closed_deals", metric: "closed_deals", kind: "change_pct", value, unit: "%", direction };
    return validateOutput(JSON.stringify(output("Deals changed.", ["B-Q2", "B-Q3"], [c])), records, records);
  };
  it("accepts exactly the engine-rounded value, rejects the unrounded or off-by-0.1 value", () => {
    const r = mk(300, 311); // +3.666…% → 3.7
    expect(buildVerifiedFacts(r)[0]!.change_pct).toBe(3.7);
    expect(check(r, 3.7, "up").ok).toBe(true);
    expect(check(r, 3.67, "up").ok).toBe(false);
    expect(check(r, 3.6, "up").ok).toBe(false);
    expect(check(r, 3.8, "up").ok).toBe(false);
  });
  it("2.9% is flat (below the 3% threshold): 'up' is rejected, 'flat' accepted", () => {
    const r = mk(1000, 1029);
    expect(buildVerifiedFacts(r)[0]!.direction).toBe("flat");
    expect(check(r, 2.9, "up").ok).toBe(false);
    expect(check(r, 2.9, "flat").ok).toBe(true);
  });
  it("exactly 3.0% is up: 'flat' is rejected, 'up' accepted", () => {
    const r = mk(1000, 1030);
    expect(buildVerifiedFacts(r)[0]!.direction).toBe("up");
    expect(check(r, 3, "flat").ok).toBe(false);
    expect(check(r, 3, "up").ok).toBe(true);
  });
});

describe("missing periods", () => {
  it("a metric with only a current record has no fact, so any claim on it fails closed", () => {
    const only: EvidenceRecord[] = [{ id: "M-Q3", department: "Sales", workspace: "ws-sales", date: "2026-09-30", source: "s", metric: "closed_deals", period: "current", value: 5, unit: "deals" }];
    expect(buildVerifiedFacts(only)).toEqual([]);
    const c: Claim = { fact_id: "F-closed_deals", metric: "closed_deals", kind: "level", period: "current", value: 5, unit: "deals" };
    const v = validateOutput(JSON.stringify(output("Five deals closed.", ["M-Q3"], [c])), only, only);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors.join()).toContain("unknown or unauthorized fact");
  });
  it("duplicate periods are ambiguous: no fact (existing computeFacts rule)", () => {
    const dup: EvidenceRecord[] = [
      ...["a", "b"].map((s) => ({ id: `D-${s}-Q2`, department: "Sales" as const, workspace: "ws-sales", date: "2026-06-30", source: "s", metric: "closed_deals" as const, period: "prior" as const, value: 1, unit: "deals" })),
      { id: "D-Q3", department: "Sales", workspace: "ws-sales", date: "2026-09-30", source: "s", metric: "closed_deals", period: "current", value: 2, unit: "deals" },
    ];
    expect(buildVerifiedFacts(dup)).toEqual([]);
  });
});

describe("role-restricted records", () => {
  it("finance cannot make a claim about a marketing metric (no such fact is authorized)", async () => {
    const c: Claim = { fact_id: "F-leads", metric: "leads", kind: "level", period: "current", value: 6300, unit: "leads" };
    const leadId = SCENARIOS[0]!.records.find((r) => r.metric === "leads" && r.period === "current")!.id;
    const errs = await errorsOf(output("Leads were 6300.", [leadId], [c]), "finance");
    expect(errs).toContain("Unsupported citation");
    expect(errs).toContain("unknown or unauthorized fact");
  });
  it("a hidden metric's claim is rejected even when it cites only authorized records", async () => {
    const c: Claim = { fact_id: "F-leads", metric: "leads", kind: "level", period: "current", value: 6300, unit: "leads" };
    const finId = recs("finance")[0]!.id;
    expect(await errorsOf(output("Leads were 6300.", [finId], [c]), "finance")).toContain("unknown or unauthorized fact");
  });
  it("the prompt's VERIFIED_FACTS block contains only the role's metrics and never hidden ids or values", () => {
    const sent = buildMessages("q", recs("finance"))[1]!.content;
    expect(sent).toContain("VERIFIED_FACTS");
    expect(sent).toContain("F-revenue");
    for (const m of ["leads", "conversion_rate", "mql_rate", "fulfillment_days"]) expect(sent).not.toContain(`F-${m}`);
    for (const r of SCENARIOS[0]!.records.filter((x) => x.workspace !== "ws-finance")) expect(sent).not.toContain(r.id);
  });
  it("finance can still make a correct claim about its own metric", async () => {
    const f = factOf("finance", "revenue");
    expect((await run(output("Revenue fell 17.9%.", [f.prior.id, f.current.id], [revPct()]), "finance")).state).toBe("ok");
  });
});

describe("contract and budget safeguards preserved", () => {
  it("input stays under the token budget for every role × scenario (no request blocked by the facts block)", () => {
    for (const s of SCENARIOS) for (const role of ROLES) {
      const msgs = buildMessages("q", authorizedRecords(req(role.id, s.id)));
      expect(estimateTokens(JSON.stringify(msgs))).toBeLessThan(MAX_INPUT_TOKENS);
    }
  });
  it("the response format sent to the model requires claims on every item", () => {
    const p = RESPONSE_FORMAT.json_schema.schema.properties;
    for (const k of ["observations", "hypotheses", "recommendations"] as const) {
      expect(p[k].items.required).toContain("claims");
      expect(p[k].items.properties.claims.maxItems).toBe(LIMITS.claims);
    }
  });
  it("truncation, human approval and verified:false rules still apply alongside claims", async () => {
    const t = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "{}" }, finish_reason: "length" }] })));
    expect((await runMeta(req(), READY, t as never)).state).toBe("rejected");
    const o = { ...output("x.", [rev().current.id], []), recommendations: [{ text: "Review.", requires_human_approval: false, cited_ids: [rev().current.id], claims: [] }] };
    expect((await run(o)).state).toBe("rejected");
  });
  it("one request only: a grounding rejection is never retried", async () => {
    const f = reply(output("Revenue fell 40%.", [rev().current.id], []));
    const r = await runMeta(req(), READY, f as never);
    expect(r.state).toBe("rejected");
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe("numericTokens", () => {
  it("ignores record ids, quarter labels and years; strips thousands separators; ignores sign", () => {
    expect(numericTokens("VH-FIN-001-Q3 in Q3 2026: $1,018,000 and -17.9%", ["VH-FIN-001-Q3"])).toEqual([1018000, 17.9]);
  });
});

// Unicode numeric bypass regression (found by the offline evaluation). Escapes are used so the characters survive editors.
const FULLWIDTH_40 = "\uFF14\uFF10"; // ４０
const ARABIC_INDIC_40 = "\u0664\u0660"; // ٤٠
const VULGAR_HALF = "\u00BD"; // ½
describe("Unicode numeric expressions cannot bypass the structured-claim requirement", () => {
  const ids = () => [rev().prior.id, rev().current.id];
  it("full-width digits are folded by NFKC and then treated as an unbacked number", async () => {
    expect(await errorsOf(output(`Revenue fell ${FULLWIDTH_40}%.`, ids(), []))).toContain("Unsupported number 40");
  });
  it("Arabic-Indic digits are rejected outright", async () => {
    expect(await errorsOf(output(`Revenue fell ${ARABIC_INDIC_40}%.`, ids(), []))).toContain("Non-ASCII numeric character");
  });
  it("Unicode fractions are folded and rejected as unbacked numbers", async () => {
    expect(await errorsOf(output(`Revenue fell by ${VULGAR_HALF}.`, ids(), []))).toContain("Unsupported number");
  });
  it.each([
    ["Devanagari digits", "\u096A\u0966"],
    ["Bengali digits", "\u09EA\u09E6"],
    ["Thai digits", "\u0E54\u0E50"],
    ["math bold digits", "\u{1D7D2}\u{1D7CE}"],
    ["circled digit", "\u2463"],
    ["superscript digits", "\u2074\u2070"],
    ["vulgar fraction three quarters", "\u00BE"],
  ])("%s are rejected", async (_n, digits) => {
    expect((await run(output(`Revenue fell ${digits}%.`, ids(), []))).state).toBe("rejected");
  });
  it("a non-ASCII numeral is rejected even when its value equals a claim's value (fail closed, no interpretation)", async () => {
    const arabic179 = "\u0661\u0667\u066B\u0669"; // ١٧٫٩
    expect(await errorsOf(output(`Revenue fell ${arabic179}%.`, ids(), [revPct()]))).toContain("Non-ASCII numeric character");
  });
  it("an extra non-ASCII numeral next to a legitimately backed ASCII number is rejected", async () => {
    expect((await run(output(`Revenue fell 17.9% (${ARABIC_INDIC_40}).`, ids(), [revPct()]))).state).toBe("rejected");
  });
  it("a zero-width character cannot split or hide a full-width number", async () => {
    expect((await run(output("Revenue fell \uFF14\u200B\uFF10%.", ids(), []))).state).toBe("rejected");
  });
  it("applies to every text field: hypotheses, recommendations and missing_evidence", async () => {
    const base = output("Revenue declined.", ids(), []);
    const hyp = { ...base, observations: [], hypotheses: [{ text: `Demand fell ${ARABIC_INDIC_40}%.`, verified: false, cited_ids: ids(), claims: [] }] };
    const recm = { ...base, observations: [], recommendations: [{ text: `Cut ${ARABIC_INDIC_40}% of spend.`, requires_human_approval: true, cited_ids: ids(), claims: [] }] };
    const miss2 = { ...base, missing_evidence: [`Need ${ARABIC_INDIC_40} records.`] };
    for (const o of [hyp, recm, miss2]) expect((await run(o)).state).toBe("rejected");
  });
  it("a full-width spelling of a claim-backed number is NFKC-equivalent to the ASCII number and is accepted", async () => {
    const fw = "\uFF11\uFF17\uFF0E\uFF19"; // １７．９
    expect((await run(output(`Revenue fell ${fw}%.`, ids(), [revPct()]))).state).toBe("ok");
  });
});

describe("existing valid ASCII claims and intentional exemptions are unchanged", () => {
  const ids = () => [rev().prior.id, rev().current.id];
  it("valid ASCII level and change claims still pass", async () => {
    expect((await run(output("Revenue was $1,018,000 in Q3 2026.", [rev().current.id], [revLevel()]))).state).toBe("ok");
    expect((await run(output("Revenue fell 17.9%.", ids(), [revPct()]))).state).toBe("ok");
  });
  it("record ids, quarter labels and years remain exempt", async () => {
    expect((await run(output(`Between Q2 and Q3 2026 (${rev().prior.id}, ${rev().current.id}) revenue declined.`, ids(), []))).state).toBe("ok");
  });
  it("full-width quarter and year labels are folded and remain exempt", async () => {
    expect((await run(output("Revenue declined in \uFF31\uFF13 \uFF12\uFF10\uFF12\uFF16.", ids(), []))).state).toBe("ok");
  });
  it("a non-ASCII digit in a quarter label is NOT exempt", async () => {
    expect((await run(output("Revenue declined in Q\u0663.", ids(), []))).state).toBe("rejected");
  });
  it("the strict duration rule is unchanged (ASCII and full-width)", async () => {
    expect(await errorsOf({ ...output("x.", ids(), []), observations: [], recommendations: [{ text: "Run a 2-week test.", requires_human_approval: true, cited_ids: ids(), claims: [] }] })).toContain("Unsupported number 2");
    expect(await errorsOf({ ...output("x.", ids(), []), observations: [], recommendations: [{ text: "Run a \uFF12-week test.", requires_human_approval: true, cited_ids: ids(), claims: [] }] })).toContain("Unsupported number 2");
  });
  it("nonAsciiNumerics ignores ASCII, ids and exempt labels and lists leftover non-ASCII numerals", () => {
    expect(nonAsciiNumerics("17.9% in Q3 2026, VH-FIN-001-Q3", ["VH-FIN-001-Q3"])).toEqual([]);
    expect(nonAsciiNumerics(`fell ${ARABIC_INDIC_40}%`, [])).toEqual(["\u0664", "\u0660"]);
    expect(numericTokens(`fell ${FULLWIDTH_40}% and ${VULGAR_HALF}`, [])).toEqual([40, 1, 2]);
  });
});
