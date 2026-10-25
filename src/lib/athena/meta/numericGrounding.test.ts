import { describe, expect, it, vi } from "vitest";
import { SCENARIOS, type EvidenceRecord } from "../data";
import { runMeta } from "./adapter.server";
import { authorizedRecords } from "./contract";
import { buildVerifiedFacts, nonAsciiNumerics, numericTokens, supportingIdsFor, uncoveredRecordIds, verifyNoNumerals } from "./numericGrounding";

// No network: fetch is always a local fake.
const READY = { META_MODEL_API_KEY: "test-key", META_MODEL_ENABLED: "true" };
const req = (roleId = "exec", scenarioId = "baseline") => ({ scenarioId, roleId, ownerConfirmed: true });
const reply = (content: unknown) =>
  vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) }, finish_reason: "stop" }], usage: { prompt_tokens: 500, completion_tokens: 200 } }), { status: 200 }));
const out = (text: string, refs = ["F-revenue"]) => ({
  interpretations: [{ text, verified: false, refs }],
  missing_evidence: [] as string[],
  recommendations: [] as unknown[],
});
const run = (o: unknown, role = "exec") => runMeta(req(role), READY, reply(o) as never);
const errorsOf = async (o: unknown, role = "exec") => {
  const r = await run(o, role);
  return r.state === "rejected" ? r.errors.join(" | ") : r.state;
};
const rec = (id: string, metric: EvidenceRecord["metric"], period: "prior" | "current", value: number, unit = "deals"): EvidenceRecord =>
  ({ id, department: "Sales", workspace: "ws-sales", date: period === "prior" ? "2026-06-30" : "2026-09-30", source: "s", metric, period, value, unit });

describe("verified facts", () => {
  const f = buildVerifiedFacts(authorizedRecords(req()));
  const revenue = f.find((x) => x.metric === "revenue")!;
  it("are computed from authorized records with exact supporting ids and the owning department", () => {
    expect(revenue).toMatchObject({ fact_id: "F-revenue", department: "Finance", unit: "USD", change_pct: -17.9, change_pp: null, direction: "down" });
    expect(revenue.prior).toEqual({ id: "VH-FIN-001-Q2", value: 1_240_000 });
    expect(revenue.current).toEqual({ id: "VH-FIN-001-Q3", value: 1_018_000 });
  });
  it("exist only for the role's authorized metrics (finance sees revenue only)", () => {
    expect(buildVerifiedFacts(authorizedRecords(req("finance"))).map((x) => x.metric)).toEqual(["revenue"]);
  });
  it("supporting ids are derived from the referenced facts, de-duplicated and order-preserving", () => {
    expect(supportingIdsFor(["F-revenue", "F-revenue", "F-nope"], f)).toEqual(["VH-FIN-001-Q2", "VH-FIN-001-Q3"]);
    expect(supportingIdsFor([], f)).toEqual([]);
  });
  it("uncoveredRecordIds flags records no fact represents (unpaired, duplicate or mismatched)", () => {
    const only = [rec("U-Q3", "closed_deals", "current", 5)];
    expect(uncoveredRecordIds(only, buildVerifiedFacts(only))).toEqual(["U-Q3"]);
    const dup = [rec("D1", "closed_deals", "prior", 1), rec("D2", "closed_deals", "prior", 1), rec("D3", "closed_deals", "current", 2)];
    expect(buildVerifiedFacts(dup)).toEqual([]);
    expect(uncoveredRecordIds(dup, buildVerifiedFacts(dup))).toEqual(["D1", "D2", "D3"]);
    const ok = [rec("P-Q2", "closed_deals", "prior", 1), rec("P-Q3", "closed_deals", "current", 2)];
    expect(uncoveredRecordIds(ok, buildVerifiedFacts(ok))).toEqual([]);
  });
});

describe("strict numeral rule: model text contains no numerals (end to end)", () => {
  it("accepts text with no numerals", async () => {
    expect((await run(out("Demand may be shifting between channels."))).state).toBe("ok");
  });
  it.each([
    ["ASCII percent", "Revenue fell 40%."],
    ["ASCII decimal", "Revenue fell 17.9 points."],
    ["currency with separators", "Revenue was $1,018,000."],
    ["a bare duration", "Run a 2-week test."],
    ["a duration in days", "Re-forecast within 30 days."],
    ["an ISO date", "Snapshot dated 2026-09-30."],
    ["a rounded paraphrase", "Revenue fell about 18%."],
  ])("rejects %s (even if the number happens to be a real fact value)", async (_n, text) => {
    expect(await errorsOf(out(text))).toContain("not allowed in model text");
  });
  it("applies to every text field: interpretations, recommendations and missing_evidence", async () => {
    const base = out("Demand may be shifting.");
    const rec3 = { ...base, recommendations: [{ text: "Run a 2-week test.", requires_human_approval: true, refs: ["F-revenue"] }] };
    const miss = { ...base, missing_evidence: ["Need 3 more quarters."] };
    for (const o of [rec3, miss]) expect(await errorsOf(o)).toContain("not allowed in model text");
  });
  it("record ids, Q1-Q4 labels and years remain intentionally exempt", async () => {
    expect((await run(out("Between Q2 and Q3 2026 (VH-FIN-001-Q2, VH-FIN-001-Q3) demand may be shifting."))).state).toBe("ok");
  });
});

