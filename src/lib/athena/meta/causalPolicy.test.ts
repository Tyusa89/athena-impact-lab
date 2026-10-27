import { readFileSync, readdirSync, statSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authorizeDemo } from "../prototypeAdapter";
import { PROTOTYPE_RUNTIME } from "./adapter.server";
import { hasCausalClaim, validateAuthorizedOutput, validateOutput } from "./analysis";
import { strictCausalClaim } from "./causalPolicy";
import type { Lane } from "./semantic";
import { DIAGNOSTIC_CATEGORIES, strictRejection, validateStrictOutput } from "./strictValidation";

// G2: strict causal-language policy. Offline: demo fixtures, no provider, fetch tripwire.
const tripwire = vi.fn(() => {
  throw new Error("network call attempted");
});
vi.stubGlobal("fetch", tripwire);
afterEach(() => tripwire.mockClear());

const I: Lane = "interpretation",
  R: Lane = "recommendation",
  G: Lane = "gap";
const ALL = [I, R, G] as const;
const rej = (t: string, lanes: readonly Lane[] = ALL) =>
  lanes.forEach((l) => expect(strictCausalClaim(t, l), `${l}: ${t}`).toBe(true));
const acc = (t: string, lanes: readonly Lane[] = ALL) =>
  lanes.forEach((l) => expect(strictCausalClaim(t, l), `${l}: ${t}`).toBe(false));

describe("affirmative causal assertions are rejected in every lane", () => {
  it.each([
    "Revenue declined because marketing performed poorly.",
    "Revenue declined due to lower lead volume.",
    "Marketing performance explains why revenue declined.",
    "Revenue declined because of a documented contract cancellation.",
    "Weak demand led to the revenue decline.",
    "Weak demand resulted in the revenue decline.",
    "Weak demand is the reason for the revenue decline.",
    "Weak demand is responsible for the revenue decline.",
    "The revenue decline is attributable to weak demand.",
    "Weak demand contributed to the revenue decline.",
    "Revenue declined, driven by weak demand.",
    "The decline stems from weak demand.",
    "The decline was a result of churn, as a result of weak demand.",
    "Weak demand influenced revenue.",
    "The root cause is weak lead quality.",
    "Fulfillment delays caused the revenue drop.",
    "Lead mix proves the conversion decline.",
    "This proof is definitive: data proves it.",
    "Backorders are the cause of lost sales.",
    "Higher leads causes lower conversion.",
    "Data confirms that delays hurt sales.",
    "That is why revenue fell.",
  ])("%s", (t) => rej(t));
});

describe("Tier 1 (proof and definitive-cause language) cannot be excused by a hedge", () => {
  it.each([
    "The likely cause is weak lead quality.",
    "The possible cause is weak lead quality.",
    "Lower conversion may have caused the decline.",
    "Weak demand might be the cause.",
    "This probably proves the decline is seasonal.",
    "It is definitively weak demand.",
  ])("%s", (t) => rej(t));
});

describe("Tier 2 (causal relationships) can be qualified in the same clause", () => {
  it.each([
    "Lower conversion may have contributed to the revenue decline.",
    "Revenue might have declined because of churn.",
    "The decline could be due to weak demand.",
    "Revenue possibly declined due to seasonality.",
    "Weak demand perhaps led to the decline.",
    "The decline seems to be driven by weak demand.",
    "If revenue declined because of churn, the pipeline needs review.",
    "It is plausible that churn was responsible for the decline.",
  ])("%s", (t) => acc(t));
  it("a hedge, denial or question in ANOTHER clause or sentence does not excuse the assertion", () => {
    rej("Revenue may fall, and it declined because of churn.");
    rej("Revenue may fall; it declined because of churn.");
    rej("Revenue may fall, it declined because of churn.");
    rej("Revenue may fall, perhaps, it declined due to churn.");
    rej("Revenue may fall. It declined because of churn.");
    rej("Whether it matters is unclear, but revenue declined because of churn.");
    rej("There is no doubt, revenue declined because of churn.");
    rej("Is revenue down? Revenue declined because of churn.");
  });
});

