// The prototype's adapter onto the reusable evidence, identity and authorization interfaces (./core). Everything specific to the demo lives
// here: the fictional tenant, the demo roles and workspaces, the bundled scenarios, and the demo's identity "verifier".
//
// SIMULATION, NOT AUTHENTICATION. The demo has no sign-in. Its identity verifier accepts whichever role the caller CLAIMS and labels the
// result `assurance: "simulated"`; any caller can therefore claim any listed role. That is the demo's role picker, shown as such in the UI.
// The tenant is never taken from the request. A real deployment replaces this file's verifier with one that validates a credential (and
// builds its boundary with `assurance: "verified"`), and sets `allowSimulatedIdentity: false` on its runtime so a simulated context is refused.
// Nothing in ./core knows about roles, workspaces, scenarios or this file.
import { z } from "zod";
import { authorizeEvidence, type AccessPolicy, type AuthorizationResult, type EvidenceScope, type EvidenceStore, type TrustedContext } from "./core/access";
import { createIdentityBoundary, type IdentityVerifier } from "./core/identity";
import type { Evidence } from "./core/evidence";
import { PROTOTYPE_CATALOG } from "./prototypeCatalog";
import { DEMO_TENANT_ID, DEPT_WORKSPACE, ROLES, SCENARIOS, WORKSPACES, type EvidenceRecord } from "./data";
import type { ResolvedRequest } from "./meta/runtime";

/** A prototype record that carries the tenant and so satisfies the neutral `Evidence` interface. */
export type PrototypeEvidence = EvidenceRecord & Evidence;

/** Synthetic-only allowlist: only these bundled scenario IDs can ever be sent. */
export const SYNTHETIC_SCENARIO_ALLOWLIST: readonly string[] = SCENARIOS.map((s) => s.id);
const WORKSPACE_IDS = WORKSPACES.map((w) => w.id) as readonly string[];

/** DEMO ROLE FILTERING ONLY — NOT REAL AUTHORIZATION. Server-owned, frozen role → workspace allowlist.
 * Copied (not referenced) from the UI role list so runtime mutation of ROLES cannot widen it.
 * Any caller can still CLAIM any listed role: there is no sign-in. */
export const SERVER_ROLE_WORKSPACES: Readonly<Record<string, readonly string[]>> = Object.freeze(
  Object.fromEntries(ROLES.map((r) => [r.id, Object.freeze(r.workspaces.filter((w) => WORKSPACE_IDS.includes(w)))])),
);
export function workspacesForRole(roleId: string): readonly string[] {
  if (!Object.prototype.hasOwnProperty.call(SERVER_ROLE_WORKSPACES, roleId)) throw new Error("Unknown role");
  return SERVER_ROLE_WORKSPACES[roleId]!;
}

/** The actor id the demo identity layer assigns to a claimed role. */
export const demoActorId = (roleId: string) => `demo-role:${roleId}`;
const WORKSPACES_BY_ACTOR: ReadonlyMap<string, readonly string[]> = new Map(Object.entries(SERVER_ROLE_WORKSPACES).map(([role, ws]) => [demoActorId(role), ws]));

/** Workspace-based demo policy. An unknown actor, or any tenant other than the demo tenant, gets an EMPTY scope (nothing permitted). */
export const demoAccessPolicy: AccessPolicy<PrototypeEvidence> = {
  evidenceScope(ctx: TrustedContext): EvidenceScope<PrototypeEvidence> {
    const granted = ctx.tenantId === DEMO_TENANT_ID ? WORKSPACES_BY_ACTOR.get(ctx.actorId) : undefined;
    const allowed = new Set(granted ?? []);
    // The demo's explicit metric-discovery grant: a role may see the NAMES of the metrics owned by the departments whose workspaces it holds, even in a scenario
    // that has no data for one of them ("no verified data"). This is stated here, by the policy; the engine never infers it from the domains of the data it sees.
    const discoverableMetrics = PROTOTYPE_CATALOG.metrics.filter((m) => allowed.has((DEPT_WORKSPACE as Record<string, string>)[m.domain] ?? "")).map((m) => m.key);
    return { tenantId: ctx.tenantId, permits: (e) => allowed.has(e.workspace), discoverableMetrics };
  },
};

