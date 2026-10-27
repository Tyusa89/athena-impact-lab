// STRICT causal-language policy (Phase G2). Pure, deterministic and client-safe; neutral (no dataset, no provider). OPT-IN: `validateOutput` calls it only when
// `profile.strictCausal === true`, and only `meta/strictValidation.ts` sets that. The legacy detector `hasCausalClaim` (analysis.ts) is untouched and still serves every other path.
//
// POLICY. Athena's facts establish observed changes (prior, current, change, direction), never causes. A model interpretation is `verified: false` by schema, a correct fact citation
// (H2.4b) shows only that the named metrics were cited, and nothing in the engine can establish causality. So an AFFIRMATIVE causal statement is rejected in every lane, while the
// model stays free to deny causality, ask about it, investigate it, or offer a clearly qualified, unverified hypothesis.
//   Tier 1, proof and definitive-cause language (proves, proof, definitive, confirms that, cause(s)/caused, the cause, root cause, is why): a hedge does NOT excuse it ("the likely cause is X"
//     is still a conclusion). Excused only by denial ("the root cause is unknown", "did not cause"), a question, or an investigative imperative that asserts nothing.
//   Tier 2, causal relationships (because (of), due to, driven by, led to, resulted in, the reason, responsible for, explains why, attributable to, contributed to, stems from, as a result of,
//     influenced): additionally excused by a hedge or conditional ("may have contributed to", "whether") IN THE SAME CLAUSE.
//   Scoping: a hedge, denial or question counts only inside the clause containing the causal term; one in another clause or sentence does not excuse an assertion.
//   Investigative imperatives (a sentence that begins with investigate, identify, determine, review ... ) are accepted in recommendations and gaps only, and never when the rest of the sentence
//     states a conclusion ("Investigate the cause, which is weak lead quality.") or the causal term introduces a clause ("Investigate churn, revenue fell because of it.").
// This is wording and clause matching, NOT semantic understanding. Verb-based or implicit causality ("hurt", "triggered", "following", ", reflecting") is not detected, and ordinary
// phrases that contain a listed word ("proof of delivery", "is the reason we are reviewing") are rejected. Both are documented limits. Correlation wording ("correlated with",
// "associated with", "moved in the same direction") is not causal and is not touched.
import { INVISIBLE_CHARS } from "./grounding";
import type { Lane } from "./semantic";

const TIER1 =
  /\b(root cause|the cause|confirms that|is why|are why|proves?|proven|proof|definitive(?:ly)?|caused?|causes|causing)\b/g;
const TIER2 =
  /\b(because of|because|due to|owing to|driven by|drives?|driving|led to|leads? to|resulted? in|results? in|resulting in|the reason|reasons? for|responsible for|explains? why|explained by|attributable to|attributed to|contributed to|contributes? to|contributing to|stems? from|as a result of|influenced|influences)\b/g;
/** Phrases that open a clause ("revenue fell because of ..."): a denial must sit directly in front of them, and an imperative does not excuse them without a "whether"/"why". */
const CLAUSE_CONNECTOR = /^(because of|because|due to|owing to|as a result of|stems? from)$/;
/** Noun forms that an investigative imperative may take as its object ("identify the root cause of ...", "review the factors responsible for ..."). */
const NOUN_FORM = /^(root cause|the cause|causes|cause|the reason|reasons? for|responsible for)$/;
const NOUN_TERM = /^(root cause|the cause|causes|cause|the reason|reasons? for)$/;

const NEGATOR =
  "(?:not|no|never|cannot|nothing|neither|nor|without|unable|yet to|unclear|unknown|uncertain|undetermined|unestablished|dont|doesnt|didnt|isnt|arent|wasnt|werent|hasnt|havent|hadnt|cant|wont|couldnt|wouldnt|shouldnt)";
const NEG_NEAR = new RegExp(`\\b${NEGATOR}\\b(?:\\s+\\w+){0,4}\\s*$`);
const NEG_DIRECT = /\b(?:not|never|no)\s*$/;
const NOUN_DENIAL =
  /^.{0,30}?\b(?:is|are|was|remains?)\s+(?:still\s+)?(?:not\s+\w+|unknown|unclear|undetermined|uncertain|unestablished)\b/;
const HEDGE =
  /\b(?:may|might|could|possibly|potentially|perhaps|plausibly|plausible|probably|likely|possible|potential|appears? to|seems? to|suggests?|hypothes[ie]s|unverified|whether|if)\b/;
