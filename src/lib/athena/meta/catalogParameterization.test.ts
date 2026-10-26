import { describe, expect, it } from "vitest";
import type { AnalysisContext } from "../core/facts";
import { SUPPORT_CATALOG, SUPPORT_PERIODS, SUPPORT_RECORDS } from "../core/fixtures";
import type { EvidenceRecord } from "../data";
import { buildMessages, validateOutput } from "./contract";
import { renderFindings } from "./findings";
import { buildVerifiedFacts, verifyNoNumerals } from "./numericGrounding";
import { checkSemantics, directionalClaims, magnitudeExpressions, semanticScope } from "./semanticGuards";

// Grounding, findings, prompt and semantic guards read the catalog they are given: nothing here uses the prototype's vocabulary.
const ctx: AnalysisContext = { catalog: SUPPORT_CATALOG, periods: SUPPORT_PERIODS };
const withSource = (r: (typeof SUPPORT_RECORDS)[number]) => ({ ...r, workspace: "ws-x", date: "2027-01-31", source: `SRC ${r.id}` });
const records = SUPPORT_RECORDS.map(withSource) as unknown as EvidenceRecord[];
const hiddenBilling = [
  { id: "SUP-004-P", metric: "refunds", department: "Billing", period: "prior", value: 10, unit: "USD" },
  { id: "SUP-004-C", metric: "refunds", department: "Billing", period: "current", value: 50, unit: "USD" },
].map((r) => withSource(r as never)) as unknown as EvidenceRecord[];
const all = [...records, ...hiddenBilling];
const facts = buildVerifiedFacts(records, ctx);
const scope = semanticScope(records, facts, SUPPORT_CATALOG);
const lane = (text: string, refs = ["F-tickets_opened"]) => JSON.stringify({ interpretations: [{ text, verified: false, refs }], missing_evidence: [], recommendations: [] });
const check = (text: string, l: "interpretation" | "recommendation" | "gap" = "interpretation") => checkSemantics(text, l, scope).map((i) => i.code);

describe("verified facts, findings and prompt follow the supplied catalog and periods", () => {
  it("builds facts with catalog ids and rendered findings with catalog labels", () => {
    expect(facts.map((f) => f.fact_id)).toEqual(["F-tickets_opened", "F-first_response_hours", "F-csat"]);
    expect(renderFindings(records, ctx).map((f) => f.text)).toEqual([
      "Tickets opened increased: 1,000 tickets → 1,200 tickets (+20% relative)",
      "First response time was flat: 5 hours → 5.1 hours (+2% relative)",
      "Customer satisfaction decreased: 92% → 88% (-4.3% relative, -4 pp)",
    ]);
  });
  it("puts the supplied periods and facts in the prompt, and nothing from the prototype", () => {
    const m = buildMessages("Why?", records, ctx);
    expect(m[1]!.content).toContain('"Jan 2027"');
    expect(m[1]!.content).toContain("F-csat");
    expect(JSON.stringify(m)).not.toMatch(/Q2 2026|Q3 2026|revenue|Marketing/i);
  });
});

describe("numeral policy exempts only the supplied reporting periods", () => {
  const ids = all.map((r) => r.id);
  it("accepts a reference to a supplied reporting year and rejects the prototype's", () => {
    expect(verifyNoNumerals("Compared with the period in 2027.", ids, SUPPORT_PERIODS)).toEqual([]);
    expect(verifyNoNumerals("Compared with the period in 2026.", ids, SUPPORT_PERIODS)).not.toEqual([]);
    expect(verifyNoNumerals("Compared with Q3 2027.", ids, SUPPORT_PERIODS)).toEqual([]);
  });
  it("with no year in the labels, no year reference is exempt", () => {
    const noYear = { prior: { label: "Last month" }, current: { label: "This month" } };
    expect(verifyNoNumerals("Compared with Q3 2027.", ids, noYear)).not.toEqual([]);
  });
  it("still rejects any other numeral", () => expect(verifyNoNumerals("Tickets rose 20%.", ids, SUPPORT_PERIODS)).not.toEqual([]));
});

