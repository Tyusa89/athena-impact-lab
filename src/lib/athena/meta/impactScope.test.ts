import { describe, expect, it } from "vitest";
import { AuthorizationError, authorizeEvidence, type AccessPolicy } from "../core/access";
import { identity, trusted } from "../core/ingest/testSupport";
import { demoAccessPolicy, demoEvidenceStore, type PrototypeEvidence } from "../prototypeAdapter";
import { DEMO_TENANT_ID } from "../data";
import { PROTOTYPE_CATALOG } from "../prototypeCatalog";
import { BUSINESS_OPS_MODEL } from "../impactModels";
import { PROTOTYPE_RUNTIME } from "./adapter.server";
import { buildImpactMap, NO_RELATIONSHIP_NOTICE, type ImpactMap } from "./impact";
import { runImpactAnalysis, type EngineRuntime } from "./runtime";

// F1: a metric is discoverable only if the caller has authorized verified data for it OR the access-policy layer explicitly grants it. Never because another
// metric of the same domain is visible. Synthetic data only.
const FULL = "Give me the complete picture of this period.";
const label = (k: string) => PROTOTYPE_CATALOG.metrics.find((m) => m.key === k)?.label ?? k;
const everyString = (x: unknown): string[] => (typeof x === "string" ? [x] : Array.isArray(x) ? x.flatMap(everyString) : x && typeof x === "object" ? Object.values(x).flatMap(everyString) : []);

/** A metric-level policy over the demo's marketing role: permits records only for `dataMetrics`, and (optionally) declares `grant` as discoverable. */
const metricPolicy = (dataMetrics: string[], grant?: unknown): AccessPolicy<PrototypeEvidence> => ({
  evidenceScope: (ctx) => {
    const base = demoAccessPolicy.evidenceScope(ctx);
    return { tenantId: base.tenantId, permits: (e) => base.permits(e) && dataMetrics.includes(e.metric), ...(grant !== undefined ? { discoverableMetrics: grant as string[] } : {}) };
  },
});
const run = async (policy: AccessPolicy<PrototypeEvidence>, scenarioId = "baseline", role = "marketing", question = FULL, store: EngineRuntime["store"] = demoEvidenceStore): Promise<ImpactMap> => {
  const runtime = { ...PROTOTYPE_RUNTIME, policy: policy as AccessPolicy, store, resolve: () => ({ ok: true as const, credential: { roleId: role }, dataset: scenarioId, question }) };
  const r = await runImpactAnalysis({ scenarioId, roleId: role, ownerConfirmed: true }, { ...runtime, resolve: (i: unknown) => PROTOTYPE_RUNTIME.resolve({ ...(i as object), question }) }, BUSINESS_OPS_MODEL);
  if (r.state !== "ok") throw new Error(`blocked: ${r.reason}`);
  return r.impact;
};
const withoutMetric = (hidden: string): EngineRuntime["store"] => ({ candidates: (c, d) => demoEvidenceStore.candidates(c, d).filter((e) => (e as PrototypeEvidence).metric !== hidden) });
const HIDDEN_FROM_LEADS_ONLY = PROTOTYPE_CATALOG.metrics.filter((m) => m.key !== "leads");
const mentions = (m: ImpactMap, k: string) => everyString(m).some((s) => s.includes(label(k)) || s.includes(k));

