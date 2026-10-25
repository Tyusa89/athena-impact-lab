import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The reusable core must stay free of Athena, EcoNest, UI, data-source and model-transport dependencies.
// Rule: a non-test core module may import only sibling core modules ("./x"), never a package, an alias or a parent directory,
// and must not touch network, environment, DOM or dynamic-loading globals.
const CORE_DIR = "src/lib/athena/core";

export function boundaryViolations(source: string, options: { parent?: boolean } = {}): string[] {
  const out: string[] = [];
  const code = source.replace(/\/\*[\s\S]*?\*\/|(?<!:)\/\/[^\n]*/g, " ");
  const specs = [
    ...code.matchAll(/\bimport\s+(?:type\s+)?(?:[\w*{},\s$]+?\s+from\s+)?["']([^"']+)["']/g),
    ...code.matchAll(/\bexport\s+(?:type\s+)?(?:\*|\{[^}]*\})\s+from\s+["']([^"']+)["']/g),
  ].map((m) => m[1]!);
  // siblings only; modules one directory down (core/ingest) may also import their parent core modules by name, and nothing else
  const allowed = options.parent ? /^\.\/[A-Za-z0-9_-]+$|^\.\.\/(access|catalog|evidence|facts|identity)$/ : /^\.\/[A-Za-z0-9_-]+$/;
  for (const spec of specs) if (!allowed.test(spec)) out.push(`forbidden import "${spec}"`);
  if (/\b(?:import|require)\s*\(/.test(code)) out.push("dynamic import/require");
  if (/\bimport\.meta\b/.test(code)) out.push("import.meta");
  for (const g of ["fetch", "process", "window", "document", "localStorage", "XMLHttpRequest", "WebSocket", "Bun", "Deno"]) if (new RegExp(`(?<![\\w.])${g}\\b(?!:)`).test(code)) out.push(`global ${g}`);
  for (const w of [/econest/i, /pendia/i, /muse/i, /\bmeta\.ai\b/i, /\bathena\b/i, /\bapi[_ ]?key\b/i]) if (w.test(code)) out.push(`mentions ${w}`);
  return out;
}

const INGEST_DIR = `${CORE_DIR}/ingest`;
const ingestFiles = () => readdirSync(INGEST_DIR).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
const coreFiles = () => readdirSync(CORE_DIR).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));

describe("core import boundary", () => {
  it("finds the core modules", () => {
    expect(coreFiles().sort()).toEqual(["access.ts", "catalog.ts", "evidence.ts", "facts.ts", "fixtures.ts", "identity.ts"]);
  });
  it.each(coreFiles())("%s depends on nothing outside the core", (f) => {
    expect(boundaryViolations(readFileSync(`${CORE_DIR}/${f}`, "utf8"))).toEqual([]);
  });

  it("finds the ingestion modules", () => {
    expect(ingestFiles().sort()).toEqual(["csv.ts", "fixtures.ts", "index.ts", "ledger.ts", "normalize.ts", "sha256.ts", "testSupport.ts", "types.ts"]);
  });
  it.each(ingestFiles())("ingest/%s depends only on core modules (no packages, no engine, no models, no I/O)", (f) => {
    expect(boundaryViolations(readFileSync(`${INGEST_DIR}/${f}`, "utf8"), { parent: true })).toEqual([]);
  });
  it("the ingestion modules never import the intelligence engine, a provider or the prototype (checked by resolved path)", () => {
    for (const f of ingestFiles()) {
      const specs = [...readFileSync(`${INGEST_DIR}/${f}`, "utf8").matchAll(/from\s+["'](\.[^"']+)["']/g)].map((m) => m[1]!);
      for (const spec of specs) expect(spec, `${f} -> ${spec}`).toMatch(/^\.\/(csv|ledger|normalize|sha256|types|fixtures|testSupport|index)$|^\.\.\/(access|catalog|evidence|facts|identity)$/);
    }
  });
  it("a parent import outside the core is still caught", () => {
    expect(boundaryViolations('import { x } from "../../engine";', { parent: true }).join()).toContain("forbidden import");
    expect(boundaryViolations('import { x } from "../../meta/contract";', { parent: true }).join()).toContain("forbidden import");
    expect(boundaryViolations('import { x } from "../engine";').join()).toContain("forbidden import"); // not allowed at the top level
    expect(boundaryViolations('import { x } from "../engine";', { parent: true }).join()).toContain("forbidden import"); // not a core module
    expect(boundaryViolations('import { x } from "../meta";', { parent: true }).join()).toContain("forbidden import");
    expect(boundaryViolations('import { x } from "../catalog";', { parent: true })).toEqual([]);
  });

  // the checker itself must catch each kind of violation (otherwise the test above proves nothing)
  it.each([
    ['import { PERIODS } from "../data";', "forbidden import"],
    ['import { computeFacts } from "../engine";', "forbidden import"],
    ['import { x } from "./meta/contract";', "forbidden import"],
    ['import { z } from "zod";', "forbidden import"],
    ['import type { T } from "@/lib/athena/data";', "forbidden import"],
    ['import React from "react";', "forbidden import"],
    ['import "../prototypeCatalog";', "forbidden import"],
    ['export * from "../data";', "forbidden import"],
    ['export { a } from "../engine";', "forbidden import"],
    ['const m = await import("../data");', "dynamic import"],
    ['const m = require("fs");', "dynamic import"],
    ['await fetch("https://api.meta.ai/v1/chat/completions");', "global fetch"],
    ["const k = process.env.META_MODEL_API_KEY;", "global process"],
    ["document.title = 'x';", "global document"],
    ["// not a comment-only line\nconst muse = 1;", "mentions"],
    ["const athena = 1;", "mentions"],
  ])("detects: %s", (src, expected) => {
    expect(boundaryViolations(src).join("|")).toContain(expected);
  });
  it("ignores mentions that appear only in comments and allows sibling imports", () => {
    expect(boundaryViolations('// never imports ../data or Athena\nimport { a } from "./catalog";\nimport type { b } from "./facts";\n/* fetch(muse) */ export const c = 1;')).toEqual([]);
  });
});
