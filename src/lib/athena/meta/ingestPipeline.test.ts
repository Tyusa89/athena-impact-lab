import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authorizeEvidence, type AccessPolicy } from "../core/access";
import type { Evidence } from "../core/evidence";
import { computeAuthorizedFacts, type AnalysisContext } from "../core/facts";
import { BUSINESS_OPS_MAPPING, BUSINESS_OPS_SOURCE, SUPPORT_DESK_CATALOG, SUPPORT_DESK_MAPPING, SUPPORT_DESK_PERIODS, SUPPORT_DESK_SOURCE } from "../core/ingest/fixtures";
import { createEvidenceLedger, csvAdapter, importSource, type EvidenceLedger, type ImportResult, type MappingSpec, type SourceDescriptor } from "../core/ingest";
import { allowAll, identity, trusted } from "../core/ingest/testSupport";
import type { Catalog } from "../core/catalog";
import { SCENARIOS } from "../data";
import { PROTOTYPE_CONTEXT, computeFacts } from "../engine";
import { PROTOTYPE_CATALOG } from "../prototypeCatalog";
import { PERIODS } from "../data";
import { runMeta, type EngineRuntime } from "./adapter.server";
import { prepareMessages } from "./contract";
import { renderFindings } from "./findings";
import { MAX_OUTPUT_TOKENS } from "./limits";
import type { ModelOutcome, ModelProvider, ModelRequest } from "./provider";

// Imported CSV evidence flows through the EXISTING engine unchanged: trusted context -> authorized evidence -> catalog-driven facts ->
// server-generated findings and citations -> (fake) provider -> validated lanes. Two unrelated datasets use the same code path.
// No network, no live model: the provider is a local fake and ingestion never calls it.
const READY = { MODEL_KEY: "k" };
const noFetch = (() => { throw new Error("no transport"); }) as unknown as typeof fetch;
const read = (name: string) => readFileSync(`src/lib/athena/core/ingest/fixtures/${name}`, "utf8");
afterEach(() => vi.restoreAllMocks());

const OPS_CTX: AnalysisContext = { catalog: PROTOTYPE_CATALOG, periods: PERIODS };
const DESK_CTX: AnalysisContext = { catalog: SUPPORT_DESK_CATALOG, periods: SUPPORT_DESK_PERIODS };

interface Dataset { name: string; csv: string; source: SourceDescriptor; spec: MappingSpec; catalog: Catalog; analysis: AnalysisContext; question: string }
const OPS: Dataset = { name: "A business operations", csv: read("business-ops.csv"), source: BUSINESS_OPS_SOURCE, spec: BUSINESS_OPS_MAPPING, catalog: PROTOTYPE_CATALOG, analysis: OPS_CTX, question: "Why is revenue down while leads are up?" };
const DESK: Dataset = { name: "B customer support", csv: read("customer-support.csv"), source: SUPPORT_DESK_SOURCE, spec: SUPPORT_DESK_MAPPING, catalog: SUPPORT_DESK_CATALOG, analysis: DESK_CTX, question: "Why is satisfaction falling while ticket volume rises?" };

const imp = (d: Dataset, tenant: string, text = d.csv, mode: "all_or_nothing" | "accept_valid" = "all_or_nothing"): ImportResult =>
  importSource({ identity, ctx: trusted(tenant), policy: allowAll, adapter: csvAdapter, input: text, source: d.source, spec: d.spec, catalog: d.catalog, options: { mode } });
const must = (r: ImportResult) => { if (!r.ok) throw new Error(`structural ${r.error.code}`); return r; };
/** Import and commit a dataset for a tenant. */
function load(ledger: EvidenceLedger, d: Dataset, tenant: string, text = d.csv, mode: "all_or_nothing" | "accept_valid" = "all_or_nothing") {
  const ctx = trusted(tenant);
  const result = must(importSource({ identity, ctx, policy: allowAll, adapter: csvAdapter, input: text, source: d.source, spec: d.spec, catalog: d.catalog, options: { mode } }));
  return { ctx, result, outcome: ledger.commit(ctx, result, "main") };
}
const domainPolicy = (grants: Record<string, string[] | "*">): AccessPolicy<Evidence> => ({
  evidenceScope: (c) => ({ tenantId: c.tenantId, permits: (e) => { const g = grants[c.actorId]; return g === "*" || (Array.isArray(g) && g.includes(e.department)); } }),
});
const overSharing: AccessPolicy<Evidence> = { evidenceScope: (c) => ({ tenantId: c.tenantId, permits: () => true }) }; // permits everything; tenant isolation must come from the engine

