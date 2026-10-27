// Phase 2B-2 semantic guards for model-authored text (interpretations, proposed actions, gaps). Pure + client-safe.
// Three narrow, independent checks. Each REJECTS the whole output with a reason; nothing is silently rewritten.
//   1. direction: a directional claim about a metric must not contradict that metric's verified finding.
//   2. magnitude: no unsupported magnitude expressions about business performance (process instructions are allowed).
//   3. domain:    no directional claim about a metric or department the role cannot see.
// These are bounded heuristics, not language understanding. Known residual gaps are listed in RESIDUAL_LIMITATIONS.
//
// Design rules to avoid rejecting legitimate business explanations:
//   - Only directional statements are compared (no bare keyword bans), and only for metrics the role is authorized for.
//   - The SUBJECT of a direction word is resolved conservatively: "Revenue from new leads rose" is about revenue (the head
//     noun), not leads; "Concern about revenue grew" and "Revenue concerns grew" are about concern, not revenue. If the
//     binding is ambiguous (e.g. "revenue versus conversion rose") no claim is inferred.
//   - Comparatives, imperatives, goal nouns, transitive subjects, habitual/generic statements, idioms ("fell short"),
//     questions, conditionals and monitoring directives are not treated as claims about the verified period.
//   - Magnitude words are checked only where they describe a metric's performance; "twice a week", "split in half",
//     "a dozen customers" and "a third option" are ordinary process language.
//   - Messages never echo model text, record ids, source labels or the names of unauthorized metrics/departments.
import { assertCatalog, goodDirection, metricLabel, type Catalog, type DomainIdOf, type MetricKeyOf } from "../core/catalog";
import type { EvidenceLike } from "../core/evidence";
import { INVISIBLE_CHARS, type VerifiedFact } from "./grounding";

export type Lane = "interpretation" | "recommendation" | "gap";
type Dir = "up" | "down" | "flat";

export const RESIDUAL_LIMITATIONS = [
  "Cross-script look-alike characters (e.g. Cyrillic letters inside a metric word) are not folded and can evade the term matching.",
  "Paraphrases the term tables do not list (e.g. 'top-of-funnel volume', 'the pipeline got bigger') are not recognised.",
  "Transitive and base-form verbs, comparatives, goal nouns, habitual/generic statements and conditional clauses are deliberately not treated as claims.",
  "Qualitative strength words (sharply, dramatically) and CJK/Roman numerals are not magnitude-checked.",
  "A direction word is bound to its subject by proximity and simple phrase rules; unusual sentence structure can bind to the wrong metric or to none, and genuinely ambiguous binding yields no claim (so it is not rejected).",
  "Elided subjects across clauses ('revenue slipped, then recovered') are not tracked, because binding across clauses would also reject legitimate path narratives.",
  "Comparatives and unlisted verbs/adverbials ('edged higher', 'cratered', 'eased', 'is trending up', 'rallied') are not recognised as directional claims.",
  "Statements about an unauthorized domain that use no recognised direction or valence word ('lead volume looks healthy', 'the sales pipeline is full') are not rejected.",
  "The habitual/generic and seasonal exemptions can let through a contradictory statement phrased as a generalisation.",
] as const;

