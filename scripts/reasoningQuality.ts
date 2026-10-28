// G4.5: offline usefulness evaluation for the local Meta reasoning runner. TEST-SIDE ONLY: pure, deterministic, no I/O, no network, no model call, and never an input to validation. A low score
// is a quality signal for the founder; it never rejects a reply (the strict validator alone decides acceptance).
//
// Two evaluations, kept apart:
//   * FINDINGS (deterministic lane): are the verified findings Athena renders itself present, and do they carry the expected direction for each tested metric? This does not depend on the model.
//   * REASONING (model lane): how specific, relevant, testable and appropriately uncertain is what the model wrote? Five dimensions, each 0-2, scored from STRUCTURE (cited facts, informative content
//     words left after removing metric names, hedges and generic filler, overlap between gaps and hypotheses, an action verb with an object) rather than from the presence of any one keyword.
// These are bounded heuristics, not language understanding: a fluent but wrong hypothesis can score well, and a sound terse one can score low. They support a human judgement.
import { PROTOTYPE_CATALOG } from "../src/lib/athena/prototypeCatalog";

export interface QualityFinding {
  metric: string;
  direction: "up" | "down" | "flat";
}
export interface QualityOutput {
  interpretations: { text: string; refs: readonly string[] }[];
  missing_evidence: readonly string[];
  recommendations: { text: string; refs: readonly string[] }[];
}

export type Score = 0 | 1 | 2;
export interface FindingsEvaluation {
  /** Every tested metric has a rendered finding. */
  allPresent: boolean;
  /** Every tested metric's finding has the expected direction. */
  directionsMatch: boolean;
  perMetric: Record<string, { present: boolean; direction: string | null; expected: string }>;
}
export interface ReasoningEvaluation {
  hypothesisSpecificity: Score;
  relevance: Score;
  missingEvidenceQuality: Score;
  actionableInvestigation: Score;
  appropriateUncertainty: Score;
  total: number;
  max: 10;
  verdict: "useful" | "partial" | "weak";
}

/** Findings evaluation. `expected` maps each tested metric to the direction the synthetic scenario was built with. */
export function evaluateFindings(
  findings: readonly QualityFinding[],
  expected: Readonly<Record<string, "up" | "down" | "flat">>,
): FindingsEvaluation {
  const perMetric: FindingsEvaluation["perMetric"] = {};
  for (const [metric, want] of Object.entries(expected)) {
    const f = findings.find((x) => x.metric === metric);
    perMetric[metric] = { present: !!f, direction: f?.direction ?? null, expected: want };
  }
  const all = Object.values(perMetric);
  return {
    allPresent: all.every((m) => m.present),
    directionsMatch: all.every((m) => m.present && m.direction === m.expected),
    perMetric,
  };
}

// ---------------------------------------------------------------- tokens
const STOP = new Set(
  "a an and are as at be been by can do does for from has have how if in into is it its of on or so than that the their them then there these this those to too up via was were what when where which while who why will with within without across also both each more most other some such than only very per".split(
    " ",
  ),
);
const HEDGES = new Set(
  "may might could possibly potentially perhaps plausibly plausible probably likely possible potential appears appear seems seem suggests suggest unverified".split(
    " ",
  ),
);
/** Words that make a sentence sound analytical without saying anything testable. */
const FILLER = new Set(
  "dynamic dynamics pattern patterns trend trends context overall various factor factors relationship relationships relate relates related relating move moves moving movement movements comove together joint jointly alignment align aligned aligns general broad broader aspect aspects stage stages efficiency relevance diagnostic diagnostics requiring require requires need needs needed attention consideration area areas topic topics issue issues matter matters situation performance outcome outcomes result results impact impacts effect effects".split(
    " ",
  ),
);
/** Verbs that, on their own, do not describe an investigation. */
const VAGUE_VERBS = new Set(
  "review monitor consider watch discuss align ensure look keep revisit think explore".split(" "),
);
/** Verbs that name something a person can actually do to data. */
const CONCRETE_VERBS = new Set(
  "compare segment split break trace pull audit test measure check collect obtain examine analyze analyse isolate correlate sample inspect quantify identify determine investigate map cohort rank time benchmark reconcile verify request gather".split(
    " ",
  ),
);

const norm = (t: string) =>
  t
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/-/g, " ");
const stem = (w: string) =>
  w.length > 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w;
const words = (t: string) => norm(t).split(/\s+/).filter(Boolean);

