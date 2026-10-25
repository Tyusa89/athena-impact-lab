# Identity boundary (PR B-2)

Scope: how the Business Impact Engine learns **who is asking and for which tenant**, and what it does and does not guarantee about that.
This is a hardening of the interfaces introduced in PR #8. It is **not** an authentication system.

## Original weakness (at PR #8, `issueTrustedContext`)

`core/access.ts` exported `issueTrustedContext(tenantId, actorId)`, a function that turned two strings into a trusted context. The context
was then accepted by `authorizeEvidence`. Verified on `main` before this change:

| | Result |
|---|---|
| Any code in the server process could call it with arbitrary strings | **Yes.** `issueTrustedContext("tenant-verdant-hollow-demo", "demo-role:exec")` returned an exec-level context and `authorizeEvidence` released every demo record. No credential, role claim or allowlist was involved. |
| Arbitrary tenant and actor values accepted | **Yes** (any non-empty, trimmed string). Whether that exposes data depends on the policy and store; a policy that knows the tenant would honour it. |
| Reachable from a browser request in the prototype | **No.** The only call site was the demo resolver, which fixed the tenant, allowlisted the role and ignored every other field. A client could not choose a tenant or actor. |

So the weakness was a **capability leak**, not a remote exploit: a single mistaken call site (or a future route handler that passed a request
field into it) would have created an authentication bypass, and nothing in the design prevented that or marked such a context as unauthenticated.

Separately, and by design, the demo has **no sign-in**: it accepts whichever role the caller claims. That is the simulated role picker, not a vulnerability
of the engine, and it is now labelled `assurance: "simulated"` in the data model as well as in the UI.

## What changed

* `core/identity.ts` (new). A trusted context can only be produced by an **`IdentityBoundary`**, which is built from one designated
  **`IdentityVerifier`** (the server-side identity adapter). `boundary.authenticate(credential)` hands the caller's raw credential to the verifier and mints
  a context from the tenant and actor **the verifier returns**. There is no exported function that takes a tenant id and an actor id.
* The context is stamped with the verifier's **assurance**: `"verified"` or `"simulated"`. A verifier's answer cannot raise its own assurance.
* `authorizeEvidence(identity, ctx, policy, candidates)` accepts a context only if **that boundary produced it**. Copies, spreads, parsed JSON, `Object.create`,
  proxies, and contexts from any other boundary are refused.
* Verification **fails closed**: a verifier that throws, rejects, answers nothing or garbage, returns malformed or oversized ids, or does not answer within the
  timeout (5 s default) yields one generic `AuthorizationError`. Nothing is loaded or sent. The verifier's answer is snapshotted (each field read once).
* `runMeta` takes the boundary from its runtime. The request resolver now returns an **unverified credential**, not a context. Authentication happens first,
  before any evidence is read. A runtime sets `allowSimulatedIdentity: false` to refuse simulated identities (the demo sets it to `true`).
* The prototype adapter is the composition root: it defines the demo "verifier" (accepts an allowlisted claimed role, fixes the tenant, `assurance: "simulated"`).
* `issueTrustedContext` is removed.

## Guarantees now enforced

1. No engine code path treats a tenant, role, permission or actor from a request, a model output or any other unverified input as an authenticated fact.
2. A context exists only as the output of the designated verifier for a credential it was given.
3. A consumer accepts only contexts from the boundary it holds; other code cannot make its own contexts count.
4. Verification failure of any kind sends nothing, reads no evidence, and reveals nothing (generic error; no log of the cause).
5. Tenant isolation is still enforced inside `authorizeEvidence`, independent of the policy and store (PR #8), and hidden identifiers cannot appear in prompts or errors.
6. Simulated identities are distinguishable from verified ones at the point of use.

## What this does NOT provide, and what still depends on future production authentication

* **It is not authentication.** There is no login, token validation, session handling or key management. The security of the whole design is the security of the
  verifier a deployment plugs in. A verifier that trusts its input (as the test verifiers and the demo's do) authenticates nothing.
* **The demo is still a simulation.** Any caller can claim any listed demo role. `assurance: "simulated"` records that; it does not prevent it.
* **Hostile code inside the server process is out of scope.** Code that can run in the process can build its own boundary with a lying verifier, call into a
  runtime it has been handed, or read memory and secrets. The design means such a boundary's contexts are refused by every consumer holding a different boundary,
  but JavaScript cannot enforce module-level secrecy against in-process attackers. Keep the boundary in the composition root and pass it only to the runtime.
* **TypeScript types, `Object.freeze`, `WeakSet` registries and the source-scan tests are guard rails against mistakes, not security boundaries.**
  The repository's tests assert that only the composition root builds a boundary and that no module exports a minting function; a determined in-process author can
  still change that. They exist to catch accidents in review.
* Needs a future authenticated runtime: a real verifier (for example validating a signed token from your identity provider), a production runtime configured with
  `allowSimulatedIdentity: false`, transport security, session lifetime and revocation, audit logging of authentications, and database-level tenant isolation in the store.
* The `dataset` selector passed to an `EvidenceStore` is a server-validated allowlisted value in the demo; a real resolver must validate it the same way.
