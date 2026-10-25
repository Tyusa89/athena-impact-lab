// The prototype's adapter onto the reusable evidence and authorization interfaces (./core). Everything specific to the demo lives
// here: the fictional tenant, the demo roles and workspaces, the bundled scenarios, and how a request becomes a trusted context.
//
// DEMO ROLE FILTERING ONLY — NOT REAL AUTHORIZATION. There is no sign-in: any caller can CLAIM any listed demo role, and
// `resolveDemoRequest` accepts that claim. A real deployment replaces this adapter with one whose resolver verifies a credential
// before it issues a trusted context. Nothing in ./core knows about roles, workspaces, scenarios or this file.
import { z } from "zod";
import { authorizeEvidence, issueTrustedContext, type AccessPolicy, type AuthorizationResult, type EvidenceScope, type EvidenceStore, type TrustedContext } from "./core/access";
import type { Evidence } from "./core/evidence";
import { DEMO_TENANT_ID, ROLES, SCENARIOS, WORKSPACES, type EvidenceRecord } from "./data";

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
    return { tenantId: ctx.tenantId, permits: (e) => allowed.has(e.workspace) };
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
});
export type MetaRequest = z.infer<typeof RequestSchema>;

export type ResolvedRequest = { ok: true; ctx: TrustedContext; dataset: string } | { ok: false; reason: string };
/** Demo identity layer: turns an (unverified) request into a trusted context. The tenant is fixed by the server, never read from the request. */
export function resolveDemoRequest(input: unknown): ResolvedRequest {
  const req = RequestSchema.safeParse(input);
  if (!req.success) return { ok: false, reason: `Invalid request: ${req.error.issues.map((i) => i.message).join("; ")}` };
  return { ok: true, ctx: issueTrustedContext(DEMO_TENANT_ID, demoActorId(req.data.roleId)), dataset: req.data.scenarioId };
}

/** Authorize a demo request's evidence directly (used by tests and by `authorizedRecords`). Same checks as the live path, in the same order. */
export function authorizeDemo(req: Pick<MetaRequest, "scenarioId" | "roleId">): AuthorizationResult<PrototypeEvidence> {
  if (!SYNTHETIC_SCENARIO_ALLOWLIST.includes(req.scenarioId)) throw new Error("Scenario not in synthetic allowlist");
  workspacesForRole(req.roleId); // throws "Unknown role"
  const ctx = issueTrustedContext(DEMO_TENANT_ID, demoActorId(req.roleId));
  return authorizeEvidence(ctx, demoAccessPolicy, demoEvidenceStore.candidates(ctx, req.scenarioId));
}
