import { readFileSync, readdirSync, statSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authorizeEvidence, type AccessPolicy } from "../core/access";
import {
  authorizeDemo,
  demoAccessPolicy,
  demoIdentity,
  type PrototypeEvidence,
} from "../prototypeAdapter";
import { PROTOTYPE_RUNTIME } from "./adapter.server";
import { validateAuthorizedOutput, validateOutput } from "./analysis";
import { buildVerifiedFacts } from "./grounding";
import { refsConsistent } from "./refConsistency";
import {
  DIAGNOSTIC_CATEGORIES,
  STRICT_REJECTION_REASON,
  strictRejection,
  validateStrictOutput,
} from "./strictValidation";

// H2.4b: mention-level evidence-reference consistency, strict profile only. Offline: demo fixtures, no provider, fetch tripwire.
const tripwire = vi.fn(() => {
  throw new Error("network call attempted");
});
vi.stubGlobal("fetch", tripwire);
afterEach(() => tripwire.mockClear());

const CTX = PROTOTYPE_RUNTIME.analysis;
const body = (lane: "i" | "r" | "g", text: string, refs: string[]) =>
  JSON.stringify({
    interpretations: lane === "i" ? [{ text, verified: false, refs }] : [],
    missing_evidence: lane === "g" ? [text] : [],
    recommendations: lane === "r" ? [{ text, requires_human_approval: true, refs }] : [],
  });
const EXEC = authorizeDemo({ scenarioId: "baseline", roleId: "exec" });
/** Marketing role with data for leads only; CAC is granted as discoverable but has no records; everything else is hidden. */
const LEADS: AccessPolicy<PrototypeEvidence> = {
  evidenceScope: (c) => {
    const b = demoAccessPolicy.evidenceScope(c);
    return {
      tenantId: b.tenantId,
      permits: (e) => b.permits(e) && e.metric === "leads",
      discoverableMetrics: ["cac"],
    };
  },
};
const MKT = (() => {
  const b = authorizeDemo({ scenarioId: "baseline", roleId: "marketing" });
  return authorizeEvidence(
    demoIdentity,
    demoIdentity.authenticateSync({ kind: "simulated-demo-role-claim", roleId: "marketing" }),
    LEADS as AccessPolicy<PrototypeEvidence>,
    [...b.authorized, ...b.withheld],
  );
})();
type Scope = typeof EXEC;
const strict = (s: Scope | typeof MKT, lane: "i" | "r" | "g", text: string, refs: string[]) =>
  validateStrictOutput(
    body(lane, text, refs),
    s.authorized,
    s.withheld,
    CTX,
    s.discoverableMetrics,
  );
const legacy = (s: Scope, lane: "i" | "r" | "g", text: string, refs: string[]) =>
  validateAuthorizedOutput(body(lane, text, refs), s.authorized, s.withheld, CTX, {
    discoverable: s.discoverableMetrics,
  });
const ok = (v: { ok: boolean }) => v.ok;
const diag = (v: ReturnType<typeof strict>) => (v.ok ? [] : v.diagnostics);

describe("1-3. direct citations", () => {
  it("accepts a correct direct citation and keeps supporting ids derived from the cited fact", () => {
    const v = strict(EXEC, "i", "Lead volume increased.", ["F-leads"]);
    expect(ok(v)).toBe(true);
    if (v.ok) {
      expect(v.output.interpretations[0]!.supporting_ids).toEqual([
        "VH-MKT-001-Q2",
        "VH-MKT-001-Q3",
      ]);
      expect(v.output.interpretations[0]!.verified).toBe(false);
    }
  });
  it("rejects a direct metric claim that cites a different metric (G1), with the closed 'relevance' category", () => {
    expect(diag(strict(EXEC, "i", "Lead volume increased.", ["F-revenue"]))).toEqual(["relevance"]);
    expect(diag(strict(EXEC, "i", "Lead volume increased.", ["F-mql_rate"]))).toEqual([
      "relevance",
    ]);
    expect(diag(strict(EXEC, "r", "Review lead volume.", ["F-revenue"]))).toEqual(["relevance"]);
  });
  it("accepts a correct two-metric citation, in either order", () => {
    expect(
      ok(
        strict(EXEC, "i", "Lead volume increased while conversion declined.", [
          "F-leads",
          "F-conversion_rate",
        ]),
      ),
    ).toBe(true);
    expect(
      ok(
        strict(EXEC, "i", "Lead volume increased while conversion declined.", [
          "F-conversion_rate",
          "F-leads",
        ]),
      ),
    ).toBe(true);
  });
});

