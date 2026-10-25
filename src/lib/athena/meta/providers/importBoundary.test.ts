import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Provider adapters are transports. They may import only the neutral provider contract and engine limits/schema, and nothing that knows
// about evidence, tenants, identity, the catalog, the prototype or the UI. (A guard rail against mistakes, not a security boundary.)
const DIR = "src/lib/athena/meta/providers";
const ALLOWED = new Set(["../limits", "../outputSchema", "../provider"]);

export function providerViolations(source: string): string[] {
  const out: string[] = [];
  const code = source.replace(/\/\*[\s\S]*?\*\/|(?<!:)\/\/[^\n]*/g, " ");
  const specs = [...code.matchAll(/\bimport\s+(?:type\s+)?(?:[\w*{},\s$]+?\s+from\s+)?["']([^"']+)["']/g), ...code.matchAll(/\bexport\s+(?:type\s+)?(?:\*|\{[^}]*\})\s+from\s+["']([^"']+)["']/g)].map((m) => m[1]!);
  for (const spec of specs) if (!ALLOWED.has(spec)) out.push(`forbidden import "${spec}"`);
  if (/\b(?:import|require)\s*\(/.test(code)) out.push("dynamic import/require");
  if (/\bprocess\b|\bimport\.meta\b|\bBun\b|\bDeno\b/.test(code)) out.push("reads the environment directly");
  if (/(?<![\w.])fetch\s*\(/.test(code)) out.push("calls the global fetch instead of the injected transport");
  for (const w of [/tenant/i, /\bidentity\b/i, /\bauthorize/i, /\bevidence\b/i, /econest/i, /pendia/i]) if (w.test(code)) out.push(`mentions ${w}`);
  return out;
}
const files = () => readdirSync(DIR).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));

describe("provider adapter import boundary", () => {
  it("finds the adapters", () => expect(files()).toEqual(["muse.ts"]));
  it.each(files())("%s depends only on the neutral provider contract", (f) => {
    expect(providerViolations(readFileSync(`${DIR}/${f}`, "utf8"))).toEqual([]);
  });
  it("the neutral contract and engine limits depend on nothing", () => {
    for (const f of ["provider.ts", "limits.ts"]) {
      const code = readFileSync(`src/lib/athena/meta/${f}`, "utf8").replace(/\/\*[\s\S]*?\*\/|(?<!:)\/\/[^\n]*/g, " ");
      expect([...code.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]), f).toEqual([]);
    }
  });
  it.each([
    ['import { PROTOTYPE_CONTEXT } from "../../engine";', "forbidden import"],
    ['import { authorizeEvidence } from "../../core/access";', "forbidden import"],
    ['import { x } from "../contract";', "forbidden import"],
    ['import type { Evidence } from "../../core/evidence";', "forbidden import"],
    ['const k = process.env.META_MODEL_API_KEY;', "environment"],
    ['await fetch("https://x");', "global fetch"],
    ['const m = await import("../../data");', "dynamic import"],
    ["const tenantId = 1;", "mentions"],
    ["function authorize() {}", "mentions"],
  ])("detects: %s", (src, expected) => expect(providerViolations(src).join("|")).toContain(expected));
  it("ignores comments and allows the neutral imports", () => {
    expect(providerViolations('// never reads tenant or evidence\nimport { MAX_OUTPUT_TOKENS } from "../limits";\nimport type { ModelProvider } from "../provider";\n/* fetch( */ export const a = 1;')).toEqual([]);
  });
});
