// Business Impact Map: a deterministic, server-built summary of what authorized evidence verifiably shows, which declared relationships are supported by it,
// what that might imply (HYPOTHESES), what is missing, and what could be done (ACTIONS that need a human). No model is involved. Provider-, dataset- and
// prototype-neutral: it reads authorized evidence, a catalog and an operator-declared relationship model, and nothing else.
//
// What the map can and cannot say (the honesty rules, all enforced by tests):
//  * VERIFIED: a metric's change between the two periods (from facts computed by the engine) and whether two metrics moved together as a declared rule expects.
//    Both are statements about the data. Each carries the record ids it rests on and the sources those records came from.
//  * NOT a finding: why anything changed. Co-movement across two periods is never presented as causation (no cause wording, `claims_causation: false`).
//  * HYPOTHESIS: a possible implication written by the operator in the relationship model, shown only when its relationship is observed, always labelled
//    unverified, never above "Medium" plausibility.
//  * MISSING EVIDENCE: what would be needed to go beyond co-movement, and metrics a relationship needs but the caller has no verified data for.
//  * ACTION: a suggestion tied to a hypothesis; always `requires_human_approval: true` and `executable: false`.
//  * SCOPE: a relationship is considered only if BOTH of its metrics are DISCOVERABLE by the caller: they have authorized verified data, or the access-policy layer
//    explicitly granted them (`EvidenceScope.discoverableMetrics`). Domain membership never makes a metric discoverable. Anything else is omitted without a trace
//    (no names, no "hidden" placeholders), so the map cannot reveal that unauthorized metrics exist.
import { assertAuthorized, type AuthorizedEvidence } from "../core/access";
import { assertCatalog, metricDef, type Catalog } from "../core/catalog";
import type { Evidence } from "../core/evidence";
import { computeAuthorizedFacts, describeChange, type AnalysisContext } from "../core/facts";
import { mentionedIn } from "./semantic";

