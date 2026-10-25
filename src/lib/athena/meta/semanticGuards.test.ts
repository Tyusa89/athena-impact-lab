import { describe, expect, it, vi } from "vitest";
import { METRIC_LABELS, ROLES, SCENARIOS, type MetricKey } from "../data";
import { runMeta } from "./adapter.server";
import { MAX_INPUT_TOKENS, authorizedRecords, buildMessages, estimateTokens, validateOutput } from "./contract";
import { buildVerifiedFacts } from "./numericGrounding";
import { METRIC_DEPARTMENT, RESIDUAL_LIMITATIONS, checkSemantics, directionalClaims, magnitudeExpressions, semanticScope, semanticText } from "./semanticGuards";

// Phase 2B-2 semantic guards. No network: fetch is always a local fake.
const READY = { META_MODEL_API_KEY: "test-key", META_MODEL_ENABLED: "true" };
type Lane = "interp" | "rec" | "gap";
type Item = [role: string, lane: Lane, text: string];
const REFS: Record<string, string[]> = { exec: ["F-revenue"], marketing: ["F-leads"], ops: ["F-backorder_rate"], finance: ["F-revenue"] };
const req = (roleId = "exec", scenarioId = "baseline") => ({ scenarioId, roleId, ownerConfirmed: true });
const ALL = (id = "baseline") => SCENARIOS.find((s) => s.id === id)!.records;
const factsFor = (role: string, scenario = "baseline") => buildVerifiedFacts(authorizedRecords(req(role, scenario)));
const scopeFor = (role: string, scenario = "baseline") => { const recs = authorizedRecords(req(role, scenario)); return semanticScope(recs, buildVerifiedFacts(recs)); };
const body = (text: string, lane: Lane, role: string) => ({
  interpretations: lane === "interp" ? [{ text, verified: false, refs: REFS[role]! }] : [],
  missing_evidence: lane === "gap" ? [text] : [],
  recommendations: lane === "rec" ? [{ text, requires_human_approval: true, refs: REFS[role]! }] : [],
});
/** Errors from the full validator (null when accepted). */
const validate = (text: string, lane: Lane, role = "exec") => {
  const v = validateOutput(JSON.stringify(body(text, lane, role)), authorizedRecords(req(role)), ALL());
  return v.ok ? null : v.errors.join(" | ");
};
const laneName = (lane: Lane) => (lane === "interp" ? "interpretation" : lane === "rec" ? "recommendation" : "gap") as "interpretation" | "recommendation" | "gap";
/** Structured issues from the semantic guards only. */
const issues = (text: string, lane: Lane, role = "exec", scenario = "baseline") => checkSemantics(text, laneName(lane), scopeFor(role, scenario), "text");
/** Messages from the semantic guards only. */
const sem = (text: string, lane: Lane, role = "exec", scenario = "baseline") => issues(text, lane, role, scenario).map((i) => i.message);
const reply = (content: unknown) =>
  vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) }, finish_reason: "stop" }], usage: { prompt_tokens: 900, completion_tokens: 200 } }), { status: 200 }));

// ---------------------------------------------------------------- corpora
/** AUTHOR-WRITTEN legitimate explanations (126). The first 86 were written while tuning the guards; the last 40 were a held-out set
 * run once and then used to fix a miss, so none of these is an independent measurement. Every one MUST be accepted. */