describe("4. two metrics, one cited", () => {
  it("rejects when any named available metric is not cited, in both lanes", () => {
    expect(
      diag(strict(EXEC, "i", "Lead volume increased while conversion declined.", ["F-leads"])),
    ).toEqual(["relevance"]);
    expect(
      diag(
        strict(EXEC, "i", "Lead volume increased while conversion declined.", [
          "F-conversion_rate",
        ]),
      ),
    ).toEqual(["relevance"]);
    expect(
      diag(strict(EXEC, "r", "Review the lead source mix and the conversion step.", ["F-leads"])),
    ).toEqual(["relevance"]);
  });
  it("an extra unrelated citation beside a named metric's fact is rejected, so unrelated records cannot become supporting ids", () => {
    expect(diag(strict(EXEC, "i", "Lead volume increased.", ["F-leads", "F-revenue"]))).toEqual([
      "relevance",
    ]);
    expect(diag(strict(EXEC, "r", "Review lead volume.", ["F-revenue", "F-leads"]))).toEqual([
      "relevance",
    ]);
    expect(
      diag(
        strict(EXEC, "i", "Lead volume increased while conversion declined.", [
          "F-leads",
          "F-conversion_rate",
          "F-revenue",
        ]),
      ),
    ).toEqual(["relevance"]);
  });
  it("a context fact is allowed only when the sentence names its metric, and then it must be cited", () => {
    expect(
      ok(
        strict(EXEC, "i", "Lead volume rose, which may relate to the revenue trend.", [
          "F-leads",
          "F-revenue",
        ]),
      ),
    ).toBe(true);
    expect(
      diag(
        strict(EXEC, "i", "Lead volume rose, which may relate to the revenue trend.", ["F-leads"]),
      ),
    ).toEqual(["relevance"]);
  });
  it("repeated citations of the same named fact are still exact (supporting ids are derived once)", () => {
    const v = strict(EXEC, "i", "Lead volume increased.", ["F-leads", "F-leads"]);
    expect(ok(v)).toBe(true);
    if (v.ok) {
      expect(v.output.interpretations[0]!.refs).toEqual(["F-leads"]);
      expect(v.output.interpretations[0]!.supporting_ids).toEqual([
        "VH-MKT-001-Q2",
        "VH-MKT-001-Q3",
      ]);
    }
  });
  it("a rejected extra never leaks into the response and nothing is rewritten", () => {
    const v = strict(EXEC, "i", "Lead volume increased.", ["F-leads", "F-revenue"]);
    expect(v.ok).toBe(false);
    expect(JSON.stringify(v)).not.toMatch(/revenue|F-|VH-/i);
  });
});