/** A provider that is not a model: it records what it was sent and answers with a canned reply. */
function provider(answer: (r: ModelRequest) => ModelOutcome | Promise<ModelOutcome>): ModelProvider & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  return {
    id: "fake", model: "fake-model", displayName: "Fake Provider", requests,
    status: () => ({ keyConfigured: true, ownerEnabled: true }), blockedCode: () => null,
    async complete(r) { requests.push(r); return answer(r); },
  };
}
const lanes = (text: string, refs: string[], extra: object = {}) => JSON.stringify({ interpretations: [{ text, verified: false, refs, ...extra }], missing_evidence: ["No channel attribution."], recommendations: [{ text: "Review the process with the owner.", requires_human_approval: true, refs }] });
const completion = (content: string): ModelOutcome => ({ kind: "completion", content, truncated: false, usage: { max_tokens_sent: MAX_OUTPUT_TOKENS, prompt_tokens: 500, completion_tokens: 100 } });

function runtime(ledger: EvidenceLedger, d: Dataset, tenant: string, actor: string, p: ModelProvider, policy: AccessPolicy<Evidence>, store: EngineRuntime["store"] = ledger.store as never): EngineRuntime {
  return {
    resolve: () => ({ ok: true, credential: { tenantId: tenant, actorId: actor }, dataset: "main" }),
    identity, allowSimulatedIdentity: false, store, policy: policy as never, analysis: d.analysis, question: d.question, provider: p,
  };
}
const go = (rt: EngineRuntime) => runMeta({}, READY, noFetch, rt);
const quiet = () => { vi.spyOn(console, "info").mockImplementation(() => {}); vi.spyOn(console, "error").mockImplementation(() => {}); };

