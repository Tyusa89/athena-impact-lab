import { afterEach, describe, expect, it, vi } from "vitest";
import { METRIC_LABELS, ROLES, SCENARIOS, type MetricKey } from "../data";
import { runMeta } from "./adapter.server";
import { authorizedRecords, validateOutput } from "./contract";
import { buildVerifiedFacts } from "./numericGrounding";

// S8: client-visible validation errors must never disclose unauthorized identifiers. No network: fetch is a local fake.
const READY = { META_MODEL_API_KEY: "test-key", META_MODEL_ENABLED: "true" };
const req = (roleId: string, scenarioId: string) => ({ scenarioId, roleId, ownerConfirmed: true });
const reply = (content: unknown) =>
  vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) }, finish_reason: "stop" }], usage: { prompt_tokens: 900, completion_tokens: 200 } }), { status: 200 }));
const lane = (text: string, refs = ["F-revenue"]) => ({
  interpretations: [{ text, verified: false, refs }],
  missing_evidence: [] as string[],
  recommendations: [] as unknown[],
});
const zw = (s: string) => s.replace(/-/g, "​-");
const fullwidth = (s: string) => s.replace(/[A-Za-z0-9]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0));
const dashes = (s: string) => s.replace(/-/g, "–");

afterEach(() => vi.restoreAllMocks());

/** Everything about this role/scenario that the role must never learn from an error. */
function forbidden(role: string, scenario: string) {
  const sc = SCENARIOS.find((s) => s.id === scenario)!;
  const authorized = authorizedRecords(req(role, scenario));
  const allowed = new Set(authorized.map((r) => r.id));
  const have = new Set(buildVerifiedFacts(authorized).map((f) => f.metric));
  const depts = new Set(authorized.map((r) => r.department));
  const hiddenRecords = sc.records.filter((r) => !allowed.has(r.id));
  const hiddenMetrics = [...new Set(sc.records.map((r) => r.metric))].filter((m) => !have.has(m)) as MetricKey[];
  const hiddenDepts = ["Marketing", "Sales", "Operations", "Finance"].filter((d) => !depts.has(d as never));
  return {
    sc, hiddenRecords, hiddenMetrics,
    strings: [
      ...hiddenRecords.flatMap((r) => [r.id, r.source, ...(r.note ? [r.note] : [])]),
      ...hiddenMetrics.flatMap((m) => [`F-${m}`, m, METRIC_LABELS[m]]),
      ...hiddenDepts,
    ],
  };
}

const roles = ROLES.filter((r) => r.id !== "exec");
const cases = SCENARIOS.flatMap((s) => roles.map((r) => ({ scenario: s.id, role: r.id })));

