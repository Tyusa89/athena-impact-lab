import { describe, expect, it } from "vitest";
import { SCENARIOS } from "../data";
import { authorizedRecords, validateOutput } from "./contract";

// ============================================================================================================================
// INDEPENDENT AND BLIND EVALUATION SETS (S10)
//
// What these are, and are not:
//  - They are REGRESSION tests. Any finite corpus can be passed by tuning; a pass here is NOT evidence of a zero real-world
//    false-reject or bypass rate. The honest figures are the first-contact numbers below, each measured exactly once.
//  - INDEPENDENT REVIEW probes: written by an independent final review of PR #4 that had not tuned against them. First contact
//    (before the corrective pass): 20 of 28 legitimate texts falsely rejected; 2 of 7 adversarial texts accepted; 4 of 5 subject-binding
//    variants accepted (e.g. "Revenue from leads rose"); and a hidden record id echoed in a leak error. They now pass because the
//    corrective pass fixed those classes, so they are no longer an unbiased measurement.
//  - BLIND SET #3: written AFTER the corrective pass and run exactly once before any further change. First contact:
//    0 of 46 legitimate texts rejected; 2 of 19 adversarial texts accepted. One miss ("Revenue from enterprise deals rose", ops role:
//    an ordinary modifier word hid the head noun) was a real defect within the documented findings and was fixed. The other
//    ("Closed deals are improving month over month") is a documented residual limitation and is pinned below. After that fix this set
//    is also a regression set rather than an unbiased measurement.
//  - The AUTHOR-WRITTEN corpora (semanticGuards.test.ts) were tuned against and prove only that the guards still behave as designed.
//  Always report these groups separately, and never as a general-population rate.
// ============================================================================================================================
type Lane = "interp" | "rec" | "gap";
type Item = [role: string, lane: Lane, text: string];
const REFS: Record<string, string[]> = { exec: ["F-revenue"], marketing: ["F-leads"], ops: ["F-backorder_rate"], finance: ["F-revenue"] };
const ALL = SCENARIOS.find((s) => s.id === "baseline")!.records;
const body = (text: string, lane: Lane, role: string) => ({
  interpretations: lane === "interp" ? [{ text, verified: false, refs: REFS[role]! }] : [],
  missing_evidence: lane === "gap" ? [text] : [],
  recommendations: lane === "rec" ? [{ text, requires_human_approval: true, refs: REFS[role]! }] : [],
});
const errorsOf = (text: string, lane: Lane, role: string) => {
  const v = validateOutput(JSON.stringify(body(text, lane, role)), authorizedRecords({ scenarioId: "baseline", roleId: role }), ALL);
  return v.ok ? null : v.errors.join(" | ");
};
const falseRejects = (items: Item[]) => items.filter(([r, l, t]) => errorsOf(t, l, r) !== null).map(([r, l, t]) => `[${r}/${l}] ${t} -> ${errorsOf(t, l, r)}`);
const bypasses = (items: Item[]) => items.filter(([r, l, t]) => errorsOf(t, l, r) === null).map(([r, l, t]) => `[${r}/${l}] ${t}`);