describe("negated causal statements are accepted", () => {
  it.each([
    "The root cause is unknown.",
    "The root cause of the change is not known.",
    "The cause is still undetermined.",
    "The data does not establish causation.",
    "The available evidence does not prove causation.",
    "The results are correlated, but causality has not been established.",
    "No evidence shows that delays caused the drop.",
    "It is unclear whether delays caused the drop.",
    "Revenue fell, not because of churn.",
    "Weak demand did not cause the decline.",
    "The reason for the decline is not known.",
    "Lead volume did not contribute to the decline.",
    "The data does not explain why revenue declined.",
  ])("%s", (t) => acc(t));
  it("a negation that does not govern the causal term does not excuse it", () => {
    rej("Revenue is not flat because of churn.");
    rej("Revenue is not low, but the decline is due to churn.");
  });
});

describe("questions and investigative language", () => {
  it("questions are accepted when they are real questions", () => {
    acc("Did lead quality contribute to the decline?");
    acc("Is weak demand responsible for the decline?");
    acc("What caused the decline?");
    rej("Weak demand caused the decline?"); // not a question form
  });
  it("investigative imperatives are accepted in recommendations and gaps", () => {
    for (const t of [
      "Investigate whether conversion contributed to the decline.",
      "Review the factors responsible for the decline.",
      "Determine whether lead quality influenced conversion.",
      "Investigate fulfillment delays and backorder causes promptly",
      "Identify the root cause of the conversion decline.",
      "Review possible causes of longer fulfillment times.",
      "Determine whether lead mix causes lower conversion.",
      "Examine potential causes of the backorder rise.",
      "Please investigate whether conversion contributed to the decline.",
    ])
      acc(t, [R, G]);
  });
  it("an interpretation is never an imperative: only the question or hedge route is open to it", () => {
    rej("Review the factors responsible for the decline.", [I]);
    rej("Identify the root cause of the conversion decline.", [I]);
    acc("Investigate whether conversion contributed to the decline.", [I]); // "whether" is a same-clause qualifier for a Tier 2 term
  });
  it("an investigative verb never excuses an embedded causal conclusion", () => {
    rej("Investigate the cause, which is weak lead quality.", [R, G]);
    rej("Investigate delays; the cause is weak lead quality.", [R, G]);
    rej("Investigate churn, revenue fell because of it.", [R, G]);
    rej("Investigate delays. Backorder causes lost revenue.", [R, G]);
    rej("Review the delays that caused the drop.", [R, G]);
    rej("Investigate delays and note that the cause was weak demand.", [R, G]);
  });
});

describe("noncausal wording is untouched", () => {
  it.each([
    "Revenue declined, while lead volume increased.",
    "Revenue and conversion moved in the same direction.",
    "The decline may reflect seasonal demand.",
    "The results are correlated with lead volume.",
    "Revenue is associated with conversion.",
    "Review the sales strategy.",
  ])("%s", (t) => acc(t));
});

describe("normalization: width and invisible-character obfuscation", () => {
  it.each([
    "Delays ｃａｕｓｅｄ the drop.",
    "Delays ca​used the drop.",
    "FULFILLMENT DELAYS CAUSED THE DROP.",
    "Revenue fell bec‍ause of churn.",
    "Revenue fell ｄｕｅ ｔｏ churn.",
    "Lead mix pr­oves the decline.",
    "Revenue fell BECAUSE   OF churn.",
  ])("%s", (t) => rej(t));
});

describe("known false positives and false negatives are pinned (documented in docs/model-output-scope.md)", () => {
  it("false positives: ordinary phrases that contain a listed word fail closed", () => {
    rej("Revenue is the reason we are reviewing the plan.");
    rej("Revenue declined because of seasonality is a hypothesis to test.");
    rej("Please attach proof of delivery.");
  });
  it("false negatives: implicit or verb-based causality is not detected", () => {
    for (const t of [
      "Weak demand hurt revenue.",
      "The campaign pause triggered the revenue decline.",
      "Revenue fell as a consequence of weak demand.",
      "Revenue declined following the campaign pause.",
      "Revenue fell, reflecting weak demand.",
    ])
      acc(t);
  });
});

