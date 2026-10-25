// Authorization interface and enforcement for evidence. Pure and dependency-free (no I/O, no authentication, no storage).
//
//   TrustedContext     who is asking and for which tenant. Produced only by an IdentityBoundary (./identity) from a verified credential;
//                      there is no way to build one from a tenant id and an actor id.
//   AccessPolicy       decides, for a trusted context, which evidence may be used (an `EvidenceScope`).
//   EvidenceStore      supplies the candidate evidence for a request. It is NOT trusted to have filtered anything.
//   authorizeEvidence  the single choke point: it accepts a context only from the identity boundary it is given, enforces tenant isolation
//                      itself, and returns a branded, frozen `AuthorizedEvidence` that the fact and prompt stages require.
//
// This establishes interfaces and server-side enforcement points. It is not authentication, not database-level tenant isolation,
// and not a statement that the engine is ready for sensitive customer records. See ./identity for what the identity boundary does and does not do.
import type { Evidence } from "./evidence";
import { AuthorizationError, type IdentityBoundary, type TrustedContext } from "./identity";

export { AuthorizationError };
export type { Assurance, IdentityBoundary, IdentityVerifier, TrustedContext, VerifiedIdentity } from "./identity";
declare const AUTHORIZED: unique symbol;
const nonEmpty = (s: unknown): s is string => typeof s === "string" && s.length > 0 && s.trim() === s;

/** The evidence one trusted context may use. */
export interface EvidenceScope<E extends Evidence = Evidence> {
  /** Must equal the context's tenant; a scope for another tenant is refused. */
  readonly tenantId: string;
  /** Must return exactly `true` to allow a record. Anything else (false, undefined, a throw) denies. */
  permits(evidence: E): boolean;
}
export interface AccessPolicy<E extends Evidence = Evidence> {
  evidenceScope(ctx: TrustedContext): EvidenceScope<E>;
}
/** Supplies candidate evidence. It may return more than the caller may see (for example other tenants' records in a shared fixture);
 * everything it returns is filtered by `authorizeEvidence`. `dataset` is an opaque selector that the server's request resolver has validated
 * against a server-side allowlist; the store must never treat it as a path, a query or a tenant. */
export interface EvidenceStore<E extends Evidence = Evidence> {
  candidates(ctx: TrustedContext, dataset: string): readonly E[];
}

/** Evidence that has passed `authorizeEvidence`: frozen, all in one tenant, and registered so it cannot be forged or rebuilt by copying. */
export type AuthorizedEvidence<E extends Evidence = Evidence> = readonly E[] & { readonly [AUTHORIZED]: true; readonly tenantId: string };
export interface AuthorizationResult<E extends Evidence = Evidence> {
  readonly authorized: AuthorizedEvidence<E>;
  /** Candidates the context may not use (other tenants, other roles). SERVER-SIDE ONLY: used to detect leaks of their identifiers in
   * model text. Must never be put in a prompt, a response or a log. */
  readonly withheld: readonly E[];
}

const authorizedSets = new WeakSet<object>();
export const isAuthorizedEvidence = (x: unknown): x is AuthorizedEvidence => typeof x === "object" && x !== null && authorizedSets.has(x);
/** Throws unless `x` came from `authorizeEvidence`. Fact calculation and model preparation call this on their input. */
export function assertAuthorized<E extends Evidence>(x: readonly E[]): asserts x is AuthorizedEvidence<E> {
  if (!isAuthorizedEvidence(x)) throw new AuthorizationError();
}

const wellFormed = (e: unknown): e is Evidence => {
  if (typeof e !== "object" || e === null) return false;
  const r = e as Record<string, unknown>;
  return nonEmpty(r["id"]) && nonEmpty(r["tenantId"]) && typeof r["source"] === "string";
};

/**
 * Select the evidence a trusted context may use.
 *  1. The context must have been produced by the given identity boundary (not a copy, parsed JSON, or another boundary's context).
 *  2. The policy's scope must be for the context's own tenant.
 *  3. A candidate is kept only if it belongs to the context's tenant (checked here, independent of the policy and the store)
 *     AND the scope permits it with exactly `true`.
 *  4. Any error from the policy or store fails closed with a generic `AuthorizationError`.
 * Malformed candidates (no id/tenant) are withheld, never authorized.
 */
export function authorizeEvidence<E extends Evidence>(identity: IdentityBoundary, ctx: TrustedContext, policy: AccessPolicy<E>, candidates: readonly E[]): AuthorizationResult<E> {
  if (!identity.owns(ctx)) throw new AuthorizationError();
  let scope: EvidenceScope<E>;
  try {
    scope = policy.evidenceScope(ctx);
  } catch {
    throw new AuthorizationError();
  }
  if (!scope || scope.tenantId !== ctx.tenantId) throw new AuthorizationError();
  const kept: E[] = [];
  const withheld: E[] = [];
  try {
    for (const c of candidates) {
      if (wellFormed(c) && c.tenantId === ctx.tenantId && scope.permits(c) === true) kept.push(Object.freeze({ ...c }));
      else withheld.push(c);
    }
  } catch {
    throw new AuthorizationError();
  }
  const authorized = Object.freeze(Object.assign(kept, { tenantId: ctx.tenantId })) as unknown as AuthorizedEvidence<E>;
  authorizedSets.add(authorized);
  return Object.freeze({ authorized, withheld: Object.freeze(withheld) });
}
