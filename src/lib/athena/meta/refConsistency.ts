// Evidence-reference CONSISTENCY for the STRICT profile (Phase H2.4b). Pure, deterministic and client-safe; neutral (no dataset, no provider). OPT-IN: only `validateOutput` with
// `profile.refConsistency === true` runs it, and only `meta/strictValidation.ts` sets that. The legacy validator never does.
//
// What it establishes is MENTION-LEVEL consistency between a sentence and the facts it cites. It is NOT semantic proof: a cited fact that passes this check has not been shown to
// support the claim, and nothing here checks that the claim is true.
//   * EXACT MATCH, when the sentence names at least one available metric: the cited fact metrics must be exactly the named available metrics. COVERAGE: every named metric that has a
//     verified fact must be cited (a sentence about two available metrics that cites one is rejected). NO EXTRAS: a cited fact whose metric is not named is rejected, so unrelated
//     records cannot ride along as supporting ids.
//   * A sentence that names no available metric is generic (an unverified hypothesis, a recommendation, department vocabulary such as "review the sales strategy"). It no longer may cite ANY
//     authorized fact (C11/C12): the facts it cites must be related to what it says, by two deterministic rules, and a generic sentence that triggers neither still passes.
//       - DEPARTMENT: when it names a department (or a metric that has no verified fact, whose owning department then counts) AND the caller has at least one verified fact in a named department, at least one cited fact must belong to a named department
//         ("review the sales strategy" may cite a Sales fact, not only a Finance fact). Extra citations beside a related one are tolerated here, unlike the metric rule above: a sentence that
//         names no metric is too vague to say which extra fact is unrelated. When no fact exists in any named department, a related citation is impossible, the schema still requires
//         a ref, and the citation is accepted: it then shows only that the minimum citation was supplied, not that the fact supports the sentence.
//       - DIRECTION: when it refers to an unspecified rise or fall ("the decline", "the recent increase"), at least one cited fact for each such direction must actually have that verified
//         direction ("the decline may reflect seasonal demand" may not cite a fact that rose).
//     This still does not show that a cited fact supports the claim, only that it is not plainly unrelated. Wholly generic text ("gather more data") has nothing to compare and may cite any
//     authorized fact; that remains a documented limit.
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
  const norm = semanticText(text);
  const entities = strictEntities(norm, catalog);
  const byId = new Map(facts.map((f) => [f.fact_id, f]));
  const cited = refs.map((r) => byId.get(r)).filter((f): f is VerifiedFact => !!f);
  const haveFact = new Set(facts.map((f) => f.metric));
  const named = new Set(
    entities.filter((e) => e.kind === "metric" && haveFact.has(e.key)).map((e) => e.key),
  );
  if (!named.size) return genericCitationsRelated(norm, entities, cited, facts, catalog);
  // Exact match: every named metric is cited (coverage) and every cited fact is a named metric (no unrelated extras).
  return (
    [...named].every((m) => cited.some((f) => f.metric === m)) &&
    cited.every((f) => named.has(f.metric))
  );
}

/** Nouns that refer to an unspecified rise or fall ("the decline"). Only the noun readings after a determiner or a short modifier count, so verbs and ordinary words are not read as claims. */
const GENERIC_MOVE =
  /\b(?:the|this|that|these|recent|overall|current|ongoing|observed|apparent|latest|sharp|steep)\s+(?:\w+\s+)?(decline|drop|decrease|fall|dip|slump|downturn|downtick|contraction|increase|rise|growth|surge|jump|uptick|spike|upswing|expansion|gain)\b/g;
const DOWN = new Set([
  "decline",
  "drop",
  "decrease",
  "fall",
  "dip",
  "slump",
  "downturn",
  "downtick",
  "contraction",
]);
const NEGATED_OR_OPEN = /\b(?:no|not|never|without|nor|neither|if|whether|unless)\b|\?/;

function genericCitationsRelated(
  norm: string,
  entities: readonly { kind: string; key: string }[],
  cited: readonly VerifiedFact[],
  facts: readonly VerifiedFact[],
  catalog: Catalog,
): boolean {
  if (!cited.length) return true; // unknown ids are the reference check's concern
  const depts = new Set<string>();
  for (const e of entities) {
    if (e.kind === "dept") depts.add(e.key);
    else {
      const owner = catalog.metrics.find((m) => m.key === e.key)?.domain; // a named metric with no verified fact: its owning department is a related department too
      if (owner) depts.add(owner);
    }
  }
  if (
    depts.size &&
    facts.some((f) => depts.has(f.department)) &&
    !cited.some((f) => depts.has(f.department))
  )
    return false;
  if (NEGATED_OR_OPEN.test(norm)) return true; // a denied, conditional or interrogative reference asserts no movement
  const wanted = new Set<"up" | "down">();
  GENERIC_MOVE.lastIndex = 0;
  for (let m = GENERIC_MOVE.exec(norm); m; m = GENERIC_MOVE.exec(norm))
    wanted.add(DOWN.has(m[1]!) ? "down" : "up");
  return [...wanted].every((d) => cited.some((f) => f.direction === d));
}
