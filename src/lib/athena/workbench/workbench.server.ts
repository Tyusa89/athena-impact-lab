// Server composition of the interactive Business Impact Map. SERVER ONLY (reads bundled synthetic data and runs the engine).
//
// Binds the generic, deterministic engine (`runImpactAnalysis`, `buildImpactMap`) to a registry of replaceable synthetic datasets and returns ONLY a
// presentation view (./view). No model provider is imported or called anywhere on this path; nothing is sent over a network.
//
//   * The browser sends dataset, scenario and role ids plus a question. It never sends a tenant, actor, workspace, permission, metric scope or record.
//     Each id is checked against a server-side allowlist; the tenant is fixed here; the role is a SIMULATION (a claim the server accepts, not authentication).
//   * Authorization, tenant isolation, metric discoverability, fact calculation and relationship assessment all run inside the engine, unchanged.
//   * Adding a dataset means adding one descriptor to DATASETS (catalog, periods, relationship model, store, policy). The interface and this file's `run` do not change.
import { createIdentityBoundary, type IdentityBoundary, type IdentityVerifier } from "../core/identity";
import type { AccessPolicy, EvidenceScope, EvidenceStore } from "../core/access";
import type { Evidence } from "../core/evidence";
import type { AnalysisContext } from "../core/facts";
import { SUPPORT_DESK_CATALOG, SUPPORT_DESK_MAPPING, SUPPORT_DESK_PERIODS, SUPPORT_DESK_SOURCE } from "../core/ingest/fixtures";
import { csvAdapter, importSource } from "../core/ingest";
import deskCsv from "../core/ingest/fixtures/customer-support.csv?raw";
import { DEMO_QUESTION, PROTOTYPE_CONTEXT } from "../engine";
import { COMPANY, ROLES, SCENARIOS } from "../data";
import { BUSINESS_OPS_MODEL, SUPPORT_DESK_MODEL } from "../impactModels";
import type { RelationshipModel } from "../meta/impact";
import { runImpactAnalysis, type EngineRuntime } from "../meta/runtime";
import { demoAccessPolicy, demoEvidenceStore, demoIdentity, resolveDemoRequest } from "../prototypeAdapter";
import { buildImpactView, type WorkbenchDatasetInfo, type WorkbenchResult } from "./view";

type Runtime = Pick<EngineRuntime, "resolve" | "identity" | "allowSimulatedIdentity" | "store" | "policy" | "analysis" | "question">;

interface WorkbenchDataset extends WorkbenchDatasetInfo {
  model: RelationshipModel;
  analysis: AnalysisContext;
  /** The engine runtime for one (already allowlisted) scenario and role. The question is untrusted and is validated by the engine. */
  runtime(scenarioId: string, roleId: string, question: unknown): Runtime;
}

// ---------------------------------------------------------------- dataset 1: business operations (the prototype's bundled scenarios and demo roles)
const ROLE_NOTES: Record<string, string> = {
  exec: "Sees every department.",
  marketing: "Sees Marketing and Sales records.",
  ops: "Sees Operations and Sales records.",
  finance: "Sees Finance records only.",
};
const businessOps: WorkbenchDataset = {
  id: "business-operations",
  name: "Business operations",
  description: `${COMPANY.name}: marketing, sales, operations and finance metrics for a fictional home-goods company.`,
  notice: COMPANY.label,
  scenarios: SCENARIOS.map((s) => ({ id: s.id, label: s.name, description: s.description })),
  roles: ROLES.map((r) => ({ id: r.id, label: r.label, description: ROLE_NOTES[r.id] ?? "" })),
  defaultQuestion: DEMO_QUESTION,
  suggestedQuestions: [DEMO_QUESTION, "Is slower fulfillment hurting sales?", "What is happening to customer acquisition cost and lead quality?", "Give me the complete picture of this period."],
  model: BUSINESS_OPS_MODEL,
  analysis: PROTOTYPE_CONTEXT,
  runtime: (scenarioId, roleId, question) => ({
    // The demo resolver requires `ownerConfirmed` because its other path can call a paid model; this deterministic path never does. Tenant, actor and workspaces come from the server.
    resolve: () => resolveDemoRequest({ scenarioId, roleId, ownerConfirmed: true, ...(question !== undefined ? { question } : {}) }),
    identity: demoIdentity, allowSimulatedIdentity: true, store: demoEvidenceStore, policy: demoAccessPolicy, analysis: PROTOTYPE_CONTEXT, question: DEMO_QUESTION,
  }),
};