const WH = /\b(?:whether|if|why|what|how|which)\b/;
const INVESTIGATIVE =
  /^(?:(?:please|we should|you should|consider|next)\s+)?(?:investigate|identify|determine|review|assess|examine|explore|check|diagnose|analy[sz]e|audit|verify|test|evaluate|find out|look into|clarify)\b/;
const ASSERTS_AFTER = /\b(?:is|are|was|were|because|due to|caused|led to|resulted in)\b/;
/** Separators after which a clause can still be a question of its own ("..., or did lower conversion contribute?"); "which", "so", "while" ... open a declarative continuation. */
const QUESTION_LEAD = new Set(["", ",", "and", "but"]);
/** A copula in front of the term inside its own clause makes it a predicate ("..., which is the cause of the drop"). */
const COPULA = /\b(?:is|are|was|were|be|been|being)\b/;
const QUESTION_START =
  /^(?:did|does|do|is|are|was|were|could|can|has|have|what|why|how|which|whether)\b/;

const normalize = (t: string) =>
  t
    .normalize("NFKC")
    .replace(INVISIBLE_CHARS, "")
    .toLowerCase()
    .replace(/[‘’ʼ`´']/g, "")
    .replace(/\s+/g, " ");
const SOFT = /[,]|\s(?:and|but|while|whereas|although|though|yet|which|so|however|then)\s/g;

interface Hit {
  index: number;
  text: string;
  tier: 1 | 2;
}
function hits(clause: string): Hit[] {
  const out: Hit[] = [];
  for (const [re, tier] of [
    [TIER1, 1],
    [TIER2, 2],
  ] as const) {
    re.lastIndex = 0;
    for (let m = re.exec(clause); m; m = re.exec(clause))
      out.push({ index: m.index, text: m[0], tier });
  }
  return out.sort((a, b) => a.index - b.index);
}
/** `lead` is the separator that opens the clause ("" for the first, "," / "and" / "but" / "which" / "so" ...). */
function clauses(segment: string): { text: string; start: number; lead: string }[] {
  const out: { text: string; start: number; lead: string }[] = [];
  let last = 0,
    lead = "";
  SOFT.lastIndex = 0;
  for (let m = SOFT.exec(segment); m; m = SOFT.exec(segment)) {
    out.push({ text: segment.slice(last, m.index), start: last, lead });
    last = m.index + m[0].length;
    lead = m[0].trim();
  }
  out.push({ text: segment.slice(last), start: last, lead });
  return out;
}

/** True when `text` asserts causality that the strict policy rejects. `lane` decides whether an investigative imperative is available (recommendation and gap only). */
export function strictCausalClaim(text: string, lane: Lane): boolean {
  const norm = normalize(text);
  // Sentence boundaries keep their terminator so a genuine question can be recognised.
  for (const [, body, end] of norm.matchAll(/([^.!?]+)([.!?]*)/g)) {
    const sentence = body!.trim();
    if (!sentence) continue;
    const questionMark = (end ?? "").includes("?");
    for (const segment of sentence.split(/[;:]/)) {
      const seg = segment.trim();
      const imperative = lane !== "interpretation" && INVESTIGATIVE.test(seg);
      let first = true;
      for (const c of clauses(seg)) {
        // A question excuses only the INTERROGATIVE clause it is asked in; a declarative clause attached to it ("..., given that marketing caused the decline", "..., which was caused by X") is judged on its own.
        const clause = c.text.trim().replace(/^(?:or|and|but)\s+/, "");
        const interrogative =
          questionMark && QUESTION_START.test(clause) && (first || QUESTION_LEAD.has(c.lead));
        if (clause) first = false;
        for (const h of hits(c.text)) {
          if (interrogative) continue;
          const before = c.text.slice(0, h.index),
            after = c.text.slice(h.index + h.text.length);
          if (CLAUSE_CONNECTOR.test(h.text) ? NEG_DIRECT.test(before) : NEG_NEAR.test(before))
            continue; // denied
          if (NOUN_TERM.test(h.text) && NOUN_DENIAL.test(after)) continue; // "the root cause is unknown"
          if (
            imperative &&
            !ASSERTS_AFTER.test(seg.slice(c.start + h.index + h.text.length)) &&
            !COPULA.test(before) &&
            (WH.test(before) || NOUN_FORM.test(h.text))
          )
            continue; // investigative
          if (h.tier === 2 && HEDGE.test(before)) continue; // qualified hypothesis, same clause only
          return true;
        }
      }
    }
  }
  return false;
}