describe("5-7. generic statements and multi-metric recommendations", () => {
  it("accepts a generic unverified hypothesis citing any authorized facts, several included", () => {
    expect(
      ok(strict(EXEC, "i", "The decline may reflect seasonal demand.", ["F-revenue", "F-leads"])),
    ).toBe(true);
    const v = strict(EXEC, "i", "The decline may reflect seasonal demand.", ["F-revenue"]);
    expect(ok(v)).toBe(true);
    if (v.ok) expect(v.output.interpretations[0]!.verified).toBe(false);
  });
  it("accepts a recommendation citing every relevant metric it names", () => {
    expect(
      ok(
        strict(EXEC, "r", "Review the lead source mix and the qualified leads step.", [
          "F-leads",
          "F-mql_rate",
        ]),
      ),
    ).toBe(true);
  });
  it("G4.7 rejects a generic business recommendation (no metric, no department, no hook): it may not display supporting facts", () => {
    expect(
      diag(strict(EXEC, "r", "Consider scheduling a planning workshop.", ["F-leads"])),
    ).toEqual(["relevance"]);
  });
  it("G4.7 anchor boundary: an exempted movement reference or a causal topic still passes without a department", () => {
    const facts = buildVerifiedFacts(EXEC.authorized, CTX);
    expect(
      refsConsistent("There was no decline in the period.", ["F-leads"], facts, CTX.catalog),
    ).toBe(true);
    expect(
      refsConsistent("The root cause is unknown.", ["F-revenue"], facts, CTX.catalog),
    ).toBe(true);
    expect(refsConsistent("Gather more data.", ["F-revenue"], facts, CTX.catalog)).toBe(false);
  });
  it("G4.7 review follow-up: a determiner-led PLURAL movement reference is direction-checked exactly like the singular", () => {
    const facts = buildVerifiedFacts(EXEC.authorized, CTX);
    // F-revenue fell and F-leads rose in this world, so "the decline(s)" may cite revenue but not leads alone.
    for (const t of ["The decline may reflect seasonal demand.", "The declines may reflect seasonal demand."]) {
      expect(refsConsistent(t, ["F-revenue"], facts, CTX.catalog), `${t} -> down fact`).toBe(true);
      expect(refsConsistent(t, ["F-leads"], facts, CTX.catalog), `${t} -> up fact`).toBe(false);
    }
    // the same alignment in the other direction ("these increases" may not cite only a falling fact)
    for (const t of ["The recent increase is encouraging.", "These increases are encouraging."]) {
      expect(refsConsistent(t, ["F-leads"], facts, CTX.catalog), `${t} -> up fact`).toBe(true);
      expect(refsConsistent(t, ["F-revenue"], facts, CTX.catalog), `${t} -> down fact`).toBe(false);
    }
    // the plural still ANCHORS the sentence, so it is not swept up by the G4.7 unanchored rule when the direction does match
    expect(diag(strict(EXEC, "i", "The declines may reflect seasonal demand.", ["F-leads"]))).toEqual(["relevance"]);
  });
  it("department vocabulary constrains citations only when a related fact exists (C11): a related fact is accepted, an unrelated one is rejected, and a department match is still not treated as verification", () => {
    expect(ok(strict(EXEC, "r", "Review the sales strategy.", ["F-conversion_rate"]))).toBe(true);
    expect(ok(strict(EXEC, "r", "Marketing and sales should communicate.", ["F-leads"]))).toBe(
      true,
    );
    expect(ok(strict(EXEC, "r", "Review the sales strategy.", ["F-revenue"]))).toBe(false);
    expect(diag(strict(EXEC, "r", "Review the sales strategy.", ["F-revenue"]))).toEqual([
      "relevance",
    ]);
  });
});

describe("8-9. unavailable and hidden metrics keep their existing rejections", () => {
  it("a claim on a discoverable metric without data is rejected as before (unavailable)", () => {
    expect(diag(strict(MKT, "i", "Customer acquisition cost rose.", ["F-leads"]))).toEqual([
      "unavailable",
    ]);
  });
  it("a hidden metric is rejected as before (domain)", () => {
    expect(diag(strict(MKT, "i", "Recognized revenue fell.", ["F-leads"]))).toEqual(["domain"]);
  });
  it("a metric without a fact is not a coverage obligation: naming it in a recommendation does not demand a citation", () => {
    expect(
      refsConsistent(
        "Collect customer acquisition cost data.",
        ["F-leads"],
        buildVerifiedFacts(MKT.authorized, CTX),
        CTX.catalog,
      ),
    ).toBe(true);
  });
});

describe("10. ordinary-language false positives (fail closed, documented)", () => {
  it("the verb 'lead' is read as the leads metric: 'Lead the review' citing another fact is rejected", () => {
    expect(diag(strict(EXEC, "r", "Lead the review of the plan.", ["F-conversion_rate"]))).toEqual([
      "relevance",
    ]);
  });
  it("...and passes when the leads fact is cited, so the model can recover", () => {
    expect(ok(strict(EXEC, "r", "Lead the review of the plan.", ["F-leads"]))).toBe(true);
  });
  it("words that are not aliases are not mentions — but an unanchored sentence is now rejected anyway (G4.7)", () => {
    // "leadership" and "conversant" match no catalog alias: with no hook of any kind the citations are arbitrary, so G4.7 rejects them.
    expect(diag(strict(EXEC, "r", "Consider a leadership offsite.", ["F-revenue"]))).toEqual([
      "relevance",
    ]);
    expect(
      diag(strict(EXEC, "r", "The team is conversant with the tooling.", ["F-revenue"])),
    ).toEqual(["relevance"]);
    // positive control: if "lead" matched inside "leadership", citing F-leads would be an exact match and pass; it does not.
    expect(diag(strict(EXEC, "r", "Consider a leadership offsite.", ["F-leads"]))).toEqual([
      "relevance",
    ]);
  });
});

