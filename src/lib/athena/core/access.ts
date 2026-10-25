// Authorization interface and enforcement for evidence. Pure and dependency-free (no I/O, no authentication, no storage).
//
//   TrustedContext   who is asking and for which tenant. Only the server's identity layer may mint one (`issueTrustedContext`),
//                    after it has verified a credential. Plain objects, copies and parsed JSON are never accepted.
//   AccessPolicy     decides, for a trusted context, which evidence may be used (an `EvidenceScope`).
//   EvidenceStore    supplies the candidate evidence for a request. It is NOT trusted to have filtered anything.
//   authorizeEvidence the single choke point: tenant isolation is enforced here regardless of what the policy or store did,
//                    and the result is a branded, frozen `AuthorizedEvidence` that the fact and prompt stages require.
//
// This establishes interfaces and server-side enforcement points. It is not authentication, not database-level tenant isolation,
// and not a statement that the engine is ready for sensitive customer records.
import type { Evidence } from "./evidence";

/** Raised for any authorization failure. The message is deliberately generic: it never names tenants, actors, records or sources. */
export class AuthorizationError extends Error {
  constructor() {
    super("Authorization failed");
    this.name = "AuthorizationError";
  }
}

declare const TRUSTED: unique symbol;
declare const AUTHORIZED: unique symbol;

/** A tenant and actor established by the server's identity layer. Never construct one from client input, model output or JSON. */
export interface TrustedContext {
  readonly [TRUSTED]: true;
  readonly tenantId: string;
  readonly actorId: string;
}

const issued = new WeakSet<object>();
const nonEmpty = (s: unknown): s is string => typeof s === "string" && s.length > 0 && s.trim() === s;

/**
 * Mint a trusted context. SERVER-SIDE ONLY: call it from the identity layer after it has verified who the caller is and which
 * tenant they belong to (a session, a signed token, ...). The ids must come from that verification, never from request fields
 * the caller controls. The result is frozen and remembered, so a forged lookalike is refused by `authorizeEvidence`.
 */
export function issueTrustedContext(tenantId: string, actorId: string): TrustedContext {
  if (!nonEmpty(tenantId) || !nonEmpty(actorId)) throw new AuthorizationError();
  const ctx = Object.freeze({ tenantId, actorId }) as unknown as TrustedContext;
  issued.add(ctx);
  return ctx;
}
export const isTrustedContext = (x: unknown): x is TrustedContext => typeof x === "object" && x !== null && issued.has(x);

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
 * everything it returns is filtered by `authorizeEvidence`. `dataset` is an opaque selector chosen by the server, not the client. */
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
 *  1. The context must have been issued by `issueTrustedContext`.
 *  2. The policy's scope must be for the context's own tenant.
 *  3. A candidate is kept only if it belongs to the context's tenant (checked here, independent of the policy and the store)
 *     AND the scope permits it with exactly `true`.
 *  4. Any error from the policy or store fails closed with a generic `AuthorizationError`.
 * Malformed candidates (no id/tenant) are withheld, never authorized.
 */
export function authorizeEvidence<E extends Evidence>(ctx: TrustedContext, policy: AccessPolicy<E>, candidates: readonly E[]): AuthorizationResult<E> {
  if (!isTrustedContext(ctx)) throw new AuthorizationError();
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