describe.each([OPS, DESK])("dataset $name: the same ingestion and evidence infrastructure", (d) => {
  it("imports cleanly, with provenance for every record", () => {
    const r = must(imp(d, "tenant-x"));
    expect(r.status).toBe("accepted");
    expect(r.rejected).toEqual([]);
    expect(r.accepted).toHaveLength(d.csv.trim().split("\n").length - 1);
    expect(new Set(r.accepted.map((e) => e.tenantId))).toEqual(new Set(["tenant-x"]));
    for (const e of r.accepted) expect(r.provenance[e.id]!.batchId).toBe(r.batch.batchId);
  });
  it("flows through authorization into catalog-driven facts and server-generated findings", () => {
    const ledger = createEvidenceLedger(identity);
    const { ctx } = load(ledger, d, "tenant-x");
    const { authorized } = authorizeEvidence(identity, ctx, domainPolicy({ importer: "*" }), ledger.store.candidates(ctx, "main"));
    const facts = computeAuthorizedFacts(authorized, d.analysis);
    expect(facts.length).toBe(authorized.length / 2); // every imported record is paired into a fact
    const findings = renderFindings(authorized, d.analysis);
    expect(findings.length).toBe(facts.length);
    for (const f of findings) expect(f.supporting_ids.every((id) => authorized.some((e) => e.id === id))).toBe(true); // citations are imported records
  });
  it("makes no model call: ingest, commit, authorize and facts leave the provider untouched", async () => {
    const p = provider(() => completion(lanes("Mix may matter.", ["F-x"])));
    const ledger = createEvidenceLedger(identity);
    const { ctx } = load(ledger, d, "tenant-x");
    const { authorized } = authorizeEvidence(identity, ctx, domainPolicy({ importer: "*" }), ledger.store.candidates(ctx, "main"));
    computeAuthorizedFacts(authorized, d.analysis);
    renderFindings(authorized, d.analysis);
    prepareMessages(d.question, authorized as never, d.analysis);
    expect(p.requests).toHaveLength(0);
  });
  it("runs the whole live pipeline: verified findings and citations from the server, model lanes unverified and approval-gated", async () => {
    quiet();
    const ledger = createEvidenceLedger(identity);
    const { ctx } = load(ledger, d, "tenant-x");
    const { authorized } = authorizeEvidence(identity, ctx, domainPolicy({ importer: "*" }), ledger.store.candidates(ctx, "main"));
    const first = computeAuthorizedFacts(authorized, d.analysis)[0]!;
    const p = provider(() => completion(lanes("Demand mix may matter.", [`F-${first.metric}`])));
    const res = await go(runtime(ledger, d, "tenant-x", "importer", p, domainPolicy({ importer: "*" })));
    expect(res.state).toBe("ok");
    if (res.state !== "ok") return;
    expect(p.requests).toHaveLength(1);
    expect(res.findings.map((f) => f.fact_id).sort()).toEqual(computeAuthorizedFacts(authorized, d.analysis).map((f) => `F-${f.metric}`).sort());
    expect(res.output.interpretations[0]).toMatchObject({ verified: false, refs: [`F-${first.metric}`], supporting_ids: first.evidenceIds });
    expect(res.output.recommendations.every((r) => r.requires_human_approval === true)).toBe(true);
    expect(res.authorizedIds.sort()).toEqual(authorized.map((e) => e.id).sort());
    const prompt = JSON.stringify(p.requests[0]!.messages);
    for (const e of authorized) expect(prompt).toContain(e.id); // the prompt is built from imported, authorized evidence
  });
  it("is deterministic end to end: repeating the pipeline gives the identical prompt and findings", async () => {
    quiet();
    const outs: unknown[] = [];
    for (let i = 0; i < 2; i++) {
      const ledger = createEvidenceLedger(identity);
      load(ledger, d, "tenant-x");
      const p = provider(() => completion("{}"));
      await go(runtime(ledger, d, "tenant-x", "importer", p, domainPolicy({ importer: "*" })));
      outs.push(p.requests[0]!.messages);
    }
    expect(outs[0]).toEqual(outs[1]);
  });
  it("a provider cannot create verified findings or citations from imported data", async () => {
    quiet();
    const ledger = createEvidenceLedger(identity);
    load(ledger, d, "tenant-x");
    const metric = ledger.store.candidates(trusted("tenant-x"), "main")[0]!.metric;
    for (const content of [
      lanes("Mix may matter.", [`F-${metric}`], { verified: true }),
      lanes("Mix may matter.", [`F-${metric}`], { supporting_ids: ["EVIL-1"] }),
      lanes("Mix may matter.", [`F-${metric}`], { cited_ids: ["EVIL-1"] }),
      lanes("Mix may matter.", ["F-not-imported"]),
      JSON.stringify({ findings: [{ fact_id: `F-${metric}`, text: "forged" }], interpretations: [], missing_evidence: [], recommendations: [] }),
    ]) {
      const res = await go(runtime(ledger, d, "tenant-x", "importer", provider(() => completion(content)), domainPolicy({ importer: "*" })));
      expect(res.state).toBe("rejected");
      expect(res).not.toHaveProperty("findings");
    }
  });
});

describe("dataset A reproduces the prototype's baseline facts from CSV (same engine, new evidence source)", () => {
  it("every verified fact equals the baseline scenario's, with only the record ids and provenance differing", () => {
    const ledger = createEvidenceLedger(identity);
    const { ctx } = load(ledger, OPS, "tenant-x");
    const { authorized } = authorizeEvidence(identity, ctx, domainPolicy({ importer: "*" }), ledger.store.candidates(ctx, "main"));
    const imported = computeAuthorizedFacts(authorized, OPS_CTX);
    const proto = computeFacts(SCENARIOS[0]!.records);
    const strip = (f: { metric: string; label: string; department: string; prior: number; current: number; unit: string; changePct: number | null; changePp: number | null; direction: string; periodLabel: string }) => ({ metric: f.metric, label: f.label, department: f.department, prior: f.prior, current: f.current, unit: f.unit, changePct: f.changePct, changePp: f.changePp, direction: f.direction, periodLabel: f.periodLabel });
    expect(imported.map(strip)).toEqual(proto.map(strip).sort((a, b) => imported.findIndex((x) => x.metric === a.metric) - imported.findIndex((x) => x.metric === b.metric)));
    expect(renderFindings(authorized, OPS_CTX).map((f) => f.text).sort()).toEqual(renderFindings(SCENARIOS[0]!.records, PROTOTYPE_CONTEXT).map((f) => f.text).sort());
  });
  it("the quoted, comma-and-quote-bearing note survives intact", () => {
    const r = must(imp(OPS, "tenant-x"));
    expect(r.accepted.find((e) => e.id === "OPS-MKT-001-Q3")!.note).toBe('Paid social share rose 22% → 51%, per the "Ads" ledger');
  });
});