const isEvidence = (r: EvidenceRecord): r is PrototypeEvidence => typeof r.tenantId === "string" && r.tenantId.length > 0;
/** Bundled scenarios as a store. Records without a tenant are dropped here and so can never be authorized. */
export const demoEvidenceStore: EvidenceStore<PrototypeEvidence> = {
  candidates(_ctx, dataset) {
    const s = SCENARIOS.find((x) => x.id === dataset);
    if (!s) throw new Error("Scenario not in synthetic allowlist");
    return s.records.filter(isEvidence);
  },
};

/** The client may send only these fields. Any tenant, workspace, permission or record data it adds is stripped by zod and never read. */
export const RequestSchema = z.object({
  scenarioId: z.string().refine((id) => SYNTHETIC_SCENARIO_ALLOWLIST.includes(id), "Scenario not in synthetic allowlist"),
  // Only an allowlisted role id is accepted; any client workspaces/records/other fields are stripped by zod.
  roleId: z.string().refine((r) => Object.prototype.hasOwnProperty.call(SERVER_ROLE_WORKSPACES, r), "Unknown role"),
  ownerConfirmed: z.literal(true),
  // An optional analysis question. UNTRUSTED: carried through unread; the engine validates it (meta/question.ts) before use.
  question: z.unknown().optional(),
});
export type MetaRequest = z.infer<typeof RequestSchema>;

/** An UNVERIFIED claim made by the caller. It is data for the verifier to judge, never an authenticated fact. */
export interface DemoRoleClaim { readonly kind: "simulated-demo-role-claim"; readonly roleId: string }

/** The demo's identity adapter. SIMULATION: it accepts any allowlisted role the caller claims; the tenant is fixed by the server. */
export const simulatedDemoVerifier: IdentityVerifier = {
  assurance: "simulated",
  verify(credential) {
    const c = credential as Partial<DemoRoleClaim> | null;
    if (typeof c !== "object" || c === null || c.kind !== "simulated-demo-role-claim" || typeof c.roleId !== "string") return null;
    if (!Object.prototype.hasOwnProperty.call(SERVER_ROLE_WORKSPACES, c.roleId)) return null;
    return { tenantId: DEMO_TENANT_ID, actorId: demoActorId(c.roleId) };
  },
};
/** The boundary built from the demo verifier. Held by the demo runtime; contexts it produces are "simulated" and accepted only by consumers holding it. */
export const demoIdentity = createIdentityBoundary(simulatedDemoVerifier);


/** Demo request resolver: validates the request shape and turns the claimed role into a credential for the identity boundary to judge.
 * It issues nothing and reads no tenant, actor, workspace or permission from the request. */
export function resolveDemoRequest(input: unknown): ResolvedRequest {
  const req = RequestSchema.safeParse(input);
  if (!req.success) return { ok: false, reason: `Invalid request: ${req.error.issues.map((i) => i.message).join("; ")}` };
  const claim: DemoRoleClaim = { kind: "simulated-demo-role-claim", roleId: req.data.roleId };
  return { ok: true, credential: claim, dataset: req.data.scenarioId, ...(req.data.question !== undefined ? { question: req.data.question } : {}) };
}

/** Authorize a demo request's evidence directly (used by tests and by `authorizedRecords`). Same checks as the live path, in the same order. */
export function authorizeDemo(req: Pick<MetaRequest, "scenarioId" | "roleId">): AuthorizationResult<PrototypeEvidence> {
  if (!SYNTHETIC_SCENARIO_ALLOWLIST.includes(req.scenarioId)) throw new Error("Scenario not in synthetic allowlist");
  workspacesForRole(req.roleId); // throws "Unknown role"
  const ctx: TrustedContext = demoIdentity.authenticateSync({ kind: "simulated-demo-role-claim", roleId: req.roleId } satisfies DemoRoleClaim);
  return authorizeEvidence(demoIdentity, ctx, demoAccessPolicy, demoEvidenceStore.candidates(ctx, req.scenarioId));
}