describe("11. wrong direction and 12. fabricated references", () => {
  it("a wrong-direction claim is still rejected by the existing guard", () => {
    expect(diag(strict(EXEC, "i", "Lead volume decreased.", ["F-leads"]))).toEqual(["direction"]);
  });
  it("an unknown or fabricated fact reference is rejected as 'ref' and consistency does not mask or add to it", () => {
    expect(diag(strict(EXEC, "i", "Lead volume increased.", ["F-nonexistent"]))).toEqual(["ref"]);
    expect(diag(strict(EXEC, "i", "Lead volume increased.", ["F-leads", "VH-MKT-001-Q2"]))).toEqual(
      ["ref"],
    );
    expect(diag(strict(MKT, "i", "Lead volume increased.", ["F-revenue"]))).toEqual(["ref"]); // a real fact the caller may not use
  });
});

describe("13-14. both citing lanes are checked, and the missing-evidence lane is unchanged", () => {
  it("interpretations and recommendations are both checked, and the first bad one rejects the whole output", () => {
    const raw = JSON.stringify({
      interpretations: [{ text: "Lead volume increased.", verified: false, refs: ["F-leads"] }],
      missing_evidence: [],
      recommendations: [
        { text: "Review lead volume.", requires_human_approval: true, refs: ["F-revenue"] },
      ],
    });
    const v = validateStrictOutput(
      raw,
      EXEC.authorized,
      EXEC.withheld,
      CTX,
      EXEC.discoverableMetrics,
    );
    expect(v.ok).toBe(false);
    const raw2 = JSON.stringify({
      interpretations: [{ text: "Lead volume increased.", verified: false, refs: ["F-revenue"] }],
      missing_evidence: [],
      recommendations: [
        { text: "Review lead volume.", requires_human_approval: true, refs: ["F-leads"] },
      ],
    });
    expect(
      validateStrictOutput(raw2, EXEC.authorized, EXEC.withheld, CTX, EXEC.discoverableMetrics).ok,
    ).toBe(false);
  });
  it("gap-lane text has no refs, is never subject to coverage, and still follows the existing rules", () => {
    const v = strict(EXEC, "g", "Lead volume by channel would help.", []);
    expect(ok(v)).toBe(true);
    expect(ok(strict(MKT, "g", "Customer acquisition cost data would help.", []))).toBe(true);
    expect(diag(strict(MKT, "g", "Recognized revenue data would help.", []))).toEqual(["domain"]);
  });
});

describe("15. public rejection is byte-identical", () => {
  it("the new category is internal only and the public response is the same fixed bytes", () => {
    expect(DIAGNOSTIC_CATEGORIES).toContain("relevance");
    expect(JSON.stringify(strictRejection())).toBe(
      JSON.stringify({
        state: "rejected",
        reason: "The model output did not pass validation and was not used.",
        requestSent: true,
      }),
    );
    expect(STRICT_REJECTION_REASON).toBe(
      "The model output did not pass validation and was not used.",
    );
    const v = strict(EXEC, "i", "Lead volume increased.", ["F-revenue"]);
    expect(JSON.stringify(v)).not.toMatch(/revenue|leads|F-|VH-|metric/i);
  });
});

