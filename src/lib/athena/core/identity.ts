// Identity boundary: the only way a TrustedContext comes into existence. Pure and dependency-free (no I/O, no vendor, no sessions).
//
// WHAT THIS IS. A capability design. A deployment designates ONE identity adapter (an `IdentityVerifier`) when it composes the
// server, by building an `IdentityBoundary` from it. A trusted context can then be produced only by `boundary.authenticate(credential)`:
// the verifier receives the caller's raw credential and returns the tenant and actor it VERIFIED, or nothing. There is no exported
// function that turns a tenant id and an actor id into a context, and nothing in the engine reads a tenant, role, permission or actor
// from a request, a model output or any other unverified input as an authenticated fact. The consumer (`authorizeEvidence`) accepts a
// context only from the boundary it was given, so a boundary built elsewhere (or a forged lookalike) is refused.
//
// WHAT THIS IS NOT. It is not authentication: it contains no login, token validation or session handling; that is the verifier's job
// and the verifier is the single place that must be correct. It does not defend against hostile code running inside the server process
// (such code can build its own boundary, but its contexts are refused by every consumer that holds a different boundary; it can still
// read process memory and secrets, which no module-level design prevents). TypeScript types, `Object.freeze` and the source-scan tests
// in this repository are guard rails against mistakes, not security boundaries. A real deployment needs a real verifier and a runtime
// whose composition root is not reachable by untrusted code.
declare const TRUSTED: unique symbol;

/** Raised for any authentication or authorization failure. Deliberately generic: it never names tenants, actors, records or sources. */
export class AuthorizationError extends Error {
  constructor() {
    super("Authorization failed");
    this.name = "AuthorizationError";
  }
}

/**
 * How much the tenant and actor can be relied on.
 *  - "verified":  a verifier established them from a credential it validated (a signed token, a session, ...).
 *  - "simulated": they were chosen by the caller and merely accepted (the demo's role picker). Nothing is authenticated.
 */
export type Assurance = "verified" | "simulated";

/** What a verifier returns: the identity it established. Never populated from request fields the caller controls. */
export interface VerifiedIdentity {
  readonly tenantId: string;
  readonly actorId: string;
}
/**
 * The designated, server-side identity adapter. Replaceable: nothing here names a vendor. It receives an opaque credential exactly as the
 * transport delivered it and must return the verified identity, or `null`/throw when it cannot. If the identity service is unavailable it
 * must throw or reject; the boundary treats every failure, malformed answer or timeout as "not authenticated".
 */
export interface IdentityVerifier {
  readonly assurance: Assurance;
  verify(credential: unknown): VerifiedIdentity | null | Promise<VerifiedIdentity | null>;
}

/** An authenticated tenant and actor, produced only by an `IdentityBoundary`. */
export interface TrustedContext {
  readonly [TRUSTED]: true;
  readonly tenantId: string;
  readonly actorId: string;
  readonly assurance: Assurance;
}

export interface IdentityBoundary {
  readonly assurance: Assurance;
  /** Verify a credential. Rejects with `AuthorizationError` on a missing/invalid credential, an unavailable verifier, a malformed answer or a timeout. */
  authenticate(credential: unknown): Promise<TrustedContext>;
  /** Same, for verifiers that answer synchronously (in-process, no network, such as the demo simulation). Refuses a verifier that answers asynchronously. */
  authenticateSync(credential: unknown): TrustedContext;
  /** True only for a context this very boundary produced (not a copy, a parsed JSON value, or a context from another boundary). */
  owns(ctx: unknown): ctx is TrustedContext;
}

export const IDENTITY_TIMEOUT_MS = 5_000;
const nonEmpty = (s: unknown): s is string => typeof s === "string" && s.length > 0 && s.length <= 256 && s.trim() === s;

/**
 * Designate an identity adapter. The result is the capability to authenticate callers; keep it in the server's composition root and hand it
 * only to the runtime that needs it. Contexts it produces are accepted only by consumers holding this same boundary.
 */
export function createIdentityBoundary(verifier: IdentityVerifier, options: { timeoutMs?: number } = {}): IdentityBoundary {
  if (verifier?.assurance !== "verified" && verifier?.assurance !== "simulated") throw new AuthorizationError();
  const assurance = verifier.assurance;
  const timeoutMs = options.timeoutMs ?? IDENTITY_TIMEOUT_MS;
  const minted = new WeakSet<object>();

  /** Validate and snapshot the verifier's answer (each field read once), then mint. Anything else is a refusal. */
  const mint = (answer: unknown): TrustedContext => {
    if (typeof answer !== "object" || answer === null) throw new AuthorizationError();
    const { tenantId, actorId } = answer as Record<string, unknown>;
    if (!nonEmpty(tenantId) || !nonEmpty(actorId)) throw new AuthorizationError();
    const ctx = Object.freeze({ tenantId, actorId, assurance }) as unknown as TrustedContext;
    minted.add(ctx);
    return ctx;
  };

  return Object.freeze({
    assurance,
    owns: (ctx: unknown): ctx is TrustedContext => typeof ctx === "object" && ctx !== null && minted.has(ctx),
    authenticateSync(credential: unknown): TrustedContext {
      let answer: unknown;
      try {
        answer = verifier.verify(credential);
      } catch {
        throw new AuthorizationError();
      }
      if (typeof (answer as { then?: unknown } | null)?.then === "function") {
        (answer as Promise<unknown>).then(undefined, () => {}); // refused, and its eventual rejection must not surface as an unhandled one
        throw new AuthorizationError(); // async verifier: use authenticate()
      }
      return mint(answer);
    },
    async authenticate(credential: unknown): Promise<TrustedContext> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const answer = await Promise.race([
          Promise.resolve().then(() => verifier.verify(credential)),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new AuthorizationError()), timeoutMs); }),
        ]);
        return mint(answer);
      } catch {
        throw new AuthorizationError(); // unavailable, rejected, timed out or malformed: always the same generic failure
      } finally {
        clearTimeout(timer);
      }
    },
  });
}
