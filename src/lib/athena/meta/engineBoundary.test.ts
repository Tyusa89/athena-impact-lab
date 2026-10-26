import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The generic engine modules must not depend on the prototype, a concrete provider, or the facades that default to either.
// (A guard rail against mistakes in review, not a security boundary.)
const NEUTRAL = ["impact", "analysis", "grounding", "render", "semantic", "runtime", "question", "provider", "providerBoundary", "limits", "outputSchema", "textSafety"];
const ALLOWED = /^(zod|\.\/(impact|analysis|grounding|render|semantic|runtime|question|provider|providerBoundary|limits|outputSchema|textSafety)|\.\.\/core\/(access|catalog|evidence|facts|identity))$/;

export function engineViolations(source: string): string[] {
  const out: string[] = [];
  const code = source.replace(/\/\*[\s\S]*?\*\/|(?<!:)\/\/[^\n]*/g, " ");
  const specs = [...code.matchAll(/\bimport\s+(?:type\s+)?(?:[\w*{},\s$]+?\s+from\s+)?["']([^"']+)["']/g), ...code.matchAll(/\bexport\s+(?:type\s+)?(?:\*|\{[^}]*\})\s+from\s+["']([^"']+)["']/g)].map((m) => m[1]!);
  for (const spec of specs) if (!ALLOWED.test(spec)) out.push(`forbidden import "${spec}"`);
  if (/\b(?:import|require)\s*\(/.test(code)) out.push("dynamic import/require");
  for (const id of ["DEMO_QUESTION", "PROTOTYPE_CATALOG", "PROTOTYPE_CONTEXT", "PROTOTYPE_RUNTIME", "SCENARIOS", "ROLES", "WORKSPACES", "DEMO_TENANT_ID", "museSpark", "Verdant", "ws-finance"]) if (new RegExp(`\\b${id}\\b`).test(code)) out.push(`mentions ${id}`);
  return out;
}

describe("the generic engine does not depend on the prototype or on a concrete provider", () => {
  it.each(NEUTRAL)("%s.ts", (f) => {
    expect(engineViolations(readFileSync(`src/lib/athena/meta/${f}.ts`, "utf8"))).toEqual([]);
  });
  it("the prototype facades are the only modules that default to the prototype", () => {
    for (const f of ["contract", "numericGrounding", "findings", "semanticGuards", "adapter.server"]) {
      const src = readFileSync(`src/lib/athena/meta/${f}.ts`, "utf8");
      expect(/PROTOTYPE_(CONTEXT|CATALOG|RUNTIME)|prototypeAdapter|\.\.\/engine/.test(src), f).toBe(true);
    }
  });
  it("the neutral runtime requires its context: no function in the generic modules has a prototype default", () => {
    for (const f of NEUTRAL) expect(readFileSync(`src/lib/athena/meta/${f}.ts`, "utf8"), f).not.toMatch(/= PROTOTYPE_/);
  });
  it.each([
    ['import { PROTOTYPE_CONTEXT } from "../engine";', "forbidden import"],
    ['import { SCENARIOS } from "../data";', "forbidden import"],
    ['import { x } from "../prototypeAdapter";', "forbidden import"],
    ['import { x } from "../prototypeCatalog";', "forbidden import"],
    ['import { museSpark } from "./providers/muse";', "forbidden import"],
    ['import { x } from "./contract";', "forbidden import"],
    ['import { x } from "./numericGrounding";', "forbidden import"],
    ['import { x } from "./adapter.server";', "forbidden import"],
    ["const q = DEMO_QUESTION;", "mentions DEMO_QUESTION"],
    ["const c = PROTOTYPE_CATALOG;", "mentions PROTOTYPE_CATALOG"],
    ['const m = await import("../engine");', "dynamic import"],
  ])("detects: %s", (src, expected) => expect(engineViolations(src).join("|")).toContain(expected));
  it("allows the neutral imports", () => {
    expect(engineViolations('import { z } from "zod";\nimport type { Evidence } from "../core/evidence";\nimport { limits } from "./limits";\n// never imports ../engine\nexport const a = 1;')).toEqual([]);
  });
});
