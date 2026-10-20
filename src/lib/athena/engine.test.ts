import { describe, expect, it } from "vitest";
import { DEPT_WORKSPACE, METRIC_LABELS, PERIODS, ROLES, SCENARIOS, WORKSPACES, build, type MetricKey } from "./data";
import { analyze, computeFacts, filterVisible } from "./engine";
import { approvalReducer, decisionOf } from "./approvals";
import { metaProviderStub, deterministicProvider } from "./provider";

const ALL = WORKSPACES.map((w) => w.id);
const sc = (id: string) => SCENARIOS.find((s) => s.id === id)!;
const fact = (id: string, m: MetricKey) => computeFacts(sc(id).records).find((f) => f.metric === m)!;

// Every subset of workspaces (16), not just the predefined roles.
const SUBSETS: string[][] = Array.from({ length: 1 << ALL.length }, (_, mask) => ALL.filter((_, i) => mask & (1 << i)));

describe("calculations", () => {
  it("uses prior period as the percentage-change denominator", () => {
    expect(fact("baseline", "leads").changePct).toBe(50); // (6300-4200)/4200
    expect(fact("baseline", "revenue").changePct).toBe(-17.9); // (1018000-1240000)/1240000
    expect(fact("baseline", "backorder_rate").changePct).toBe(325); // (17-4)/4
  });
  it("reports percentage-point change for rate metrics", () => {
    expect(fact("baseline", "mql_rate").changePp).toBe(-13);
    expect(fact("baseline", "conversion_rate").changePp).toBe(-4.1);
    expect(fact("baseline", "leads").changePp).toBeNull();
  });
  it("treats changes under 3% as flat", () => {
    expect(fact("quality-only", "fulfillment_days").direction).toBe("flat");
    expect(fact("ops-only", "mql_rate").direction).toBe("flat");
  });
  it("closed deals ≈ leads × conversion rate in every scenario (within 1 deal)", () => {
    for (const s of SCENARIOS) {
      for (const period of ["prior", "current"] as const) {
        const v = (m: MetricKey) => s.records.find((r) => r.metric === m && r.period === period)!.value;
        expect(Math.abs(v("leads") * (v("conversion_rate") / 100) - v("closed_deals"))).toBeLessThanOrEqual(1);
      }
    }
  });
  it("drops a metric with duplicate or missing period records instead of guessing", () => {
    const recs = sc("baseline").records.filter((r) => !(r.metric === "leads" && r.period === "prior"));
    expect(computeFacts(recs).find((f) => f.metric === "leads")).toBeUndefined();
  });
});

describe("evidence provenance", () => {
  it("record IDs are unique across all scenarios", () => {
    const ids = SCENARIOS.flatMap((s) => s.records.map((r) => r.id));
    expect(new Set(ids).size).toBe(ids.length);
  });
  it("records carry correct period dates and department workspace", () => {
    for (const s of SCENARIOS) for (const r of s.records) {
      expect(r.date).toBe(PERIODS[r.period].date);
      expect(r.workspace).toBe(DEPT_WORKSPACE[r.department]);
      expect(r.id.endsWith(r.period === "prior" ? "-Q2" : "-Q3")).toBe(true);
    }
  });
  it("build rejects a workspace that does not match the department", () => {
    expect(() => build("X", [["leads", "Marketing", "ws-sales", "src", 1, 2, "leads"]])).toThrow();
  });
  it("every cited ID resolves to a visible record with matching metric and value", () => {
    for (const s of SCENARIOS) for (const ws of SUBSETS) {
      const a = analyze(s.records, ws);
      const vis = new Map(filterVisible(s.records, ws).map((r) => [r.id, r]));
      for (const f of a.facts) {
        const [p, c] = f.evidenceIds.map((id) => vis.get(id)!);
        expect(p!.metric).toBe(f.metric); expect(c!.metric).toBe(f.metric);
        expect(p!.value).toBe(f.prior); expect(c!.value).toBe(f.current);
      }
      const all = [...a.signals, ...a.hypotheses, ...a.actions].flatMap((x) => x.evidenceIds);
      all.forEach((id) => expect(vis.has(id)).toBe(true));
    }
  });
});