describe("S8: no unauthorized identifier appears anywhere in a client-visible rejection", () => {
  it("covers every restricted role in every scenario", () => {
    expect(cases.length).toBe(SCENARIOS.length * 3);
  });

  it.each(cases)("$scenario / $role: rejections never contain hidden ids, sources, notes, fact ids, metric labels or department names", async ({ scenario, role }) => {
    const f = forbidden(role, scenario);
    const rec = f.hiddenRecords[0]!, other = f.hiddenRecords.at(-1)!;
    const metric = f.hiddenMetrics[0]!;
    const keyAttack: Record<string, unknown> = { ...lane("Demand may be shifting.") };
    keyAttack[rec.id] = true; // the hidden id as an extra JSON key
    const attacks: [string, unknown][] = [
      ["plain hidden id", lane(`See ${rec.id} for context.`)],
      ["hidden id, zero-width", lane(`See ${zw(rec.id)}.`)],
      ["hidden id, full-width", lane(`See ${fullwidth(rec.id)}.`)],
      ["hidden id, en dashes", lane(`See ${dashes(rec.id)}.`)],
      ["hidden id, lower case", lane(`see ${rec.id.toLowerCase()}`)],
      ["hidden source label", lane(`Check ${rec.source} data.`)],
      ["hidden source label, zero-width", lane(`Check ${rec.source.replace(" ", "​ ")} data.`)],
      ["hidden source label, full-width", lane(`Check ${fullwidth(rec.source)} data.`)],
      ["leak plus numeral plus causal in one output", lane(`Delays caused ${rec.id} to fall 40%.`)],
      ["leak in a second hidden record", lane(`Compare ${other.id} with ${rec.id}.`)],
      ["leak in missing_evidence", { ...lane("ok."), missing_evidence: [`Need ${rec.id}`] }],
      ["leak in a proposed action", { interpretations: [], missing_evidence: [], recommendations: [{ text: `Review ${rec.source}.`, requires_human_approval: true, refs: ["F-revenue"] }] }],
      ["hidden record id as a ref", lane("Mix may matter.", [rec.id])],
      ["hidden fact id as a ref", lane("Mix may matter.", [`F-${metric}`])],
      ["hidden id as an extra schema key", keyAttack],
      ["hidden id as a lane key", { ...lane("ok."), [rec.id]: [] }],
      ["legacy shape carrying a hidden id", { observations: [{ text: rec.id, cited_ids: [rec.id], claims: [] }], hypotheses: [], missing_evidence: [], recommendations: [] }],
      ["not JSON, containing a hidden id", `{"oops": "${rec.id}"`],
      ["unauthorized metric claim by label", lane(`${METRIC_LABELS[metric]} rose.`)],
      ["unauthorized metric claim by key", lane(`${metric.replace("_", " ")} rose.`)],
      ["unauthorized department claim", lane(f.hiddenRecords.some((r) => r.department === "Marketing") ? "Marketing performance weakened." : "Operations improved.")],
      ["contradiction plus hidden id", lane(`Revenue rose and ${rec.id} fell.`)],
      ["magnitude plus hidden source", lane(`${rec.source} doubled.`)],
    ];
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    for (const [name, output] of attacks) {
      const r = await runMeta(req(role, scenario), READY, reply(output) as never);
      expect(r.state, `${name} must be rejected, got ${r.state}`).toBe("rejected");
      const wire = JSON.stringify(r).toLowerCase();
      const hits = f.strings.filter((s) => s && wire.includes(s.toLowerCase()));
      expect(hits, `${scenario}/${role} "${name}" leaked [${hits.join(" | ")}] in ${wire.slice(0, 300)}`).toEqual([]);
      if (r.state === "rejected") for (const c of r.categories ?? []) expect(c).toMatch(/^[a-z]+$/); // safe diagnostic codes only
    }
    // the server-side log carries category codes only
    const logged = JSON.stringify([...infoSpy.mock.calls, ...errorSpy.mock.calls]).toLowerCase();
    expect(f.strings.filter((s) => s && logged.includes(s.toLowerCase()))).toEqual([]);
  });

  it("a leak is reported on its own: nothing else is returned alongside it", () => {
    const f = forbidden("finance", "baseline");
    const text = `Delays caused ${f.hiddenRecords[0]!.id} to fall 40% and revenue rose.`;
    const v = validateOutput(JSON.stringify(lane(text)), authorizedRecords(req("finance", "baseline")), f.sc.records);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.errors).toEqual(["Cross-workspace leak: the output refers to a record or source outside the authorized scope"]);
      expect(v.categories).toEqual(["leak"]);
    }
  });

  it("internal diagnostic categories are retained for every kind of rejection (codes only)", () => {
    const auth = authorizedRecords(req("exec", "baseline"));
    const all = SCENARIOS[0]!.records;
    const cat = (o: unknown) => { const v = validateOutput(typeof o === "string" ? o : JSON.stringify(o), auth, all); return v.ok ? ["ok"] : v.categories; };
    expect(cat("not json")).toEqual(["json"]);
    expect(cat({ observations: [] })).toEqual(["legacy"]);
    expect(cat({ interpretations: "x", missing_evidence: [], recommendations: [] })).toEqual(["schema"]);
    expect(cat(lane("Mix may matter.", ["F-nope"]))).toEqual(["ref"]);
    expect(cat(lane("Delays caused the decline."))).toEqual(["causal"]);
    expect(cat(lane("Revenue fell 40%."))).toContain("numeral");
    expect(cat(lane("Revenue rose."))).toEqual(["direction"]);
    expect(cat(lane("Revenue fell forty percent."))).toEqual(["magnitude"]);
    expect(cat(lane("Mix may matter."))).toEqual(["ok"]);
  });

  it("schema errors never echo a model-supplied key name", () => {
    const f = forbidden("finance", "baseline");
    const o: Record<string, unknown> = { ...lane("ok.") };
    o[f.hiddenRecords[0]!.id] = 1;
    const v = validateOutput(JSON.stringify(o), authorizedRecords(req("finance", "baseline")), f.sc.records);
    expect(v.ok).toBe(false);
    if (!v.ok) { expect(v.errors.join()).toContain("unrecognized key"); expect(v.errors.join()).not.toContain(f.hiddenRecords[0]!.id); }
  });

  it("validation errors never quote model text", () => {
    const auth = authorizedRecords(req("exec", "baseline"));
    const all = SCENARIOS[0]!.records;
    for (const text of [
      "UNIQUEMARKER rose sharply and revenue rose.", "UNIQUEMARKER fell 40%.", "UNIQUEMARKER caused the decline.", "UNIQUEMARKER doubled revenue.",
      "UNIQUEMARKER fell \u0664\u0660.", "UNIQUEMARKER fell \uFF14\uFF10 percent.", "UNIQUEMARKER Forty percent.",
    ]) {
      const v = validateOutput(JSON.stringify(lane(text)), auth, all);
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.errors.join()).not.toContain("UNIQUEMARKER");
    }
  });
});
