// Prototype-facing facade over ./render: `renderFindings` defaults its analysis context to the bundled prototype's. The live pipeline passes its own.
import type { AnalysisContext, CoreRecord } from "../core/facts";
import { PROTOTYPE_CONTEXT } from "../engine";
import * as r from "./render";

export * from "./render";
export const renderFindings = <R extends CoreRecord>(authorized: readonly R[], ctx: AnalysisContext = PROTOTYPE_CONTEXT) => r.renderFindings(authorized, ctx);