describe("parity with the legacy detector", () => {
  const LEGACY_REJECTED = [
    "Fulfillment delays caused the revenue drop.",
    "Lead mix proves the conversion decline.",
    "This proof is definitive: data proves it.",
    "Backorders are the cause of lost sales.",
    "Backorders is the cause of lost sales.",
    "Higher leads causes lower conversion.",
    "FULFILLMENT DELAYS CAUSED THE DROP.",
    "Delays ca​used the drop.",
    "Delays ｃａｕｓｅｄ the drop.",
    "Data confirms that delays hurt sales.",
    "Investigate delays. Backorder causes lost revenue.",
    "Lead volume proves the cause.",
    "Delays definitively explain the drop.",
    "Delays are the cause of the drop.",
  ];
  const LEGACY_INVESTIGATIVE = [
    "Investigate fulfillment delays and backorder causes promptly",
    "Identify the root cause of the conversion decline.",
    "Review possible causes of longer fulfillment times.",
    "Determine whether lead mix causes lower conversion.",
    "Examine potential causes of the backorder rise.",
  ];
  it("every legacy-rejected sample is still rejected by the strict policy, in every lane", () => {
    for (const t of LEGACY_REJECTED) {
      for (const l of ALL) {
        expect(hasCausalClaim(t, l !== I), `legacy ${l}: ${t}`).toBe(true);
        expect(strictCausalClaim(t, l), `strict ${l}: ${t}`).toBe(true);
      }
    }
  });
  it("every legacy-allowed investigative recommendation is still allowed", () => {
    for (const t of LEGACY_INVESTIGATIVE) {
      expect(hasCausalClaim(t, true)).toBe(false);
      acc(t, [R, G]);
    }
  });
  it("the ONLY intentional loosenings are denied statements (legacy rejects 'cause' in an interpretation even when it is denied)", () => {
    for (const t of ["The root cause is unknown.", "The cause is still undetermined."]) {
      expect(hasCausalClaim(t, false)).toBe(true);
      acc(t, [I]);
    }
  });
  it("the intentional tightenings: cue words no longer excuse an asserted cause in a recommendation or gap", () => {
    for (const t of [
      "The root cause is weak lead quality.",
      "The likely cause is weak lead quality.",
      "Possible causes include delays.",
      "Fix the possible cause: weak lead quality.",
    ]) {
      expect(hasCausalClaim(t, true)).toBe(false);
      rej(t, [R, G]);
    }
  });
});

// ------------------------------------------------------------------------------------------------------------------------------------------------------------------
const CTX = PROTOTYPE_RUNTIME.analysis;
const EXEC = authorizeDemo({ scenarioId: "baseline", roleId: "exec" });
const body = (lane: "i" | "r" | "g", text: string, refs: string[]) =>
  JSON.stringify({
    interpretations: lane === "i" ? [{ text, verified: false, refs }] : [],
    missing_evidence: lane === "g" ? [text] : [],
    recommendations: lane === "r" ? [{ text, requires_human_approval: true, refs }] : [],
  });
const strict = (lane: "i" | "r" | "g", text: string, refs: string[]) =>
  validateStrictOutput(
    body(lane, text, refs),
    EXEC.authorized,
    EXEC.withheld,
    CTX,
    EXEC.discoverableMetrics,
  );
const legacy = (lane: "i" | "r" | "g", text: string, refs: string[]) =>
  validateAuthorizedOutput(body(lane, text, refs), EXEC.authorized, EXEC.withheld, CTX, {
    discoverable: EXEC.discoverableMetrics,
  });
const diag = (v: ReturnType<typeof strict>) => (v.ok ? [] : v.diagnostics);

