import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ROLES, SCENARIOS } from "../data";
import { runPrototypeImpact } from "../meta/adapter.server";

// NEW snapshot (the existing combos.json is untouched): the Business Impact Map for every scenario/role with two business questions. It pins the deterministic
// output so that any change to wording, scope, ordering or evidence tracing is a reviewed change. Regenerate deliberately with UPDATE_GOLDEN=1.
const FILE = "src/lib/athena/golden/impact.json";
const QUESTIONS = { revenueVsLeads: "Why is revenue down while lead volume is rising?", fulfillmentVsSales: "Is slower fulfillment hurting sales?" };

async function capture() {
  const out: Record<string, unknown> = {};
  for (const sc of SCENARIOS) for (const role of ROLES) for (const [qn, q] of Object.entries(QUESTIONS)) {
    const r = await runPrototypeImpact({ scenarioId: sc.id, roleId: role.id, ownerConfirmed: true, question: q });
    out[`${sc.id}/${role.id}/${qn}`] = r;
  }
  return out;
}

describe("golden snapshot: Business Impact Maps (prototype dataset)", () => {
  it("covers every scenario, role and question", async () => {
    expect(Object.keys(await capture())).toHaveLength(SCENARIOS.length * ROLES.length * Object.keys(QUESTIONS).length);
  });
  it("matches the captured file exactly", async () => {
    const now = JSON.parse(JSON.stringify(await capture()));
    if (process.env["UPDATE_GOLDEN"] === "1") { writeFileSync(FILE, JSON.stringify(now, null, 1) + "\n"); return; }
    expect(existsSync(FILE)).toBe(true);
    expect(now).toEqual(JSON.parse(readFileSync(FILE, "utf8")));
  });
});