describe("dataset B yields its own facts under its own catalog", () => {
  it("computes the support-desk facts", () => {
    const ledger = createEvidenceLedger(identity);
    const { ctx } = load(ledger, DESK, "tenant-y");
    const { authorized } = authorizeEvidence(identity, ctx, domainPolicy({ importer: "*" }), ledger.store.candidates(ctx, "main"));
    const f = Object.fromEntries(computeAuthorizedFacts(authorized, DESK_CTX).map((x) => [x.metric, x]));
    expect(f["tickets_opened"]).toMatchObject({ changePct: 20, direction: "up", periodLabel: "Jan 2027 → Feb 2027" });
    expect(f["first_response_hours"]).toMatchObject({ direction: "flat" });
    expect(f["resolution_hours"]).toMatchObject({ changePct: 32.7, direction: "up" });
    expect(f["csat"]).toMatchObject({ changePct: -4.3, changePp: -4, direction: "down", department: "CustomerExperience" });
  });
  it("is not understood by dataset A's catalog (and vice versa): wrong-catalog imports are rejected, never reinterpreted", () => {
    const wrong = must(importSource({ identity, ctx: trusted("t"), policy: allowAll, adapter: csvAdapter, input: DESK.csv, source: DESK.source, spec: { ...DESK.spec }, catalog: PROTOTYPE_CATALOG }));
    expect(wrong.accepted).toEqual([]);
    expect(wrong.rejected.every((x) => x.reasons.some((y) => y.code === "metric_unknown"))).toBe(true);
    const wrong2 = importSource({ identity, ctx: trusted("t"), policy: allowAll, adapter: csvAdapter, input: OPS.csv, source: OPS.source, spec: OPS.spec, catalog: SUPPORT_DESK_CATALOG });
    expect(wrong2.ok === false && wrong2.error.code).toBe("bad_mapping"); // the mapping targets keys this catalog does not have
  });
});