describe("F1 reproduction: a visible metric does not make its domain-mates discoverable", () => {
  it("a caller authorized only for `leads` learns nothing about lead quality or acquisition cost (same Marketing domain)", async () => {
    const m = await run(metricPolicy(["leads"]));
    expect(m.verified_changes.map((v) => v.metric)).toEqual(["leads"]);
    expect(m.relationships).toEqual([]);
    expect(m.notices).toContain(NO_RELATIONSHIP_NOTICE);
    for (const k of ["mql_rate", "cac"]) expect(mentions(m, k)).toBe(false);
    expect(JSON.stringify(m)).not.toMatch(/lead-quality|acquisition|no verified data|Verified data for/i);
    expect(m.missing_evidence.every((x) => !/^Verified data for/.test(x))).toBe(true);
  });

  it("no other catalog metric is named anywhere in the map (labels, keys, ids, focus, hypotheses, missing evidence, actions, notices)", async () => {
    for (const q of [FULL, "Why is lead quality down?", "What happened to customer acquisition cost and revenue?", "Marketing: how are we doing?"]) {
      const m = await run(metricPolicy(["leads"]), "baseline", "marketing", q);
      for (const h of HIDDEN_FROM_LEADS_ONLY) expect(mentions(m, h.key), `${h.key} via "${q}"`).toBe(false);
      expect(m.focus.every((f) => f === label("leads"))).toBe(true);
      expect(m.hypotheses).toEqual([]);
      expect(m.proposed_actions).toEqual([]);
    }
  });

  it("asking about a hidden metric by name neither reveals it nor changes what is shown beyond the authorized scope", async () => {
    const plain = await run(metricPolicy(["leads"]), "baseline", "marketing", FULL);
    const asked = await run(metricPolicy(["leads"]), "baseline", "marketing", "Why is customer acquisition cost up?");
    expect(asked.focus).toEqual([]);
    expect(asked.relationships).toEqual(plain.relationships);
    expect(mentions(asked, "cac")).toBe(false);
  });
});

describe("authorization to discover a metric is separate from verified data for it", () => {
  it("an explicitly granted metric with no data gets the useful 'missing verified data' explanation", async () => {
    const m = await run(metricPolicy(["leads"], ["cac"]), "baseline", "marketing", FULL, withoutMetric("cac"));
    const r = m.relationships.find((x) => x.id === "leads-vs-acquisition-cost")!;
    expect(r).toMatchObject({ status: "insufficient_evidence", verified: false, claims_causation: false });
    expect(r.statement).toMatch(new RegExp(`^${label("cac")} has no verified data in your authorized scope`));
    expect(m.missing_evidence).toContain(`Verified data for ${label("cac")}.`);
    expect(r.fact_refs).toEqual(["F-leads"]);
  });

  it("the grant is per metric: granting `cac` does not reveal `mql_rate`", async () => {
    const m = await run(metricPolicy(["leads"], ["cac"]), "baseline", "marketing", FULL, withoutMetric("cac"));
    expect(m.relationships.map((r) => r.id)).toEqual(["leads-vs-acquisition-cost"]);
    expect(mentions(m, "mql_rate")).toBe(false);
  });

  it("a grant yields no data: the metric gets no verified change and no co-movement, even when the store holds its records", async () => {
    const m = await run(metricPolicy(["leads"], ["cac"]));
    expect(m.verified_changes.map((v) => v.metric)).toEqual(["leads"]);
    expect(m.relationships.map((r) => [r.id, r.status])).toEqual([["leads-vs-acquisition-cost", "insufficient_evidence"]]);
    expect(m.hypotheses).toEqual([]);
  });

  it("a relationship needs BOTH ends discoverable: a grant for one end alone adds nothing", async () => {
    const m = await run(metricPolicy(["leads"], ["conversion_rate"]), "baseline", "marketing", FULL, withoutMetric("conversion_rate"));
    expect(m.relationships).toEqual([]); // conversion_rate pairs with mql_rate / closed_deals / fulfillment_days, none discoverable
    for (const k of ["mql_rate", "closed_deals", "revenue", "fulfillment_days", "backorder_rate", "cac"]) expect(mentions(m, k)).toBe(false);
  });

  it("unknown keys in a grant are ignored and a grant for another domain grants only that metric", async () => {
    const m = await run(metricPolicy(["leads"], ["not_a_metric", "__proto__", "revenue"]), "baseline", "marketing", FULL, withoutMetric("cac"));
    expect(mentions(m, "not_a_metric")).toBe(false);
    expect(m.relationships.map((r) => r.id)).toEqual([]); // revenue pairs with closed_deals / fulfillment_days, neither discoverable
  });
});