// ---------------------------------------------------------------- dataset 2: customer support (a different catalog, different periods, different roles, imported from CSV)
const DESK_TENANT = "tenant-support-desk-demo";
const OTHER_TENANT = "tenant-other-demo"; // a second tenant's copy of the same file sits in the store: isolation is exercised on every request
const DESK_DEFAULT_QUESTION = "Why is customer satisfaction falling while ticket volume rises?";
const DESK_ROLES: { id: string; label: string; description: string; domains: readonly string[]; discover: readonly string[] }[] = [
  { id: "desk-director", label: "Support director (all areas)", description: "Sees Support and Customer Experience records.", domains: ["Support", "CustomerExperience"], discover: [] },
  { id: "support-lead", label: "Support team lead", description: "Sees Support records. The access policy also lets this role know about one further metric for which it has no data.", domains: ["Support"], discover: ["csat"] },
  { id: "cx-analyst", label: "Customer experience analyst", description: "Sees Customer Experience records only.", domains: ["CustomerExperience"], discover: [] },
];
const DESK_ROLE_BY_ID = new Map(DESK_ROLES.map((r) => [r.id, r]));

interface DeskClaim { readonly kind: "simulated-desk-role-claim"; readonly roleId: string }
/** Server-only claim used to load the bundled file into a tenant. It is never produced from a request: `resolve` below can only build a role claim. */
interface LoaderClaim { readonly kind: "bundled-fixture-loader"; readonly tenantId: string }
const deskVerifier: IdentityVerifier = {
  assurance: "simulated",
  verify(credential) {
    const c = credential as { kind?: unknown; roleId?: unknown; tenantId?: unknown } | null;
    if (typeof c !== "object" || c === null) return null;
    if (c.kind === "bundled-fixture-loader" && (c.tenantId === DESK_TENANT || c.tenantId === OTHER_TENANT)) return { tenantId: c.tenantId, actorId: "bundled-fixture-loader" };
    if (c.kind !== "simulated-desk-role-claim" || typeof c.roleId !== "string" || !DESK_ROLE_BY_ID.has(c.roleId)) return null;
    return { tenantId: DESK_TENANT, actorId: `desk-role:${c.roleId}` };
  },
};
const deskIdentity: IdentityBoundary = createIdentityBoundary(deskVerifier);