describe("end to end through the strict validator", () => {
  it("an affirmative causal claim with CORRECT exact citations is rejected as 'causal': a citation is not causal proof", () => {
    expect(
      diag(strict("i", "Revenue declined because marketing performed poorly.", ["F-revenue"])),
    ).toEqual(["causal"]);
    expect(
      diag(strict("i", "Revenue declined due to lower lead volume.", ["F-revenue", "F-leads"])),
    ).toEqual(["causal"]);
    expect(diag(strict("r", "The root cause is weak lead quality.", ["F-mql_rate"]))).toEqual([
      "causal",
    ]);
    expect(diag(strict("g", "Revenue declined because of churn.", []))).toEqual(["causal"]);
  });
  it("a qualified hypothesis is accepted, stays verified:false and keeps supporting ids derived from the cited facts", () => {
    const v = strict("i", "Lower conversion may have contributed to the revenue decline.", [
      "F-conversion_rate",
      "F-revenue",
    ]);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.output.interpretations[0]!.verified).toBe(false);
      expect(v.output.interpretations[0]!.supporting_ids).toEqual([
        "VH-SAL-001-Q2",
        "VH-SAL-001-Q3",
        "VH-FIN-001-Q2",
        "VH-FIN-001-Q3",
      ]);
    }
  });
  it("denial, question and investigative wording pass end to end", () => {
    expect(strict("i", "The root cause is unknown.", ["F-revenue"]).ok).toBe(true);
    expect(strict("i", "The data does not establish causation.", ["F-revenue"]).ok).toBe(true);
    expect(
      strict("r", "Investigate whether conversion contributed to the decline.", [
        "F-conversion_rate",
      ]).ok,
    ).toBe(true);
    expect(strict("g", "The root cause of the change is not known.", []).ok).toBe(true);
  });
  it("H2.4b exact-reference consistency is preserved and not masked by the causal result", () => {
    expect(
      diag(
        strict("i", "Lower conversion may have contributed to the revenue decline.", [
          "F-conversion_rate",
        ]),
      ),
    ).toEqual(["relevance"]);
    expect(
      diag(
        strict("i", "Lower conversion may have contributed to the revenue decline.", [
          "F-conversion_rate",
          "F-revenue",
          "F-leads",
        ]),
      ),
    ).toEqual(["relevance"]);
    expect(diag(strict("i", "Revenue declined because of churn.", ["F-leads"]))).toEqual(
      expect.arrayContaining(["relevance", "causal"]),
    );
  });
  it("the existing guards still run: unknown references and wrong direction", () => {
    expect(diag(strict("i", "The root cause is unknown.", ["F-nonexistent"]))).toEqual(["ref"]);
    expect(diag(strict("i", "Lead volume decreased.", ["F-leads"]))).toEqual(["direction"]);
  });
  it("the public rejection is byte-identical and no category was added", () => {
    expect(JSON.stringify(strictRejection())).toBe(
      JSON.stringify({
        state: "rejected",
        reason: "The model output did not pass validation and was not used.",
        requestSent: true,
      }),
    );
    expect([...DIAGNOSTIC_CATEGORIES]).toEqual([
      "json",
      "legacy",
      "schema",
      "leak",
      "ref",
      "relevance",
      "unsafe",
      "causal",
      "numeral",
      "magnitude",
      "direction",
      "domain",
      "unavailable",
      "provider",
      "unknown",
    ]);
    expect(
      JSON.stringify(strict("i", "Revenue declined because of churn.", ["F-revenue"])),
    ).not.toMatch(/revenue|because|F-/i); // internal categories only; the text is never echoed
  });
});

