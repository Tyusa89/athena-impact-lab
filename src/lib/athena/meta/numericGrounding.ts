// Prototype-facing facade over ./grounding. The generic engine (./grounding) requires an explicit analysis context or reporting periods; this module
// keeps the original signatures by defaulting them to the bundled prototype's. The live pipeline never calls these defaulted forms.
import type { AuthorizedEvidence } from "../core/access";
import type { Evidence } from "../core/evidence";
import type { AnalysisContext, CoreRecord, PeriodPair } from "../core/facts";
import { PROTOTYPE_CONTEXT } from "../engine";
import * as g from "./grounding";

export * from "./grounding";
export const buildVerifiedFacts = <R extends CoreRecord>(authorized: readonly R[], ctx: AnalysisContext = PROTOTYPE_CONTEXT) => g.buildVerifiedFacts(authorized, ctx);
export const buildAuthorizedFacts = <E extends Evidence>(authorized: AuthorizedEvidence<E>, ctx: AnalysisContext = PROTOTYPE_CONTEXT) => g.buildAuthorizedFacts(authorized, ctx);
export const numericTokens = (text: string, recordIds: readonly string[], periods: PeriodPair = PROTOTYPE_CONTEXT.periods) => g.numericTokens(text, recordIds, periods);
export const nonAsciiNumerics = (text: string, recordIds: readonly string[], periods: PeriodPair = PROTOTYPE_CONTEXT.periods) => g.nonAsciiNumerics(text, recordIds, periods);
export const verifyNoNumerals = (text: string, recordIds: readonly string[], periods: PeriodPair = PROTOTYPE_CONTEXT.periods) => g.verifyNoNumerals(text, recordIds, periods);