// Unicode numeric bypass regression (found by the offline evaluation). Escapes are used so the characters survive editors.
const FULLWIDTH_40 = "４０"; // ４０
const ARABIC_INDIC_40 = "٤٠"; // ٤٠
const VULGAR_HALF = "½"; // ½
describe("Unicode numeric expressions cannot bypass the numeral rule", () => {
  it("full-width digits are folded by NFKC and then rejected as numerals", async () => {
    expect(await errorsOf(out(`Revenue fell ${FULLWIDTH_40}%.`))).toContain("Numeral 40 not allowed");
  });
  it("Arabic-Indic digits are rejected outright", async () => {
    expect(await errorsOf(out(`Revenue fell ${ARABIC_INDIC_40}%.`))).toContain("Non-ASCII numeric character");
  });
  it("Unicode fractions are folded and rejected", async () => {
    expect(await errorsOf(out(`Revenue fell by ${VULGAR_HALF}.`))).toContain("not allowed in model text");
  });
  it.each([
    ["Devanagari digits", "४०"],
    ["Bengali digits", "৪০"],
    ["Thai digits", "๔๐"],
    ["math bold digits", "\u{1D7D2}\u{1D7CE}"],
    ["circled digit", "④"],
    ["superscript digits", "⁴⁰"],
    ["vulgar fraction three quarters", "¾"],
  ])("%s are rejected", async (_n, digits) => {
    expect((await run(out(`Revenue fell ${digits}%.`))).state).toBe("rejected");
  });
  it("a zero-width character cannot split or hide a full-width number", async () => {
    expect((await run(out("Revenue fell ４​０%."))).state).toBe("rejected");
  });
  it("a full-width spelling of any number is rejected (no number is ever allowed, backed or not)", async () => {
    expect((await run(out("Revenue fell １７．９%."))).state).toBe("rejected");
  });
  it("full-width quarter and year labels are folded and remain exempt; a non-ASCII digit in a quarter label is not", async () => {
    expect((await run(out("Demand shifted in Ｑ３ ２０２６."))).state).toBe("ok");
    expect((await run(out("Demand shifted in Q٣."))).state).toBe("rejected");
  });
  it("the strict duration rule is unchanged (ASCII and full-width)", async () => {
    const mk = (t: string) => ({ ...out("x."), interpretations: [], recommendations: [{ text: t, requires_human_approval: true, refs: ["F-revenue"] }] });
    expect(await errorsOf(mk("Run a 2-week test."))).toContain("Numeral 2");
    expect(await errorsOf(mk("Run a ２-week test."))).toContain("Numeral 2");
  });
});

describe("scanner helpers", () => {
  it("numericTokens ignores record ids, quarter labels and years; strips thousands separators; ignores sign", () => {
    expect(numericTokens("VH-FIN-001-Q3 in Q3 2026: $1,018,000 and -17.9%", ["VH-FIN-001-Q3"])).toEqual([1018000, 17.9]);
    expect(numericTokens(`fell ${FULLWIDTH_40}% and ${VULGAR_HALF}`, [])).toEqual([40, 1, 2]);
  });
  it("nonAsciiNumerics ignores ASCII, ids and exempt labels and lists leftover non-ASCII numerals", () => {
    expect(nonAsciiNumerics("17.9% in Q3 2026, VH-FIN-001-Q3", ["VH-FIN-001-Q3"])).toEqual([]);
    expect(nonAsciiNumerics(`fell ${ARABIC_INDIC_40}%`, [])).toEqual(["٤", "٠"]);
  });
  it("verifyNoNumerals returns no errors for numeral-free text", () => {
    expect(verifyNoNumerals("Demand may be shifting.", [])).toEqual([]);
  });
});

describe("scenario sanity: every bundled scenario still yields facts for every role that sees data", () => {
  it("each role with authorized records has at least one fact", () => {
    for (const s of SCENARIOS) for (const roleId of ["exec", "marketing", "ops", "finance"]) {
      const recs = authorizedRecords(req(roleId, s.id));
      if (recs.length) expect(buildVerifiedFacts(recs).length).toBeGreaterThan(0);
    }
  });
});
