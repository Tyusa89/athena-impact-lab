import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// MEDIUM-1 (PR #29 review): the pre-existing browser-bundle guard in meta/authorization.test.ts text-scans each client file for forbidden
// module names. That catches a DIRECT import and misses an INDIRECT one through an intermediary module. This file adds the transitive check
// and keeps the text scan in place as defence in depth (neither replaces the other).
//
// `browserClosure` is a pure function over an injected reader, so the same code is exercised against synthetic graphs (the mutation-style
// tests below, which prove it detects direct AND indirect reachability) and against the real repository.
//
// WHAT IT MODELS. A module is reachable from the browser bundle when a client entry imports it, directly or transitively, by
//   * a relative specifier (`./x`, `../x`) or the `@/` alias configured in vite.config.ts / vitest.config.ts (`@` -> `src`);
//   * a static import, a side-effect import (`import "./x"`), or a re-export (`export { a } from "./x"`, `export * from "./x"`);
//   * a literal dynamic import (`import("./x")`).
// `import type` / `export type` statements are skipped: TypeScript erases them, so they ship nothing.
//
// THE ONE MODELLED BOUNDARY. A TanStack `createServerFn` module (`*.functions.ts`) reaches its server code through `await import(...)` INSIDE
// a handler, and the plugin strips handler bodies from the client bundle. Dynamic imports are therefore not followed out of `*.functions.ts`;
// their STATIC imports still are, because those would ship. The files that actually acted as such a boundary are pinned below, so introducing
// a new one is a reviewed change rather than a silent widening.
//
// LIMITS (also recorded in docs/tindara-public-api.md): a computed specifier (`import(someVar)`), a re-export laundered through a bare
// package, and a client entry outside the ENTRY globs below are all invisible to this scan.

type Read = (file: string) => string | null;

const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|(?<!:)\/\/[^\n]*/g, " ");

/** Specifiers a module pulls in. `followDynamic: false` models a server-function boundary. */
export function specifiersOf(source: string, followDynamic: boolean): string[] {
  const code = stripComments(source);
  const out: string[] = [];
  for (const m of code.matchAll(/\bimport\s+(?!type\b)(?:[\w*{},\s$]+?\s+from\s+)?["']([^"']+)["']/g)) out.push(m[1]!);
  for (const m of code.matchAll(/\bexport\s+(?!type\b)(?:\*|\{[\s\S]*?\})\s+from\s+["']([^"']+)["']/g)) out.push(m[1]!);
  if (followDynamic) for (const m of code.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) out.push(m[1]!);
  return out;
}

/** Resolve a specifier the way vite would, using `read` to decide which candidate exists. Bare packages resolve to null (not our concern). */
export function resolveSpecifier(fromFile: string, spec: string, read: Read): string | null {
  const clean = spec.replace(/[?#].*$/, "");
  let base: string;
  if (clean.startsWith("@/")) base = path.posix.join("src", clean.slice(2));
  else if (clean.startsWith(".")) base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), clean));
  else return null;
  for (const c of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) if (read(c) !== null) return c;
  return null;
}

const isServerFnModule = (f: string) => /\.functions\.tsx?$/.test(f);

/** Every module reachable from `entries`, plus the server-function modules whose dynamic imports were deliberately not followed. */
export function browserClosure(entries: readonly string[], read: Read): { closure: string[]; boundaries: string[] } {
  const seen = new Set<string>();
  const boundaries = new Set<string>();
  const queue = [...entries];
  while (queue.length) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    const source = read(file);
    if (source === null) continue;
    seen.add(file);
    const follow = !isServerFnModule(file);
    if (!follow) boundaries.add(file);
    for (const spec of specifiersOf(source, follow)) {
      const next = resolveSpecifier(file, spec, read);
      if (next && !seen.has(next)) queue.push(next);
    }
  }
  return { closure: [...seen].sort(), boundaries: [...boundaries].sort() };
}