describe("invalid or unauthorized data cannot contaminate verified findings", () => {
  const SECRET_UNIT = OPS.csv.replace("OPS-FIN-001-Q3,Revenue (GL),Finance,Q3 2026,1018000,usd", "OPS-FIN-001-Q3,Revenue (GL),Finance,Q3 2026,1018000,eur");
  it("all-or-nothing: one bad row means no evidence at all, and the live pipeline refuses to send anything", async () => {
    quiet();
    const ledger = createEvidenceLedger(identity);
    const { outcome, result } = load(ledger, OPS, "tenant-x", SECRET_UNIT);
    expect(result.status).toBe("rejected");
    expect(outcome).toEqual({ committed: false, reason: "not_importable", added: 0 });
    const p = provider(() => completion(lanes("x", ["F-revenue"])));
    expect(await go(runtime(ledger, OPS, "tenant-x", "importer", p, domainPolicy({ importer: "*" })))).toMatchObject({ state: "blocked", requestSent: false });
    expect(p.requests).toHaveLength(0);
  });
  it("accept_valid with a half-rejected metric fails closed: the orphaned half would be unverifiable, so nothing is sent", async () => {
    quiet();
    const ledger = createEvidenceLedger(identity);
    load(ledger, OPS, "tenant-x", SECRET_UNIT, "accept_valid");
    const p = provider(() => completion(lanes("x", ["F-revenue"])));
    const res = await go(runtime(ledger, OPS, "tenant-x", "importer", p, domainPolicy({ importer: "*" })));
    expect(res).toMatchObject({ state: "blocked", requestSent: false, reason: expect.stringContaining("cannot be fully represented") });
    expect(p.requests).toHaveLength(0);
  });
  it("accept_valid with a fully rejected metric: that metric has no fact, no finding, no id and no label in the prompt, and cannot be cited", async () => {
    quiet();
    const text = OPS.csv.replaceAll("usd,SYN-GL Revenue Summary,", "eur,SYN-GL Revenue Summary,"); // both revenue rows have a bad unit
    const ledger = createEvidenceLedger(identity);
    const { result } = load(ledger, OPS, "tenant-x", text, "accept_valid");
    expect(result.rejected).toHaveLength(2);
    const p = provider(() => completion(lanes("Mix may matter.", ["F-leads"])));
    const res = await go(runtime(ledger, OPS, "tenant-x", "importer", p, domainPolicy({ importer: "*" })));
    expect(res.state).toBe("ok");
    if (res.state !== "ok") return;
    expect(res.findings.map((f) => f.metric)).not.toContain("revenue");
    // the data portion of the prompt (the runtime's own question text is server-chosen and says "revenue" here, so it is excluded)
    const prompt = JSON.stringify(p.requests[0]!.messages.map((m) => m.content.replace(/^Question:.*\n/, "")));
    for (const s of ["revenue", "Recognized revenue", "OPS-FIN", "SYN-GL", "1018000", "1240000"]) expect(prompt).not.toContain(s);
    const cited = await go(runtime(ledger, OPS, "tenant-x", "importer", provider(() => completion(lanes("Mix may matter.", ["F-revenue"]))), domainPolicy({ importer: "*" })));
    expect(cited.state).toBe("rejected");
  });
  it("conflicting duplicates are removed from verified findings, not resolved in anyone's favour", async () => {
    quiet();
    const text = DESK.csv + "CustomerExperience,csat,Feb 2027,50,%,\n"; // contradicts the Feb csat row
    const ledger = createEvidenceLedger(identity);
    const { result } = load(ledger, DESK, "tenant-y", text, "accept_valid");
    expect(result.rejected.flatMap((x) => x.reasons.map((r) => r.code))).toEqual(["conflicting_record", "conflicting_record"]);
    const p = provider(() => completion(lanes("x", ["F-tickets_opened"])));
    const res = await go(runtime(ledger, DESK, "tenant-y", "importer", p, domainPolicy({ importer: "*" })));
    expect(res).toMatchObject({ state: "blocked" }); // the Jan csat row is now unpaired: fail closed
  });
  it("a later conflicting import does not change the facts already committed", async () => {
    quiet();
    const ledger = createEvidenceLedger(identity);
    load(ledger, DESK, "tenant-y");
    const changed = DESK.csv.replace("Support,tickets_opened,Feb 2027,1200", "Support,tickets_opened,Feb 2027,9999");
    const second = load(ledger, { ...DESK, source: { ...DESK.source, sourceId: "desk-export-2" } }, "tenant-y", changed);
    expect(second.outcome).toMatchObject({ committed: false, reason: "conflicts_with_existing" });
    const ctx = trusted("tenant-y");
    const { authorized } = authorizeEvidence(identity, ctx, domainPolicy({ importer: "*" }), ledger.store.candidates(ctx, "main"));
    expect(computeAuthorizedFacts(authorized, DESK_CTX).find((f) => f.metric === "tickets_opened")!.current).toBe(1200);
  });
  it("unauthorized domains are excluded from facts and prompts, and cannot be cited or named in model text", async () => {
    quiet();
    const ledger = createEvidenceLedger(identity);
    load(ledger, OPS, "tenant-x");
    const grants = { "mkt-analyst": ["Marketing"] };
    const p = provider(() => completion(lanes("Mix may matter.", ["F-leads"])));
    const res = await go(runtime(ledger, OPS, "tenant-x", "mkt-analyst", p, domainPolicy(grants)));
    expect(res.state).toBe("ok");
    if (res.state !== "ok") return;
    expect(res.findings.map((f) => f.metric).sort()).toEqual(["cac", "leads", "mql_rate"]);
    const prompt = JSON.stringify(p.requests[0]!.messages);
    for (const s of ["OPS-FIN", "OPS-SAL", "OPS-OPS", "SYN-GL", "SYN-Pipeline", "SYN-WMS", "F-revenue", "Recognized revenue", "1240000"]) expect(prompt).not.toContain(s);
    for (const content of [lanes("Mix may matter.", ["F-revenue"]), lanes("Check OPS-FIN-001-Q3 for context.", ["F-leads"]), lanes("Check SYN-GL Revenue Summary data.", ["F-leads"]), lanes("Revenue improved.", ["F-leads"])]) {
      const r = await go(runtime(ledger, OPS, "tenant-x", "mkt-analyst", provider(() => completion(content)), domainPolicy(grants)));
      expect(r.state).toBe("rejected");
      expect(JSON.stringify(r)).not.toMatch(/OPS-FIN|SYN-GL|F-revenue/);
    }
  });
  it("an actor with no grants gets nothing sent", async () => {
    quiet();
    const ledger = createEvidenceLedger(identity);
    load(ledger, OPS, "tenant-x");
    const p = provider(() => completion("{}"));
    expect(await go(runtime(ledger, OPS, "tenant-x", "nobody", p, domainPolicy({})))).toMatchObject({ state: "blocked", requestSent: false });
    expect(p.requests).toHaveLength(0);
  });
});