/** The bundled file, imported once per tenant through the same ingestion path any real source would use. Fails closed (empty) if it cannot be imported. */
function importDeskFor(tenantId: string): readonly Evidence[] {
  // The other tenant's copy differs in value (+1), so a leak across tenants would change what the interface shows, not merely duplicate it.
  const input = tenantId === DESK_TENANT ? deskCsv : deskCsv.replace(/,(\d+(?:\.\d+)?),(tickets|hours|%)/g, (_m, n: string, u: string) => `,${Number(n) + 1},${u}`);
  const ctx = deskIdentity.authenticateSync({ kind: "bundled-fixture-loader", tenantId } satisfies LoaderClaim);
  const r = importSource({ identity: deskIdentity, ctx, policy: { mayImport: () => true }, adapter: csvAdapter, input, source: SUPPORT_DESK_SOURCE, spec: SUPPORT_DESK_MAPPING, catalog: SUPPORT_DESK_CATALOG });
  return r.ok && r.status !== "rejected" ? r.accepted : [];
}
let deskRecords: readonly Evidence[] | undefined;
const deskStore: EvidenceStore<Evidence> = {
  candidates(_ctx, dataset) {
    if (dataset !== "pricing-backlog") throw new Error("Scenario not in synthetic allowlist");
    deskRecords ??= [...importDeskFor(DESK_TENANT), ...importDeskFor(OTHER_TENANT)];
    return deskRecords;
  },
};
const deskPolicy: AccessPolicy<Evidence> = {
  evidenceScope(ctx): EvidenceScope<Evidence> {
    const role = ctx.tenantId === DESK_TENANT ? DESK_ROLE_BY_ID.get(ctx.actorId.replace(/^desk-role:/, "")) : undefined;
    const allowed = new Set(role?.domains ?? []);
    return { tenantId: ctx.tenantId, permits: (e) => allowed.has(e.department), discoverableMetrics: [...(role?.discover ?? [])] };
  },
};
const customerSupport: WorkbenchDataset = {
  id: "customer-support",
  name: "Customer support",
  description: "A fictional customer-support service desk.",
  notice: "SYNTHETIC service-desk data for demonstration",
  scenarios: [{ id: "pricing-backlog", label: "Jan → Feb 2027 service desk snapshot", description: "A two-month service desk comparison." }],
  roles: DESK_ROLES.map((r) => ({ id: r.id, label: r.label, description: r.description })),
  defaultQuestion: DESK_DEFAULT_QUESTION,
  suggestedQuestions: [DESK_DEFAULT_QUESTION, "Is slower first response hurting satisfaction?", "Give me the complete picture of this period."],
  model: SUPPORT_DESK_MODEL,
  analysis: { catalog: SUPPORT_DESK_CATALOG, periods: SUPPORT_DESK_PERIODS },
  runtime: (scenarioId, roleId, question) => ({
    resolve: () => ({ ok: true, credential: { kind: "simulated-desk-role-claim", roleId } satisfies DeskClaim, dataset: scenarioId, ...(question !== undefined ? { question } : {}) }),
    identity: deskIdentity, allowSimulatedIdentity: true, store: deskStore, policy: deskPolicy as AccessPolicy,
    analysis: { catalog: SUPPORT_DESK_CATALOG, periods: SUPPORT_DESK_PERIODS }, question: DESK_DEFAULT_QUESTION,
  }),
};

const DATASETS: ReadonlyMap<string, WorkbenchDataset> = new Map([businessOps, customerSupport].map((d) => [d.id, d]));

/** What the interface may offer: names and descriptions of datasets, scenarios and simulated roles, and sample questions. No metric, record or count. */
export function workbenchOptions(): WorkbenchDatasetInfo[] {
  return [...DATASETS.values()].map((d) => ({
    id: d.id, name: d.name, description: d.description, notice: d.notice, defaultQuestion: d.defaultQuestion, suggestedQuestions: [...d.suggestedQuestions],
    scenarios: d.scenarios.map((s) => ({ ...s })), roles: d.roles.map((r) => ({ ...r })),
  }));
}

const BAD_SELECTION = "Unknown dataset, scenario or role.";
const isId = (x: unknown): x is string => typeof x === "string" && x.length > 0 && x.length <= 64;

/** Run the deterministic engine for one selection and return its presentation view. Never throws; every failure is a fixed, non-revealing message. */
export async function runWorkbench(input: unknown): Promise<WorkbenchResult> {
  try {
    const req = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
    const { datasetId, scenarioId, roleId } = req;
    const ds = isId(datasetId) ? DATASETS.get(datasetId) : undefined;
    const scenario = ds && isId(scenarioId) ? ds.scenarios.find((s) => s.id === scenarioId) : undefined;
    const role = ds && isId(roleId) ? ds.roles.find((r) => r.id === roleId) : undefined;
    if (!ds || !scenario || !role) return { state: "blocked", reason: BAD_SELECTION };
    // A blank question means "use the dataset's default"; anything else is untrusted text that the engine validates and never echoes.
    const q = req["question"];
    const question = q === undefined || q === null || (typeof q === "string" && q.trim() === "") ? undefined : q;
    const r = await runImpactAnalysis({}, ds.runtime(scenario.id, role.id, question), ds.model);
    if (r.state !== "ok") return { state: "blocked", reason: r.reason };
    return { state: "ok", view: buildImpactView(r.impact, r.records, ds.analysis, ds.model, { datasetName: ds.name, scenarioName: scenario.label, roleLabel: role.label }) };
  } catch {
    return { state: "blocked", reason: "The analysis could not be completed." };
  }
}