/**
 * Modules that must never be reachable from the browser bundle, directly or transitively.
 *
 * NOT on this list, deliberately: `core/access.ts`, `core/identity.ts` and `prototypeAdapter.ts`. Measuring the real graph showed all three
 * are ALREADY reachable from the client on `main`, and legitimately so: `core/facts.ts` (which the in-browser deterministic demo engine uses)
 * imports the value `assertAuthorized` from `core/access`, and `MetaPanel` reaches `prototypeAdapter` through the `meta/contract` facade for
 * the demo's role and scenario lists. All three are pure, dependency-free modules that hold no secret, no credential and no evidence, and the
 * security model never rested on their absence from the client: authorization happens on the server over the server's own evidence. Failing
 * the build on long-standing intended behaviour would be wrong, so that reachability is PINNED instead (see the test below), which means it
 * cannot grow without review. The direct-import guard in meta/authorization.test.ts — no client file may name them or designate an identity
 * adapter — is unchanged and still enforced.
 */
export const FORBIDDEN_IN_BROWSER = [
  { label: "Tindara public entry point", re: /^src\/lib\/tindara\// },
  { label: "server-only module", re: /\.server\.tsx?$/ },
  { label: "strict reasoning path", re: /^src\/lib\/athena\/meta\/(strictRuntime|strictValidation|scopedPrompt)\.tsx?$/ },
  { label: "evidence ledger / importer", re: /^src\/lib\/athena\/core\/ingest\/(ledger|normalize)\.tsx?$/ },
] as const;

/** Pure engine modules that the client bundle already reaches on `main`. Pinned so the set cannot grow unnoticed; see FORBIDDEN_IN_BROWSER for why they are not failures. */
export const PRE_EXISTING_CLIENT_REACHABLE = [
  "src/lib/athena/core/access.ts",
  "src/lib/athena/core/identity.ts",
  "src/lib/athena/prototypeAdapter.ts",
];

export function browserViolations(entries: readonly string[], read: Read): string[] {
  const { closure } = browserClosure(entries, read);
  return closure.flatMap((f) => FORBIDDEN_IN_BROWSER.filter((p) => p.re.test(f)).map((p) => `${f} (${p.label})`)).sort();
}

// ---------------------------------------------------------------------------------------------------- mutation-style tests on synthetic graphs
const fromMap = (files: Record<string, string>): Read => (f) => files[f] ?? null;
const CLEAN = {
  "src/routes/index.tsx": `import { Panel } from "@/components/Panel";\nimport { fmt } from "./helpers";`,
  "src/components/Panel.tsx": `import { label } from "@/lib/view";\nexport const Panel = () => null;`,
  "src/lib/view.ts": `export const label = "x";`,
  "src/routes/helpers.ts": `export const fmt = (n: number) => n;`,
  "src/lib/tindara/index.ts": `export const runImpactAnalysis = 1;`,
};
const ENTRY = ["src/routes/index.tsx"];

describe("the transitive checker detects what the text scan misses", () => {
  it("a clean client graph has no violation (the baseline is not already failing)", () => {
    expect(browserViolations(ENTRY, fromMap(CLEAN))).toEqual([]);
    // and the walk really visited the graph, so the empty result is not an artefact of resolving nothing
    expect(browserClosure(ENTRY, fromMap(CLEAN)).closure).toEqual([
      "src/components/Panel.tsx", "src/lib/view.ts", "src/routes/helpers.ts", "src/routes/index.tsx",
    ]);
  });

  it("MUTATION: a DIRECT import of the entry point into a route is detected", () => {
    const files = { ...CLEAN, "src/routes/index.tsx": `import { runImpactAnalysis } from "@/lib/tindara";\nexport default 1;` };
    expect(browserViolations(ENTRY, fromMap(files))).toEqual(["src/lib/tindara/index.ts (Tindara public entry point)"]);
  });

  it("MUTATION: an INDIRECT import through an intermediary module is detected (the text scan misses this)", () => {
    const files = {
      ...CLEAN,
      "src/lib/view.ts": `export { runImpactAnalysis } from "@/lib/tindara";\nexport const label = "x";`,
    };
    // route -> @/components/Panel -> @/lib/view -> @/lib/tindara : three hops, no client file names "tindara"
    expect(browserViolations(ENTRY, fromMap(files))).toEqual(["src/lib/tindara/index.ts (Tindara public entry point)"]);
    for (const f of ["src/routes/index.tsx", "src/components/Panel.tsx"]) expect(files[f as keyof typeof files]).not.toMatch(/tindara/);
  });

  it("MUTATION: a relative (non-aliased) indirect path is detected", () => {
    const files = { ...CLEAN, "src/routes/helpers.ts": `export * from "../lib/tindara";\nexport const fmt = (n: number) => n;` };
    expect(browserViolations(ENTRY, fromMap(files))).toEqual(["src/lib/tindara/index.ts (Tindara public entry point)"]);
  });

  it("MUTATION: a literal dynamic import in client code is detected", () => {
    const files = { ...CLEAN, "src/lib/view.ts": `export const label = () => import("@/lib/tindara");` };
    expect(browserViolations(ENTRY, fromMap(files))).toEqual(["src/lib/tindara/index.ts (Tindara public entry point)"]);
  });

  it("MUTATION: reaching a server-only module or the strict path is detected", () => {
    const withServer = { ...CLEAN, "src/lib/view.ts": `export * from "@/lib/athena/meta/adapter.server";`, "src/lib/athena/meta/adapter.server.ts": `export const x = 1;` };
    expect(browserViolations(ENTRY, fromMap(withServer))).toEqual(["src/lib/athena/meta/adapter.server.ts (server-only module)"]);
    const withStrict = { ...CLEAN, "src/lib/view.ts": `export * from "@/lib/athena/meta/strictRuntime";`, "src/lib/athena/meta/strictRuntime.ts": `export const runStrictAnalysis = 1;` };
    expect(browserViolations(ENTRY, fromMap(withStrict))).toEqual(["src/lib/athena/meta/strictRuntime.ts (strict reasoning path)"]);
    const withLedger = { ...CLEAN, "src/lib/view.ts": `export * from "@/lib/athena/core/ingest/ledger";`, "src/lib/athena/core/ingest/ledger.ts": `export const createEvidenceLedger = 1;` };
    expect(browserViolations(ENTRY, fromMap(withLedger))).toEqual(["src/lib/athena/core/ingest/ledger.ts (evidence ledger / importer)"]);
  });

  it("a server-function module's DYNAMIC import is a boundary, but its STATIC import is not", () => {
    const viaDynamic = {
      ...CLEAN,
      "src/routes/index.tsx": `import { go } from "@/lib/api.functions";`,
      "src/lib/api.functions.ts": `export const go = async () => (await import("@/lib/tindara")).runImpactAnalysis;`,
    };
    const r = browserClosure(ENTRY, fromMap(viaDynamic));
    expect(browserViolations(ENTRY, fromMap(viaDynamic))).toEqual([]); // stripped from the client bundle
    expect(r.boundaries).toEqual(["src/lib/api.functions.ts"]); // ...and the stop was recorded, not silent
    // the same module reaching it STATICALLY does ship, and is caught
    const viaStatic = { ...viaDynamic, "src/lib/api.functions.ts": `import { runImpactAnalysis } from "@/lib/tindara";\nexport const go = () => runImpactAnalysis;` };
    expect(browserViolations(ENTRY, fromMap(viaStatic))).toEqual(["src/lib/tindara/index.ts (Tindara public entry point)"]);
  });

  it("`import type` is skipped (TypeScript erases it) while a value import of the same module is not", () => {
    const typeOnly = { ...CLEAN, "src/lib/view.ts": `import type { EngineRuntime } from "@/lib/tindara";\nexport const label = "x";` };
    expect(browserViolations(ENTRY, fromMap(typeOnly))).toEqual([]);
    const valueImport = { ...CLEAN, "src/lib/view.ts": `import { runImpactAnalysis } from "@/lib/tindara";\nexport const label = "x";` };
    expect(browserViolations(ENTRY, fromMap(valueImport))).toEqual(["src/lib/tindara/index.ts (Tindara public entry point)"]);
  });
});

// ---------------------------------------------------------------------------------------------------- the real repository
const walk = (d: string): string[] => (existsSync(d) ? readdirSync(d).flatMap((f) => (statSync(`${d}/${f}`).isDirectory() ? walk(`${d}/${f}`) : [`${d}/${f}`])) : []);
const realRead: Read = (f) => (existsSync(f) && statSync(f).isFile() ? readFileSync(f, "utf8") : null);
/** Browser entry points: the client router, the generated route tree, and every route and component (components are included even if the
 * route tree does not reach them yet, so an unwired client module cannot hide a violation). Test files are excluded. */
const CLIENT_ENTRIES = [
  "src/router.tsx",
  "src/routeTree.gen.ts",
  ...[...walk("src/routes"), ...walk("src/components")].filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\./.test(f)),
];