const AUTHOR_LEGIT: Item[] = [
  ["exec", "interp", "Lead volume rose while conversion fell, so lower-intent leads may be diluting the pipeline."],
  ["exec", "interp", "Fulfillment delays and rising backorders may be suppressing closes."],
  ["exec", "interp", "A change in the lead scoring definition could shift lead quality without a real change."],
  ["exec", "interp", "Paid social may be attracting lower-quality leads."],
  ["exec", "interp", "Revenue decline may be downstream of weaker conversion."],
  ["exec", "interp", "Customer acquisition cost increased as paid social share grew."],
  ["exec", "interp", "Longer fulfillment times could be discouraging buyers, which may explain weaker conversion."],
  ["exec", "interp", "The drop in conversion coincides with a rise in backorders."],
  ["exec", "interp", "Lead quality declined, and closed deals fell as well."],
  ["exec", "interp", "Seasonal demand variation may account for part of the revenue decline."],
  ["exec", "interp", "Higher lead volume with lower lead quality can strain sales capacity."],
  ["exec", "interp", "Backorder growth may reflect a supplier delay on one product family."],
  ["exec", "interp", "Fulfillment improvements would reduce backorders if supply recovered."],
  ["exec", "interp", "Conversion fell although lead volume increased."],
  ["exec", "interp", "Conversion did not improve despite higher lead volume."],
  ["exec", "interp", "Revenue did not rise."],
  ["exec", "interp", "Revenue declined; demand may be weakening."],
  ["exec", "interp", "Conversion is weaker than expected."],
  ["exec", "interp", "Backorders are up and fulfillment is slower."],
  ["exec", "interp", "Weaker conversion may relate to slower follow-up."],
  ["exec", "interp", "Marketing spend may be shifting toward paid social."],
  ["exec", "interp", "Pipeline coverage looks thin."],
  ["exec", "interp", "Inventory shortages may be limiting supply."],
  ["exec", "interp", "Rising ad costs may reduce revenue."],
  ["exec", "interp", "The decline in revenue may be linked to the fall in closed deals."],
  ["exec", "interp", "Fewer qualified leads may be reaching sales."],
  ["exec", "interp", "Without a change in lead scoring, conversion would probably keep falling."],
  ["exec", "interp", "If lead quality recovers, conversion may follow."],
  ["exec", "interp", "One possible explanation is a change in channel mix."],
  ["exec", "interp", "A percentage of low-intent leads may be misclassified."],
  ["exec", "interp", "Lead volume and backorders both rose, while revenue and conversion fell."],
  ["exec", "interp", "Cost per acquisition and fulfillment times increased while closed deals decreased."],
  ["marketing", "interp", "Lead volume rose while lead quality fell."],
  ["marketing", "interp", "Customer acquisition cost rose as paid social share grew."],
  ["ops", "interp", "Backorders rose and fulfillment slowed."],
  ["ops", "interp", "Fulfillment delays may reduce revenue."],
  ["ops", "interp", "Revenue impact cannot be assessed from operations data."],
  ["ops", "interp", "Longer fulfillment may be hurting conversion."],
  ["finance", "interp", "Revenue softness may be demand-related."],
  ["finance", "interp", "Revenue declined, so demand may be weakening."],
  ["finance", "interp", "Revenue recognition timing may explain part of the change."],
  ["finance", "interp", "Seasonality and pricing may both be involved."],
  ["exec", "rec", "Review channel mix toward higher-quality sources."],
  ["exec", "rec", "Increase the lead score threshold and monitor conversion."],
  ["exec", "rec", "Reduce backorders by prioritising stock for top products."],
  ["exec", "rec", "Improve conversion by tightening lead scoring."],
  ["exec", "rec", "Investigate the rising backorder rate and fulfillment delays."],
  ["exec", "rec", "Address declining conversion with a lead scoring pilot."],
  ["exec", "rec", "Pause campaigns that attract low-intent leads."],
  ["exec", "rec", "Drive a reduction in backorders and a rise in conversion."],
  ["exec", "rec", "Double check the attribution data before acting."],
  ["exec", "rec", "Run a two week pilot of a lead score gate."],
  ["exec", "rec", "Raise the lead score threshold and lower the hand-off delay."],
  ["finance", "rec", "Ask the sales team to confirm the revenue forecast."],
  ["finance", "rec", "Re-forecast next quarter with sensitivity ranges."],
  ["finance", "rec", "Investigate whether pricing or seasonality explains the decline."],
  ["exec", "interp", "Lower lead quality increased the cost of acquisition."],
  ["exec", "interp", "Weak lead quality increased customer acquisition cost."],
  ["exec", "interp", "Falling conversion may reduce closed deals."],
  ["exec", "interp", "Rising fulfillment times and backorders may be eroding conversion."],
  ["exec", "interp", "Declining lead quality is lowering conversion."],
  ["exec", "interp", "Poor scoring is raising customer acquisition cost."],
  ["exec", "interp", "Revenue was reviewed after conversion fell."],
  ["exec", "interp", "The fall in conversion is not explained by lead volume, which rose."],
  ["exec", "interp", "Lead volume has grown faster than sales capacity."],
  ["exec", "interp", "Increasing lead volume without screening may lower quality."],
  ["exec", "interp", "Backorders did not fall."],
  ["exec", "interp", "Conversion did not rise."],
  ["exec", "interp", "Backorders worsened."],
  ["exec", "interp", "Revenue is shrinking."],
  ["exec", "interp", "Sales team morale fell."],
  ["exec", "interp", "Customer acquisition cost is climbing and closed deals are slipping."],
  ["exec", "interp", "A rise in backorders and longer fulfillment times may be hurting conversion."],
  ["exec", "interp", "Revenue pressure follows the drop in closed deals."],
  ["marketing", "interp", "Lead quality fell, which may explain weaker conversion."],
  ["marketing", "interp", "Channel mix changes may have diluted lead quality."],
  ["ops", "interp", "Backorder growth and slower fulfillment may be limiting closed deals."],
  ["finance", "interp", "The revenue decline may reflect lower demand."],
  ["finance", "interp", "Customers may be delaying purchases."],
  ["finance", "rec", "Review the revenue forecast assumptions."],
  ["exec", "rec", "Revisit leads that were dropped from the CRM."],
  ["exec", "gap", "No attribution data by channel is available."],
  ["exec", "gap", "Need three more quarters of history."],
  ["exec", "gap", "Revenue data by region is not available."],
  ["ops", "gap", "Revenue and sales data are not visible to this role."],
  ["finance", "gap", "Sales pipeline data is not available for comparison."],
  ["exec", "interp", "Seasonality may be flattering the earlier period."],
  ["exec", "interp", "Channel mix shifted toward paid social, which tends to bring in less-qualified leads."],
  ["exec", "interp", "Slower fulfillment may be eroding customer confidence and hurting conversion."],
  ["exec", "interp", "Backlogs in the warehouse may be delaying shipments."],
  ["exec", "interp", "A shortfall in qualified leads could explain the weaker close rate."],
  ["exec", "interp", "Pricing changes may have affected deal sizes."],
  ["exec", "interp", "The rise in acquisition cost suggests campaign efficiency is falling."],
  ["exec", "interp", "Customer acquisition cost climbed while conversion slipped."],
  ["exec", "interp", "Closed deals dropped in line with conversion."],
  ["exec", "interp", "Sales cycles may be lengthening."],
  ["exec", "interp", "Revenue fell as closed deals declined."],
  ["exec", "interp", "Revenue weakness lines up with the fall in conversion."],
  ["exec", "interp", "The strength of the pipeline may be overstated."],
  ["exec", "interp", "Fulfillment delays grew after the supplier issue."],
  ["exec", "interp", "Inventory constraints worsened backorders."],
  ["exec", "interp", "Improved stock availability would help."],
  ["exec", "interp", "Better lead scoring could lift conversion."],
  ["exec", "interp", "Conversion softened as lead volume expanded."],
  ["marketing", "interp", "Lead volume grew but lead quality eroded."],
  ["marketing", "interp", "Qualified leads are shrinking even as lead volume increases."],
  ["ops", "interp", "Delivery times lengthened and backorders mounted."],
  ["ops", "interp", "Backorders spiked after the supplier delay."],
  ["ops", "interp", "Conversion slid while fulfillment lagged."],
  ["finance", "interp", "Revenue has slipped, possibly on weaker demand."],
  ["finance", "interp", "Revenue timing may be shifting between periods."],
  ["finance", "interp", "Cash timing is outside this data."],
  ["exec", "rec", "Monitor conversion weekly."],
  ["exec", "rec", "Prioritise backorder reduction for top sellers."],
  ["exec", "rec", "Test a stricter lead qualification gate."],
  ["exec", "rec", "Review why revenue fell."],
  ["exec", "rec", "Check whether the rising backorders reflect supplier issues."],
  ["exec", "gap", "No attribution data by channel."],
  ["exec", "gap", "Cohort level conversion history is missing."],
  ["exec", "gap", "Reasons for the revenue drop are not visible."],
  ["marketing", "interp", "Paid social may be crowding out higher-intent channels."],
  ["ops", "rec", "Escalate the supplier delay to purchasing."],
  ["finance", "rec", "Align the forecast with the sales team once data is available."],
  ["exec", "interp", "Demand for the Bamboo Linen line may have cooled."],
  ["exec", "interp", "Staffing gaps could be slowing lead follow-up."],
  ["exec", "interp", "Both lead quality and conversion are lower than in Q2 2026."],
];
/** AUTHOR-WRITTEN contradictions, unsupported magnitudes and unauthorized-domain claims (146; same provenance as above). Every one MUST be rejected. */
const AUTHOR_BAD: Item[] = [
  ["exec", "interp", "Revenue rose sharply."],
  ["exec", "interp", "Revenue has risen."],
  ["exec", "interp", "Revenue is up."],
  ["exec", "interp", "Revenue grew."],
  ["exec", "interp", "Revenue climbed."],
  ["exec", "interp", "Revenue increased."],
  ["exec", "interp", "There was an increase in revenue."],
  ["exec", "interp", "Growth in revenue was strong."],
  ["exec", "interp", "Revenue growth was strong."],
  ["exec", "interp", "Revenue improved."],
  ["exec", "interp", "Revenue is looking stronger."],
  ["exec", "interp", "Revenue did not fall."],
  ["exec", "interp", "No decline in revenue."],
  ["exec", "interp", "Conversion improved noticeably."],
  ["exec", "interp", "Conversion rose."],
  ["exec", "interp", "Rising conversion helped."],
  ["exec", "interp", "Conversion is better."],
  ["exec", "interp", "Lead volume fell."],
  ["exec", "interp", "Declining lead volume hurt."],
  ["exec", "interp", "Leads are down."],
  ["exec", "interp", "Lead quality improved."],
  ["exec", "interp", "Fulfillment times fell."],
  ["exec", "interp", "Fulfillment improved."],
  ["exec", "interp", "Backorders dropped."],
  ["exec", "interp", "Backorders improved."],
  ["exec", "interp", "Customer acquisition cost fell."],
  ["exec", "interp", "Closed deals increased."],
  ["exec", "interp", "Revenue was flat."],
  ["exec", "interp", "Conversion remained stable."],
  ["exec", "interp", "Revenue and conversion both rose."],
  ["exec", "interp", "Lead volume fell while revenue rose."],
  ["exec", "interp", "Revenue may have risen."],
  ["exec", "interp", "REVENUE ROSE."],
  ["exec", "interp", "Revenue r​ose."],
  ["exec", "interp", "Ｒevenue rose."],
  ["exec", "interp", "Revenue ROSE, but conversion fell."],
  ["exec", "rec", "Capitalise on rising revenue."],
  ["exec", "rec", "Revenue rose, so hire more staff."],
  ["exec", "gap", "Revenue rose last quarter and we lack why."],
  ["exec", "interp", "Revenue is growing."],
  ["exec", "interp", "Revenue has grown."],
  ["exec", "interp", "Revenue went up."],
  ["exec", "interp", "An improvement in revenue."],
  ["exec", "interp", "Strong revenue growth."],
  ["exec", "interp", "Backorders did not rise."],
  ["exec", "interp", "Backorders have not risen."],
  ["exec", "interp", "Conversion did not fall."],
  ["exec", "interp", "Closed deals held steady."],
  ["exec", "interp", "Revenue is stable."],
  ["exec", "interp", "Lead quality is improving."],
  ["exec", "interp", "Marketing is improving lead quality."],
  ["exec", "interp", "Strong lead quality is lifting conversion."],
  ["exec", "interp", "Revenue grew and conversion improved."],
  ["exec", "interp", "Lead volume dropped sharply."],
  ["exec", "interp", "Backorders decreased."],
  ["exec", "interp", "Fulfillment times shortened and backorders fell."],
  ["marketing", "interp", "Lead quality is up."],
  ["marketing", "interp", "Customer acquisition cost fell."],
  ["ops", "interp", "Backorders fell."],
  ["ops", "interp", "Fulfillment is improving."],
  ["finance", "interp", "Marketing is growing."],
  ["finance", "interp", "Operations improved."],
  ["finance", "interp", "Warehouse inventory fell."],
  ["finance", "interp", "Campaigns declined."],
  ["finance", "interp", "Conversion did not fall."],
  ["finance", "interp", "The sales pipeline grew."],
  ["exec", "interp", "Revenue fell forty percent."],
  ["exec", "interp", "Revenue fell forty-two per cent."],
  ["exec", "interp", "Revenue fell twenty five percent."],
  ["exec", "interp", "Revenue doubled."],
  ["exec", "interp", "Revenue halved versus Q2."],
  ["exec", "interp", "Revenue tripled."],
  ["exec", "interp", "Leads quadrupled."],
  ["exec", "interp", "Revenue was cut in half."],
  ["exec", "interp", "Revenue fell by half."],
  ["exec", "interp", "Half of the leads were low quality."],
  ["exec", "interp", "A third of leads were low quality."],
  ["exec", "interp", "Three quarters of the deals were lost."],
  ["exec", "interp", "Leads were twice as many."],
  ["exec", "interp", "Leads rose tenfold."],
  ["exec", "interp", "Leads rose two-fold."],
  ["exec", "interp", "Revenue fell by an order of magnitude."],
  ["exec", "interp", "Double-digit growth in leads."],
  ["exec", "interp", "Thousands of leads arrived."],
  ["exec", "interp", "Hundreds of deals closed."],
  ["exec", "interp", "A dozen leads converted."],
  ["exec", "interp", "Revenue fell by thirty."],
  ["exec", "interp", "Revenue fell forty."],
  ["exec", "interp", "Leads rose by twenty."],
  ["exec", "interp", "Revenue was five million dollars."],
  ["exec", "interp", "Revenue fell by a few percentage points."],
  ["exec", "interp", "Revenue fell ten times faster."],
  ["exec", "interp", "Leads rose three times."],
  ["exec", "interp", "Revenue fell by 100 basis points."],
  ["exec", "interp", "Revenue fell forty pct."],
  ["exec", "rec", "Reduce backorders by half."],
  ["exec", "gap", "Need forty percent more data."],
  ["exec", "interp", "Revenue fell ４０ percent."],
  ["exec", "interp", "Revenue fell forty ％."],
  ["finance", "interp", "Lead volume increased while conversion fell."],
  ["finance", "interp", "Lead volume may be rising."],
  ["finance", "interp", "Leads are up."],
  ["finance", "interp", "Conversion improved."],
  ["finance", "interp", "Sales declined."],
  ["finance", "interp", "Marketing performance weakened."],
  ["finance", "interp", "Backorders rose."],
  ["finance", "interp", "Customer acquisition cost fell."],
  ["finance", "interp", "The rise in lead volume is notable."],
  ["finance", "interp", "Growth in leads helped revenue."],
  ["finance", "interp", "Fulfillment times fell."],
  ["finance", "rec", "Capitalise on rising lead volume."],
  ["finance", "gap", "Backorders rose and we lack data."],
  ["ops", "interp", "Revenue fell."],
  ["ops", "interp", "Revenue is down."],
  ["ops", "interp", "Lead quality declined."],
  ["ops", "interp", "Marketing spend fell."],
  ["marketing", "interp", "Revenue rose."],
  ["marketing", "interp", "Fulfillment times increased."],
  ["marketing", "interp", "Backorders rose."],
  ["marketing", "interp", "Warehouse operations weakened."],
  ["exec", "interp", "Revenue expanded."],
  ["exec", "interp", "Conversion rebounded."],
  ["exec", "interp", "Fulfillment times shrank."],
  ["exec", "interp", "Revenue surged."],
  ["exec", "interp", "Closed deals jumped."],
  ["exec", "interp", "CAC dropped."],
  ["exec", "interp", "Lead quality strengthened."],
  ["finance", "interp", "Leads surged."],
  ["finance", "interp", "Customer acquisition cost climbed."],
  ["finance", "interp", "Fulfillment deteriorated."],
  ["ops", "interp", "Revenue climbed."],
  ["ops", "interp", "Marketing spend rose."],
  ["exec", "interp", "Revenue plunged by forty-five percent."],
  ["exec", "interp", "Revenue was cut by a third."],
  ["exec", "interp", "Revenue fell sixty."],
  ["exec", "interp", "Leads rose one hundred percent."],
  ["exec", "interp", "Revenue shrank by two thirds."],
  ["exec", "interp", "Revenue collapsed to a quarter of its prior level."],
  ["exec", "interp", "Leads rose by a factor of three."],
  ["exec", "interp", "The revenue line improved over the period."],
  ["exec", "interp", "Closed deals grew."],
  ["exec", "interp", "Backorders shrank."],
  ["exec", "interp", "Customer acquisition cost is falling."],
  ["exec", "interp", "Lead volume is declining."],
  ["marketing", "interp", "Revenue improved."],
  ["finance", "interp", "The sales team grew."],
];
/** Documented residual gaps (comparatives, unlisted verbs, adverbials). These are still ACCEPTED today; pinned so a change is deliberate. */
const KNOWN_MISS: Item[] = [
  ["exec", "interp", "Revenue edged higher."],
  ["exec", "interp", "Leads cratered."],
  ["exec", "interp", "Backorders eased."],
  ["exec", "interp", "Revenue is trending up."],
  ["exec", "interp", "Revenue rallied."],
];