/** Lower-case, fold compatibility forms, drop invisible characters and combining marks, unify dashes/underscores, normalise contractions. */
export function semanticText(t: string): string {
  return t
    .normalize("NFKD").replace(INVISIBLE_CHARS, "").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/[‘’ʼ`´]/g, "'")
    .replace(/\bcan't\b/g, "cannot").replace(/n't\b/g, " not").replace(/'/g, "")
    .replace(/[‐-―−\-_/\\]+/g, " ")
    .replace(/[^\p{L}\p{N}%\s.,;:!?]/gu, " ")
    .replace(/\s+/g, " ").trim();
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ------------------------------------------------------------------ entities (metrics and departments)
/** The department that owns each metric. Used to tell "not authorized" from "authorized but no data in this scenario". */
export const departmentByMetric = <C extends Catalog>(c: C) => (assertCatalog(c), Object.fromEntries(c.metrics.map((m) => [m.key, m.domain])) as Record<MetricKeyOf<C>, DomainIdOf<C>>);

type Entity = { kind: "metric" | "dept"; key: string; start: number; end: number };
/** Term table built from a catalog's aliases: longest phrase first (stable, so ties keep catalog order), whole-word matching. */
const termTables = new WeakMap<Catalog, { kind: "metric" | "dept"; key: string; re: RegExp }[]>();
function termTable(c: Catalog) {
  assertCatalog(c);
  let t = termTables.get(c);
  if (!t) {
    const list = [
      ...c.metrics.flatMap((m) => m.aliases.map((term) => ({ term, kind: "metric" as const, key: m.key }))),
      ...c.domains.flatMap((d) => d.aliases.map((term) => ({ term, kind: "dept" as const, key: d.id }))),
    ].sort((a, b) => b.term.length - a.term.length);
    t = list.map((x) => ({ kind: x.kind, key: x.key, re: new RegExp(`\\b${esc(x.term)}\\b`, "g") }));
    termTables.set(c, t);
  }
  return t;
}

function findEntities(text: string, catalog: Catalog): Entity[] {
  const taken: [number, number][] = [];
  const out: Entity[] = [];
  for (const t of termTable(catalog)) {
    t.re.lastIndex = 0;
    for (let m = t.re.exec(text); m; m = t.re.exec(text)) {
      const start = m.index, end = start + m[0].length;
      if (taken.some(([a, b]) => start < b && end > a)) continue;
      taken.push([start, end]);
      out.push({ kind: t.kind, key: t.key, start, end });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Every catalog metric or department mentioned in text, as `{kind, key}` (whole-word alias matches). Used by the scope check. */
export function mentionedEntities(text: string, catalog: Catalog): { kind: "metric" | "dept"; key: string }[] {
  assertCatalog(catalog);
  return findEntities(semanticText(text), catalog).map((e) => ({ kind: e.kind, key: e.key }));
}

/** Catalog metrics and domains mentioned in free text (whole-word alias matches, longest phrase first). Used to focus a deterministic analysis on what a question
 * is about. It selects among things the caller is already authorized for; it never reaches evidence itself. */
export function mentionedIn(text: string, catalog: Catalog): { metrics: string[]; domains: string[] } {
  assertCatalog(catalog);
  const metrics: string[] = [], domains: string[] = [];
  for (const e of findEntities(semanticText(text), catalog)) {
    const list = e.kind === "metric" ? metrics : domains;
    if (!list.includes(e.key)) list.push(e.key);
  }
  return { metrics, domains };
}

// ------------------------------------------------------------------ directional words
type Cls = "iv" | "tv" | "ipart" | "tpart" | "noun" | "hom" | "basev" | "adj" | "flat";
interface W { cls: Cls; dir?: Dir; val?: "good" | "bad" }
const WORDS = new Map<string, W>();
const add = (cls: Cls, spec: { dir?: Dir; val?: "good" | "bad" }, ...ws: string[]) => ws.forEach((w) => WORDS.set(w, { cls, ...spec }));
// intransitive verbs: subject (left) changed
add("iv", { dir: "up" }, "rose", "risen", "rises", "grew", "grown", "grows", "climbed", "climbs", "surged", "surges", "soared", "soars", "jumped", "jumps", "spiked", "spikes", "rebounded");
add("iv", { dir: "down" }, "fell", "fallen", "falls", "declined", "declines", "dropped", "slid", "slipped", "slips", "shrank", "shrunk", "shrinks", "plunged", "plunges", "dipped", "dips", "tumbled", "collapsed");
add("iv", { val: "good" }, "recovered", "recovers");
add("iv", { val: "bad" }, "deteriorated", "deteriorates");
// transitive-capable past verbs: object (right, adjacent) changed, else subject (left) if no object follows
add("tv", { dir: "up" }, "increased", "expanded", "raised", "boosted", "lifted");
add("tv", { dir: "down" }, "decreased", "reduced", "lowered");
add("tv", { val: "good" }, "improved", "improves", "strengthened", "strengthens");
add("tv", { val: "bad" }, "worsened", "worsens", "weakened", "weakens", "softened", "softens", "eroded");
// participles: intransitive ones modify an adjacent metric; transitive-capable gerunds only count after a link verb
add("ipart", { dir: "up" }, "rising", "climbing", "surging", "soaring", "growing", "jumping");
add("ipart", { dir: "down" }, "falling", "declining", "dropping", "shrinking", "slipping", "sliding", "dipping", "plunging");
add("ipart", { val: "bad" }, "worsening", "deteriorating", "weakening", "softening", "eroding");
add("tpart", { dir: "up" }, "increasing", "expanding", "raising", "boosting", "lifting");
add("tpart", { dir: "down" }, "decreasing", "reducing", "lowering");
add("tpart", { val: "good" }, "improving", "strengthening", "recovering");
// nouns (never recommendations: "a reduction in backorders" is usually a goal)
add("noun", { dir: "up" }, "growth", "upswing", "uptick", "expansion");
add("noun", { dir: "down" }, "slump", "downturn", "downtick", "contraction", "shrinkage", "reduction");
add("noun", { val: "good" }, "improvement", "recovery", "rebound");
add("noun", { val: "bad" }, "deterioration", "weakness", "softness", "erosion");
// base/noun homographs: only the noun reading ("a rise in X", "X decline") is checked; the base-verb reading is ignored
add("hom", { dir: "up" }, "rise", "increase", "surge", "spike", "jump", "gain", "climb");
add("hom", { dir: "down" }, "fall", "decrease", "decline", "drop", "dip", "slide");
// base verbs: only meaningful when negated by an auxiliary ("did not fall", "does not improve"); otherwise ignored (may be hypothetical or transitive)
add("basev", { dir: "up" }, "grow", "expand");
add("basev", { dir: "down" }, "shrink", "contract");
add("basev", { val: "good" }, "improve", "recover", "strengthen");
add("basev", { val: "bad" }, "worsen", "deteriorate", "weaken", "soften");
// predicative comparatives and flat words
add("adj", { val: "bad" }, "weaker", "softer", "worse");
add("adj", { val: "good" }, "stronger", "better", "healthier");
add("flat", { dir: "flat" }, "flat", "unchanged", "stable", "steady", "stagnant", "constant", "static", "plateaued", "stagnated");

const WORD_KEYS = [...WORDS.keys()].sort((a, b) => b.length - a.length);
const WORD_RE = new RegExp(`\\b(?:${WORD_KEYS.join("|")}|up|down)\\b`, "g");
const LINK_BEFORE = /\b(?:is|are|was|were|be|been|being|remains?|remained|stayed|stays|seems?|seemed|looks?|looked|looking|appears?|appeared|appearing|became|become|becomes|becoming|gets|got|getting|keeps|kept|continues?|continued|went|goes|going|moved|moving)\s+(?:\w+ly\s+)?$/;
const AUX_NEG = /\b(?:did|does|do) not\s+(?:\w+ly\s+)?$/;
const NEGATOR = /\b(?:not|no|never|neither|nor|cannot|without|failed to|fail to|unable to|stopped)\b/;
const CONDITIONAL_LEAD = /^(?:if|when|whenever|unless|whether|once|until|without|absent|assuming|provided)\b/;
const CONDITIONAL = new Set(["if", "when", "whenever", "unless", "whether", "once", "until", "without", "absent", "assuming", "provided"]);
const SPLIT = /(,|:|\s(?:while|whereas|but|although|though|yet|even as|as|because|which|so|then|after|before|since|when|whenever|unless|if|whether|once|until|without|absent|assuming|provided|despite|rather than|instead of)\s)/;
const OBJECT_FREE_FOLLOW = /^(?:$|(?:by|in|from|to|between|over|during|since|through|across|versus|vs|relative|compared|again|further|too|also|then|last|this|next|and|or|but|while|as|due|likely|\w+ly)\b)/;
const ATTRIBUTIVE_GAP = new Set(["the", "a", "an", "this", "these", "those", "our", "its", "their", "overall", "total", "new", "further", "continued", "recent", "sharp", "steady"]);
const PASSIVE_BEFORE = /\b(?:was|were|been|being|is|are|get|gets|got)\s+$/;
const gap = (text: string, a: number, b: number) => { const s = text.slice(a, b).trim(); return s ? s.split(/\s+/).length : 0; };

// --- subject resolution (B1, S6)
/** Separators that make the EARLIER entity the head noun: "revenue FROM new leads", "conversion OF qualified leads", "revenue driven by leads". */
const DET = "(?:(?:the|our|its|their|all|new|total|overall|existing|recent|these|those|each|every|any|some|such|top|key|main|major|big|large)\\s+)*";
/** Up to two ordinary modifier words may follow the determiners ("revenue from ENTERPRISE deals"); verbs and conjunctions never qualify. */
const MODIFIERS = "(?:(?!(?:is|are|was|were|has|have|had|be|been|and|or|but|that|which|who|while|as|than|because|so|if|when|then)\\b)[a-z]+\\s+){0,2}";
const HEAD_SEP = new RegExp(`^\\s*(?:(?:of|from|per|in|for|on|by|among|across|within|at|with|via|through)|(?:driven|caused|led|fueled|generated|produced|sourced|attributed|derived|coming|stemming|resulting|arising)\\s+(?:by|from|to|in))\\s+${DET}${MODIFIERS}$`);
const BLANK = /^\s*$/;
const CHAIN_SEP = /^\s*(?:and|&|or|plus|as well as|,)\s*(?:both\s+)?$/;
/** A parenthetical/appositive between commas ("revenue, driven by new leads, rose") is removed before binding. */
const APPOSITIVE = /,\s*(?:driven|caused|led|fueled|boosted|lifted|helped|hurt|pushed|pulled|dragged|supported|prompted|triggered|aided|buoyed|reflecting|including|especially|mainly|largely|partly|mostly|notably|particularly|thanks to|owing to|due to|according to|which|who)\b[^,]*,/g;
/** An entity right after one of these is the complement of some other noun ("pressure ON revenue", "interest IN lead quality"), not the subject. */
const OBLIQUE_BEFORE = new RegExp(`\\b(?:about|on|of|over|for|around|regarding|concerning|toward|towards|surrounding|behind|into|among|across|within|at|by|from|with|than|versus|vs|against|beyond|despite|amid|amidst|in)\\s+${DET}(?:a\\s+|an\\s+)?$`);
/** Words that may sit between the subject entity and its verb. Anything else is a different head noun ("revenue CONCERNS grew"). */
const ALLOWED_GAP = new Set([
  "is", "are", "was", "were", "be", "been", "being", "am", "has", "have", "had", "having", "will", "would", "could", "can", "may", "might", "must", "shall", "should", "did", "does", "do",
  "not", "never", "no", "also", "again", "then", "still", "just", "only", "even", "already", "recently", "now", "both", "all", "each", "together", "alike", "further", "too", "to",
  "seems", "seem", "seemed", "appears", "appear", "appeared", "looks", "look", "looked", "looking", "remains", "remain", "remained", "stayed", "stays", "kept", "keeps", "keep",
  "continued", "continues", "continue", "begun", "began", "start", "started", "starts", "finally", "eventually", "since", "quickly", "slowly", "held", "hold", "holds",
  "went", "goes", "go", "going", "moved", "moving", "became", "become", "becomes", "becoming", "gets", "got", "getting",
  // generic measure nouns that merely restate the metric ("marketing PERFORMANCE weakened")
  "performance", "results", "figure", "figures", "number", "numbers", "line", "level", "levels", "rate", "rates", "trend", "trends", "activity", "output", "volume", "volumes", "total", "totals", "spend", "spending", "metrics",
]);
const gapIsClean = (s: string) => s.trim().split(/\s+/).filter(Boolean).every((w) => ALLOWED_GAP.has(w) || /ly$/.test(w));
/** A prepositional modifier of the head noun ("revenue FROM the long tail OF accounts grew") does not change the subject. Kept short on purpose. */
const HEAD_PP = /^(?:of|from|per|in|for|on|by|among|across|within|at|with|via|through|driven by|caused by|led by|fueled by|generated by|sourced from|attributed to|derived from)\b/;
const subjectGapOk = (s: string) => gapIsClean(s) || (HEAD_PP.test(s.trim()) && s.trim().split(/\s+/).length <= 8);
/** Boundary words: if the text between two entities contains one, the second starts a new predicate, so the pair is not an ambiguous noun phrase. */
const SEP_BOUNDARY = new RegExp(`\\b(?:${WORD_KEYS.join("|")}|up|down|is|are|was|were|has|have|had|be|been|did|does|do|will|would|can|could|may|might|and|or|but)\\b`);

// --- context that makes a direction word NOT a claim about the verified period (S5, S6, S7)
const HABITUAL = /\b(?:typically|usually|often|generally|normally|historically|seasonally|commonly|frequently|sometimes|always|traditionally|customarily|tends? to|tended to|as a rule|in general|on average|annually|every (?:year|quarter|month|season)|each (?:year|quarter|season)|ahead of the holidays?|before the holidays?|during the holidays?)\b/;
const OFF_PERIOD = /\b(?:in|during|over|around|before|after|every|each)\s+(?:the\s+)?(?:holidays?|holiday season|summer|winter|spring|autumn|peak season|january|february|april|june|july|august|september|october|november|december|q1|q4|first quarter|fourth quarter|new year|black friday|year end)\b/;
const IDIOM_TAIL = /^(?:short|behind|through|apart|victim|prey|foul|into|under|flat|to the occasion|out of (?:favou?r|line|step))\b/;
const MONITOR_LEAD = /^(?:please\s+)?(?:watch|monitor|track|check|verify|confirm|test|see|flag|alert|look for|keep an eye on|stay alert|be alert|prepare for|plan for|anticipate|expect|guard against|brace for|find out)\b/;

interface Claim { entities: Entity[]; dir: Dir; negated: boolean; word: string; forward: boolean }
interface ClauseInfo { text: string; conditional: boolean; monitor: boolean }

function clausesOf(text: string): ClauseInfo[] {
  const out: ClauseInfo[] = [];
  const pieces = text.split(/([.!?;\n]+)/);
  for (let i = 0; i < pieces.length; i += 2) {
    const sentence = (pieces[i] ?? "").trim();
    if (!sentence) continue;
    const question = (pieces[i + 1] ?? "").includes("?"); // a question asserts nothing
    const monitor = MONITOR_LEAD.test(sentence);
    const parts = sentence.split(SPLIT);
    let cond = question || CONDITIONAL_LEAD.test(parts[0] ?? "");
    out.push({ text: parts[0] ?? "", conditional: cond, monitor });
    for (let j = 1; j < parts.length; j += 2) {
      cond = question || CONDITIONAL.has((parts[j] ?? "").trim());
      out.push({ text: parts[j + 1] ?? "", conditional: cond, monitor });
    }
  }
  return out.filter((c) => c.text.trim());
}

function chainLeft(es: Entity[], idx: number, clause: string): Entity[] {
  const chain = [es[idx]!];
  for (let i = idx - 1; i >= 0; i--) {
    const sep = clause.slice(es[i]!.end, chain[0]!.start);
    if (CHAIN_SEP.test(sep)) chain.unshift(es[i]!); else break;
  }
  return chain;
}
const leftOf = (es: Entity[], pos: number, maxGap: number, clause: string): number => {
  for (let i = es.length - 1; i >= 0; i--) if (es[i]!.end <= pos) return gap(clause, es[i]!.end, pos) <= maxGap ? i : -1;
  return -1;
};
const rightOf = (es: Entity[], pos: number, maxGap: number, clause: string): number => {
  for (let i = 0; i < es.length; i++) if (es[i]!.start >= pos) return gap(clause, pos, es[i]!.start) <= maxGap ? i : -1;
  return -1;
};
/** Head of the noun phrase that ends at entity `idx`: "revenue from new leads" -> revenue; compound modifiers ("sales revenue") keep the last word. */
function resolveHead(es: Entity[], idx: number, clause: string): number {
  let c = idx;
  while (c > 0) {
    const sep = clause.slice(es[c - 1]!.end, es[c]!.start);
    if (BLANK.test(sep) || CHAIN_SEP.test(sep)) { c--; continue; }
    if (HEAD_SEP.test(sep)) return resolveHead(es, c - 1, clause);
    break;
  }
  return idx;
}
/** Two entities joined by something we cannot interpret ("revenue VERSUS conversion rose"): do not guess which is the subject. */
function isAmbiguous(es: Entity[], h: number, clause: string): boolean {
  if (h === 0) return false;
  const sep = clause.slice(es[h - 1]!.end, es[h]!.start);
  if (BLANK.test(sep) || CHAIN_SEP.test(sep) || HEAD_SEP.test(sep) || gap(clause, es[h - 1]!.end, es[h]!.start) > 3) return false;
  return !SEP_BOUNDARY.test(sep);
}

/** Directional claims in a text, each bound to the metric/department entities it describes. */
export function directionalClaims(text: string, lane: Lane, catalog: Catalog): Claim[] {
  assertCatalog(catalog);
  const claims: Claim[] = [];
  const interp = lane === "interpretation";
  for (const c of clausesOf(semanticText(text).replace(APPOSITIVE, " "))) {
    if (c.conditional) continue;
    const es = findEntities(c.text, catalog);
    if (!es.length) continue;
    WORD_RE.lastIndex = 0;
    for (let m = WORD_RE.exec(c.text); m; m = WORD_RE.exec(c.text)) {
      const word = m[0], start = m.index, end = start + word.length;
      let w = WORDS.get(word);
      const before = c.text.slice(Math.max(0, start - 36), start);
      if (!w) { // bare "up"/"down": only as a predicate after a link verb ("revenue is down")
        if (!interp || !LINK_BEFORE.test(before)) continue;
        w = { cls: "flat", dir: word === "up" ? "up" : "down" };
      }
      if (!interp && !((w.cls === "iv" && w.dir) || (w.cls === "ipart" && w.dir))) continue; // actions and gaps: unambiguous descriptive words only
      if (word === "dropped" && PASSIVE_BEFORE.test(before)) continue;
      const auxNeg = AUX_NEG.test(before);
      if (w.cls === "basev" && !auxNeg) continue;
      const tail = c.text.slice(end).trim();
      // generic, idiomatic or off-period statements are not claims about the verified Q2->Q3 change (S5)
      if (HABITUAL.test(c.text.slice(0, start)) || OFF_PERIOD.test(tail) || ((w.cls === "iv" || w.cls === "tv") && IDIOM_TAIL.test(tail))) continue;
      let idx = -1;
      let side: "left" | "right" = "left";
      switch (w.cls) {
        case "iv": idx = leftOf(es, start, 6, c.text); break;
        case "tv": {
          const r = rightOf(es, end, 1, c.text);
          if (r >= 0) { idx = r; side = "right"; }
          else if (OBJECT_FREE_FOLLOW.test(tail)) idx = leftOf(es, start, 6, c.text);
          break;
        }
        case "ipart": {
          const r = rightOf(es, end, 2, c.text);
          const between = r >= 0 ? c.text.slice(end, es[r]!.start).trim().split(/\s+/).filter(Boolean) : [];
          if (r >= 0 && between.every((x) => ATTRIBUTIVE_GAP.has(x))) { idx = r; side = "right"; } else idx = leftOf(es, start, 3, c.text);
          break;
        }
        case "tpart":
          if (LINK_BEFORE.test(before)) {
            idx = rightOf(es, end, 1, c.text);
            if (idx >= 0) side = "right"; else if (OBJECT_FREE_FOLLOW.test(tail)) idx = leftOf(es, start, 5, c.text);
          }
          break;
        case "basev": idx = leftOf(es, start, 4, c.text); break;
        case "noun": case "hom": {
          if (w.cls === "hom" && auxNeg) { idx = leftOf(es, start, 4, c.text); break; }
          const prep = /^(?:in|of|for|on|across|within)\s+(?:the\s+|our\s+|its\s+|their\s+)?/.exec(tail);
          if (prep) { const r = rightOf(es, end + (c.text.slice(end).length - tail.length) + prep[0].length, 0, c.text); if (r >= 0) { idx = r; side = "right"; break; } }
          idx = leftOf(es, start, w.cls === "hom" ? 0 : 1, c.text);
          break;
        }
        case "adj": if (LINK_BEFORE.test(before)) idx = leftOf(es, start, 3, c.text); break;
        case "flat": idx = leftOf(es, start, 4, c.text); break;
      }
      if (idx < 0) continue;
      let subject = idx;
      if (side === "left") { // the entity must really be the subject of the verb (B1, S6)
        if (!subjectGapOk(c.text.slice(es[idx]!.end, start))) continue; // "revenue CONCERNS grew": a different head noun; "revenue FROM the tail grew": same head
        subject = resolveHead(es, idx, c.text); // "revenue FROM new leads rose": revenue
        if (OBLIQUE_BEFORE.test(c.text.slice(0, es[subject]!.start))) continue; // "pressure ON revenue rose"
        if (isAmbiguous(es, subject, c.text)) continue; // "revenue VERSUS conversion rose": no inference
      }
      const chain = side === "left" ? chainLeft(es, subject, c.text) : [es[subject]!];
      const negated = auxNeg || NEGATOR.test(c.text.slice(Math.max(0, start - 28), start)) || (side === "right" && NEGATOR.test(c.text.slice(Math.max(0, start - 14), start)));
      const forward = !interp && c.monitor; // monitoring directives talk about what may happen next (S7)
      // valence words resolve per metric; departments have no polarity, so a valence word only counts as an assumed direction for the domain check
      if (w.dir) claims.push({ entities: chain, dir: w.dir, negated, word, forward });
      else for (const e of chain) {
        if (e.kind !== "metric") { claims.push({ entities: [e], dir: w.val === "good" ? "up" : "down", negated, word, forward }); continue; }
        const good: Dir = goodDirection(catalog, e.key);
        const bad: Dir = good === "up" ? "down" : "up";
        claims.push({ entities: [e], dir: w.val === "good" ? good : bad, negated, word, forward });
      }
    }
  }
  return claims;
}

// ------------------------------------------------------------------ magnitude (B2)
const ONES = "zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen";
const TENS = "twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety";
const NUM = `(?:(?:${TENS})(?: (?:${ONES}))?|${ONES})`;
const MOVE = "rose|risen|rises|rising|fell|fallen|falls|falling|dropped|drops|dropping|declined|declines|declining|increased|increases|increasing|decreased|decreases|decreasing|grew|grown|grows|growing|climbed|climbing|slid|jumped|surged|plunged|dipped|up|down";
const TIME_UNITS = "days?|weeks?|months?|quarters?|years?|hours?|minutes?|sprints?|cycles?|periods?|phases?|steps?|times?";
const FRACTION_WORD = "thirds?|fifths?|sixths?|eighths?|ninths?|tenths?";
const COMPARE = "as|higher|lower|more|less|fewer|larger|smaller|greater|bigger|faster|slower|the";
/** "always": inherently a performance claim wherever it appears. "metric": only when it describes a metric (ordinary process language otherwise). */
export const MAGNITUDE_PATTERNS: { kind: string; ctx: "always" | "metric"; re: RegExp }[] = [
  { kind: "percent", ctx: "always", re: /%|\bper ?cent\b|\bpercent(?:age points?)?\b|\bpct\b|\bbasis points?\b|\bbps\b|\bpp\b/ },
  { kind: "multiple", ctx: "always", re: new RegExp(`\\b(?:redoubl|doubl|tripl|quadrupl|quintupl)(?:ed|ing)\\b|\\bhalv(?:ed|ing)\\b|\\bmultipl(?:ied|ying)\\b|\\bfactor of ${NUM}\\b|\\bthrice\\b`) },
  { kind: "fold", ctx: "always", re: /\b(?:two|three|four|five|six|seven|eight|nine|ten|twelve|twenty|hundred|thousand|million|n|x)\s?fold\b/ },
  { kind: "order-of-magnitude", ctx: "always", re: /\borders? of magnitude\b/ },
  { kind: "digit-band", ctx: "always", re: /\b(?:single|double|triple) digits?\b/ },
  { kind: "times", ctx: "always", re: new RegExp(`\\b(?:${MOVE})\\s+(?:by\\s+)?${NUM}\\s+times\\b`) },
  { kind: "spelled-movement", ctx: "always", re: new RegExp(`\\b(?:${MOVE})\\s+(?:(?:by|to|from|about|around|roughly|nearly|almost|approximately|over|under)\\s+)?(?:(?:about|roughly|nearly|almost|approximately)\\s+)?${NUM}\\b(?!\\s+(?:${TIME_UNITS}))`) },
  { kind: "twice", ctx: "metric", re: /\btwice\b(?!\s+(?:a|per|each|every)\s+(?:day|week|month|quarter|year|sprint|cycle|hour))/ },
  { kind: "times", ctx: "metric", re: new RegExp(`\\b(?:${NUM}|dozens of|hundreds of)\\s+times\\s+(?:${COMPARE})\\b|\\btimes\\s+(?:as|higher|lower|more|larger|greater|bigger|faster|slower)\\b`) },
  { kind: "half", ctx: "metric", re: /\b(?:by|in|cut in|down by|reduced by)\s+half\b|\bhalf\s+(?:of|as|the)\b/ },
  { kind: "fraction", ctx: "metric", re: new RegExp(`\\b(?:a|one|per) quarter of\\b|\\b(?:two|three) quarters of (?:the|its|their|all)\\b|\\b(?:${NUM}|a|one) (?:${FRACTION_WORD})\\s+(?:of|${COMPARE})\\b|\\bby\\s+(?:${NUM}|a|one) (?:${FRACTION_WORD})\\b|\\b(?:${MOVE})\\s+(?:to\\s+)?(?:${NUM}|a|one) (?:${FRACTION_WORD})\\b`) },
  { kind: "scale-word", ctx: "metric", re: /\b(?:hundreds?|thousands?|millions?|billions?|trillions?|dozens?)\b/ },
  { kind: "spelled-amount", ctx: "metric", re: new RegExp(`\\b${NUM}\\s+(?:dollars?|usd|euros?|cents?|points?)\\b`) },
];
const MOVEMENT_CONTEXT = new RegExp(`\\b(?:${WORD_KEYS.join("|")}|up|down|reduce|cut|lower|raise|increase|improve|grow|boost|decrease|halve|drive|lift|expand|shrink|drop|rise|fall|decline)\\b`);

/**
 * Unsupported magnitude expression kinds in a text.
 * Interpretations: a metric-bound pattern counts when the SENTENCE mentions a metric.
 * Proposed actions and gaps (narrower, to spare process instructions): the CLAUSE must mention a metric AND a movement/target word,
 * so "Review revenue twice a week" or "Pull a hundred records" pass while "Reduce backorders by half" does not.
 */
export function magnitudeExpressions(text: string, lane: Lane, catalog: Catalog): string[] {
  assertCatalog(catalog);
  const t = semanticText(text);
  const kinds = new Set<string>();
  for (const p of MAGNITUDE_PATTERNS) if (p.ctx === "always" && p.re.test(t)) kinds.add(p.kind);
  const units = lane === "interpretation" ? t.split(/[.!?;\n]+/).map((s) => s.trim()).filter(Boolean) : clausesOf(t).map((c) => c.text);
  for (const unit of units) {
    const hasMetric = findEntities(unit, catalog).some((e) => e.kind === "metric");
    if (!hasMetric || (lane !== "interpretation" && !MOVEMENT_CONTEXT.test(unit))) continue;
    for (const p of MAGNITUDE_PATTERNS) if (p.ctx === "metric" && p.re.test(unit)) kinds.add(p.kind);
  }
  return [...kinds];
}

// ------------------------------------------------------------------ checking
export interface SemanticScope {
  /** Verified facts for the role (authorized AND with data). */
  facts: readonly VerifiedFact[];
  /** Metric keys the role may DISCOVER: metrics with verified data, plus metrics the access-policy layer explicitly granted (`EvidenceScope.discoverableMetrics`).
   * Never inferred from the department of another metric. A hand-built scope that lacks this set discovers nothing (fail closed). */
  discoverable?: ReadonlySet<string>;
  /** Departments the role may name: those that own at least one discoverable metric. Informational: `checkSemantics` derives it from `discoverable` and never reads this field. */
  departments: ReadonlySet<string>;
  /** The business vocabulary the text is read against. */
  catalog: Catalog;
  /** When anything but `undefined` or `false` (see `isStrictMentions`), ANY mention of a non-discoverable metric or department is rejected. When `false` or absent (the legacy default), a neutral mention of a metric in a department
   * the role has no access to at all stays allowed (gaps, hand-offs), but a metric in a department the role does access, which it may not discover, is always rejected. */
  strictMentions?: boolean;
}
export interface SemanticScopeOptions {
  /** Explicit metric-level grant from the access-policy layer. Unknown keys are ignored. Absent: only metrics with verified facts are discoverable. */
  discoverable?: Iterable<string> | undefined;
  strictMentions?: boolean | undefined;
}
/** Strict mention enforcement is the DEFAULT-DENY side of the switch: only `undefined` (not configured) and exactly `false` (explicitly legacy) leave it off. Any other value
 * (`true`, the string "true", "false", 0, 1, null, an object, ...) is treated as strict, so a malformed or unexpected setting can never silently relax enforcement. */
export const isStrictMentions = (v: unknown): boolean => !(v === undefined || v === false);
export function semanticScope(authorized: readonly EvidenceLike[], facts: readonly VerifiedFact[], catalog: Catalog, opts: SemanticScopeOptions = {}): SemanticScope {
  assertCatalog(catalog);
  void authorized; // record membership grants nothing by itself: authorization to discover a metric is not inferred from which department's records happen to be present
  const known = new Set(catalog.metrics.map((m) => m.key));
  const discoverable = new Set<string>([...facts.map((f) => f.metric), ...[...(opts.discoverable ?? [])].filter((k) => known.has(k))].filter((k) => known.has(k)));
  const owner = departmentByMetric(catalog) as Record<string, string>;
  return { facts, discoverable, departments: new Set([...discoverable].map((k) => owner[k]!)), catalog, strictMentions: isStrictMentions(opts.strictMentions) };
}
/** `domain`: outside the role's discoverable scope (a hidden metric or department; the SAME code and wording whether the metric is in another department or the role's own).
 * `unavailable`: a metric the policy lets the role discover, with no verified data in this scenario. Messages never name unauthorized things or echo model text. */
export interface SemanticIssue { code: "magnitude" | "direction" | "domain" | "unavailable"; message: string }

/** One fixed wording for every scope violation, so the response cannot tell a hidden metric of the role's own department from one elsewhere, or a claim from a mention. */
const SCOPE_MESSAGE = (where: string) => `Semantic guard (domain): ${where} refers to a metric or department outside this role's authorized scope`;
const DOMAIN_MESSAGE = (where: string) => `Semantic guard (domain): ${where} makes a directional claim about a metric or department outside this role's authorized scope`;

/** All semantic-guard issues for one text. Empty when the text passes. `where` is a safe locator such as "interpretation 2". */
export function checkSemantics(text: string, lane: Lane, scope: SemanticScope, where = "text"): SemanticIssue[] {
  assertCatalog(scope.catalog); // a hand-built scope is checked too
  const discoverable = scope.discoverable instanceof Set ? scope.discoverable : new Set<string>(); // a malformed hand-built scope discovers nothing
  const owner: Record<string, string> = departmentByMetric(scope.catalog);
  const departments = new Set<string>([...discoverable].map((k) => owner[k]).filter((d): d is string => !!d));
  const issues: SemanticIssue[] = [];
  const seen = new Set<string>();
  const push = (i: SemanticIssue) => { if (!seen.has(i.message)) { seen.add(i.message); issues.push(i); } };
  for (const kind of magnitudeExpressions(text, lane, scope.catalog)) push({ code: "magnitude", message: `Semantic guard (magnitude): ${where} contains an unsupported ${kind} expression; numbers and magnitudes appear only in Athena-computed findings` });
  const byMetric = new Map<string, VerifiedFact>(scope.facts.map((f) => [f.metric, f]));
  const hidden = (e: { kind: string; key: string }) => (e.kind === "metric" ? !discoverable.has(e.key) : !departments.has(e.key));
  // A hidden metric inside a department the role DOES have access to is never mentionable (that department is not "elsewhere"); a hidden metric or department in a
  // department the role has no access to at all may be mentioned neutrally unless the scope is strict.
  const strict = !(scope.discoverable instanceof Set) || isStrictMentions(scope.strictMentions); // no usable discoverable set: nothing is mentionable either
  const sameDepartment = (e: { kind: string; key: string }) => e.kind === "metric" && departments.has(owner[e.key]!);
  const claimed = new Set<string>();
  for (const claim of directionalClaims(text, lane, scope.catalog)) {
    for (const e of claim.entities) {
      claimed.add(`${e.kind}:${e.key}`);
      const claimText = `${claim.negated ? "not " : ""}${claim.dir}`;
      if (hidden(e)) push({ code: "domain", message: DOMAIN_MESSAGE(where) });
      else if (e.kind === "metric") {
        const f = byMetric.get(e.key);
        if (!f) push({ code: "unavailable", message: `Semantic guard (unavailable data): ${where} makes a directional claim about a metric for which no verified data is available in this scenario` });
        else if (!claim.forward && contradicts(claim, f.direction)) push({ code: "direction", message: `Semantic guard (direction): ${where} says ${metricLabel(scope.catalog, e.key)} is ${claimText}, but the verified finding is ${f.direction}` });
      }
    }
  }
  for (const e of mentionedEntities(text, scope.catalog)) {
    if (claimed.has(`${e.kind}:${e.key}`) || !hidden(e)) continue;
    if (strict || sameDepartment(e)) push({ code: "domain", message: SCOPE_MESSAGE(where) });
  }
  return issues;
}

/** A claim contradicts a verified direction when it states the opposite (flat facts tolerate small up/down wording). */
function contradicts(c: Claim, fact: Dir): boolean {
  if (c.negated) return c.dir === fact;
  if (c.dir === "flat") return fact !== "flat";
  if (fact === "flat") return false;
  return c.dir !== fact;
}