describe("the real browser bundle does not reach the engine's server-only modules", () => {
  it("found the client entry points", () => {
    expect(CLIENT_ENTRIES).toContain("src/router.tsx");
    expect(CLIENT_ENTRIES.filter((f) => f.startsWith("src/routes/")).length).toBeGreaterThan(2);
    expect(CLIENT_ENTRIES.filter((f) => f.startsWith("src/components/")).length).toBeGreaterThan(5);
    for (const f of CLIENT_ENTRIES) expect(realRead(f), f).not.toBeNull();
  });

  it("reaches no forbidden module, directly or transitively", () => {
    expect(browserViolations(CLIENT_ENTRIES, realRead)).toEqual([]);
  });

  it("the walk actually traversed the app (so the empty result is not vacuous)", () => {
    const { closure } = browserClosure(CLIENT_ENTRIES, realRead);
    expect(closure.length).toBeGreaterThan(20);
    for (const f of ["src/routes/__root.tsx", "src/routes/index.tsx", "src/routes/impact.tsx", "src/components/MetaPanel.tsx"])
      expect(closure, f).toContain(f);
    // it followed the `@/` alias and crossed from routes into lib
    expect(closure.some((f) => f.startsWith("src/lib/"))).toBe(true);
  });

  it("the only server-function boundaries are the two known ones", () => {
    expect(browserClosure(CLIENT_ENTRIES, realRead).boundaries).toEqual([
      "src/lib/athena/meta.functions.ts",
      "src/lib/athena/workbench/workbench.functions.ts",
    ]);
  });

  it("the pre-existing client-reachable pure modules are exactly the pinned set (it cannot grow unnoticed)", () => {
    const { closure } = browserClosure(CLIENT_ENTRIES, realRead);
    const reachable = PRE_EXISTING_CLIENT_REACHABLE.filter((f) => closure.includes(f));
    // every pinned module really is reachable (so the pin describes reality, not an aspiration)...
    expect(reachable).toEqual(PRE_EXISTING_CLIENT_REACHABLE);
    // ...and no OTHER core or prototype module joined them
    const others = closure.filter((f) => /^src\/lib\/athena\/(core\/[^/]+|prototype[^/]*)\.tsx?$/.test(f) && !PRE_EXISTING_CLIENT_REACHABLE.includes(f));
    // `core/evidence.ts` is absent because it is types-only and every importer uses `import type`, which TypeScript erases.
    expect(others).toEqual(["src/lib/athena/core/catalog.ts", "src/lib/athena/core/facts.ts", "src/lib/athena/prototypeCatalog.ts"]);
  });

  it("MUTATION on the real graph: injecting an indirect import into a real client module is detected", () => {
    // `src/lib/athena/approvals.ts` is real client-safe code reached from the UI; laundering the entry point through it must be caught.
    const injected: Read = (f) =>
      f === "src/lib/athena/approvals.ts" ? `export * from "./tindaraProbe";\n${readFileSync(f, "utf8")}` : f === "src/lib/athena/tindaraProbe.ts" ? `export * from "../tindara";` : realRead(f);
    const { closure } = browserClosure(CLIENT_ENTRIES, injected);
    expect(closure, "approvals.ts must really be reachable for this mutation to be meaningful").toContain("src/lib/athena/approvals.ts");
    expect(browserViolations(CLIENT_ENTRIES, injected)).toContain("src/lib/tindara/index.ts (Tindara public entry point)");
    // the unmutated graph is clean, so the detection above is caused by the injection and not by the baseline
    expect(browserViolations(CLIENT_ENTRIES, realRead)).toEqual([]);
  });
});