// ---------------------------------------------------------------- author-written corpora (regression only)
// These sets were written by the same author as the guards and were tuned against. Passing them shows the guards still behave as
// designed; it is NOT an estimate of real-world false-reject or bypass rates. Independent and blind sets are in semanticIndependent.test.ts.
describe("author-written corpora (regression, not an independent measurement)", () => {
  it("author-tuned legitimate texts (86): none rejected", () => {
    expect(AUTHOR_LEGIT.slice(0, 86).filter(([r, l, t]) => validate(t, l, r) !== null).map(([r, l, t]) => `[${r}/${l}] ${t}`)).toEqual([]);
  });
  it("author held-out legitimate texts (40, since spent): none rejected", () => {
    expect(AUTHOR_LEGIT.slice(86).filter(([r, l, t]) => validate(t, l, r) !== null).map(([r, l, t]) => `[${r}/${l}] ${t}`)).toEqual([]);
  });
  it("author-tuned adversarial texts (120): all rejected", () => {
    expect(AUTHOR_BAD.slice(0, 120).filter(([r, l, t]) => validate(t, l, r) === null).map(([r, l, t]) => `[${r}/${l}] ${t}`)).toEqual([]);
  });
  it("author held-out adversarial texts (26, since spent): all rejected", () => {
    expect(AUTHOR_BAD.slice(120).filter(([r, l, t]) => validate(t, l, r) === null).map(([r, l, t]) => `[${r}/${l}] ${t}`)).toEqual([]);
  });
  it("corpus sizes are as documented", () => {
    expect([AUTHOR_LEGIT.length, AUTHOR_BAD.length]).toEqual([126, 146]);
  });
  it("KNOWN residual gaps are still accepted (pinned so any change is deliberate)", () => {
    for (const [role, lane, text] of KNOWN_MISS) expect(validate(text, lane, role), text).toBeNull();
  });
});