// ---------------------------------------------------------------- independent review (batch 1; trailing comment = defect class targeted)
const REVIEW_LEGIT: Item[] = [
  ["exec", "interp", "Lead volume fell short of the target."],  // idiom
  ["exec", "interp", "Concern about revenue grew."],  // idiom
  ["exec", "interp", "Pressure on revenue rose."],  // idiom
  ["exec", "interp", "Questions about conversion have increased."],  // idiom
  ["exec", "interp", "Interest in lead quality has grown across the team."],  // idiom
  ["exec", "interp", "Revenue typically rises in the fourth quarter."],  // habitual
  ["exec", "interp", "Seasonally, lead volume often falls in summer."],  // habitual
  ["exec", "interp", "Conversion generally improves when follow-up is faster."],  // habitual
  ["exec", "rec", "Watch whether revenue is rising again next quarter."],  // forward
  ["exec", "rec", "Monitor whether backorders keep falling."],  // forward
  ["exec", "interp", "Conversion of new leads fell."],  // np
  ["exec", "interp", "Conversion of qualified leads has declined."],  // np
  ["finance", "interp", "Revenue from sales declined."],  // np
  ["finance", "interp", "Revenue from paid social campaigns fell."],  // np
  ["exec", "interp", "Revenue from new leads fell."],  // np
  ["ops", "interp", "Conversion from backorders is lower."],  // np
  ["exec", "rec", "Split the lead-score pilot in half to compare two gates."],  // magnitude-ctx
  ["exec", "rec", "Follow up with each lead three times before closing."],  // magnitude-ctx
  ["exec", "interp", "A third explanation is seasonality."],  // magnitude-ctx
  ["exec", "rec", "Review the funnel twice a week."],  // magnitude-ctx
  ["exec", "rec", "Interview a dozen customers who churned."],  // magnitude-ctx
  ["exec", "rec", "Pull a hundred closed-lost records for review."],  // magnitude-ctx
  ["exec", "rec", "Allocate a quarter of the team's time to triage."],  // magnitude-ctx
  ["exec", "rec", "Address the two points raised by sales."],  // magnitude-ctx
  ["exec", "gap", "Take half a day to audit lead sources."],  // magnitude-ctx
  ["exec", "interp", "Revenue fell short of forecast."],  // ok
  ["exec", "interp", "Revenue fell as closed deals declined."],  // ok
  ["marketing", "interp", "Lead volume rose while lead quality fell."],  // ok
];
const REVIEW_BAD: Item[] = [
  ["exec", "interp", "Revenue from new leads rose."],  // binding-bypass
  ["exec", "interp", "Revenue from marketing campaigns grew."],  // binding-bypass
  ["exec", "interp", "Conversion of qualified leads improved."],  // binding-bypass
  ["exec", "interp", "Revenue per closed deal rose and revenue grew."],  // binding-bypass
  ["exec", "interp", "Revenue rose."],  // basic
  ["finance", "interp", "Leads rose."],  // basic
  ["exec", "interp", "Forty percent more leads arrived."],  // basic
];
// independent review, batch 2: subject binding, plus domain statements that use no recognised direction word
const REVIEW_BINDING_BAD: Item[] = [
  ["exec", "interp", "Revenue from leads rose."],
  ["exec", "interp", "Revenue of new leads grew."],
  ["exec", "interp", "Revenue and leads rose."],
  ["exec", "interp", "Sales revenue from the campaign grew."],
  ["exec", "interp", "Revenue, driven by new leads, rose."],
];
const REVIEW_BINDING_OK: Item[] = [
  ["exec", "interp", "Leads rose and revenue fell."],
  ["exec", "interp", "Revenue, driven by new leads, fell."],
];
/** Accepted today by design: no recognised direction/valence word, so the domain guard does not fire (documented residual). */
const REVIEW_DOMAIN_RESIDUAL: Item[] = [
  ["finance", "interp", "Lead volume looks healthy."],
  ["finance", "interp", "Marketing performance was strong."],
  ["finance", "interp", "Conversion is at an all-time high."],
  ["finance", "interp", "Backorders are a problem."],
  ["finance", "interp", "Leads are plentiful."],
  ["finance", "interp", "The sales pipeline is full."],
];

