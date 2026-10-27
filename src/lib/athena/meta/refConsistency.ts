// Evidence-reference CONSISTENCY for the STRICT profile (Phase H2.4b). Pure, deterministic and client-safe; neutral (no dataset, no provider). OPT-IN: only `validateOutput` with
// `profile.refConsistency === true` runs it, and only `meta/strictValidation.ts` sets that. The legacy validator never does.
//
// What it establishes is MENTION-LEVEL consistency between a sentence and the facts it cites. It is NOT semantic proof: a cited fact that passes this check has not been shown to
// support the claim, and nothing here checks that the claim is true.
//   * EXACT MATCH, when the sentence names at least one available metric: the cited fact metrics must be exactly the named available metrics. COVERAGE: every named metric that has a
//     verified fact must be cited (a sentence about two available metrics that cites one is rejected). NO EXTRAS: a cited fact whose metric is not named is rejected, so unrelated
//     records cannot ride along as supporting ids.
//   * A sentence that names no available metric is generic (an unverified hypothesis, a recommendation, department vocabulary such as "review the sales strategy") and may cite any
//     authorized fact. Department words are deliberately NOT used to constrain citations: that would reject the generic business language H2.3 accepts, and a department match would
//     only look like verification.
// Citations are never rewritten, added or removed (a violation rejects the output), and `supporting_ids` stay derived from the cited facts alone. Ordinary words that equal a catalog alias ("lead the review") count as
// mentions and fail closed.
import type { Catalog } from "../core/catalog";
import type { VerifiedFact } from "./grounding";
import { semanticText } from "./semantic";
import { strictEntities } from "./strictVocabulary";

/** True when the cited fact ids are consistent with what `text` names. Unknown ids are not this check's concern (the reference check rejects them). */
export function refsConsistent(
  text: string,
  refs: readonly string[],
  facts: readonly VerifiedFact[],
  catalog: Catalog,
): boolean {
  const entities = strictEntities(semanticText(text), catalog);
  const byId = new Map(facts.map((f) => [f.fact_id, f]));
  const cited = refs.map((r) => byId.get(r)).filter((f): f is VerifiedFact => !!f);
  const haveFact = new Set(facts.map((f) => f.metric));
  const named = new Set(
    entities.filter((e) => e.kind === "metric" && haveFact.has(e.key)).map((e) => e.key),
  );
  if (!named.size) return true;
  // Exact match: every named metric is cited (coverage) and every cited fact is a named metric (no unrelated extras).
  return (
    [...named].every((m) => cited.some((f) => f.metric === m)) &&
    cited.every((f) => named.has(f.metric))
  );
}