describe("data presence makes a metric discoverable; domain presence does not", () => {
  it("with data for two metrics, only relationships between them are assessed", async () => {
    const m = await run(metricPolicy(["leads", "mql_rate"]));
    expect(m.relationships.map((r) => r.id)).toEqual(["leads-vs-lead-quality"]);
    expect(mentions(m, "cac")).toBe(false);
  });

  it("the demo policy's explicit grant keeps the previous behaviour for whole-department roles", async () => {
    const m = await run(demoAccessPolicy, "quality-only", "exec");
    expect(m.relationships.find((r) => r.id === "leads-vs-acquisition-cost")).toMatchObject({ status: "insufficient_evidence" });
  });

  it("without any grant the same whole-department role no longer sees 'no verified data' for a metric it has no data for", async () => {
    const stripped: AccessPolicy<PrototypeEvidence> = { evidenceScope: (c) => { const { tenantId, permits } = demoAccessPolicy.evidenceScope(c); return { tenantId, permits }; } };
    const m = await run(stripped, "quality-only", "exec");
    expect(m.relationships.find((r) => r.id === "leads-vs-acquisition-cost")).toBeUndefined();
    expect(mentions(m, "cac")).toBe(false);
  });
});

describe("preserved guarantees", () => {
  it("verified calculations, provenance of sources and non-causal wording are unchanged for authorized metrics", async () => {
    const m = await run(metricPolicy(["leads", "mql_rate"], ["cac"]));
    const full = await run(demoAccessPolicy);
    expect(m.verified_changes).toEqual(full.verified_changes.filter((v) => ["leads", "mql_rate"].includes(v.metric)));
    for (const r of m.relationships) expect(r.claims_causation).toBe(false);
    for (const h of m.hypotheses) expect(h).toMatchObject({ verified: false, claims_causation: false });
    for (const a of m.proposed_actions) expect(a).toMatchObject({ requires_human_approval: true, executable: false });
    expect(m.notices).toEqual(expect.arrayContaining(full.notices.slice(0, 3)));
  });
});

describe("the grant travels only through the access-policy layer and fails closed", () => {
  const cands = () => demoEvidenceStore.candidates(trusted(DEMO_TENANT_ID), "baseline");
  const authorize = (policy: AccessPolicy<PrototypeEvidence>) => authorizeEvidence(identity, trusted(DEMO_TENANT_ID, "demo-role:marketing"), policy as AccessPolicy<PrototypeEvidence>, cands());
  it("returns a frozen copy, empty by default", () => {
    expect(authorize(demoAccessPolicy).discoverableMetrics).not.toEqual(undefined);
    const r = authorize(metricPolicy(["leads"], ["cac", "cac"]));
    expect(r.discoverableMetrics).toEqual(["cac"]);
    expect(Object.isFrozen(r.discoverableMetrics)).toBe(true);
    expect(authorize(metricPolicy(["leads"])).discoverableMetrics).toEqual([]);
  });
  it.each([[null], ["cac"], [[1]], [[""]], [[" cac"]], [{ length: 1, 0: "cac" }]])("a malformed declaration (%j) is refused", (bad) => {
    expect(() => authorize(metricPolicy(["leads"], bad))).toThrow(AuthorizationError);
  });
  it("the request cannot supply a grant: extra request fields are ignored", async () => {
    const r = await runImpactAnalysis({ scenarioId: "baseline", roleId: "marketing", ownerConfirmed: true, discoverableMetrics: ["cac", "revenue"] }, { ...PROTOTYPE_RUNTIME, policy: metricPolicy(["leads"]) as AccessPolicy }, BUSINESS_OPS_MODEL);
    expect(r.state === "ok" && r.impact.relationships).toEqual([]);
  });
  it("buildImpactMap given a grant outside the catalog does not throw or widen", () => {
    const { authorized } = authorize(metricPolicy(["leads"]));
    const m = buildImpactMap(authorized, PROTOTYPE_RUNTIME.analysis, BUSINESS_OPS_MODEL, { discoverableMetrics: ["zzz"] });
    expect(m.relationships).toEqual([]);
  });
});