describe("legacy behaviour is unchanged", () => {
  it("the legacy validator still uses hasCausalClaim: it accepts 'because' and still rejects a denied 'cause' in an interpretation", () => {
    expect(
      legacy("i", "Revenue declined because marketing performed poorly.", ["F-revenue"]).ok,
    ).toBe(true);
    const denied = legacy("i", "The root cause is unknown.", ["F-revenue"]);
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.categories).toEqual(["causal"]);
    expect(legacy("r", "The root cause is weak lead quality.", ["F-mql_rate"]).ok).toBe(true);
  });
  it("the flag is exactly-true: nothing else enables it", () => {
    const raw = body("i", "Revenue declined because of churn.", ["F-revenue"]);
    const all = [...EXEC.authorized, ...EXEC.withheld];
    for (const flag of [undefined, false, 1, "true", null] as unknown[])
      expect(
        validateOutput(
          raw,
          EXEC.authorized,
          all,
          CTX,
          { discoverable: EXEC.discoverableMetrics },
          { strictCausal: flag as boolean },
        ).ok,
        String(flag),
      ).toBe(true);
    expect(
      validateOutput(
        raw,
        EXEC.authorized,
        all,
        CTX,
        { discoverable: EXEC.discoverableMetrics },
        { strictCausal: true },
      ).ok,
    ).toBe(false);
  });
  it("hasCausalClaim itself is unchanged (source pinned)", () => {
    const src = readFileSync("src/lib/athena/meta/analysis.ts", "utf8");
    expect(src).toContain(
      "const STRONG_CAUSAL = /\\b(proves?|proven|caused|is the cause|definitively|confirms that)\\b/;",
    );
    expect(src).toContain(
      "const INVESTIGATIVE = /\\b(investigate|investigating|identify|examine|review|explore|assess|determine|diagnose|analy[sz]e|check|audit|verify|test|possible|potential|likely|underlying|root)\\b/;",
    );
  });
});

describe("client input cannot toggle the policy, and strict execution stays inactive", () => {
  it("a model-output key named strictCausal is a schema violation, not a switch", () => {
    const raw = JSON.stringify({
      interpretations: [
        {
          text: "Revenue declined because of churn.",
          verified: false,
          refs: ["F-revenue"],
          strictCausal: false,
        },
      ],
      missing_evidence: [],
      recommendations: [],
      strictCausal: false,
    });
    expect(
      diag(
        validateStrictOutput(raw, EXEC.authorized, EXEC.withheld, CTX, EXEC.discoverableMetrics),
      ),
    ).toEqual(["schema"]);
  });
  it("validateStrictOutput takes no option that relaxes the policy, and it is the only setter", () => {
    expect(validateStrictOutput.length).toBe(5);
    const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\/|(?<!:)\/\/[^\n]*/g, " ");
    const walk = (d: string): string[] =>
      readdirSync(d).flatMap((f) =>
        statSync(`${d}/${f}`).isDirectory() ? walk(`${d}/${f}`) : [`${d}/${f}`],
      );
    const prod = walk("src").filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\./.test(f));
    expect(
      prod.filter((f) => /strictCausal\s*:\s*true/.test(strip(readFileSync(f, "utf8")))),
    ).toEqual(["src/lib/athena/meta/strictValidation.ts"]);
    const using = (re: RegExp, self: string[]) =>
      prod.filter((f) => !self.includes(f) && re.test(strip(readFileSync(f, "utf8"))));
    expect(
      using(/causalPolicy|strictCausalClaim/, [
        "src/lib/athena/meta/causalPolicy.ts",
        "src/lib/athena/meta/analysis.ts",
      ]),
    ).toEqual([]);
    expect(
      using(/strictRuntime|runStrictAnalysis/, ["src/lib/athena/meta/strictRuntime.ts"]),
    ).toEqual([]);
    expect(
      using(/strictValidation|validateStrictOutput/, [
        "src/lib/athena/meta/strictValidation.ts",
        "src/lib/athena/meta/strictRuntime.ts",
      ]),
    ).toEqual([]);
  });
  it("makes no network call", () => {
    strict("i", "Revenue declined because of churn.", ["F-revenue"]);
    expect(tripwire).not.toHaveBeenCalled();
  });
});
