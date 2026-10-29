// Prototype-facing facade over ./semantic. The generic guards require an explicit catalog; this module keeps the original signatures by defaulting it
// to the bundled prototype's, and exposes the prototype's metric -> department map. The live pipeline always passes its own catalog.
import { assertCatalog, type Catalog } from "../core/catalog";
import type { EvidenceLike } from "../core/evidence";
import { PROTOTYPE_CATALOG } from "../prototypeCatalog";
import type { VerifiedFact } from "./grounding";
import * as s from "./semantic";

export * from "./semantic";
export const METRIC_DEPARTMENT = s.departmentByMetric(PROTOTYPE_CATALOG);
export const directionalClaims = (text: string, lane: s.Lane, catalog: Catalog = PROTOTYPE_CATALOG) => s.directionalClaims(text, lane, catalog);
export const magnitudeExpressions = (text: string, lane: s.Lane = "interpretation", catalog: Catalog = PROTOTYPE_CATALOG) => s.magnitudeExpressions(text, lane, catalog);
/** The prototype policy's explicit metric grant (`demoAccessPolicy`): every metric owned by a department whose workspace the role holds. This restates the POLICY's rule for callers that
 * have no policy at hand (tests, the facade); the generic `semanticScope` never infers a grant from the departments of the records it is given. */
export const prototypeDiscoverable = (authorized: readonly EvidenceLike[], catalog: Catalog = PROTOTYPE_CATALOG): string[] => {
  assertCatalog(catalog);
  const held = new Set(authorized.map((r) => r.department));
  return catalog.metrics.filter((m) => held.has(m.domain)).map((m) => m.key);
};
export const semanticScope = (authorized: readonly EvidenceLike[], facts: readonly VerifiedFact[], catalog: Catalog = PROTOTYPE_CATALOG, opts: s.SemanticScopeOptions = {}) => {
  // F2: only the LEGACY (non-strict) scope may fall back to the department-derived grant. A strict scope (anything but `undefined`/`false` for `strictMentions`, as `isStrictMentions` reads it)
  // needs the policy's explicit grant (`undefined` and `null` both count as absent); inferring it from which departments' records happen to be present would let record presence widen what the model may name.
  if ((opts.discoverable === undefined || opts.discoverable === null) && s.isStrictMentions(opts.strictMentions)) throw new TypeError("A strict semantic scope requires an explicit discoverable grant");
  return s.semanticScope(authorized, facts, catalog, { ...opts, discoverable: opts.discoverable ?? prototypeDiscoverable(authorized, catalog) });
};
