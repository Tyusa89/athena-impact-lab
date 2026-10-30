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
// TWO LAYERS. This file holds both, because they establish different properties:
//   * STATIC reachability (always runs): over-approximates, because it cannot know what the bundler will eliminate. Good for a strict rule.
//   * BUNDLE emission (runs when `vite build --sourcemap` artifacts exist): ground truth after tree shaking, read from sourcemap `sources`.
// A module can be statically reachable and still not shipped; only the second layer can tell. Both are asserted below.
//
// LIMITS (also recorded in docs/tindara-public-api.md, and pinned as tests further down): a computed specifier (`import(someVar)`), a
// re-export laundered through a bare package, an alias other than `@/`, and a client entry outside the ENTRY globs below are all invisible to
// the static scan.

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
 * Modules that must never be STATICALLY REACHABLE from the browser bundle, directly or transitively. This is the strict rule and it currently
 * holds with no exemptions: none of these is reachable at all, so nothing here is grandfathered.
 *
 * `core/access.ts`, `core/identity.ts` and `prototypeAdapter.ts` are deliberately NOT on this list. They are statically reachable (through
 * `core/facts.ts`'s value import of `assertAuthorized`, and through the `meta/contract` facade) but the bundler eliminates them, which was
 * MEASURED rather than assumed: see STATICALLY_REACHABLE_NOT_EMITTED and the bundle-level section, which assert they are absent from the
 * emitted chunks. They are also not server-only — all three are pure, dependency-free modules holding no secret, credential or evidence, and
 * the security model never rested on their absence from the client, since authorization happens on the server over the server's own evidence.
 * Promoting them to this list would therefore fail the build on a module that is provably not shipped, which would be a false alarm; the
 * honest split is a strict rule for server-only modules here, plus a pinned, measured baseline for the rest.
 *
 * The direct-import guard in meta/authorization.test.ts — no client file may name them or designate an identity adapter — is unchanged.
 */
export const FORBIDDEN_IN_BROWSER = [
  { label: "Tindara public entry point", re: /^src\/lib\/tindara\// },
  { label: "server-only module", re: /\.server\.tsx?$/ },
  { label: "strict reasoning path", re: /^src\/lib\/athena\/meta\/(strictRuntime|strictValidation|scopedPrompt)\.tsx?$/ },
  { label: "evidence ledger / importer", re: /^src\/lib\/athena\/core\/ingest\/(ledger|normalize)\.tsx?$/ },
] as const;

/**
 * Modules this STATIC scan reaches but that the bundler then ELIMINATES, so they are not emitted into any client asset.
 *
 * Measured, not assumed: `vite build --sourcemap` was run and the `sources` arrays of the four emitted client chunks were read. None of these
 * three appears there, nor does `meta/contract.ts`. `core/facts.ts` imports the value `assertAuthorized` from `core/access`, and `MetaPanel`
 * reaches `prototypeAdapter` through the `meta/contract` facade, but neither symbol is used on a retained path, so rollup drops them.
 *
 * This list is therefore NOT an exemption from the forbidden-module policy: those modules are not server-only, and the property that actually
 * matters (nothing privileged is emitted) is asserted against the build output in the bundle-level section below. This list exists so that the
 * gap between static reachability and emission stays small and reviewed: if a module joins it, someone must look at why.
 */
export const STATICALLY_REACHABLE_NOT_EMITTED = [
  "src/lib/athena/core/access.ts",
  "src/lib/athena/core/identity.ts",
  "src/lib/athena/prototypeAdapter.ts",
];

// ---------------------------------------------------------------------------------------------------- bundle-level ground truth (after tree shaking)
/** Source modules that actually reached a client chunk, read from the emitted sourcemaps. This is ground truth AFTER tree shaking, unlike the static scan above. */
export function emittedClientModules(mapFiles: readonly string[], read: Read): string[] {
  const out = new Set<string>();
  for (const f of mapFiles) {
    const raw = read(f);
    if (raw === null) continue;
    let sources: unknown;
    try {
      sources = (JSON.parse(raw) as { sources?: unknown }).sources;
    } catch {
      continue;
    }
    if (!Array.isArray(sources)) continue;
    for (const s of sources) {
      if (typeof s !== "string") continue;
      const m = /(?:^|\/)(src\/.*)$/.exec(s.split(/[?#]/)[0]!);
      if (m) out.add(m[1]!);
    }
  }
  return [...out].sort();
}

/**
 * Strings that must never appear in a client asset. Each is a literal from a module that must stay on the server.
 * NOT included, deliberately: "META_MODEL_API_KEY" and "META_MODEL_ENABLED". Those env-var NAMES are legitimately present as MetaPanel's
 * status labels ("Server key META_MODEL_API_KEY configured"). The name is not the value; `process.env` is on this list, which is what proves
 * no client code reads an environment at all.
 */
export const FORBIDDEN_CLIENT_MARKERS = [
  "process.env",
  "Authorization failed",
  "AuthorizationError",
  "simulated-demo-role-claim",
  "demo-role:",
  "SERVER_ROLE_WORKSPACES",
  "did not pass validation",
  "UNAVAILABLE_METRICS",
  "VERIFIED_FACTS",
  "already_imported",
  "conflicts_with_existing",
  "Scenario not in synthetic allowlist",
  "authorizeEvidence",
  "createIdentityBoundary",
  "runStrictAnalysis",
  "validateStrictOutput",
];

export function markersFound(jsFiles: readonly string[], read: Read, markers: readonly string[] = FORBIDDEN_CLIENT_MARKERS): string[] {
  const hits = new Set<string>();
  for (const f of jsFiles) {
    const src = read(f);
    if (src === null) continue;
    for (const m of markers) if (src.includes(m)) hits.add(m);
  }
  return [...hits].sort();
}

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

  it("the statically-reachable-but-not-emitted set is exactly the pinned one (it cannot grow unnoticed)", () => {
    const { closure } = browserClosure(CLIENT_ENTRIES, realRead);
    const reachable = STATICALLY_REACHABLE_NOT_EMITTED.filter((f) => closure.includes(f));
    // every pinned module really is statically reachable (so the pin describes reality, not an aspiration)...
    expect(reachable).toEqual(STATICALLY_REACHABLE_NOT_EMITTED);
    // ...and no OTHER core or prototype module joined them
    const others = closure.filter((f) => /^src\/lib\/athena\/(core\/[^/]+|prototype[^/]*)\.tsx?$/.test(f) && !STATICALLY_REACHABLE_NOT_EMITTED.includes(f));
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

// ---------------------------------------------------------------------------------------------------- limitations of the static checker, pinned as tests
// These document blind spots so they are visible in the suite rather than only in prose. Each asserts the CURRENT (unsafe) behaviour, so if a
// future change closes a gap the test fails and the limitation note gets removed deliberately.
describe("known limitations of the static scan (pinned so they stay visible)", () => {
  it("a COMPUTED dynamic specifier is not followed", () => {
    const files = {
      "src/routes/index.tsx": "const where = \"@/lib/tindara\";\nexport const load = () => import(where);",
      "src/lib/tindara/index.ts": "export const runImpactAnalysis = 1;",
    };
    expect(browserViolations(["src/routes/index.tsx"], fromMap(files))).toEqual([]); // LIMITATION, not a guarantee
  });
  it("a re-export laundered through a BARE PACKAGE specifier is not followed", () => {
    const files = {
      "src/routes/index.tsx": 'export * from "some-pkg";',
      "src/lib/tindara/index.ts": "export const runImpactAnalysis = 1;",
    };
    expect(browserViolations(["src/routes/index.tsx"], fromMap(files))).toEqual([]); // LIMITATION
  });
  it("a client entry outside the walked globs is not covered", () => {
    const files = {
      "src/widgets/Rogue.tsx": 'export * from "@/lib/tindara";',
      "src/lib/tindara/index.ts": "export const runImpactAnalysis = 1;",
    };
    expect(browserViolations(["src/routes/index.tsx"], fromMap(files))).toEqual([]); // not an entry => invisible
    expect(browserViolations(["src/widgets/Rogue.tsx"], fromMap(files))).toEqual(["src/lib/tindara/index.ts (Tindara public entry point)"]);
  });
  it("an alias other than `@/` is not resolved", () => {
    const files = { "src/routes/index.tsx": 'export * from "~/lib/tindara";', "src/lib/tindara/index.ts": "export const x = 1;" };
    expect(browserViolations(["src/routes/index.tsx"], fromMap(files))).toEqual([]); // LIMITATION
  });
});

// ---------------------------------------------------------------------------------------------------- bundle-level checks (ground truth after tree shaking)
describe("the bundle-level checker works (synthetic, always runs)", () => {
  it("reads emitted modules out of sourcemap `sources`, normalizing relative prefixes and query suffixes", () => {
    const maps = {
      "out/a.js.map": JSON.stringify({ sources: ["../../src/lib/athena/engine.ts", "../../src/routes/index.tsx?tsr-split=component", "../../node_modules/react/index.js"] }),
      "out/b.js.map": JSON.stringify({ sources: ["../src/lib/athena/data.ts"] }),
      "out/bad.js.map": "not json",
    };
    expect(emittedClientModules(Object.keys(maps), fromMap(maps))).toEqual([
      "src/lib/athena/data.ts", "src/lib/athena/engine.ts", "src/routes/index.tsx",
    ]);
  });
  it("finds forbidden markers and ignores the permitted env-var NAMES", () => {
    const js = { "out/a.js": 'const x = "Authorization failed"; const y = process.env.FOO;', "out/b.js": 'label("Server key META_MODEL_API_KEY configured")' };
    expect(markersFound(Object.keys(js), fromMap(js))).toEqual(["Authorization failed", "process.env"]);
    // the env NAME alone is not a marker, which is why the key label in MetaPanel does not trip it
    expect(markersFound(["out/b.js"], fromMap(js))).toEqual([]);
  });
});

const BUILD_DIR = ".output/public";
const builtJs = () => walk(BUILD_DIR).filter((f) => f.endsWith(".js"));
const builtMaps = () => walk(BUILD_DIR).filter((f) => f.endsWith(".js.map"));

/**
 * When is bundle verification EXPECTED? Whenever a build exists (`.output/public` present), or when CI forces it with
 * `TINDARA_VERIFY_BUNDLE=1`. Once expected, it FAILS CLOSED: absent, unreadable, malformed or STALE artifacts are failures, never skips.
 * `bun run verify:bundle` (vite build --sourcemap && this file) is the one command that guarantees a fresh build plus verification.
 * With no build and no flag the section is skipped — but `assertFreshArtifacts` itself is unit-tested below, so the fail-closed behaviour is
 * regression-covered either way.
 */
const verificationExpected = () => process.env["TINDARA_VERIFY_BUNDLE"] === "1" || existsSync(BUILD_DIR);

/** Fail closed. Returns the sourcemap paths; throws a directive message otherwise. `newestSource` lets the caller inject a clock for testing. */
export function assertFreshArtifacts(maps: readonly string[], js: readonly string[], read: Read, mtime: (f: string) => number, newestSource: number): string[] {
  if (js.length === 0) throw new Error("Bundle verification expected but no client JS was emitted; run `vite build --sourcemap`.");
  if (maps.length === 0) throw new Error("Bundle verification expected but no sourcemaps were emitted; run `vite build --sourcemap` (not a plain build).");
  for (const f of maps) {
    const raw = read(f);
    if (raw === null) throw new Error(`Sourcemap unreadable: ${f}`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`Sourcemap malformed (not JSON): ${f}`);
    }
    const sources = (parsed as { sources?: unknown }).sources;
    if (!Array.isArray(sources) || sources.length === 0 || !sources.every((s) => typeof s === "string"))
      throw new Error(`Sourcemap malformed (no usable "sources" array): ${f}`);
  }
  const oldestArtifact = Math.min(...[...maps, ...js].map(mtime));
  if (newestSource > oldestArtifact) throw new Error("Build artifacts are STALE (a source file is newer); re-run `vite build --sourcemap`.");
  return [...maps];
}

/** Newest mtime among the sources that actually affect the bundle. Generated and test files are excluded: the router plugin rewrites
 * routeTree.gen.ts during the build (so it is always newer than the artifacts), and tests are never bundled. */
function newestSourceMtime(): number {
  const files = walk("src").filter((f) => /\.(ts|tsx|css)$/.test(f) && !/\.test\.|routeTree\.gen\.ts$/.test(f));
  return Math.max(...files.map((f) => statSync(f).mtimeMs));
}

describe("the fail-closed artifact check behaves correctly (synthetic, always runs)", () => {
  const ok = JSON.stringify({ sources: ["../../src/lib/athena/engine.ts"] });
  const at = (t: number) => () => t;
  it("accepts a fresh, well-formed set", () => {
    expect(assertFreshArtifacts(["m.js.map"], ["a.js"], fromMap({ "m.js.map": ok }), at(100), 50)).toEqual(["m.js.map"]);
  });
  it("fails when no JS, or no sourcemap, was emitted", () => {
    expect(() => assertFreshArtifacts([], [], fromMap({}), at(100), 50)).toThrow(/no client JS/);
    expect(() => assertFreshArtifacts([], ["a.js"], fromMap({}), at(100), 50)).toThrow(/no sourcemaps/);
  });
  it("fails when a sourcemap is unreadable", () => {
    expect(() => assertFreshArtifacts(["m.js.map"], ["a.js"], () => null, at(100), 50)).toThrow(/unreadable/);
  });
  it("fails when a sourcemap is malformed", () => {
    expect(() => assertFreshArtifacts(["m.js.map"], ["a.js"], fromMap({ "m.js.map": "not json" }), at(100), 50)).toThrow(/malformed \(not JSON\)/);
    for (const bad of ['{"sources":[]}', '{"sources":"x"}', "{}", '{"sources":[1,2]}'])
      expect(() => assertFreshArtifacts(["m.js.map"], ["a.js"], fromMap({ "m.js.map": bad }), at(100), 50), bad).toThrow(/no usable "sources"/);
  });
  it("fails when the artifacts are STALE relative to sources", () => {
    expect(() => assertFreshArtifacts(["m.js.map"], ["a.js"], fromMap({ "m.js.map": ok }), at(100), 101)).toThrow(/STALE/);
    // equal timestamps are not stale (a source written in the same millisecond as the build)
    expect(() => assertFreshArtifacts(["m.js.map"], ["a.js"], fromMap({ "m.js.map": ok }), at(100), 100)).not.toThrow();
  });
});

// Fail-closed: when a build exists (or CI sets TINDARA_VERIFY_BUNDLE=1) every check below must pass; nothing here is skipped silently.
describe.skipIf(!verificationExpected())("the emitted client bundle contains nothing privileged", () => {
  it("the artifacts are present, readable, well-formed and FRESH (fails closed otherwise)", () => {
    expect(() => assertFreshArtifacts(builtMaps(), builtJs(), realRead, (f) => statSync(f).mtimeMs, newestSourceMtime())).not.toThrow();
  });

  it("found real build artifacts to inspect (not vacuous)", () => {
    expect(builtMaps().length).toBeGreaterThan(0);
    const emitted = emittedClientModules(builtMaps(), realRead);
    // modules that genuinely belong in the browser ARE there, so an empty/misparsed result cannot pass the checks below
    for (const f of ["src/lib/athena/engine.ts", "src/lib/athena/data.ts", "src/routes/index.tsx"]) expect(emitted, f).toContain(f);
  });

  it("emits no forbidden module (public entry point, server-only, strict path, ledger/importer)", () => {
    const emitted = emittedClientModules(builtMaps(), realRead);
    expect(emitted.flatMap((f) => FORBIDDEN_IN_BROWSER.filter((p) => p.re.test(f)).map((p) => `${f} (${p.label})`))).toEqual([]);
  });

  it("tree shaking really does eliminate the statically-reachable modules: none is emitted", () => {
    const emitted = emittedClientModules(builtMaps(), realRead);
    for (const f of STATICALLY_REACHABLE_NOT_EMITTED) expect(emitted, f).not.toContain(f);
    expect(emitted).not.toContain("src/lib/athena/meta/contract.ts");
  });

  it("emits no secret, no identity-verifier implementation and no server-only behaviour", () => {
    expect(markersFound(builtJs(), realRead)).toEqual([]);
  });

  /** MetaPanel imports the single string constant META_MODEL from the `meta/contract` facade, and that facade re-exports the WHOLE validator
   * (`export * from "./analysis"`), the demo role allowlist and `RequestSchema`. Nothing of that is emitted: only `providers/muse.ts`, the
   * constant's actual origin, survives. So the convenience import introduces no secret, no privileged logic and no extra dependency — but it
   * is tree shaking, not module structure, that achieves it (recorded as a limitation; importing from `./providers/muse` directly would
   * remove the reliance). */
  it("the meta/contract facade contributes no validator, no demo allowlist and no extra dependency", () => {
    const emitted = emittedClientModules(builtMaps(), realRead);
    for (const f of ["src/lib/athena/meta/contract.ts", "src/lib/athena/meta/analysis.ts", "src/lib/athena/meta/semantic.ts",
      "src/lib/athena/meta/grounding.ts", "src/lib/athena/meta/refConsistency.ts", "src/lib/athena/meta/causalPolicy.ts",
      "src/lib/athena/meta/semanticGuards.ts", "src/lib/athena/meta/textSafety.ts"])
      expect(emitted, f).not.toContain(f);
    // the only meta modules in the browser are the request gate and the provider adapter that owns META_MODEL
    expect(emitted.filter((f) => f.startsWith("src/lib/athena/meta/"))).toEqual([
      "src/lib/athena/meta/providers/muse.ts", "src/lib/athena/meta/requestGate.ts",
    ]);
    // validator and schema internals, and zod (reachable via RequestSchema), are absent
    expect(markersFound(builtJs(), realRead, ["Semantic guard", "refsConsistent", "requires_human_approval", "ZodError", "safeParse", "META_ENDPOINT"])).toEqual([]);
    // zod is reachable through `RequestSchema` but is not a bundled MODULE. (Checked on the sourcemaps' `sources` paths: a loose text match
    // would false-positive on `sourcesContent`, where an unrelated @tanstack/router-core file happens to mention zod.)
    const bundledPaths = builtMaps().flatMap((f) => {
      try {
        const s = (JSON.parse(realRead(f) ?? "") as { sources?: unknown }).sources;
        return Array.isArray(s) ? s.filter((x): x is string => typeof x === "string") : [];
      } catch {
        return [];
      }
    });
    expect(bundledPaths.length).toBeGreaterThan(0); // the parse worked, so the filter below is meaningful
    expect(bundledPaths.filter((s) => /(?:^|\/)zod(?:\/|$)|node_modules\/zod/.test(s))).toEqual([]);
    // what DOES survive from the facade's chain is the model name string the UI displays, which is not a secret
    expect(markersFound(builtJs(), realRead, ["muse-spark"])).toEqual(["muse-spark"]);
  });

  it("the server-function modules are emitted only as client stubs: their handler bodies are gone", () => {
    const emitted = emittedClientModules(builtMaps(), realRead);
    expect(emitted).toContain("src/lib/athena/meta.functions.ts"); // the RPC stub does ship...
    // ...but nothing it dynamically imports does, and no client code reads an environment
    for (const f of emitted) expect(f, f).not.toMatch(/\.server\.tsx?$/);
    expect(markersFound(builtJs(), realRead, ["process.env"])).toEqual([]);
  });
});
