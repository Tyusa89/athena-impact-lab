import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as tindara from "./index";

// C1 Phase 0 architecture + contract tests for the Tindara public entry point.
//
// The point of these tests is that the public surface cannot ACCIDENTALLY grow. Four independent checks:
//   1. the barrel's own import specifiers are on an allowlist;
//   2. the barrel does not mention any prototype/demo/strict identifier (comments stripped first, so the header's prose is not a false positive);
//   3. the barrel's RUNTIME exports equal a pinned list, so adding or removing one is a deliberate, reviewed change;
//   4. the TRANSITIVE module closure reachable from the barrel contains no prototype adapter, facade, concrete provider, strict-path module or fixture.
// (3) and (4) are what make "a demo runtime cannot leak through the entry point" a test result rather than a claim: (3) catches a direct
// re-export, (4) catches one that arrives through a chain of internal imports.
const ENTRY = "src/lib/tindara/index.ts";
const SRC = "src/lib";

const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|(?<!:)\/\/[^\n]*/g, " ");

/** LOW-5: type-only exports are erased at runtime, so `Object.keys` cannot see them. They are pinned by parsing the entry point's own
 * `export type { ... }` blocks instead. Without this, a type could be added to or removed from the public surface unnoticed. */
function typeOnlyExports(): string[] {
  const code = stripComments(readFileSync(ENTRY, "utf8"));
  const names = new Set<string>();
  for (const m of code.matchAll(/\bexport\s+type\s*\{([^}]*)\}/g))
    for (const raw of m[1]!.split(",")) {
      const n = raw.trim().replace(/^type\s+/, "").split(/\s+as\s+/).pop()!.trim();
      if (n) names.add(n);
    }
  return [...names].sort();
}
const specifiersOf = (source: string): string[] =>
  [
    ...source.matchAll(/\bimport\s+(?:type\s+)?(?:[\w*{},\s$]+?\s+from\s+)?["']([^"']+)["']/g),
    ...source.matchAll(/\bexport\s+(?:type\s+)?(?:\*|\{[\s\S]*?\})\s+from\s+["']([^"']+)["']/g),
  ].map((m) => m[1]!);

/** Modules the public surface may re-export from: the reusable core, its ingestion subtree, and the GENERIC engine modules only. */
const ALLOWED_ENTRY_IMPORTS = new Set([
  "../athena/core/identity", "../athena/core/access", "../athena/core/evidence", "../athena/core/facts", "../athena/core/catalog",
  "../athena/core/ingest",
  "../athena/meta/runtime", "../athena/meta/impact", "../athena/meta/analysis", "../athena/meta/outputSchema", "../athena/meta/grounding",
  "../athena/meta/render", "../athena/meta/question", "../athena/meta/provider", "../athena/meta/limits", "../athena/meta/semantic",
]);

/** Anything whose path matches one of these may not be reachable from the entry point. */
const FORBIDDEN_FILE = [
  { label: "prototype adapter/catalog", re: /prototype/i },
  { label: "demo data", re: /athena[\\/]data\.ts$/ },
  { label: "prototype demo engine", re: /athena[\\/]engine\.ts$/ },
  { label: "prototype relationship models", re: /impactModels\.ts$/ },
  { label: "prototype approvals", re: /approvals\.ts$/ },
  { label: "prototype-facing facade", re: /meta[\\/](contract|adapter\.server|findings|numericGrounding|semanticGuards)\.ts$/ },
  { label: "concrete model provider", re: /meta[\\/]providers[\\/]/ },
  { label: "strict reasoning path", re: /meta[\\/](strictRuntime|strictValidation|scopedPrompt)\.ts$/ },
  { label: "fixtures or test support", re: /fixtures|testSupport/ },
  { label: "server transport", re: /\.functions\.ts$|\.server\.ts$/ },
  { label: "UI", re: /[\\/](components|routes|hooks)[\\/]/ },
] as const;

/** Identifiers that must never appear in the entry point's code (comments excluded). */
const FORBIDDEN_IDENTIFIERS = [
  "PROTOTYPE_RUNTIME", "PROTOTYPE_CATALOG", "PROTOTYPE_CONTEXT", "DEMO_QUESTION", "DEMO_TENANT_ID", "SCENARIOS", "ROLES", "WORKSPACES",
  "DEPT_WORKSPACE", "SERVER_ROLE_WORKSPACES", "SYNTHETIC_SCENARIO_ALLOWLIST", "museSpark", "demoIdentity", "demoAccessPolicy",
  "demoEvidenceStore", "resolveDemoRequest", "authorizeDemo", "simulatedDemoVerifier", "demoActorId", "runMeta", "runPrototypeImpact",
  "runStrictAnalysis", "validateStrictOutput", "strictRejection", "buildScopedMessages", "BUSINESS_OPS_MODEL", "SUPPORT_DESK_CATALOG",
  "EvidenceRecord", "econest", "EcoNest",
];