describe("16. legacy behavior unchanged", () => {
  it("the legacy validator still accepts a mismatched citation (default profile), and with the same supporting ids as before", () => {
    const v = legacy(EXEC, "i", "Lead volume increased.", ["F-revenue"]);
    expect(v.ok).toBe(true);
    if (v.ok)
      expect(v.output.interpretations[0]!.supporting_ids).toEqual([
        "VH-FIN-001-Q2",
        "VH-FIN-001-Q3",
      ]);
  });
  it("the flag is exactly-true: undefined, false and other values do not enable it", () => {
    const raw = body("i", "Lead volume increased.", ["F-revenue"]);
    for (const flag of [undefined, false, 1, "true", null] as unknown[]) {
      const v = validateOutput(
        raw,
        EXEC.authorized,
        [...EXEC.authorized, ...EXEC.withheld],
        CTX,
        { discoverable: EXEC.discoverableMetrics },
        { refConsistency: flag as boolean },
      );
      expect(v.ok, String(flag)).toBe(true);
    }
    expect(
      validateOutput(
        raw,
        EXEC.authorized,
        [...EXEC.authorized, ...EXEC.withheld],
        CTX,
        { discoverable: EXEC.discoverableMetrics },
        { refConsistency: true },
      ).ok,
    ).toBe(false);
  });
  it("the legacy runtime paths never set the flag", () => {
    const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\/|(?<!:)\/\/[^\n]*/g, " ");
    const walk = (d: string): string[] =>
      readdirSync(d).flatMap((f) =>
        statSync(`${d}/${f}`).isDirectory() ? walk(`${d}/${f}`) : [`${d}/${f}`],
      );
    const setters = walk("src").filter(
      (f) =>
        /\.(ts|tsx)$/.test(f) &&
        !/\.test\./.test(f) &&
        /refConsistency\s*:\s*true/.test(strip(readFileSync(f, "utf8"))),
    );
    expect(setters).toEqual(["src/lib/athena/meta/strictValidation.ts"]);
  });
});

describe("17. client fields cannot enable or disable the rule", () => {
  it("a model-output or request key named refConsistency is a schema violation, not a switch", () => {
    const raw = JSON.stringify({
      interpretations: [
        {
          text: "Lead volume increased.",
          verified: false,
          refs: ["F-revenue"],
          refConsistency: false,
        },
      ],
      missing_evidence: [],
      recommendations: [],
      refConsistency: false,
    });
    const v = validateStrictOutput(
      raw,
      EXEC.authorized,
      EXEC.withheld,
      CTX,
      EXEC.discoverableMetrics,
    );
    expect(v.ok).toBe(false);
    expect(diag(v)).toEqual(["schema"]);
  });
  it("validateStrictOutput has no parameter that turns the rule off", () => {
    expect(validateStrictOutput.length).toBe(5);
    expect(readFileSync("src/lib/athena/meta/strictValidation.ts", "utf8")).toContain(
      "refConsistency: true",
    );
  });
});

describe("18. strict execution stays inactive", () => {
  it("no live module imports the strict runtime or validation; refConsistency is reachable only through validateOutput's profile", () => {
    const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\/|(?<!:)\/\/[^\n]*/g, " ");
    const walk = (d: string): string[] =>
      readdirSync(d).flatMap((f) =>
        statSync(`${d}/${f}`).isDirectory() ? walk(`${d}/${f}`) : [`${d}/${f}`],
      );
    const prod = walk("src").filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\./.test(f));
    const using = (re: RegExp, self: string[]) =>
      prod.filter((f) => !self.includes(f) && re.test(strip(readFileSync(f, "utf8"))));
    expect(
      using(/strictRuntime|runStrictAnalysis/, ["src/lib/athena/meta/strictRuntime.ts"]),
    ).toEqual([]);
    expect(
      using(/strictValidation|validateStrictOutput/, [
        "src/lib/athena/meta/strictValidation.ts",
        "src/lib/athena/meta/strictRuntime.ts",
      ]),
    ).toEqual([]);
    expect(
      using(/refConsistency|refsConsistent/, [
        "src/lib/athena/meta/refConsistency.ts",
        "src/lib/athena/meta/analysis.ts",
        "src/lib/athena/meta/strictValidation.ts",
      ]),
    ).toEqual([]);
  });
  it("makes no network call", () => {
    strict(EXEC, "i", "Lead volume increased.", ["F-leads"]);
    expect(tripwire).not.toHaveBeenCalled();
  });
});