describe("semantic guards read the supplied catalog", () => {
  it("resolves the supplied aliases and polarity", () => {
    expect(directionalClaims("Ticket volume rose.", "interpretation", SUPPORT_CATALOG)[0]).toMatchObject({ dir: "up" });
    expect(directionalClaims("Revenue rose.", "interpretation", SUPPORT_CATALOG)).toEqual([]); // not in this business
    expect(directionalClaims("Response time worsened.", "interpretation", SUPPORT_CATALOG)[0]).toMatchObject({ dir: "up" }); // lower is better
    expect(directionalClaims("Customer satisfaction deteriorated.", "interpretation", SUPPORT_CATALOG)[0]).toMatchObject({ dir: "down" }); // higher is better
    expect(magnitudeExpressions("Ticket volume doubled.", "interpretation", SUPPORT_CATALOG)).not.toEqual([]);
  });
  it("direction: rejects contradictions of the verified findings and accepts consistent statements", () => {
    expect(check("Ticket volume fell.")).toEqual(["direction"]);
    expect(check("Ticket volume rose.")).toEqual([]);
    expect(check("Customer satisfaction improved.")).toEqual(["direction"]);
    expect(check("Customer satisfaction fell.")).toEqual([]);
    expect(check("Response time rose.")).toEqual([]); // flat verified: small up wording tolerated
  });
  it("domain: a metric in an unauthorized domain, by metric alias or domain alias, is rejected; an unavailable one is told apart", () => {
    expect(check("Refund volume rose.")).toEqual(["domain"]);
    expect(check("Billing performance weakened.")).toEqual(["domain"]);
    // A metric the access-policy layer explicitly lets the role discover, with no data, is "unavailable" (discoverability is metric-level; a department set no longer decides it).
    expect(checkSemantics("Refunds rose.", "interpretation", semanticScope(records, facts, SUPPORT_CATALOG, { discoverable: ["refunds"] })).map((i) => i.code)).toEqual(["unavailable"]);
  });
});

describe("validateOutput under another catalog", () => {
  const run = (o: string) => validateOutput(o, records, all, ctx);
  it("accepts a clean output and returns findings and supporting ids from the catalog", () => {
    const v = run(lane("Staffing levels may matter.", ["F-tickets_opened", "F-csat"]));
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.output.interpretations[0]!.supporting_ids).toEqual(["SUP-001-P", "SUP-001-C", "SUP-003-P", "SUP-003-C"]);
      expect(v.findings).toHaveLength(3);
    }
  });
  it.each([
    ["direction", lane("Ticket volume fell.")],
    ["domain", lane("Refund volume rose.")],
    ["numeral", lane("Tickets rose 20%.")],
    ["magnitude", lane("Ticket volume doubled.")],
    ["causal", lane("Understaffing caused the backlog.")],
    ["leak", lane("See SUP-004-C for context.")],
    ["ref", lane("Mix may matter.", ["F-refunds"])],
  ])("rejects %s", (cat, out) => {
    const v = run(out);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.categories).toContain(cat);
  });
});

describe("every prototype alias is recognised as the entity the catalog says it is", async () => {
  const { PROTOTYPE_CATALOG } = await import("../prototypeCatalog");
  const empty = { facts: [], departments: new Set<string>(), catalog: PROTOTYPE_CATALOG };
  const aliases = [...PROTOTYPE_CATALOG.metrics.flatMap((m) => m.aliases.map((a) => ({ a, owner: `metric ${m.key}` }))), ...PROTOTYPE_CATALOG.domains.flatMap((d) => d.aliases.map((a) => ({ a, owner: `domain ${d.id}` })))];
  it("covers the whole alias table", () => expect(aliases.length).toBe(PROTOTYPE_CATALOG.metrics.reduce((n, m) => n + m.aliases.length, 0) + PROTOTYPE_CATALOG.domains.reduce((n, d) => n + d.aliases.length, 0)));
  it.each(aliases)("$a ($owner) is found as an entity in a directional claim", ({ a, owner }) => {
    const claims = directionalClaims(`${a} rose.`, "interpretation", PROTOTYPE_CATALOG);
    expect(claims.length, `${a} produced no claim`).toBeGreaterThan(0);
    const e = claims[0]!.entities[0]!;
    expect(`${e.kind === "metric" ? "metric" : "domain"} ${e.key}`).toBe(owner);
    // with no authorized departments, every alias is outside scope
    expect(checkSemantics(`${a} rose.`, "interpretation", empty).map((i) => i.code)).toContain("domain");
  });
});