/** Resolve a relative specifier to a .ts file under src/, or null when it is not a local TypeScript module. */
function resolveLocal(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = path.resolve(path.dirname(fromFile), spec.replace(/\?.*$/, ""));
  for (const candidate of [base, `${base}.ts`, path.join(base, "index.ts")])
    if (existsSync(candidate) && candidate.endsWith(".ts")) return path.relative(process.cwd(), candidate).replace(/\\/g, "/");
  return null;
}

/** Every local .ts module reachable from `entry` by following relative imports/re-exports (the entry itself included). */
function moduleClosure(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.shift()!;
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    for (const spec of specifiersOf(stripComments(readFileSync(file, "utf8")))) {
      const next = resolveLocal(file, spec);
      if (next && !seen.has(next)) queue.push(next);
    }
  }
  return [...seen].sort();
}

describe("1. the entry point imports only the reusable core and the generic engine", () => {
  it("every import specifier is on the allowlist", () => {
    const specs = [...new Set(specifiersOf(stripComments(readFileSync(ENTRY, "utf8"))))];
    expect(specs.length).toBeGreaterThan(5); // the scan actually found the re-exports
    expect(specs.filter((s) => !ALLOWED_ENTRY_IMPORTS.has(s))).toEqual([]);
  });
  it("it imports no package, alias or path outside the engine", () => {
    for (const s of specifiersOf(stripComments(readFileSync(ENTRY, "utf8")))) {
      expect(s.startsWith("../athena/"), s).toBe(true);
      expect(s, s).not.toMatch(/\.\.\/\.\.|@\//);
    }
  });
});

describe("2. the entry point names nothing from the prototype, the demo or the strict path", () => {
  const code = stripComments(readFileSync(ENTRY, "utf8"));
  it.each(FORBIDDEN_IDENTIFIERS)("does not mention %s", (id) => {
    expect(new RegExp(`\\b${id}\\b`).test(code), id).toBe(false);
  });
});

describe("3. the runtime export surface is pinned", () => {
  // Value exports only (type-only exports do not exist at runtime). Changing this list is a deliberate public-API change and must be reviewed.
  const EXPECTED = [
    "AuthorizationError", "BLOCK_CODES", "CAUSAL_WORDS", "DEFAULT_IMPORT_LIMITS", "DEFAULT_PROMPT_SUBJECT", "FAILURE_CODES",
    "IDENTITY_TIMEOUT_MS", "LIMITS", "MAX_INPUT_TOKENS", "MAX_OUTPUT_TOKENS", "NOTICES", "NO_RELATIONSHIP_NOTICE", "OUTPUT_JSON_SCHEMA",
    "OutputSchema", "QUESTION_MAX", "QUESTION_MIN", "QUESTION_REJECTIONS", "REJECTION_CODES", "REQUEST_TIMEOUT_MS", "RESIDUAL_LIMITATIONS",
    "STRUCTURAL_CODES", "assertAuthorized", "assertCatalog", "assertRelationshipModel", "authorizeEvidence", "authorizeRequest",
    "authorizedFactsBlockReason", "buildAuthorizedFacts", "buildImpactMap", "buildVerifiedFacts", "computeAuthorizedFacts", "computeFacts",
    "createEvidenceLedger", "createIdentityBoundary", "csvAdapter", "describeChange", "domainDef", "estimateTokens", "factIdFor",
    "factsBlockReason", "goodDirection", "importSource", "isAuthorizedEvidence", "isImportResult", "isIsoDate", "metaStatus", "metricDef",
    "metricDomain", "metricLabel", "parseCsv", "prepareMessages", "renderFindings", "renderImpactMapMarkdown", "requireMetric",
    "runAnalysis", "runImpactAnalysis", "sha256Hex", "validateCatalog", "validateMapping", "validateQuestion",
    "validateRecords", "validateRelationshipModel",
  ];
  it("exports exactly the pinned list", () => {
    expect(Object.keys(tindara).sort()).toEqual([...EXPECTED].sort());
  });
  it("MEDIUM-2: the strict-capable validator and its profile are NOT exported", () => {
    // `validateAuthorizedOutput` takes a `ValidateProfile` that can switch on strict behaviour (refConsistency, strictCausal), so exporting it
    // would put part of the strict profile on the Phase 0 surface. It still runs inside `runAnalysis`; only direct, profile-chosen calls are withheld.
    for (const id of ["validateAuthorizedOutput", "validateOutput", "ValidateProfile"]) expect(Object.keys(tindara), id).not.toContain(id);
    expect(typeOnlyExports()).not.toContain("ValidateProfile");
    // the implementation is untouched: the generic module still exports it for the engine's own use
    expect(readFileSync("src/lib/athena/meta/analysis.ts", "utf8")).toMatch(/export function validateAuthorizedOutput/);
  });
  it("exports no demo runtime, demo identity, concrete provider or strict entry point", () => {
    for (const id of FORBIDDEN_IDENTIFIERS) expect(Object.keys(tindara), id).not.toContain(id);
  });
  it("LOW-5: the TYPE-ONLY export surface is pinned too (it cannot be seen at runtime)", () => {
    expect(typeOnlyExports()).toEqual([
      "AccessPolicy", "Aggregation", "AnalysisContext", "Assurance", "AuthorizationResult", "AuthorizedEvidence", "BlockCode", "Catalog",
      "CommitOutcome", "CoreFact", "CoreRecord", "Direction", "DomainDef", "DomainIdOf", "EngineRuntime", "Evidence", "EvidenceLedger",
      "EvidenceLike", "EvidenceScope", "EvidenceStore", "FailureCode", "FieldRole", "IdentityBoundary", "IdentityVerifier", "ImpactAction",
      "ImpactHypothesis", "ImpactMap", "ImpactOptions", "ImpactResult", "ImportBatch", "ImportLimits", "ImportOptions", "ImportPolicy",
      "ImportRequest", "ImportResult", "ImportStatus", "MappingSpec", "MetaOutput", "MetaResult", "MetaStatus", "MetricDef", "MetricKeyOf",
      "ModelMessage", "ModelOutcome", "ModelOutput", "ModelProvider", "ModelRequest", "ModelUsage", "PeriodPair", "PeriodSpec", "Polarity",
      "Prepared", "Provenance", "ProvenanceRef", "ProviderCall", "ProviderEnv", "ProviderStatus", "QuestionRejection", "QuestionResult",
      "RawRow", "RawTable", "RejectedRecord", "RejectionCode", "RejectionReason", "RelationshipAssessment", "RelationshipModel",
      "RelationshipRule", "RelationshipStatus", "ResolvedRequest", "SourceAdapter", "SourceDescriptor", "SourceReadResult", "StructuralCode",
      "StructuralError", "TrustedContext", "Usage", "ValidationResult", "VerifiedChange", "VerifiedFact", "VerifiedFinding", "VerifiedIdentity",
    ]);
  });
  it("LOW-2: `EngineRuntime` IS exported (as a type); `SemanticScopeOptions` is intentionally not", () => {
    expect(typeOnlyExports()).toContain("EngineRuntime");
    // `semanticScope` is not on the public surface, so its options bag has no public use
    expect(typeOnlyExports()).not.toContain("SemanticScopeOptions");
    expect(Object.keys(tindara)).not.toContain("semanticScope");
  });
  it("the deterministic entry point and the runtime seam are present and callable", () => {
    expect(typeof tindara.runImpactAnalysis).toBe("function");
    expect(typeof tindara.createIdentityBoundary).toBe("function");
    expect(typeof tindara.authorizeEvidence).toBe("function");
  });
});

describe("4. nothing reachable from the entry point is prototype-only", () => {
  const closure = moduleClosure(ENTRY);
  it("the closure was actually walked", () => {
    expect(closure).toContain(ENTRY);
    // it reaches the real engine, so an empty/broken walk cannot pass the checks below
    for (const f of ["src/lib/athena/core/access.ts", "src/lib/athena/core/identity.ts", "src/lib/athena/meta/runtime.ts", "src/lib/athena/meta/impact.ts"])
      expect(closure, f).toContain(f);
    expect(closure.length).toBeGreaterThan(12);
  });
  it.each(FORBIDDEN_FILE)("reaches no $label", ({ re }) => {
    expect(closure.filter((f) => re.test(f))).toEqual([]);
  });
  it("stays inside the engine (core, its ingestion subtree, generic meta, and this entry point)", () => {
    for (const f of closure)
      expect(f.startsWith(`${SRC}/athena/core/`) || f.startsWith(`${SRC}/athena/meta/`) || f.startsWith(`${SRC}/tindara/`), f).toBe(true);
  });
  it("in particular, the STRICT path is not reachable (strict/legacy separation preserved)", () => {
    expect(closure.filter((f) => /strict/i.test(f))).toEqual(["src/lib/athena/meta/strictVocabulary.ts"]);
    // strictVocabulary is the shared inflection-tolerant term matcher used by the legacy semantic guards too; the strict RUNTIME and
    // VALIDATOR are what must stay out, and the assertion above pins that.
  });
});

describe("5. the consumer contract test consumes only the public entry point", () => {
  it("imports nothing but ./index and the test framework", () => {
    const specs = specifiersOf(stripComments(readFileSync("src/lib/tindara/consumer.test.ts", "utf8")));
    expect([...new Set(specs)].sort()).toEqual(["./index", "vitest"]);
  });
});
