import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ROLES, SCENARIOS } from "../data";
import { analyze } from "../engine";
import { RESPONSE_FORMAT, authorizedRecords, buildMessages, estimateTokens, validateOutput } from "../meta/contract";
import { factsBlockReason } from "../meta/adapter.server";
import { buildVerifiedFacts } from "../meta/numericGrounding";
import { renderFindings } from "../meta/findings";
import { DEMO_QUESTION } from "../engine";

// Golden snapshots for all scenario/role combinations. Captured from the pre-catalog code and compared after the refactor:
// verified findings, citations, analysis, prompt text, token estimates and validation decisions must be byte-identical.
// Regenerate deliberately with UPDATE_GOLDEN=1 (never as part of a refactor).
const FILE = "src/lib/athena/golden/combos.json"; // vitest runs from the repo root

const lane = (text: string, refs = ["F-revenue"]) => JSON.stringify({ interpretations: [{ text, verified: false, refs }], missing_evidence: [], recommendations: [] });
const act = (text: string) => JSON.stringify({ interpretations: [], missing_evidence: [], recommendations: [{ text, requires_human_approval: true, refs: ["F-revenue"] }] });
const gap = (text: string) => JSON.stringify({ interpretations: [], missing_evidence: [text], recommendations: [] });
const PROBES: [string, (hiddenId: string, hiddenSource: string) => string][] = [
  ["benign", () => lane("Lead mix may matter.")],
  ["benign-refs", () => lane("Mix may matter.", ["F-leads", "F-revenue"])],
  ["unknown-ref", () => lane("Mix may matter.", ["F-nope"])],
  ["rev-rose", () => lane("Revenue rose.")],
  ["rev-fell", () => lane("Revenue fell.")],
  ["rev-flat", () => lane("Revenue was flat.")],
  ["leads-fell", () => lane("Lead volume fell.")],
  ["leads-rose", () => lane("Lead volume rose.")],
  ["mql-rose", () => lane("Lead quality improved.")],
  ["conv-rose", () => lane("Sales conversion rose.")],
  ["deals-rose", () => lane("Closed deals rose.")],
  ["ful-fell", () => lane("Fulfillment time fell.")],
  ["back-fell", () => lane("The backorder rate dropped.")],
  ["cac-fell", () => lane("Customer acquisition cost fell.")],
  ["mkt-weak", () => lane("Marketing performance weakened.")],
  ["ops-improved", () => lane("Operations improved.")],
  ["fin-grew", () => lane("Finance budgets grew.")],
  ["sales-fell", () => lane("The sales pipeline shrank.")],
  ["numeral", () => lane("Revenue fell 40%.")],
  ["numeral-word", () => lane("Revenue fell forty percent.")],
  ["magnitude", () => lane("Revenue doubled.")],
  ["causal", () => lane("Delays caused the decline.")],
  ["causal-action", () => act("Investigate what caused the decline.")],
  ["action-benign", () => act("Review the channel mix with the team.")],
  ["action-rev", () => act("Re-forecast revenue next quarter.")],
  ["gap-benign", () => gap("No seasonal baseline is available.")],
  ["gap-claim", () => gap("Revenue rose but data is missing.")],
  ["leak-id", (id) => lane(`See ${id} for context.`)],
  ["leak-source", (_id, src) => lane(`Check ${src} data.`)],
  ["leak-multi", (id) => lane(`Delays caused ${id} to fall 40% and revenue rose.`)],
  ["legacy", () => JSON.stringify({ observations: [], hypotheses: [], missing_evidence: [], recommendations: [] })],
  ["bad-json", () => "not json"],
  ["extra-key", () => JSON.stringify({ interpretations: [], missing_evidence: [], recommendations: [], x: 1 })],
  ["ambiguous", () => lane("Revenue versus conversion rose.")],
  ["negated", () => lane("Revenue did not fall.")],
  ["habitual", () => lane("Leads typically rise in the summer.")],
];

function capture() {
  const out: Record<string, unknown> = {};
  for (const sc of SCENARIOS) {
    for (const role of ROLES) {
      const req = { scenarioId: sc.id, roleId: role.id };
      const auth = authorizedRecords(req);
      const hidden = sc.records.filter((r) => !auth.some((a) => a.id === r.id));
      const hid = hidden[0]?.id ?? "NONE-000", hsrc = hidden[0]?.source ?? "NONE SOURCE";
      const messages = buildMessages(DEMO_QUESTION, auth);
      const a = analyze(sc.records, role.workspaces);
      out[`${sc.id}/${role.id}`] = {
        authorizedIds: auth.map((r) => r.id),
        verifiedFacts: buildVerifiedFacts(auth),
        findings: renderFindings(auth),
        analysis: a,
        blockReason: factsBlockReason(auth),
        messages,
        estimatedTokens: estimateTokens(JSON.stringify(messages)),
        validation: Object.fromEntries(PROBES.map(([name, make]) => [name, validateOutput(make(hid, hsrc), auth, sc.records)])),
      };
    }
  }
  return { responseFormat: RESPONSE_FORMAT, combos: out };
}

describe("golden snapshots (all scenario/role combinations)", () => {
  it("covers every scenario/role combination", () => {
    expect(Object.keys(capture().combos)).toHaveLength(SCENARIOS.length * ROLES.length);
    expect(SCENARIOS.length * ROLES.length).toBe(12);
  });
  it("matches the captured golden file exactly", () => {
    const now = JSON.parse(JSON.stringify(capture()));
    if (process.env["UPDATE_GOLDEN"] === "1") { writeFileSync(FILE, JSON.stringify(now, null, 1) + "\n"); return; }
    expect(existsSync(FILE)).toBe(true);
    expect(now).toEqual(JSON.parse(readFileSync(FILE, "utf8")));
  });
});