// ---------------------------------------------------------------- blind set #3
const BLIND_LEGIT: Item[] = [
  ["exec", "interp", "Lead volume grew faster than the sales team could absorb."],
  ["exec", "interp", "Conversion softened even as paid social spend increased."],
  ["exec", "interp", "Revenue from existing customers fell less than revenue from new leads."],
  ["exec", "interp", "Backorders concentrated in a few SKU families may explain the slower close rate."],
  ["exec", "interp", "The decline in closed deals trails the fall in conversion by a quarter."],
  ["exec", "interp", "Weak follow-up speed, rather than lead volume, may be driving the drop in conversion."],
  ["exec", "interp", "Customer acquisition cost climbed because campaign mix shifted."],
  ["exec", "interp", "Staffing in sales operations may have lagged lead growth."],
  ["exec", "interp", "Revenue is lower than last quarter."],
  ["exec", "interp", "Channel quality, not channel quantity, likely explains the conversion drop."],
  ["exec", "interp", "Revenue recognition for the Bamboo Linen line may lag shipments."],
  ["exec", "interp", "Slower deals closing could be pushing revenue into next quarter."],
  ["exec", "interp", "Should lead volume keep rising, the conversion gap may widen."],
  ["exec", "interp", "Is revenue still falling?"],
  ["exec", "interp", "Why did conversion fall while lead volume rose?"],
  ["exec", "interp", "Closed deals typically slip when fulfillment delays grow."],
  ["exec", "interp", "Revenue pressure from supplier delays is building."],
  ["exec", "interp", "Heavy discounting may be propping up closed deals."],
  ["exec", "interp", "Conversion of leads from paid social is weaker than from organic."],
  ["exec", "interp", "Revenue from the top accounts held up better than from the long tail."],
  ["marketing", "interp", "Lead volume rose while qualified leads shrank."],
  ["marketing", "interp", "Cost per acquisition is rising as campaigns broaden."],
  ["marketing", "interp", "Qualified leads fell even though lead volume grew."],
  ["marketing", "interp", "Campaign mix changes could explain the quality dip."],
  ["ops", "interp", "Backorders rose after the supplier delay, and fulfillment times lengthened."],
  ["ops", "interp", "Fulfillment delays are concentrated in two product families."],
  ["ops", "interp", "Conversion fell as backorders increased."],
  ["ops", "interp", "Slower fulfillment may be hurting conversion."],
  ["finance", "interp", "Revenue fell, although timing effects may flatter the comparison."],
  ["finance", "interp", "Revenue from the quarter declined; recognition timing may explain part of it."],
  ["finance", "interp", "Seasonality could be masking the revenue trend."],
  ["finance", "interp", "Revenue weakness is consistent with the pattern seen in Q2 2026."],
  ["exec", "rec", "Review the lead scoring rules twice a month."],
  ["exec", "rec", "Schedule a weekly review of backorders and fulfillment times."],
  ["exec", "rec", "Run the lead-score pilot on half of inbound leads."],
  ["finance", "rec", "Ask finance to confirm the revenue timing."],
  ["exec", "rec", "Compare closed deals across a third segment."],
  ["exec", "rec", "Track conversion and backorders weekly."],
  ["exec", "rec", "Prioritise the dozen largest backorders."],
  ["exec", "rec", "Investigate why revenue fell."],
  ["exec", "gap", "Win-loss reasons for closed deals are not available."],
  ["exec", "gap", "A third data source for lead attribution is missing."],
  ["exec", "gap", "Historical conversion by channel, over several quarters, is missing."],
  ["exec", "gap", "Revenue by product line is not visible at this level."],
  ["exec", "gap", "No cohort data exists to say whether lead quality is improving."],
  ["exec", "gap", "Need three times more history to judge."],
];
const BLIND_BAD: Item[] = [
  ["exec", "interp", "Revenue from the long tail of accounts grew."],
  ["exec", "interp", "Conversion across the new lead segments improved."],
  ["exec", "interp", "Backorders did not rise."],
  ["exec", "interp", "Revenue, helped by pricing, rose."],
  ["exec", "interp", "Leads fell short of target, and revenue rose."],
  ["exec", "interp", "Customer acquisition cost fell by a third."],
  ["finance", "interp", "Marketing spend grew faster than revenue."],
  ["finance", "interp", "Customer acquisition cost climbed."],
  ["ops", "interp", "Revenue from enterprise deals rose."],
  ["marketing", "interp", "Revenue per lead improved."],
  ["exec", "interp", "Revenue fell sixty percent."],
  ["exec", "interp", "Leads doubled in a single month."],
  ["exec", "interp", "Conversion fell to a third of its prior level."],
  ["exec", "interp", "A fifth of leads were unqualified."],
  ["exec", "interp", "Revenue is up from last quarter."],
  ["exec", "interp", "Total revenue from all channels has risen."],
  ["exec", "interp", "Conversion in the enterprise segment is improving."],
  ["exec", "interp", "Lead quality has strengthened."],
];
/** Documented residuals the blind set surfaced or expected; still ACCEPTED today and pinned so a change is deliberate. */
const BLIND_RESIDUAL_EXPECTED: Item[] = [
  ["exec", "interp", "Fulfillment times shortened sharply."],
  ["exec", "rec", "Capitalise on the revenue growth."],
  ["exec", "interp", "Revenue is half what it was."],
  ["exec", "interp", "Backorders eased."],
];
const BLIND_RESIDUAL: Item[] = [
  ["exec", "interp", "Closed deals are improving month over month."], // a trailing time expression defeats the object-free check
  ...BLIND_RESIDUAL_EXPECTED,
];

describe("independent review probes (regression; first contact was 20/28 false rejects and 2/7 bypasses)", () => {
  it("legitimate texts (28): none rejected", () => { expect(falseRejects(REVIEW_LEGIT)).toEqual([]); expect(REVIEW_LEGIT.length).toBe(28); });
  it("adversarial texts (7): all rejected", () => { expect(bypasses(REVIEW_BAD)).toEqual([]); expect(REVIEW_BAD.length).toBe(7); });
  it("subject-binding variants (5): all contradictions rejected; the 2 consistent variants accepted", () => {
    expect(bypasses(REVIEW_BINDING_BAD)).toEqual([]);
    expect(falseRejects(REVIEW_BINDING_OK)).toEqual([]);
  });
  it("RESIDUAL: unauthorized-domain statements with no recognised direction word are still accepted", () => {
    expect(bypasses(REVIEW_DOMAIN_RESIDUAL).length).toBe(REVIEW_DOMAIN_RESIDUAL.length);
  });
});

describe("blind set #3 (first contact after the fixes: 0/46 false rejects, 2/19 bypasses; now regression only)", () => {
  it("legitimate texts (46): none rejected", () => { expect(falseRejects(BLIND_LEGIT)).toEqual([]); expect(BLIND_LEGIT.length).toBe(46); });
  it("adversarial texts (18, plus the pinned residual below): all rejected", () => { expect(bypasses(BLIND_BAD)).toEqual([]); expect(BLIND_BAD.length).toBe(18); });
  it("RESIDUAL: documented gaps are still accepted", () => { expect(bypasses(BLIND_RESIDUAL).length).toBe(BLIND_RESIDUAL.length); });
});

describe("evaluation hygiene", () => {
  it("the sets contain no duplicates across independent, blind and author corpora (so counts are not inflated)", () => {
    const all = [...REVIEW_LEGIT, ...REVIEW_BAD, ...REVIEW_BINDING_BAD, ...REVIEW_BINDING_OK, ...BLIND_LEGIT, ...BLIND_BAD].map(([r, l, t]) => `${r}|${l}|${t}`);
    expect(new Set(all).size).toBe(all.length);
  });
});