/** Wording that asserts or implies proof of cause. Forbidden in every string the map can contain, including operator-written rule text. */
export const CAUSAL_WORDS = /\b(caus(?:e|es|ed|ing)|because|due to|led to|leads to|lead to|result(?:s|ed)? in|driven by|drives|proves?|proven|responsible for|the reason|root cause|guarantee[sd]?|definitely|certainly)\b/i;
const HEDGE = /\b(may|might|possibly|could|potentially)\b/i;
const ID_RE = /^[a-z][a-z0-9-]{0,40}$/;
const TEXT_RE = /^[\p{L}\p{N} .,;:?!'"()/%&-]+$/u;

export interface RelationshipRule {
  readonly id: string;
  /** Catalog metric keys. Direction of the rule is for reading only: it asserts no cause. */
  readonly from: string;
  readonly to: string;
  /** "same": the two metrics are expected to move the same way; "opposite": in opposite ways. */
  readonly expect: "same" | "opposite";
  /** A hedged possible implication, shown as an unverified hypothesis when the relationship is observed. */
  readonly implication: string;
  /** Evidence that would be needed to say more than "these moved together". */
  readonly missing: readonly string[];
  readonly action?: { readonly title: string; readonly owner: string };
  readonly plausibility: "Low" | "Medium";
}
export interface RelationshipModel { readonly name: string; readonly rules: readonly RelationshipRule[] }

/** Configuration problems in a relationship model (developer-facing; the model is trusted operator config but is still held to the honesty rules). */
export function validateRelationshipModel(model: RelationshipModel, catalog: Catalog): string[] {
  assertCatalog(catalog);
  const out: string[] = [];
  if (!model || !Array.isArray(model.rules) || typeof model.name !== "string" || !model.name) return ["model must have a name and rules"];
  const ids = new Set<string>(), pairs = new Set<string>();
  const text = (label: string, t: unknown, max: number) => {
    if (typeof t !== "string" || !t.trim() || t.length > max || !TEXT_RE.test(t)) out.push(`${label} must be plain text of at most ${max} characters`);
    else if (CAUSAL_WORDS.test(t)) out.push(`${label} uses causal wording`);
  };
  for (const r of model.rules) {
    if (!r || typeof r !== "object") { out.push("a rule is not an object"); continue; }
    if (!ID_RE.test(r.id)) out.push(`rule id ${String(r.id)} is invalid`);
    if (ids.has(r.id)) out.push(`duplicate rule id ${r.id}`);
    ids.add(r.id);
    if (!metricDef(catalog, r.from) || !metricDef(catalog, r.to)) out.push(`rule ${r.id} refers to a metric that is not in the catalog`);
    if (r.from === r.to) out.push(`rule ${r.id} relates a metric to itself`);
    const pair = [r.from, r.to].sort().join("|");
    if (pairs.has(pair)) out.push(`rule ${r.id} duplicates a relationship between the same two metrics`);
    pairs.add(pair);
    if (r.expect !== "same" && r.expect !== "opposite") out.push(`rule ${r.id} has an invalid expectation`);
    if (r.plausibility !== "Low" && r.plausibility !== "Medium") out.push(`rule ${r.id} has an invalid plausibility (never above Medium)`);
    text(`rule ${r.id} implication`, r.implication, 240);
    if (typeof r.implication === "string" && !HEDGE.test(r.implication)) out.push(`rule ${r.id} implication is not hedged (use may, might, possibly or could)`);
    if (!Array.isArray(r.missing) || r.missing.length > 5) out.push(`rule ${r.id} missing evidence must be at most 5 items`);
    else r.missing.forEach((m: string, i: number) => text(`rule ${r.id} missing[${i}]`, m, 160));
    if (r.action) {
      text(`rule ${r.id} action title`, r.action.title, 160);
      if (!catalog.domains.some((d) => d.id === r.action!.owner)) out.push(`rule ${r.id} action owner is not a catalog domain`);
    }
  }
  return out;
}
export function assertRelationshipModel(model: RelationshipModel, catalog: Catalog): void {
  const problems = validateRelationshipModel(model, catalog);
  if (problems.length) throw new Error(`Invalid relationship model: ${problems.join("; ")}`);
}

type Dir = "up" | "down" | "flat";
export interface ProvenanceRef { batchId: string; sourceId: string; line: number }
export interface VerifiedChange {
  kind: "verified_change"; verified: true;
  fact_id: string; metric: string; label: string; domain: string; direction: Dir; text: string;
  supporting_ids: string[]; sources: string[]; provenance?: ProvenanceRef[];
}
export type RelationshipStatus = "co_movement_observed" | "pattern_not_present" | "insufficient_evidence";
export interface RelationshipAssessment {
  kind: "relationship"; id: string; status: RelationshipStatus;
  /** True when the statement is derived from verified facts (observed / not present); false when it only reports that data is missing. */
  verified: boolean; claims_causation: false;
  statement: string; fact_refs: string[]; supporting_ids: string[];
}
export interface ImpactHypothesis {
  kind: "hypothesis"; verified: false; claims_causation: false;
  relationship_id: string; statement: string; plausibility: "Low" | "Medium";
  fact_refs: string[]; supporting_ids: string[]; missing_evidence: string[];
}
export interface ImpactAction {
  kind: "proposed_action"; id: string; relationship_id: string; title: string; owner: string; rationale: string;
  supporting_ids: string[]; requires_human_approval: true; executable: false;
}
export interface ImpactMap {
  kind: "business_impact_map";
  /** The reporting window, e.g. "Q2 2026 → Q3 2026". (The question is deliberately not echoed: the map contains only engine-generated and operator-declared text.) */
  period: string;
  /** Labels of the authorized metrics the question is about (empty: no particular focus, everything the model relates is shown). */
  focus: string[];
  verified_changes: VerifiedChange[];
  relationships: RelationshipAssessment[];
  hypotheses: ImpactHypothesis[];
  missing_evidence: string[];
  proposed_actions: ImpactAction[];
  notices: string[];
}

export const NOTICES = [
  "Relationships are co-movements between two periods of verified metrics. They do not show that one metric affects another.",
  "Hypotheses are unverified possibilities from the configured relationship model. Nothing here establishes why a metric changed.",
  "Proposed actions are suggestions only. None can run without human approval.",
] as const;
export const NO_RELATIONSHIP_NOTICE = "No relationship in the model could be assessed for this question within your authorized scope.";
const GENERAL_GAP = "A longer history than two periods (no trend or seasonal baseline).";

const WORD = { up: "increased", down: "decreased", flat: "was flat" } as const;
const PATTERN = { same: "both moved the same way", opposite: "they moved in opposite directions" } as const;
const uniq = <T,>(xs: readonly T[]) => [...new Set(xs)];

export interface ImpactOptions {
  /** Optional lookup of import provenance for a record id (for example `ledger.provenanceOf`). Adds batch, source system and line to verified changes. */
  provenance?: (evidenceId: string) => ProvenanceRef | undefined;
  /** The (already validated) analysis question; used only to choose which authorized relationships to foreground. Default: no focus. */
  question?: string;
  /** Metric keys the access-policy layer explicitly lets the caller discover without data (`EvidenceScope.discoverableMetrics`). Metrics with authorized
   * verified data are always discoverable; no other metric is, and domain membership never makes one so. Unknown keys are ignored. */
  discoverableMetrics?: readonly string[];
}

export function buildImpactMap<E extends Evidence>(authorized: AuthorizedEvidence<E>, ctx: AnalysisContext, model: RelationshipModel, opts: ImpactOptions = {}): ImpactMap {
  assertAuthorized(authorized);
  assertCatalog(ctx.catalog);
  assertRelationshipModel(model, ctx.catalog);
  const cat = ctx.catalog;
  const period = `${ctx.periods.prior.label} → ${ctx.periods.current.label}`;
  const sourceOf = new Map(authorized.map((e) => [e.id, e.source]));

  // ---- verified changes (the full verified picture; catalog order for stable output)
  const facts = computeAuthorizedFacts(authorized, ctx);
  const factOf = new Map(facts.map((f) => [f.metric, f]));
  // Discoverable = has authorized verified data, or is explicitly granted by the access-policy layer. NEVER inferred from the domain of another metric.
  const discoverable = new Set<string>([...factOf.keys(), ...(opts.discoverableMetrics ?? []).filter((k) => !!metricDef(cat, k))]);
  const inScope = (metric: string) => discoverable.has(metric);
  const order = new Map(cat.metrics.map((m, i) => [m.key, i]));
  const verified_changes: VerifiedChange[] = [...facts].sort((a, b) => order.get(a.metric)! - order.get(b.metric)!).map((f) => {
    const refs = opts.provenance ? f.evidenceIds.map((id) => opts.provenance!(id)).filter((p): p is ProvenanceRef => !!p) : [];
    const vc: VerifiedChange = {
      kind: "verified_change", verified: true, fact_id: `F-${f.metric}`, metric: f.metric, label: f.label, domain: f.department, direction: f.direction,
      text: `${f.label} ${WORD[f.direction]}: ${describeChange(f)}`, supporting_ids: [...f.evidenceIds], sources: uniq(f.evidenceIds.map((id) => sourceOf.get(id)!)),
    };
    return refs.length ? { ...vc, provenance: refs } : vc;
  });

  // ---- relationships in scope: both metrics are discoverable (authorized data, or explicitly granted); everything else is omitted without a trace
  const considered = model.rules.filter((r) => inScope(r.from) && inScope(r.to));

  // ---- focus: what the question is about (authorized metrics only), then the relationships connecting them
  let focus: string[] = [];
  if (opts.question) {
    const m = mentionedIn(opts.question, cat);
    focus = uniq([...m.metrics, ...cat.metrics.filter((x) => m.domains.includes(x.domain)).map((x) => x.key)]).filter(inScope);
  }
  let selected = considered;
  if (focus.length) {
    // transitive closure by repeated relaxation (relationship graphs are tiny)
    const closure = new Map<string, Set<string>>();
    for (const m of cat.metrics) closure.set(m.key, new Set());
    for (let changed = true; changed;) { changed = false; for (const r of considered) { const s = closure.get(r.from)!; const before = s.size; s.add(r.to); for (const x of closure.get(r.to)!) s.add(x); if (s.size !== before) changed = true; } }
    const onPath = (u: string, v: string) => focus.some((a) => (u === a || closure.get(a)!.has(u)) && focus.some((b) => b !== a && (v === b || closure.get(v)!.has(b))));
    selected = considered.filter((r) => focus.includes(r.from) || focus.includes(r.to) || onPath(r.from, r.to));
  }

  const label = (k: string) => metricDef(cat, k)!.label;
  const relationships: RelationshipAssessment[] = [], hypotheses: ImpactHypothesis[] = [], proposed_actions: ImpactAction[] = [];
  const missing: string[] = [];
  for (const r of selected) {
    const a = factOf.get(r.from), b = factOf.get(r.to);
    if (!a || !b) {
      const lacking = [a ? null : label(r.from), b ? null : label(r.to)].filter((x): x is string => !!x);
      relationships.push({ kind: "relationship", id: r.id, status: "insufficient_evidence", verified: false, claims_causation: false, statement: `${lacking.join(" and ")} ${lacking.length > 1 ? "have" : "has"} no verified data in your authorized scope for ${period}, so this relationship cannot be assessed.`, fact_refs: [a, b].filter((x) => x).map((x) => `F-${x!.metric}`), supporting_ids: uniq([...(a?.evidenceIds ?? []), ...(b?.evidenceIds ?? [])]) });
      for (const l of lacking) missing.push(`Verified data for ${l}.`);
      continue;
    }
    const moved = a.direction !== "flat" && b.direction !== "flat";
    const together = r.expect === "same" ? a.direction === b.direction : a.direction !== b.direction;
    const observed = moved && together;
    const refs = [`F-${a.metric}`, `F-${b.metric}`], ids = uniq([...a.evidenceIds, ...b.evidenceIds]);
    const facts2 = `In ${period}, ${label(r.from)} ${WORD[a.direction]} and ${label(r.to)} ${WORD[b.direction]}`;
    relationships.push(observed
      ? { kind: "relationship", id: r.id, status: "co_movement_observed", verified: true, claims_causation: false, statement: `${facts2}: ${PATTERN[r.expect]}. This is co-movement across two periods only; it does not show that either change affects the other.`, fact_refs: refs, supporting_ids: ids }
      : { kind: "relationship", id: r.id, status: "pattern_not_present", verified: true, claims_causation: false, statement: `${facts2}. The pattern the relationship model looks for (${PATTERN[r.expect]}) is not present, so no implication is drawn.`, fact_refs: refs, supporting_ids: ids });
    if (!observed) continue;
    hypotheses.push({ kind: "hypothesis", verified: false, claims_causation: false, relationship_id: r.id, statement: `Possible implication (unverified hypothesis): ${r.implication}`, plausibility: r.plausibility, fact_refs: refs, supporting_ids: ids, missing_evidence: [...r.missing, GENERAL_GAP] });
    missing.push(...r.missing);
    if (r.action) proposed_actions.push({ kind: "proposed_action", id: `ACT-${r.id}`, relationship_id: r.id, title: r.action.title, owner: r.action.owner, rationale: `Suggested on the basis of an unverified hypothesis, not a finding: ${r.implication}`, supporting_ids: ids, requires_human_approval: true, executable: false });
  }
  if (relationships.some((x) => x.status === "co_movement_observed") || verified_changes.length) missing.push(GENERAL_GAP);

  const notices: string[] = [...NOTICES];
  if (!relationships.length) notices.push(NO_RELATIONSHIP_NOTICE);
  return {
    kind: "business_impact_map", period, focus: focus.map(label), verified_changes, relationships, hypotheses,
    missing_evidence: uniq(missing), proposed_actions, notices,
  };
}

/** A readable rendering of a map for reviewers and demos. Every section is labelled with what kind of statement it holds. */
export function renderImpactMapMarkdown(m: ImpactMap, question = ""): string {
  const L: string[] = [];
  L.push(`**Question:** ${question || "(none: all configured relationships)"}`, "", `**Period:** ${m.period}` + (m.focus.length ? `  \n**Focus:** ${m.focus.join(", ")}` : ""), "");
  L.push("#### Verified changes (computed from authorized evidence)");
  for (const v of m.verified_changes) L.push(`- ${v.text}  \n  evidence: ${v.supporting_ids.join(", ")} · source: ${v.sources.join("; ")}${v.provenance ? ` · import: ${v.provenance.map((p) => `${p.batchId} line ${p.line}`).join(", ")}` : ""}`);
  L.push("", "#### Relationships (verified co-movement, not cause)");
  if (!m.relationships.length) L.push("- (none assessable within the authorized scope)");
  for (const r of m.relationships) L.push(`- **${r.id}** [${r.status}] ${r.statement}  \n  facts: ${r.fact_refs.join(", ")} · evidence: ${r.supporting_ids.join(", ")}`);
  L.push("", "#### Hypotheses (UNVERIFIED)");
  if (!m.hypotheses.length) L.push("- (none)");
  for (const h of m.hypotheses) L.push(`- ${h.statement} _(plausibility ${h.plausibility}; from ${h.relationship_id})_`);
  L.push("", "#### Missing evidence");
  if (!m.missing_evidence.length) L.push("- (none listed)");
  for (const x of m.missing_evidence) L.push(`- ${x}`);
  L.push("", "#### Proposed actions (require human approval; not executable)");
  if (!m.proposed_actions.length) L.push("- (none)");
  for (const a of m.proposed_actions) L.push(`- **${a.owner}:** ${a.title}  \n  ${a.rationale}`);
  L.push("", ...m.notices.map((n) => `> ${n}`));
  return L.join("\n");
}
