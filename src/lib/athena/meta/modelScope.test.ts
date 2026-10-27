import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccessPolicy } from "../core/access";
import { SUPPORT_DESK_CATALOG } from "../core/ingest/fixtures";
import { PROTOTYPE_CATALOG } from "../prototypeCatalog";
import { SCENARIOS } from "../data";
import { authorizeDemo, demoAccessPolicy, type PrototypeEvidence } from "../prototypeAdapter";
import { PROTOTYPE_RUNTIME } from "./adapter.server";
import { validateAuthorizedOutput } from "./analysis";
import { buildAuthorizedFacts } from "./grounding";
import { checkSemantics, semanticScope } from "./semantic";
import { runAnalysis, type EngineRuntime } from "./runtime";
import { UNSAFE_KINDS, unsafeTextKinds } from "./textSafety";
import type { ModelProvider } from "./provider";

// H1: model-output validation enforces SERVER-AUTHORIZED, METRIC-LEVEL discoverability (not department membership), rejects mentions of hidden metrics with one
// fixed wording that does not say whether they exist, and rejects links, markup, code and commands. No live calls: the provider is a local fake and fetch is a tripwire.
const tripwire = vi.fn(() => { throw new Error("network call attempted"); });
vi.stubGlobal("fetch", tripwire);
afterEach(() => tripwire.mockClear());

const ENV = { META_MODEL_API_KEY: "sk-test-not-real", META_MODEL_ENABLED: "true" };
const label = (k: string) => PROTOTYPE_CATALOG.metrics.find((m) => m.key === k)!.label;
const body = (text: string, lane: "interp" | "rec" | "gap" = "interp", refs = ["F-leads"]) => JSON.stringify({
  interpretations: lane === "interp" ? [{ text, verified: false, refs }] : [],
  missing_evidence: lane === "gap" ? [text] : [],
  recommendations: lane === "rec" ? [{ text, requires_human_approval: true, refs }] : [],
});
const fake = (content: string): ModelProvider & { calls: number } => {
  const p = { calls: 0, id: "fake", model: "fake-model", displayName: "Fake", status: () => ({ keyConfigured: true, ownerEnabled: true }), blockedCode: () => null,
    async complete() { p.calls++; return { kind: "completion" as const, content, truncated: false, usage: { max_tokens_sent: 2000 } }; } };
  return p;
};
/** The marketing demo role, but a METRIC-level policy: records only for `dataMetrics`, and an optional explicit grant. */
const policy = (dataMetrics: string[], grant?: string[]): AccessPolicy<PrototypeEvidence> => ({
  evidenceScope: (ctx) => { const b = demoAccessPolicy.evidenceScope(ctx); return { tenantId: b.tenantId, permits: (e) => b.permits(e) && dataMetrics.includes(e.metric), ...(grant ? { discoverableMetrics: grant } : {}) }; },
});
const run = (content: string, pol: AccessPolicy<PrototypeEvidence>, role = "marketing", scenarioId = "baseline") => {
  const provider = fake(content);
  const runtime: EngineRuntime = { ...PROTOTYPE_RUNTIME, policy: pol as AccessPolicy, provider };
  return runAnalysis({ scenarioId, roleId: role, ownerConfirmed: true }, ENV, fetch, runtime).then((r) => ({ r, provider }));
};
const REFS: Record<string, string[]> = { marketing: ["F-leads"], finance: ["F-revenue"], exec: ["F-revenue"], ops: ["F-backorder_rate"] };
const errorsOf = async (text: string, pol: AccessPolicy<PrototypeEvidence>, lane: "interp" | "rec" | "gap" = "interp", role = "marketing", scenario = "baseline") => {
  const { r } = await run(body(text, lane, REFS[role]), pol, role, scenario);
  return r.state === "rejected" ? r.errors : r.state === "ok" ? [] : [`${r.state}:${"reason" in r ? r.reason : ""}`];
};
const LEADS_ONLY = policy(["leads"]);