describe("signals vs hypotheses", () => {
  it("signals only describe observation, never causation", () => {
    const a = analyze(sc("baseline").records, ALL);
    expect(a.signals.every((s) => s.status === "observed")).toBe(true);
    expect(a.hypotheses.every((h) => h.verified === false)).toBe(true);
  });
  it("scenario B does not observe a fulfillment increase", () => {
    expect(analyze(sc("quality-only").records, ALL).signals.find((s) => s.key === "fulfillment")!.status).toBe("not-observed");
  });
  it("scenario C does not observe a lead-quality decrease and has no lead-mix hypothesis", () => {
    const a = analyze(sc("ops-only").records, ALL);
    expect(a.signals.find((s) => s.key === "quality")!.status).toBe("not-observed");
    expect(a.hypotheses.some((h) => h.title.includes("lead mix"))).toBe(false);
  });
});

describe("simulated permission leakage", () => {
  const roleSets = [...ROLES.map((r) => r.workspaces), ...SUBSETS];
  it("no hidden ID, source, metric label, department or total count appears in any output", () => {
    for (const s of SCENARIOS) for (const ws of roleSets) {
      const a = analyze(s.records, ws);
      const out = JSON.stringify(a);
      const hidden = s.records.filter((r) => !ws.includes(r.workspace));
      const visibleDepts = new Set(filterVisible(s.records, ws).map((r) => r.department));
      const visibleMetrics = new Set(filterVisible(s.records, ws).map((r) => r.metric));
      for (const r of hidden) {
        expect(out).not.toContain(r.id);
        if (!visibleMetrics.has(r.metric)) expect(out).not.toContain(METRIC_LABELS[r.metric]);
        if (!visibleDepts.has(r.department)) expect(out).not.toContain(`"${r.department}"`);
        if (!filterVisible(s.records, ws).some((v) => v.source === r.source)) expect(out).not.toContain(r.source);
      }
      expect(a.visibleRecordCount).toBe(s.records.length - hidden.length);
      expect(out).not.toMatch(/hidden/i);
    }
  });
  it("empty workspace set produces no facts, hypotheses or actions", () => {
    const a = analyze(sc("baseline").records, []);
    expect([a.facts.length, a.hypotheses.length, a.actions.length, a.citedIds.length]).toEqual([0, 0, 0, 0]);
    expect(a.evidenceCoverage).toBe("Minimal");
  });
  it("finance-only role sees only revenue and no marketing/sales actions", () => {
    const a = analyze(sc("baseline").records, ["ws-finance"]);
    expect(a.facts.map((f) => f.metric)).toEqual(["revenue"]);
    expect(a.actions.map((x) => x.owner)).toEqual(["Finance"]);
    expect(a.hypotheses).toEqual([]);
  });
  it("deterministic provider summary cites only visible IDs", async () => {
    for (const s of SCENARIOS) for (const ws of SUBSETS) {
      const vis = new Set(filterVisible(s.records, ws).map((r) => r.id));
      const res = (await deterministicProvider.summarize(analyze(s.records, ws)))!;
      res.citedIds.forEach((id) => expect(vis.has(id)).toBe(true));
    }
  });
});

describe("simulated approvals", () => {
  it("pending → approved, then cannot flip to rejected without undo", () => {
    let s = approvalReducer({}, { type: "approve", id: "A" });
    expect(decisionOf(s, "A")).toBe("approved");
    s = approvalReducer(s, { type: "reject", id: "A" });
    expect(decisionOf(s, "A")).toBe("approved");
    s = approvalReducer(s, { type: "undo", id: "A" });
    expect(decisionOf(s, "A")).toBe("pending");
    s = approvalReducer(s, { type: "reject", id: "A" });
    expect(decisionOf(s, "A")).toBe("rejected");
  });
  it("reset clears all decisions and does not mutate input", () => {
    const s0 = { A: "approved" as const };
    expect(approvalReducer(s0, { type: "reset" })).toEqual({});
    expect(s0).toEqual({ A: "approved" });
  });
  it("all actions require approval", () => {
    expect(analyze(sc("baseline").records, ALL).actions.every((x) => x.requiresApproval)).toBe(true);
  });
});

describe("meta provider stub", () => {
  it("returns no output and is not configured", async () => {
    expect(metaProviderStub.status).toBe("not-configured");
    expect(await metaProviderStub.summarize(analyze(sc("baseline").records, ALL))).toBeNull();
  });
});
