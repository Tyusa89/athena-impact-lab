// Prototype-facing facade over ./semantic. The generic guards require an explicit catalog; this module keeps the original signatures by defaulting it
// to the bundled prototype's, and exposes the prototype's metric -> department map. The live pipeline always passes its own catalog.
import type { Catalog } from "../core/catalog";
import type { EvidenceLike } from "../core/evidence";
import { PROTOTYPE_CATALOG } from "../prototypeCatalog";
import type { VerifiedFact } from "./grounding";
import * as s from "./semantic";

export * from "./semantic";
export const METRIC_DEPARTMENT = s.departmentByMetric(PROTOTYPE_CATALOG);
export const directionalClaims = (text: string, lane: s.Lane, catalog: Catalog = PROTOTYPE_CATALOG) => s.directionalClaims(text, lane, catalog);
export const magnitudeExpressions = (text: string, lane: s.Lane = "interpretation", catalog: Catalog = PROTOTYPE_CATALOG) => s.magnitudeExpressions(text, lane, catalog);
export const semanticScope = (authorized: readonly EvidenceLike[], facts: readonly VerifiedFact[], catalog: Catalog = PROTOTYPE_CATALOG) => s.semanticScope(authorized, facts, catalog);