describe("same-department hidden metrics (Marketing owns leads, lead quality and acquisition cost; the role may discover only leads)", () => {
  it("a directional claim about a hidden same-department metric is rejected as out of scope, not as 'unavailable'", async () => {
    for (const t of ["Lead quality fell.", "Customer acquisition cost rose.", "Lead quality and acquisition cost both weakened."]) {
      const e = await errorsOf(t, LEADS_ONLY);
      expect(e, t).toHaveLength(1);
      expect(e[0]).toMatch(/^Semantic guard \(domain\):.*outside this role's authorized scope/);
      expect(e.join()).not.toMatch(/unavailable|no verified data/i);
    }
  });
  it("a merely neutral mention of a hidden same-department metric is rejected, in every lane", async () => {
    for (const lane of ["interp", "rec", "gap"] as const) {
      const e = await errorsOf("Lead quality may be worth a look.", LEADS_ONLY, lane);
      expect(e.join(), lane).toMatch(/outside this role's authorized scope/);
    }
  });
  it("the rejection is the same for a hidden metric in the role's own department and one in another department", async () => {
    const same = await errorsOf("Lead quality fell.", LEADS_ONLY), other = await errorsOf("Recognized revenue fell.", LEADS_ONLY);
    expect(same).toEqual(other);
    const sameN = await errorsOf("Lead quality may be worth a look.", LEADS_ONLY), otherDept = await errorsOf("Sales conversion rate fell.", LEADS_ONLY);
    expect(sameN).toHaveLength(1); expect(otherDept).toHaveLength(1);
  });
  it("messages never name, label, key or describe the hidden metric, and never echo the model text", async () => {
    for (const k of ["mql_rate", "cac", "revenue", "conversion_rate"]) {
      const e = (await errorsOf(`${label(k)} fell sharply.`, LEADS_ONLY)).join(" ");
      expect(e).not.toContain(label(k)); expect(e).not.toContain(k); expect(e.toLowerCase()).not.toContain("fell sharply");
    }
  });
  it("an authorized metric with data is still accepted and still checked against its verified direction", async () => {
    expect(await errorsOf("Lead volume rose.", LEADS_ONLY)).toEqual([]);
    expect((await errorsOf("Lead volume fell.", LEADS_ONLY)).join()).toMatch(/Semantic guard \(direction\)/);
  });
  it("a hidden metric asked for by the question is not mentioned back: the rejection is identical to any other out-of-scope text", async () => {
    const e = await errorsOf("Lead quality", LEADS_ONLY, "gap");
    expect(e.join()).toMatch(/outside this role's authorized scope/);
  });
});

describe("discoverability is a policy grant, separate from data", () => {
  it("a granted metric with no data gets the 'unavailable' explanation; a neutral mention is accepted; its department-mates stay hidden", async () => {
    const p = policy(["leads"], ["cac"]);
    expect((await errorsOf("Customer acquisition cost rose.", p)).join()).toMatch(/unavailable data/);
    expect(await errorsOf("Customer acquisition cost may be worth a look.", p)).toEqual([]);
    expect((await errorsOf("Lead quality fell.", p)).join()).toMatch(/outside this role's authorized scope/);
  });
  it("without a grant the same metric is simply out of scope (no hint that it exists in the role's department)", async () => {
    expect((await errorsOf("Customer acquisition cost rose.", policy(["leads"]))).join()).toMatch(/outside this role's authorized scope/);
  });
  it("a grant never widens to the metric's department", async () => {
    const s = semanticScope([], [], PROTOTYPE_CATALOG, { discoverable: ["cac"] });
    expect([...s.discoverable!]).toEqual(["cac"]);
    expect([...s.departments]).toEqual(["Marketing"]); // informational only: derived from the grant, never the reverse
    expect(checkSemantics("Lead quality fell.", "interpretation", s).map((i) => i.code)).toEqual(["domain"]);
  });
  it("unknown or malformed grant entries are ignored, never widen", () => {
    const s = semanticScope([], [], PROTOTYPE_CATALOG, { discoverable: ["not_a_metric", "__proto__", "constructor", ""] });
    expect([...s.discoverable!]).toEqual([]);
  });
  it("the demo policy's explicit grant keeps whole-department roles exactly as before", async () => {
    expect(await errorsOf("Lead quality fell.", demoAccessPolicy)).toEqual([]); // in scope, with data, consistent with the verified direction
    expect((await errorsOf("Lead quality rose.", demoAccessPolicy)).join()).toMatch(/Semantic guard \(direction\)/);
    expect((await errorsOf("Customer acquisition cost rose.", demoAccessPolicy, "interp", "exec", "quality-only")).join()).toMatch(/unavailable data/); // granted, no data in this scenario
  });
});

describe("no allow-all fallback", () => {
  it("a scope built without a grant discovers only metrics with verified data", () => {
    const authorized = authorizeDemo({ scenarioId: "baseline", roleId: "marketing" }).authorized;
    const s = semanticScope(authorized, buildAuthorizedFacts(authorized, PROTOTYPE_RUNTIME.analysis), PROTOTYPE_CATALOG);
    expect([...s.discoverable!].sort()).toEqual(["cac", "conversion_rate", "closed_deals", "leads", "mql_rate"].sort());
    expect(s.discoverable!.has("revenue")).toBe(false);
  });
  it("a hand-built scope with no discoverable set rejects every mention (fail closed), including claims about metrics with facts", () => {
    const empty = { facts: [], departments: new Set(["Marketing"]), catalog: PROTOTYPE_CATALOG };
    expect(checkSemantics("Lead volume rose.", "interpretation", empty).map((i) => i.code)).toEqual(["domain"]);
    expect(checkSemantics("Lead volume may be worth a look.", "interpretation", { ...empty, strictMentions: true }).map((i) => i.code)).toEqual(["domain"]);
  });
  it("a scope whose discoverable set is not a Set fails closed", () => {
    const bad = { facts: [], departments: new Set(["Marketing"]), discoverable: ["leads"] as unknown as ReadonlySet<string>, catalog: PROTOTYPE_CATALOG };
    expect(checkSemantics("Lead volume rose.", "interpretation", bad).map((i) => i.code)).toEqual(["domain"]);
  });
  it("a policy that declares no grant leaves the live path with data-only discoverability, not department-wide", async () => {
    const authorized = authorizeDemo({ scenarioId: "quality-only", roleId: "marketing" });
    const noGrant = validateAuthorizedOutput(body("Customer acquisition cost rose."), authorized.authorized, authorized.withheld, PROTOTYPE_RUNTIME.analysis);
    expect(noGrant.ok).toBe(false);
    if (!noGrant.ok) { expect(noGrant.categories).toEqual(["domain"]); expect(noGrant.errors.join()).not.toMatch(/unavailable/); } // no grant: out of scope, not "authorized but no data"
    const granted = validateAuthorizedOutput(body("Customer acquisition cost rose."), authorized.authorized, authorized.withheld, PROTOTYPE_RUNTIME.analysis, { discoverable: ["cac"] });
    if (!granted.ok) expect(granted.categories).toEqual(["unavailable"]);
  });
});

describe("cross-department restrictions are preserved", () => {
  it("a directional claim outside the role's departments is rejected; a neutral cross-department mention stays allowed in the legacy mode", async () => {
    const fin = demoAccessPolicy;
    expect((await errorsOf("Lead volume rose.", fin, "interp", "finance")).join()).toMatch(/outside this role's authorized scope/);
    expect(await errorsOf("Lead volume may be worth a look.", fin, "interp", "finance")).toEqual([]);
  });
  it("strict mode rejects every mention of anything the role cannot discover", () => {
    const authorized = authorizeDemo({ scenarioId: "baseline", roleId: "finance" }).authorized;
    const facts = buildAuthorizedFacts(authorized, PROTOTYPE_RUNTIME.analysis);
    const strict = semanticScope(authorized, facts, PROTOTYPE_CATALOG, { discoverable: ["revenue"], strictMentions: true });
    const legacy = semanticScope(authorized, facts, PROTOTYPE_CATALOG, { discoverable: ["revenue"] });
    for (const t of ["Lead volume may be worth a look.", "Marketing could help.", "Sales and fulfillment are involved."]) {
      expect(checkSemantics(t, "gap", strict).length, t).toBeGreaterThan(0);
      expect(checkSemantics(t, "gap", legacy), t).toEqual([]);
    }
  });
});

describe("side channels", () => {
  it("the scope message is fixed wording that names nothing, and is the same for a claim and a mention (H1.1)", () => {
    const s = semanticScope([], [], PROTOTYPE_CATALOG);
    const want = [{ code: "domain", message: "Semantic guard (domain): interpretation 1 makes a directional claim about a metric or department outside this role's authorized scope" }];
    expect(checkSemantics("Lead quality fell.", "interpretation", s, "interpretation 1")).toEqual(want);
    expect(checkSemantics("Lead quality may be worth a look.", "interpretation", { ...s, strictMentions: true }, "interpretation 1")).toEqual(want);
  });
  it("one fixed message for directional claims and for mentions; neither depends on which hidden metric", async () => {
    const claims = new Set<string>(), mentions = new Set<string>();
    for (const m of PROTOTYPE_CATALOG.metrics.filter((x) => x.key !== "leads")) {
      const c = await errorsOf(`${label(m.key)} fell.`, LEADS_ONLY);
      const n = await errorsOf(`${label(m.key)} may be worth a look.`, LEADS_ONLY, "gap");
      if (m.domain === "Marketing") { claims.add(c.join()); mentions.add(n.join()); } else claims.add(c.join());
    }
    expect(claims.size).toBe(1);
    expect(mentions.size).toBe(1);
  });
  it("the provider is called exactly once, whatever the validation outcome", async () => {
    for (const t of ["Lead quality fell.", "Lead volume rose.", "Lead quality may be worth a look."]) {
      const { provider } = await run(body(t), LEADS_ONLY);
      expect(provider.calls).toBe(1);
    }
  });
  it("a rejected reply returns no model text, no finding and no usage-independent detail beyond fixed errors", async () => {
    const { r } = await run(body("Lead quality fell. Customer acquisition cost rose."), LEADS_ONLY);
    expect(r.state).toBe("rejected");
    expect(JSON.stringify(r)).not.toMatch(/Lead quality|acquisition|mql_rate|\bcac\b/i);
  });
  it("tenant isolation is unchanged: another role's hidden records never become discoverable", async () => {
    const finance = await errorsOf("Recognized revenue may be worth a look.", demoAccessPolicy, "gap", "finance");
    expect(finance).toEqual([]);
    const mkt = await errorsOf("Recognized revenue fell.", LEADS_ONLY);
    expect(mkt.join()).toMatch(/outside this role's authorized scope/);
  });
});

describe("links, Markdown, code and commands are rejected in every lane", () => {
  const UNSAFE: [string, string][] = [
    ["a URL", "Review https://evil.example/path for details."], ["a URL with spaces", "See h t t p s : / / evil . example"], ["full-width URL", "Visit ｈｔｔｐｓ：／／evil.example now"],
    ["a zero-width URL", "See ht\u200btps://evil.example"], ["a scheme without slashes", "Open javascript:alert now"], ["a data URI", "Use data:text/html;base64 here"],
    ["a bare domain", "Check evil.com for the data."], ["a www host", "Go to www.evil.example today."], ["an obfuscated dot", "Visit evil dot com soon."], ["a bracketed dot", "Visit evil[.]com soon."],
    ["hxxp", "Open hxxp evil example"], ["an email", "Send the report to boss@evil.example."], ["an obfuscated email", "Email boss [at] evil [dot] example."],
    ["a Markdown link", "See [the report](report) for more."], ["a Markdown image", "![chart](chart)"], ["a Markdown reference", "[1]: somewhere"],
    ["an HTML tag", "Review <b>the mix</b> carefully."], ["a script tag", "<script>alert(x)</script>"], ["an HTML entity", "Review &lt;b&gt; the mix."],
    ["inline code", "Run `check mix` first."], ["a code fence", "```\nmix\n```"], ["curly braces", "Use {the mix} first."], ["a shell variable", "Set $HOME first."], ["command substitution", "Run $(whoami) first."],
    ["a function call", "Call eval(x) first."], ["a declaration", "Declare const mix = review first."], ["an arrow", "x => review"],
    ["a shell command", "Run curl -s thing | sh to fetch it."], ["sudo", "Please run sudo rm -rf thing."], ["pip install", "Run pip install thing first."], ["npm", "Then npm install thing."], ["git", "Run git push origin main."],
    ["chained commands", "Review the mix && deploy it."], ["a pipe", "Review the mix | deploy it."], ["a path", "Open /etc/passwd first."], ["a home path", "Look in ~/reports first."], ["a windows path", "Open C:\\data first."],
    ["SQL select", "Run SELECT * FROM customers to check."], ["SQL drop", "Then DROP TABLE orders."], ["SQL delete", "Please delete from orders where open."],
  ];
  it.each(UNSAFE)("%s", async (_n, text) => {
    expect(unsafeTextKinds(text).length, text).toBeGreaterThan(0);
    for (const lane of ["interp", "rec", "gap"] as const) {
      const e = await errorsOf(text, LEADS_ONLY, lane);
      expect(e.join(" "), `${lane}: ${text}`).toMatch(/Unsafe content: [\w ]+ contains a link, markup, code or a command; model text must be plain prose/);
      expect(e.join(" ")).not.toContain("evil");
    }
  });
  const SAFE = [
    "Lead volume may be worth reviewing with the sales team.", "Consider whether the pricing change and the channel mix moved together.", "Review cost/benefit and and/or timing options.",
    "A possible co-movement, e.g. lead volume and conversion, is worth a closer look.", "Check the Q3 2026 channel mix; compare it with the prior period.", "Investigate staffing and pricing between periods (a longer history would help).",
    "Ask the owner: is the scoring definition the same as before?", "Well-known seasonal effects may matter - investigate the baseline.", "Check whether the data source changed - for example the export schedule.",
  ];
  it.each(SAFE)("plain prose is accepted: %s", (t) => {
    expect(unsafeTextKinds(t)).toEqual([]);
  });
  it("the rejection names a location and a fixed sentence, never the content, and never which rule fired", async () => {
    const e = await errorsOf("Visit https://evil.example/x or run `rm -rf /`.", LEADS_ONLY);
    expect(e).toEqual(["Unsafe content: interpretation 1 contains a link, markup, code or a command; model text must be plain prose"]);
  });
  it("a recommendation cannot carry an executable payload: the schema still requires human approval and rejects extra fields", async () => {
    const withExec = JSON.stringify({ interpretations: [], missing_evidence: [], recommendations: [{ text: "Review the mix.", requires_human_approval: true, refs: ["F-leads"], executable: true, command: "x" }] });
    const { r } = await run(withExec, LEADS_ONLY);
    expect(r.state).toBe("rejected");
    const noApproval = JSON.stringify({ interpretations: [], missing_evidence: [], recommendations: [{ text: "Review the mix.", requires_human_approval: false, refs: ["F-leads"] }] });
    expect((await run(noApproval, LEADS_ONLY)).r.state).toBe("rejected");
  });
  it("categories are a closed set", () => {
    expect([...UNSAFE_KINDS].sort()).toEqual(["code", "command", "email", "link", "markup"]);
  });
  it("accepted prose passes end to end and yields the three lanes with server-derived citations", async () => {
    const { r } = await run(JSON.stringify({ interpretations: [{ text: "Lead volume moved while other metrics may need review.", verified: false, refs: ["F-leads"] }], missing_evidence: ["Lead source mix by period."], recommendations: [{ text: "Review the lead source mix with the sales team.", requires_human_approval: true, refs: ["F-leads"] }] }), LEADS_ONLY);
    expect(r.state).toBe("ok");
    if (r.state === "ok") {
      expect(r.findings.map((f) => f.fact_id)).toEqual(["F-leads"]);
      expect(r.output.interpretations[0]!.supporting_ids).toEqual(["VH-MKT-001-Q2", "VH-MKT-001-Q3"]);
    }
  });
});

describe("a second dataset, same rules", () => {
  it("customer-support catalog: a hidden same-department metric is out of scope, a granted one is unavailable", () => {
    const facts = [{ fact_id: "F-tickets_opened", metric: "tickets_opened", department: "Support", unit: "tickets", prior: { id: "a", value: 1 }, current: { id: "b", value: 2 }, change_pct: 100, change_pp: null, direction: "up" as const }];
    const hiddenSame = semanticScope([], facts, SUPPORT_DESK_CATALOG);
    expect(checkSemantics("Resolution time rose.", "interpretation", hiddenSame).map((i) => i.code)).toEqual(["domain"]);
    expect(checkSemantics("Customer satisfaction fell.", "interpretation", hiddenSame).map((i) => i.code)).toEqual(["domain"]);
    const granted = semanticScope([], facts, SUPPORT_DESK_CATALOG, { discoverable: ["resolution_hours"] });
    expect(checkSemantics("Resolution time rose.", "interpretation", granted).map((i) => i.code)).toEqual(["unavailable"]);
    expect(checkSemantics("Customer satisfaction fell.", "interpretation", granted).map((i) => i.code)).toEqual(["domain"]);
  });
});

describe("existing scenario coverage", () => {
  it("every scenario and role: facts-covered metrics are never rejected as out of scope", async () => {
    for (const s of SCENARIOS) for (const role of ["exec", "marketing", "ops", "finance"]) {
      const authorized = authorizeDemo({ scenarioId: s.id, roleId: role });
      const facts = buildAuthorizedFacts(authorized.authorized, PROTOTYPE_RUNTIME.analysis);
      const sc = semanticScope(authorized.authorized, facts, PROTOTYPE_CATALOG);
      for (const f of facts) expect(checkSemantics(`${label(f.metric)} may be worth a look.`, "gap", { ...sc, strictMentions: true }), `${s.id}/${role}/${f.metric}`).toEqual([]);
    }
  });
});
