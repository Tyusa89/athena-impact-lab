import { describe, expect, it } from "vitest";
import { SCENARIOS, ROLES } from "./data";
import { analyze } from "./engine";
import { metaProviderStub } from "./provider";

const all = ROLES[0]!.workspaces;
const sc = (id: string) => SCENARIOS.find((s) => s.id === id)!;

describe("Athena engine", () => {
  it("baseline supports all five chain links for exec", () => {
    const a = analyze(sc("baseline").records, all);
    expect(a.chain.map((c) => c.status)).toEqual(Array(5).fill("supported"));
  });
  it("quality-only does not support fulfillment link", () => {
    const a = analyze(sc("quality-only").records, all);
    expect(a.chain.find((c) => c.key === "fulfillment")!.status).toBe("not-supported");
  });
  it("hidden records never appear in output", () => {
    for (const s of SCENARIOS) for (const r of ROLES) {
      const a = analyze(s.records, r.workspaces);
      const hidden = new Set(s.records.filter((x) => !r.workspaces.includes(x.workspace)).map((x) => x.id));
      const out = JSON.stringify(a);
      hidden.forEach((id) => expect(out).not.toContain(id));
    }
  });
  it("finance-only role marks marketing links insufficient", () => {
    const a = analyze(sc("baseline").records, ["ws-finance"]);
    expect(a.chain.find((c) => c.key === "leads")!.status).toBe("insufficient-evidence");
    expect(a.overallConfidence).toBe("Low");
  });
  it("all actions require human approval", () => {
    expect(analyze(sc("baseline").records, all).actions.every((x) => x.requiresApproval)).toBe(true);
  });
  it("meta stub returns no fabricated output", async () => {
    expect(await metaProviderStub.summarize(analyze(sc("baseline").records, all))).toBeNull();
  });
});