// ---------------------------------------------------------------- 1. direction
describe("direction guard: a directional claim must not contradict the verified finding", () => {
  // baseline x exec: leads up, MQL down, CAC up, conversion down, deals down, fulfillment up, backorders up, revenue down
  it.each([
    ["verb", "Revenue rose sharply."], ["present perfect", "Revenue has risen."], ["synonym", "Revenue grew."], ["particle", "Revenue is up."],
    ["noun phrase", "There was an increase in revenue."], ["compound noun", "Strong revenue growth."], ["valence", "Conversion improved noticeably."],
    ["predicative adjective", "Conversion is better."], ["attributive participle", "Declining lead volume hurt."], ["flat claim", "Revenue was flat."],
    ["negated base verb", "Conversion did not fall."], ["negated noun", "No decline in revenue."], ["hedged retrospective", "Revenue may have risen."],
    ["chain", "Revenue and conversion both rose."], ["second clause", "Lead volume fell while revenue rose."], ["object of transitive", "Strong lead quality is lifting conversion."],
  ])("%s: %s", (_n, text) => {
    expect(sem(text, "interp").join()).toContain("Semantic guard (direction)");
  });
  it("names the metric, the claimed direction and the verified direction, and never rewrites the text", () => {
    const [e] = sem("Revenue rose sharply.", "interp");
    expect(e).toContain("Recognized revenue");
    expect(e).toContain("is up");
    expect(e).toContain("verified finding is down");
  });
  it("consistent statements are accepted (including hedged and multi-metric ones)", () => {
    for (const t of [
      "Revenue fell.", "Lead volume rose while conversion fell.", "Revenue may be falling.", "Backorders are up and fulfillment is slower.",
      "Revenue weakness lines up with the fall in conversion.", "Customer acquisition cost climbed while conversion slipped.",
    ]) expect(sem(t, "interp"), t).toEqual([]);
  });
  it("comparatives, imperatives and goal nouns are not claims", () => {
    for (const [t, lane] of [
      ["Paid social may be attracting lower-quality leads.", "interp"], ["Higher lead volume with lower lead quality can strain capacity.", "interp"],
      ["Increase the lead score threshold and monitor conversion.", "rec"], ["Reduce backorders by prioritising stock.", "rec"],
      ["Drive a reduction in backorders and a rise in conversion.", "rec"], ["Improve conversion by tightening lead scoring.", "rec"],
    ] as [string, Lane][]) expect(sem(t, lane), t).toEqual([]);
  });
  it("conditional and counterfactual clauses are skipped", () => {
    for (const t of ["If revenue rises, hiring can resume.", "When conversion improves, revisit the forecast.", "Without a change in lead scoring, conversion would keep falling."])
      expect(sem(t, "interp"), t).toEqual([]);
  });
  it("transitive verbs bind the OBJECT, not the subject", () => {
    expect(sem("Weak lead quality increased customer acquisition cost.", "interp")).toEqual([]); // CAC really is up
    expect(sem("Weak scoring increased churn.", "interp")).toEqual([]); // no metric object
    expect(sem("Strong lead quality increased customer acquisition cost.", "interp")).toEqual([]);
    expect(sem("Lower lead quality increased conversion.", "interp").join()).toContain("direction"); // claims conversion went up
    expect(directionalClaims("Declining lead quality is lowering conversion.", "interpretation").map((c) => [c.entities[0]!.key, c.dir]).sort()).toEqual([["conversion_rate", "down"], ["mql_rate", "down"]]);
  });
  it("attributive participles do not bind across a conjunction or verb", () => {
    expect(sem("Customer acquisition cost is climbing and closed deals are slipping.", "interp")).toEqual([]);
    expect(sem("Customer acquisition cost is falling and closed deals are slipping.", "interp").join()).toContain("Customer acquisition cost is down");
  });
  it("passive 'dropped' means discarded, not decreased", () => {
    expect(sem("Revisit leads that were dropped from the CRM.", "rec")).toEqual([]);
    expect(sem("Lead volume dropped sharply.", "interp").join()).toContain("direction");
  });
});

describe("direction guard: property check over every scenario x role x authorized fact", () => {
  const TERM: Record<MetricKey, string> = {
    leads: "Lead volume", mql_rate: "Lead quality", conversion_rate: "Conversion", closed_deals: "Closed deals",
    fulfillment_days: "Fulfillment time", backorder_rate: "Backorders", revenue: "Revenue", cac: "Customer acquisition cost",
  };
  const GOOD: Record<MetricKey, "up" | "down"> = { leads: "up", mql_rate: "up", conversion_rate: "up", closed_deals: "up", revenue: "up", fulfillment_days: "down", backorder_rate: "down", cac: "down" };
  const cases = SCENARIOS.flatMap((s) => ROLES.flatMap((r) => factsFor(r.id, s.id).map((f) => ({ scenario: s.id, role: r.id, f }))));
  it("covers up, down and flat facts", () => {
    expect(new Set(cases.map((c) => c.f.direction))).toEqual(new Set(["up", "down", "flat"]));
    expect(cases.length).toBeGreaterThan(40);
  });
  it("a statement matching the verified direction is accepted; the opposite is rejected; flat facts tolerate up/down wording", () => {
    const wrong: string[] = [];
    for (const { scenario, role, f } of cases) {
      const t = TERM[f.metric], same = f.direction === "up" ? "rose" : "fell", opp = f.direction === "up" ? "fell" : "rose";
      const ok = (text: string) => sem(text, "interp", role, scenario).length === 0;
      if (f.direction === "flat") {
        for (const x of [`${t} was unchanged.`, `${t} rose.`, `${t} fell.`]) if (!ok(x)) wrong.push(`${scenario}/${role}: flat should accept "${x}"`);
      } else {
        if (!ok(`${t} ${same}.`)) wrong.push(`${scenario}/${role}: should accept "${t} ${same}."`);
        if (ok(`${t} ${opp}.`)) wrong.push(`${scenario}/${role}: should reject "${t} ${opp}."`);
        if (ok(`${t} was unchanged.`)) wrong.push(`${scenario}/${role}: should reject "${t} was unchanged."`);
        // valence resolves per metric polarity ("improved" is a decrease for fulfillment time, backorders and CAC)
        const improvedIsOk = GOOD[f.metric] === f.direction;
        if (ok(`${t} improved.`) !== improvedIsOk) wrong.push(`${scenario}/${role}: "${t} improved." expected ${improvedIsOk ? "accept" : "reject"}`);
        if (ok(`${t} worsened.`) === improvedIsOk) wrong.push(`${scenario}/${role}: "${t} worsened." expected ${improvedIsOk ? "reject" : "accept"}`);
      }
    }
    expect(wrong).toEqual([]);
  });
});