describe("one tenant's imported data cannot become another tenant's evidence", () => {
  it("two tenants, two unrelated datasets, one ledger: each sees only its own, even when the store and policy over-share", async () => {
    quiet();
    const ledger = createEvidenceLedger(identity);
    load(ledger, OPS, "tenant-ops");
    load(ledger, DESK, "tenant-desk");
    // a deliberately leaky store: returns BOTH tenants' evidence to whoever asks
    const leaky: EngineRuntime["store"] = { candidates: (_ctx, dataset) => [...ledger.store.candidates(trusted("tenant-ops"), dataset), ...ledger.store.candidates(trusted("tenant-desk"), dataset)] as never };
    const opsProvider = provider(() => completion(lanes("Mix may matter.", ["F-leads"])));
    const deskProvider = provider(() => completion(lanes("Mix may matter.", ["F-tickets_opened"])));
    const a = await go(runtime(ledger, OPS, "tenant-ops", "importer", opsProvider, overSharing, leaky));
    const b = await go(runtime(ledger, DESK, "tenant-desk", "importer", deskProvider, overSharing, leaky));
    expect([a.state, b.state]).toEqual(["ok", "ok"]);
    const opsPrompt = JSON.stringify(opsProvider.requests[0]!.messages), deskPrompt = JSON.stringify(deskProvider.requests[0]!.messages);
    for (const s of ["tickets_opened", "csat", "Jan 2027", "desk-export", "Service desk"]) expect(opsPrompt).not.toContain(s);
    for (const s of ["OPS-MKT", "OPS-FIN", "SYN-GL", "revenue", "Q3 2026"]) expect(deskPrompt).not.toContain(s);
    expect(a.state === "ok" && a.authorizedIds.every((id) => id.startsWith("OPS-"))).toBe(true);
    expect(b.state === "ok" && b.authorizedIds.every((id) => id.startsWith("desk-export:"))).toBe(true);
  });
  it("model text naming the other tenant's records is rejected as a leak, without echo", async () => {
    quiet();
    const ledger = createEvidenceLedger(identity);
    load(ledger, OPS, "tenant-ops");
    load(ledger, DESK, "tenant-desk");
    const leaky: EngineRuntime["store"] = { candidates: (_c, d) => [...ledger.store.candidates(trusted("tenant-ops"), d), ...ledger.store.candidates(trusted("tenant-desk"), d)] as never };
    const r = await go(runtime(ledger, OPS, "tenant-ops", "importer", provider(() => completion(lanes("See desk-export:L2 for context.", ["F-leads"]))), overSharing, leaky));
    expect(r.state).toBe("rejected");
    expect(JSON.stringify(r)).not.toContain("desk-export");
  });
  it("a tenant column inside an uploaded file cannot redirect evidence to another tenant", () => {
    const evil = DESK.csv.replace("area,", "tenant_id,area,").replace(/^(Support|CustomerExperience),/gm, "tenant-ops,$1,");
    expect(imp(DESK, "tenant-desk", evil)).toEqual({ ok: false, error: { code: "tenant_column_in_file" } });
  });
  it("evidence imported for one tenant cannot be committed or read under another", () => {
    const ledger = createEvidenceLedger(identity);
    const r = must(imp(DESK, "tenant-desk"));
    expect(() => ledger.commit(trusted("tenant-ops"), r, "main")).toThrow();
    expect(ledger.store.candidates(trusted("tenant-ops"), "main")).toEqual([]);
  });
});