/** Words that merely NAME a catalog metric or department; naming a metric is not a hypothesis. */
const NAME_WORDS: ReadonlySet<string> = new Set(
  [
    ...PROTOTYPE_CATALOG.metrics.flatMap((m) => [...m.aliases, m.label]),
    ...PROTOTYPE_CATALOG.domains.flatMap((d) => [...d.aliases, d.id]),
  ].flatMap((p) => words(p).map(stem)),
);

/** Content words that remain after removing stop words, hedges, filler, vague verbs and metric/department names. */
export function informativeTokens(text: string): string[] {
  return words(text)
    .map(stem)
    .filter(
      (w) =>
        w.length > 2 &&
        !STOP.has(w) &&
        !HEDGES.has(w) &&
        !FILLER.has(w) &&
        !VAGUE_VERBS.has(w) &&
        !NAME_WORDS.has(w),
    );
}
const hedgeCount = (text: string) => words(text).filter((w) => HEDGES.has(w)).length;

const distinct = (xs: readonly string[]) => new Set(xs).size;
const grade = (good: number, n: number): Score => (n === 0 || good === 0 ? 0 : good === n ? 2 : 1);

/** A hypothesis is specific when it links at least two distinct cited facts and still has several informative content words after naming, hedging and filler are removed. */
const specificHypothesis = (i: QualityOutput["interpretations"][number]) =>
  distinct(i.refs) >= 2 && informativeTokens(i.text).length >= 3;
/** A gap is concrete when it carries several informative words and shares at least one with a hypothesis or recommendation, so it can actually test something the model proposed. */
const concreteGap = (gap: string, others: ReadonlySet<string>) => {
  const t = informativeTokens(gap);
  return t.length >= 3 && t.some((w) => others.has(w));
};
/** An action is an investigation when it names a concrete operation (not only a vague verb) and enough informative detail to say on what. */
const actionable = (text: string) => {
  const ws = words(text).map(stem);
  const lead = ws.slice(0, 8);
  return (
    lead.some((w) => CONCRETE_VERBS.has(w) || CONCRETE_VERBS.has(w.replace(/e$/, ""))) &&
    informativeTokens(text).length >= 3
  );
};

/** Reasoning evaluation of ACCEPTED model output. `factIds` are the authorized verified fact ids the reply could cite. */
export function evaluateReasoning(
  out: QualityOutput,
  factIds: readonly string[],
): ReasoningEvaluation {
  const cited = new Set([...out.interpretations, ...out.recommendations].flatMap((x) => x.refs));
  const hypothesisSpecificity = grade(
    out.interpretations.filter(specificHypothesis).length,
    out.interpretations.length,
  );

  const coveredFacts = factIds.filter((f) => cited.has(f)).length;
  const relevance: Score =
    factIds.length === 0 || coveredFacts <= 1 ? 0 : coveredFacts === factIds.length ? 2 : 1;

  const others = new Set(
    [...out.interpretations.map((i) => i.text), ...out.recommendations.map((r) => r.text)].flatMap(
      informativeTokens,
    ),
  );
  const concrete = out.missing_evidence.filter((g) => concreteGap(g, others)).length;
  // An empty list is the lowest quality score, but only a quality score: the schema and validator allow it.
  const missingEvidenceQuality: Score =
    out.missing_evidence.length === 0 ? 0 : concrete === out.missing_evidence.length ? 2 : 1;

  const actionableInvestigation = grade(
    out.recommendations.filter((r) => actionable(r.text)).length,
    out.recommendations.length,
  );

  const counts = out.interpretations.map((i) => hedgeCount(i.text));
  const fine = counts.filter((c) => c >= 1 && c <= 2).length;
  const appropriateUncertainty: Score =
    counts.length === 0 || fine === 0 ? 0 : fine === counts.length ? 2 : 1;

  const total =
    hypothesisSpecificity +
    relevance +
    missingEvidenceQuality +
    actionableInvestigation +
    appropriateUncertainty;
  const dims = [
    hypothesisSpecificity,
    relevance,
    missingEvidenceQuality,
    actionableInvestigation,
    appropriateUncertainty,
  ];
  const verdict =
    total >= 8 && dims.every((d) => d >= 1)
      ? "useful"
      : total <= 4 || hypothesisSpecificity === 0
        ? "weak"
        : "partial";
  return {
    hypothesisSpecificity,
    relevance,
    missingEvidenceQuality,
    actionableInvestigation,
    appropriateUncertainty,
    total,
    max: 10,
    verdict,
  };
}