// ---------------------------------------------------------------- 2. magnitude
describe("magnitude guard: no unsupported magnitude expressions", () => {
  it.each([
    ["spelled percent", "Revenue fell forty percent.", "percent"], ["hyphenated spelled percent", "Revenue fell forty-two per cent.", "percent"],
    ["percent sign", "Revenue fell a lot %.", "percent"], ["pct", "Revenue fell forty pct.", "percent"], ["basis points", "Revenue slipped by 100 basis points.", "percent"],
    ["percentage points", "Conversion lost a few percentage points.", "percent"], ["doubled", "Revenue doubled.", "multiple"], ["tripled", "Revenue tripled.", "multiple"],
    ["quadrupled", "Leads quadrupled.", "multiple"], ["halved", "Revenue halved versus Q2.", "multiple"], ["twice", "Leads were twice as many.", "twice"],
    ["multiplied", "Leads multiplied.", "multiple"], ["factor of", "Leads rose by a factor of three.", "multiple"], ["tenfold", "Leads rose tenfold.", "fold"],
    ["two-fold", "Leads rose two-fold.", "fold"], ["times", "Leads rose three times.", "times"], ["times faster", "Revenue fell ten times faster.", "times"],
    ["order of magnitude", "Revenue fell by an order of magnitude.", "order-of-magnitude"], ["double-digit", "Double-digit growth in leads.", "digit-band"],
    ["cut in half", "Revenue was cut in half.", "half"], ["by half", "Revenue fell by half.", "half"], ["half of", "Half of the leads were low quality.", "half"],
    ["a third", "A third of leads were low quality.", "fraction"], ["two thirds", "Revenue shrank by two thirds.", "fraction"], ["three quarters of", "Three quarters of the deals were lost.", "fraction"],
    ["a quarter of", "Revenue collapsed to a quarter of its prior level.", "fraction"], ["thousands", "Thousands of leads arrived.", "scale-word"], ["hundreds", "Hundreds of deals closed.", "scale-word"],
    ["a dozen", "A dozen leads converted.", "scale-word"], ["million", "Revenue was five million dollars.", "scale-word"], ["movement + spelled number", "Revenue fell by thirty.", "spelled-movement"],
    ["movement without preposition", "Revenue fell forty.", "spelled-movement"], ["rose + spelled number", "Leads rose by twenty.", "spelled-movement"],
    ["spelled amount", "Revenue was five dollars short.", "spelled-amount"],
  ])("%s: %s", (_n, text, kind) => {
    expect(magnitudeExpressions(text)).toContain(kind);
    expect(sem(text, "interp").join()).toContain("Semantic guard (magnitude)");
  });
  it("is enforced in every lane", () => {
    expect(sem("Reduce backorders by half.", "rec").join()).toContain("magnitude");
    expect(sem("Need forty percent more data.", "gap").join()).toContain("magnitude");
  });
  it("does not reject ordinary wording that merely resembles a magnitude", () => {
    for (const t of [
      "A percentage of low-intent leads may be misclassified.", "Double check the attribution data before acting.", "One possible explanation is a change in channel mix.",
      "No one owns attribution today.", "Several channels may overlap.", "Both segments were affected.", "A few accounts may distort the picture.", "Run a two week pilot.",
      "Need three more quarters of history.", "Review the first quarter and the last quarter separately.", "The half year review is overdue.", "Multiple channels may be involved.",
      "Pricing and seasonality may both be involved.", "Revenue declined between the two periods.", "Compare the two segments.",
    ]) expect(sem(t, "interp"), t).toEqual([]);
  });
  it("is robust to casing, width, zero-width characters and Unicode dashes", () => {
    for (const t of ["REVENUE FELL FORTY PERCENT.", "Revenue fell forty per\u200Bcent.", "Revenue fell forty\uFF05.", "Revenue DOUBLED.", "Leads rose two\u2011fold.", "Leads rose by a \u0066actor of three."])
      expect(magnitudeExpressions(t).length, t).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------- 3. domain
describe("domain guard: no directional claim about a metric or department outside the role's scope", () => {
  it.each([
    ["finance", "Lead volume increased while conversion fell."], ["finance", "Lead volume may be rising."], ["finance", "Leads are up."], ["finance", "Conversion improved."],
    ["finance", "Sales declined."], ["finance", "Marketing performance weakened."], ["finance", "Backorders rose."], ["finance", "Customer acquisition cost fell."],
    ["finance", "The rise in lead volume is notable."], ["finance", "Fulfillment times fell."], ["finance", "The sales pipeline grew."], ["finance", "Warehouse inventory fell."],
    ["ops", "Revenue fell."], ["ops", "Revenue is down."], ["ops", "Lead quality declined."], ["ops", "Marketing spend fell."],
    ["marketing", "Revenue rose."], ["marketing", "Fulfillment times increased."], ["marketing", "Backorders rose."], ["marketing", "Warehouse operations weakened."],
  ])("%s: %s", (role, text) => {
    expect(sem(text, "interp", role).join()).toContain("Semantic guard (domain)");
  });
  it("applies to proposed actions and gaps too (descriptive wording only)", () => {
    expect(sem("Capitalise on rising lead volume.", "rec", "finance").join()).toContain("domain");
    expect(sem("Backorders rose and we lack data.", "gap", "finance").join()).toContain("domain");
  });
  it("neutral mentions of other domains are NOT rejected (gaps, hand-offs, impact hypotheses)", () => {
    for (const [role, lane, t] of [
      ["ops", "gap", "Revenue and sales data are not visible to this role."], ["finance", "gap", "Sales pipeline data is not available for comparison."],
      ["finance", "rec", "Ask the sales team to confirm the revenue forecast."], ["ops", "interp", "Fulfillment delays may reduce revenue."],
      ["ops", "interp", "Revenue impact cannot be assessed from operations data."], ["finance", "interp", "Customers may be delaying purchases."],
      ["finance", "rec", "Align the forecast with the sales team once data is available."],
    ] as [string, Lane, string][]) expect(sem(t, lane, role), t).toEqual([]);
  });
  it("statements about the role's OWN domains are not domain violations", () => {
    expect(sem("Lead volume rose while lead quality fell.", "interp", "marketing")).toEqual([]);
    expect(sem("Sales team morale fell.", "interp", "marketing")).toEqual([]);
    expect(sem("Backorders rose and fulfillment slowed.", "interp", "ops")).toEqual([]);
  });
  it("property: for every role, every unauthorized metric is rejected when directional and accepted when merely mentioned", () => {
    const TERM: Record<MetricKey, string> = { leads: "Lead volume", mql_rate: "Lead quality", conversion_rate: "Conversion", closed_deals: "Closed deals", fulfillment_days: "Fulfillment time", backorder_rate: "Backorders", revenue: "Revenue", cac: "Customer acquisition cost" };
    const wrong: string[] = [];
    for (const s of SCENARIOS) for (const r of ROLES) {
      const have = new Set(factsFor(r.id, s.id).map((f) => f.metric));
      for (const m of Object.keys(TERM) as MetricKey[]) {
        if (have.has(m)) continue;
        if (sem(`${TERM[m]} rose.`, "interp", r.id, s.id).length === 0) wrong.push(`${s.id}/${r.id}: "${TERM[m]} rose." accepted`);
        if (sem(`${TERM[m]} may be worth a look.`, "interp", r.id, s.id).length !== 0) wrong.push(`${s.id}/${r.id}: neutral "${TERM[m]}" rejected`);
      }
    }
    expect(wrong).toEqual([]);
  });
});

// ---------------------------------------------------------------- lanes
describe("lanes: proposed actions and gaps are checked only for unambiguous descriptive wording", () => {
  it("descriptive past tense / participles in a recommendation are checked", () => {
    expect(sem("Capitalise on rising revenue.", "rec").join()).toContain("direction");
    expect(sem("Revenue rose, so hire more staff.", "rec").join()).toContain("direction");
    expect(sem("Investigate the rising backorder rate and fulfillment delays.", "rec")).toEqual([]);
    expect(sem("Address declining conversion with a lead scoring pilot.", "rec")).toEqual([]);
  });
  it("goal phrasing is never a claim: imperatives, gerunds, nouns, valence", () => {
    for (const t of ["Increase lead quality.", "Raise the threshold.", "Boost conversion.", "Improved conversion tracking would help.", "Consider increasing conversion.", "Achieve a drop in customer acquisition cost.", "Reduce revenue risk."])
      expect(sem(t, "rec"), t).toEqual([]);
  });
});

// ---------------------------------------------------------------- evasion robustness
describe("normalisation: obfuscation does not hide a contradiction or a domain claim", () => {
  it.each([
    ["upper case", "REVENUE ROSE."], ["zero-width inside the verb", "Revenue r\u200Bose."], ["full-width letter", "\uFF32evenue rose."],
    ["soft hyphen", "Reve\u00ADnue rose."], ["combining accent", "Reve\u0301nue rose."], ["bidi marks", "\u202ERevenue rose.\u202C"],
    ["extra whitespace", "Revenue   \n  rose."], ["curly apostrophe negation", "Revenue didn\u2019t fall."], ["contraction", "Revenue hasn't fallen."],
  ])("%s", (_n, text) => {
    expect(sem(text, "interp").join()).toContain("Semantic guard (direction)");
  });
  it("semanticText folds width, case, marks, invisibles, dashes and contractions", () => {
    expect(semanticText("Lower\u2011Quality\u00A0Leads \u2013 can\u2019t")).toBe("lower quality leads cannot");
    expect(semanticText("\uFF32\uFF25\uFF36\uFF25\uFF2E\uFF35\uFF25")).toBe("revenue");
  });
  it("hyphenated legitimate words are still accepted", () => {
    for (const t of ["Paid social may attract lower\u2011quality leads.", "Double\u2011check the attribution data.", "Lead\u2011scoring changes may matter."])
      expect(sem(t, "interp"), t).toEqual([]);
  });
});

// ---------------------------------------------------------------- integration
describe("integration: rejected, never rewritten; architecture unchanged", () => {
  it("accepted text passes through byte-for-byte (no silent rewriting)", () => {
    const text = "Lead volume rose while conversion fell, so lower-intent leads may be diluting the pipeline.";
    const v = validateOutput(JSON.stringify(body(text, "interp", "exec")), authorizedRecords(req()), ALL());
    expect(v.ok && v.output.interpretations[0]!.text).toBe(text);
  });
  it("a rejection returns errors only: no output and no findings", () => {
    const v = validateOutput(JSON.stringify(body("Revenue rose sharply.", "interp", "exec")), authorizedRecords(req()), ALL());
    expect(v.ok).toBe(false);
    expect("output" in v || "findings" in v).toBe(false);
    if (!v.ok) expect(v.errors.join()).toContain("Semantic guard (direction)");
  });
  it("runMeta reports a semantic rejection after exactly one request, never retried", async () => {
    const f = reply(body("Revenue rose sharply.", "interp", "exec"));
    const r = await runMeta(req(), READY, f as never);
    expect(r.state).toBe("rejected");
    expect(r.requestSent).toBe(true);
    expect(r.state === "rejected" && r.errors.join()).toContain("Semantic guard (direction)");
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("verified findings, derived citations and approval gating are unchanged for accepted output", async () => {
    const o = {
      interpretations: [{ text: "Lead volume rose while conversion fell.", verified: false, refs: ["F-leads", "F-conversion_rate"] }],
      missing_evidence: ["No attribution data by channel."],
      recommendations: [{ text: "Review channel mix toward higher-quality sources.", requires_human_approval: true, refs: ["F-mql_rate"] }],
    };
    const r = await runMeta(req(), READY, reply(o) as never);
    if (r.state !== "ok") throw new Error(`expected ok, got ${r.state}`);
    expect(r.findings.find((x) => x.fact_id === "F-revenue")!.text).toBe("Recognized revenue decreased: $1,240,000 → $1,018,000 (-17.9% relative)");
    expect(r.output.interpretations[0]!.verified).toBe(false);
    expect(r.output.recommendations[0]!.requires_human_approval).toBe(true);
    expect(r.output.interpretations[0]!.supporting_ids).toEqual(["VH-MKT-001-Q2", "VH-MKT-001-Q3", "VH-SAL-001-Q2", "VH-SAL-001-Q3"].filter((id) => r.output.interpretations[0]!.supporting_ids.includes(id)));
    expect(r.output.interpretations[0]!.supporting_ids).toHaveLength(4);
  });
  it("earlier gates still run: unknown refs, numerals and causal wording are still rejected", () => {
    const refs = { ...body("Mix may matter.", "interp", "exec"), interpretations: [{ text: "Mix may matter.", verified: false, refs: ["F-nope"] }] };
    expect(validateOutput(JSON.stringify(refs), authorizedRecords(req()), ALL()).ok).toBe(false);
    expect(validate("Revenue fell 17.9%.", "interp")).toContain("Numeral");
    expect(validate("Delays caused the decline.", "interp")).toContain("Causal-proof");
  });
  it("the system prompt tells the model about the new rules; input stays under budget for every role x scenario", () => {
    const sys = buildMessages("q", authorizedRecords(req()))[0]!.content;
    expect(sys).toMatch(/spell out numbers, fractions or multiples/);
    expect(sys).toMatch(/not in VERIFIED_FACTS/);
    for (const s of SCENARIOS) for (const r of ROLES) expect(estimateTokens(JSON.stringify(buildMessages("q", authorizedRecords(req(r.id, s.id)))))).toBeLessThan(MAX_INPUT_TOKENS);
  });
});

// ---------------------------------------------------------------- residual limitations
describe("residual limitations (documented, pinned)", () => {
  it("lists the known gaps, including cross-script look-alikes and paraphrases", () => {
    const all = RESIDUAL_LIMITATIONS.join(" ");
    expect(all).toMatch(/look-alike/i);
    expect(all).toMatch(/[Pp]araphrases/);
    expect(all).toMatch(/Elided subjects/);
    expect(all).toMatch(/Comparatives/);
  });
  it("cross-script look-alike: a Cyrillic letter inside the metric word evades term matching", () => {
    expect(sem("R\u0435venue rose.", "interp")).toEqual([]); // Cyrillic small ie
  });
  it("paraphrase: an unlisted description of the same change is not recognised", () => {
    expect(sem("The top of the funnel got much bigger.", "interp", "finance")).toEqual([]);
  });
  it("elided subject across clauses is not tracked", () => {
    expect(sem("Revenue slipped, then recovered strongly.", "interp")).toEqual([]);
  });
  it("qualitative strength words are not magnitude-checked", () => {
    expect(sem("Revenue fell dramatically.", "interp")).toEqual([]);
  });
});

// ================================================================ Phase 2B-2 corrective pass
// ---------------------------------------------------------------- B1: subject binding
describe("B1: the head metric is the subject, not a nearby secondary metric or department", () => {
  // baseline x exec: revenue DOWN, leads UP, conversion DOWN, CAC UP
  it.each([
    "Revenue from new leads rose.", "Revenue from leads rose.", "Revenue of new leads grew.", "Revenue from marketing campaigns grew.",
    "Conversion of qualified leads improved.", "Sales revenue from the campaign grew.", "Revenue per closed deal rose.",
    "Revenue from the long tail of accounts grew.", "Revenue from enterprise leads rose.", "Total revenue from all channels has risen.",
    "Conversion in the enterprise segment is improving.", "Conversion across the new lead segments improved.",
  ])("a contradiction about the head metric is rejected: %s", (text) => {
    expect(sem(text, "interp").join()).toContain("Semantic guard (direction)");
  });
  it.each([
    "Revenue from new leads fell.", "Conversion of new leads fell.", "Conversion of qualified leads has declined.", "Revenue from enterprise leads fell.",
    "Revenue from the long tail of accounts fell.", "Sales revenue from the campaign declined.", "Conversion in the enterprise segment is weaker.",
  ])("a consistent statement about the head metric is accepted, even though a nearer metric disagrees: %s", (text) => {
    expect(sem(text, "interp"), text).toEqual([]);
  });
  it("the nearer secondary metric or department never becomes the subject", () => {
    const only = (t: string) => directionalClaims(t, "interpretation").flatMap((c) => c.entities.map((e) => e.key));
    expect(only("Revenue from new leads rose.")).toEqual(["revenue"]);
    expect(only("Conversion of new leads fell.")).toEqual(["conversion_rate"]);
    expect(only("Sales revenue from the campaign grew.")).toEqual(["revenue"]);
    expect(only("Revenue from paid social campaigns fell.")).toEqual(["revenue"]);
  });
  it("apposition: the commented-off phrase is dropped before binding", () => {
    expect(sem("Revenue, driven by new leads, rose.", "interp").join()).toContain("(direction)");
    expect(sem("Revenue, helped by pricing, rose.", "interp").join()).toContain("(direction)");
    expect(sem("Revenue, driven by new leads, fell.", "interp")).toEqual([]);
    expect(sem("Revenue, which was lifted by new leads, fell.", "interp")).toEqual([]);
  });
  it("in-scope sentences with an out-of-scope modifier are not domain violations (finance)", () => {
    for (const t of ["Revenue from sales declined.", "Revenue from paid social campaigns fell.", "Sales revenue declined.", "Revenue from marketing campaigns fell."])
      expect(sem(t, "interp", "finance"), t).toEqual([]);
    expect(sem("Revenue from sales rose.", "interp", "finance").join()).toContain("(direction)"); // still a contradiction about revenue
  });
  it("an out-of-scope HEAD is still a domain violation even when a modifier is in scope (ops)", () => {
    expect(sem("Revenue from enterprise deals rose.", "interp", "ops").join()).toContain("(domain)");
    expect(sem("Revenue per lead improved.", "interp", "marketing").join()).toContain("(domain)");
    expect(sem("Revenue from existing customers fell.", "interp", "ops").join()).toContain("(domain)");
  });
  it("ambiguous binding yields no claim (nothing is inferred or rejected)", () => {
    for (const t of ["Revenue versus conversion rose.", "Revenue against leads fell.", "Conversion relative to revenue improved."]) {
      expect(directionalClaims(t, "interpretation"), t).toEqual([]);
      expect(sem(t, "interp"), t).toEqual([]);
    }
  });
  it("explicit conjunctions still bind every conjunct", () => {
    expect(sem("Revenue and conversion both rose.", "interp").join()).toContain("(direction)");
    expect(sem("Lead volume and backorders rose.", "interp")).toEqual([]);
    expect(sem("Revenue from leads and campaigns rose.", "interp").join()).toContain("(direction)");
  });
  it("a measure noun between metric and verb is the same subject; an unrelated noun is not", () => {
    expect(sem("Revenue performance strengthened.", "interp").join()).toContain("(direction)");
    expect(sem("Revenue concerns have grown.", "interp")).toEqual([]);
    expect(sem("Conversion issues increased.", "interp")).toEqual([]);
  });
});

// ---------------------------------------------------------------- B2: context-sensitive magnitude
describe("B2: magnitude words are checked where they describe performance, not ordinary process language", () => {
  it.each([
    ["rec", "Review the funnel twice a week."], ["rec", "Review revenue twice a week."], ["rec", "Split the lead-score pilot in half to compare two gates."],
    ["rec", "Follow up with each lead three times before closing."], ["rec", "Check conversion three times a week."], ["interp", "A third explanation is seasonality."],
    ["rec", "Interview a dozen customers who churned."], ["rec", "Pull a hundred closed-lost records for review."], ["rec", "Allocate a quarter of the team's time to triage."],
    ["rec", "Address the two points raised by sales."], ["gap", "Take half a day to audit lead sources."], ["rec", "Run the lead-score pilot on half of inbound leads."],
    ["rec", "Compare closed deals across a third segment."], ["rec", "Prioritise the dozen largest backorders."], ["gap", "Need three times more history to judge."],
    ["gap", "A third data source for lead attribution is missing."], ["rec", "Contact each lead twice before handing off."], ["interp", "Both of the two segments overlap."],
    ["interp", "Conversion is reviewed twice a week by the team."], ["interp", "Revenue is reported twice a month."], ["interp", "Backorders are checked twice per day."],
  ] as [Lane, string][])("process language is accepted (%s): %s", (lane, text) => {
    expect(sem(text, lane).filter((m) => m.includes("(magnitude)")), text).toEqual([]);
  });
  it.each([
    ["interp", "Half of the leads were low quality."], ["interp", "A third of leads were low quality."], ["interp", "Three quarters of the deals were lost."],
    ["interp", "Revenue fell by half."], ["interp", "Revenue was cut in half."], ["interp", "Leads were twice as many."], ["interp", "Revenue fell ten times faster."],
    ["interp", "Leads rose three times."], ["interp", "Thousands of leads arrived."], ["interp", "A dozen leads converted."], ["interp", "Revenue was five dollars short."],
    ["interp", "Revenue shrank by two thirds."], ["interp", "Revenue collapsed to a quarter of its prior level."], ["interp", "Revenue was cut by a third."],
    ["rec", "Reduce backorders by half."], ["rec", "Cut backorders by a third."], ["rec", "Grow leads tenfold."], ["gap", "Need forty percent more data."],
  ] as [Lane, string][])("unsupported quantitative claims about metric performance are rejected (%s): %s", (lane, text) => {
    expect(sem(text, lane).join(), text).toContain("(magnitude)");
  });
  it("inherently quantitative forms are rejected in every lane and context", () => {
    for (const lane of ["interp", "rec", "gap"] as Lane[]) for (const t of ["Forty percent of the plan is done.", "The pilot doubled the sample.", "Aim for double-digit coverage.", "A tenfold increase in effort."])
      expect(sem(t, lane).join(), `${lane}: ${t}`).toContain("(magnitude)");
  });
  it("cadence is exempt even in an interpretation that mentions a metric, but a multiplier of the metric is not", () => {
    expect(magnitudeExpressions("Conversion is reviewed twice a week by the team.", "interpretation")).toEqual([]);
    expect(magnitudeExpressions("Conversion was twice the prior level.", "interpretation")).toContain("twice");
  });
  it("lanes differ: a clause in an action or gap needs a metric AND a movement/target word; an interpretation needs only a metric", () => {
    expect(magnitudeExpressions("Pull a hundred leads for review.", "recommendation")).toEqual([]);
    expect(magnitudeExpressions("Pull a hundred leads for review.", "interpretation")).toContain("scale-word");
    expect(magnitudeExpressions("Reduce leads by half.", "recommendation")).toContain("half");
    expect(magnitudeExpressions("A dozen leads in the review.", "gap")).toEqual([]);
  });
  it("messages name the kind of expression but never echo the text", () => {
    const [m] = sem("Half of the leads were low quality.", "interp");
    expect(m).toContain("unsupported half expression");
    expect(m).not.toContain("leads were low");
  });
});

// ---------------------------------------------------------------- S5-S7: language context
describe("S5-S7: habitual statements, non-metric subjects, questions and monitoring are not claims about the verified period", () => {
  it.each([
    "Revenue typically rises in the fourth quarter.", "Retail revenue usually climbs before the holidays.", "Seasonally, lead volume often falls in summer.",
    "Conversion generally improves when follow-up is faster.", "Closed deals tend to slip when fulfillment delays grow.", "Lead volume historically rises in Q4.",
    "On average, revenue rises in the holiday season.",
  ])("habitual or generic: %s", (text) => {
    expect(sem(text, "interp"), text).toEqual([]);
  });
  it.each([
    "Lead volume fell short of the target.", "Lead volume fell flat.", "Revenue rose to the occasion.", "Conversion fell behind plan.",
  ])("idiom: %s", (text) => {
    expect(sem(text, "interp"), text).toEqual([]);
  });
  it.each([
    "Concern about revenue grew.", "Pressure on revenue rose.", "Questions about conversion have increased.", "Interest in lead quality has grown across the team.",
    "Customer complaints about conversion rose.", "Scrutiny of closed deals has risen.", "Revenue concerns have grown.",
  ])("non-metric subject: %s", (text) => {
    expect(sem(text, "interp"), text).toEqual([]);
  });
  it.each(["Is revenue still falling?", "Why did conversion fall while lead volume rose?", "Did revenue rise?", "Has lead quality improved?"])("question: %s", (text) => {
    expect(sem(text, "interp"), text).toEqual([]);
  });
  it.each([
    "Watch whether revenue is rising again next quarter.", "Monitor whether backorders keep falling.", "Watch for revenue rising in Q4.",
    "Track revenue as it rises.", "Monitor revenue rising after the pricing change.", "Check if conversion is improving.",
  ])("monitoring recommendation: %s", (text) => {
    expect(sem(text, "rec"), text).toEqual([]);
  });
  it("actual contradictions are still rejected next to those exemptions", () => {
    for (const t of ["Revenue rose.", "Revenue rose, and it typically rises in Q4.", "Pressure on revenue rose and revenue grew.", "Is revenue falling? Revenue rose."])
      expect(sem(t, "interp").join(), t).toContain("(direction)");
    for (const t of ["Capitalise on rising revenue.", "Revenue rose, so hire more staff."]) expect(sem(t, "rec").join(), t).toContain("(direction)");
  });
  it("a monitoring directive does not exempt a claim about an unauthorized domain", () => {
    expect(sem("Watch lead volume rising.", "rec", "finance").join()).toContain("(domain)");
  });
});

// ---------------------------------------------------------------- S9: unauthorized vs unavailable
describe("S9: unavailable data is distinguished from unauthorized data", () => {
  it("a role with no authority over the department gets a domain error", () => {
    const [i] = issues("Customer acquisition cost rose.", "interp", "finance");
    expect(i!.code).toBe("domain");
    expect(i!.message).toContain("outside this role's authorized scope");
  });
  it("an authorized department whose metric has no data in this scenario gets an unavailable error", () => {
    const [i] = issues("Customer acquisition cost rose.", "interp", "exec", "quality-only");
    expect(i!.code).toBe("unavailable");
    expect(i!.message).toContain("no verified data is available in this scenario");
    expect(i!.message).not.toContain("authorized scope");
  });
  it("the same metric with data is compared to its verified finding (baseline)", () => {
    expect(issues("Customer acquisition cost rose.", "interp", "exec", "baseline")).toEqual([]);
    expect(issues("Customer acquisition cost fell.", "interp", "exec", "baseline")[0]!.code).toBe("direction");
  });
  it("matrix: every scenario x role x metric is classified as domain / unavailable / compared exactly as its scope dictates", () => {
    const TERM: Record<MetricKey, string> = { leads: "Lead volume", mql_rate: "Lead quality", conversion_rate: "Conversion", closed_deals: "Closed deals", fulfillment_days: "Fulfillment time", backorder_rate: "Backorders", revenue: "Revenue", cac: "Customer acquisition cost" };
    const wrong: string[] = [];
    for (const sc of SCENARIOS) for (const r of ROLES) {
      const recs = authorizedRecords(req(r.id, sc.id));
      const depts = new Set(recs.map((x) => x.department));
      const have = new Set(buildVerifiedFacts(recs).map((f) => f.metric));
      for (const m of Object.keys(TERM) as MetricKey[]) {
        const got = issues(`${TERM[m]} rose.`, "interp", r.id, sc.id).map((i) => i.code);
        const want = !depts.has(METRIC_DEPARTMENT[m]) ? ["domain"] : !have.has(m) ? ["unavailable"] : null;
        if (want ? got.join() !== want.join() : got.some((c) => c !== "direction")) wrong.push(`${sc.id}/${r.id}/${m}: got [${got}] want ${want ?? "direction-or-none"}`);
      }
    }
    expect(wrong).toEqual([]);
  });
  it("METRIC_DEPARTMENT agrees with the data for every record in every scenario", () => {
    for (const sc of SCENARIOS) for (const r of sc.records) expect(METRIC_DEPARTMENT[r.metric], `${sc.id}/${r.id}`).toBe(r.department);
  });
});
