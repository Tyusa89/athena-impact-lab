import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The reusable core must stay free of Athena, EcoNest, UI, data-source and model-transport dependencies.
// Rule: a non-test core module may import only sibling core modules ("./x"), never a package, an alias or a parent directory,
// and must not touch network, environment, DOM or dynamic-loading globals.
const CORE_DIR = "src/lib/athena/core";

export function boundaryViolations(source: string): string[] {
  const out: string[] = [];
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const specs = [
    ...code.matchAll(/\bimport\s+(?:type\s+)?(?:[\w*{},\s$]+?\s+from\s+)?["']([^"']+)["']/g),
    ...code.matchAll(/\bexport\s+(?:type\s+)?(?:\*|\{[^}]*\})\s+from\s+["']([^"']+)["']/g),
  ].map((m) => m[1]!);
  for (const spec of specs) if (!/^\.\/[A-Za-z0-9_-]+$/.test(spec)) out.push(`forbidden import "${spec}"`);
  if (/\b(?:import|require)\s*\(/.test(code)) out.push("dynamic import/require");
  if (/\bimport\.meta\b/.test(code)) out.push("import.meta");
  for (const g of ["fetch", "process", "window", "document", "localStorage", "XMLHttpRequest", "WebSocket", "Bun", "Deno"]) if (new RegExp(`(?<![\\w.])${g}\\b(?!:)`).test(code)) out.push(`global ${g}`);
  for (const w of [/econest/i, /pendia/i, /muse/i, /\bmeta\.ai\b/i, /\bathena\b/i, /\bapi[_ ]?key\b/i]) if (w.test(code)) out.push(`mentions ${w}`);
  return out;
}

const coreFiles = () => readdirSync(CORE_DIR).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));

describe("core import boundary", () => {
  it("finds the core modules", () => {
    expect(coreFiles().sort()).toEqual(["access.ts", "catalog.ts", "evidence.ts", "facts.ts", "fixtures.ts", "identity.ts"]);
  });
  it.each(coreFiles())("%s depends on nothing outside the core", (f) => {
    expect(boundaryViolations(readFileSync(`${CORE_DIR}/${f}`, "utf8"))).toEqual([]);
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
