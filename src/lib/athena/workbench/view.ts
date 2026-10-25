// The presentation model of the interactive Business Impact Map. Pure and dependency-light (core types only): no I/O, no model, no UI.
//
// The engine owns the intelligence. This module only PROJECTS an engine result (`ImpactMap`) plus the caller's already-authorized evidence into a
// plain, serializable shape a user interface can draw. It computes nothing: no calculation, no relationship logic, no authorization decision.
//   * Every field is copied explicitly (no spread of engine objects), so a field added to the engine later is not shipped to a browser by accident.
//   * Evidence is projected only for ids the map itself cites, and only from the `AuthorizedEvidence` the engine used. Withheld records are never read.
//   * Nodes and edges are the metrics and relationships already present in the map, i.e. already discoverable; nothing else is added.
//   * A responsible domain on an action is shown only if it is a domain of the caller's verified changes (an owner naming any other department would
//     reveal that department); otherwise it is null and the UI says it is yet to be assigned.
import type { AuthorizedEvidence } from "../core/access";
import { metricDef } from "../core/catalog";
import type { Evidence } from "../core/evidence";
import type { AnalysisContext } from "../core/facts";
import type { ImpactMap, RelationshipModel } from "../meta/impact";

export type NodeState = "verified" | "unknown";
export interface ViewNode {
  metric: string; label: string; state: NodeState;
  /** Null for an unknown node (discoverable, but no verified data). */
  direction: "up" | "down" | "flat" | null; changeText: string | null; domain: string | null; factId: string | null; evidenceIds: string[];
}
export type RelationshipStatus = "co_movement_observed" | "pattern_not_present" | "insufficient_evidence";
export interface ViewEdge {
  id: string; from: string; to: string; status: RelationshipStatus; expect: "same" | "opposite"; statement: string;
  factRefs: string[]; evidenceIds: string[]; hasHypothesis: boolean;
}
export interface ViewEvidence {
  id: string; source: string; date: string; metric: string; metricLabel: string; department: string;
  period: "prior" | "current"; periodLabel: string; value: number; unit: string;
}
export interface ViewChange { factId: string; metric: string; label: string; domain: string; direction: "up" | "down" | "flat"; text: string; evidenceIds: string[]; sources: string[] }
export interface ViewHypothesis { relationshipId: string; statement: string; plausibility: "Low" | "Medium"; missingEvidence: string[]; factRefs: string[]; evidenceIds: string[] }
export interface ViewAction { id: string; relationshipId: string; title: string; /** Null: the responsible domain is not within the caller's authorized scope. */ owner: string | null; rationale: string; evidenceIds: string[]; requiresHumanApproval: true; executable: false }

export interface ImpactView {
  kind: "impact_view";
  context: { datasetName: string; scenarioName: string; roleLabel: string; simulatedRole: true };
  period: string;
  focus: string[];
  nodes: ViewNode[];
  edges: ViewEdge[];
  changes: ViewChange[];
  hypotheses: ViewHypothesis[];
  missingEvidence: string[];
  actions: ViewAction[];
  notices: string[];
  /** Authorized records cited by the sections above, keyed by id. */
  evidence: Record<string, ViewEvidence>;
}

export interface ViewContext { datasetName: string; scenarioName: string; roleLabel: string }

const uniq = <T,>(xs: readonly T[]) => [...new Set(xs)];

export function buildImpactView(map: ImpactMap, records: AuthorizedEvidence<Evidence>, analysis: AnalysisContext, model: RelationshipModel, vctx: ViewContext): ImpactView {
  const cat = analysis.catalog;
  const labelOf = (k: string) => metricDef(cat, k)?.label ?? "";
  const ruleOf = new Map(model.rules.map((r) => [r.id, r]));

  const changes: ViewChange[] = map.verified_changes.map((v) => ({
    factId: v.fact_id, metric: v.metric, label: v.label, domain: v.domain, direction: v.direction, text: v.text, evidenceIds: [...v.supporting_ids], sources: [...v.sources],
  }));
  const authorizedDomains = new Set(changes.map((c) => c.domain));

  const edges: ViewEdge[] = [];
  for (const r of map.relationships) {
    const rule = ruleOf.get(r.id);
    if (!rule) continue; // an assessment the model does not declare is not drawn
    edges.push({
      id: r.id, from: rule.from, to: rule.to, status: r.status, expect: rule.expect, statement: r.statement, factRefs: [...r.fact_refs], evidenceIds: [...r.supporting_ids],
      hasHypothesis: map.hypotheses.some((h) => h.relationship_id === r.id),
    });
  }

  const nodes: ViewNode[] = changes.map((c) => ({
    metric: c.metric, label: c.label, state: "verified" as const, direction: c.direction, changeText: c.text, domain: c.domain, factId: c.factId, evidenceIds: [...c.evidenceIds],
  }));
  const known = new Set(nodes.map((n) => n.metric));
  for (const e of edges) for (const m of [e.from, e.to]) {
    if (known.has(m)) continue;
    known.add(m);
    nodes.push({ metric: m, label: labelOf(m), state: "unknown", direction: null, changeText: null, domain: null, factId: null, evidenceIds: [] });
  }

  const hypotheses: ViewHypothesis[] = map.hypotheses.map((h) => ({
    relationshipId: h.relationship_id, statement: h.statement, plausibility: h.plausibility, missingEvidence: [...h.missing_evidence], factRefs: [...h.fact_refs], evidenceIds: [...h.supporting_ids],
  }));
  const actions: ViewAction[] = map.proposed_actions.map((a) => ({
    id: a.id, relationshipId: a.relationship_id, title: a.title, owner: authorizedDomains.has(a.owner) ? a.owner : null, rationale: a.rationale, evidenceIds: [...a.supporting_ids],
    requiresHumanApproval: true as const, executable: false as const,
  }));

  const cited = new Set<string>([...changes, ...edges, ...hypotheses, ...actions].flatMap((x) => x.evidenceIds));
  const evidence: Record<string, ViewEvidence> = Object.create(null) as Record<string, ViewEvidence>;
  for (const e of records) {
    if (!cited.has(e.id)) continue;
    evidence[e.id] = {
      id: e.id, source: e.source, date: e.date, metric: e.metric, metricLabel: labelOf(e.metric), department: e.department, period: e.period,
      periodLabel: analysis.periods[e.period].label, value: e.value, unit: e.unit,
    };
  }

  return {
    kind: "impact_view", context: { ...vctx, simulatedRole: true }, period: map.period, focus: [...map.focus], nodes, edges, changes, hypotheses,
    missingEvidence: [...map.missing_evidence], actions, notices: [...map.notices], evidence,
  };
}

export const STATUS_LABEL: Record<RelationshipStatus, string> = {
  co_movement_observed: "Supported: co-movement observed",
  pattern_not_present: "Not supported: pattern not present",
  insufficient_evidence: "Cannot be assessed: no verified data",
};

// ---------------------------------------------------------------- what the interface may offer and receive (client-safe types; the server module builds them)
export interface WorkbenchOption { id: string; label: string; description: string }
/** Names and descriptions only: no metric, record, count or relationship. */
export interface WorkbenchDatasetInfo {
  id: string; name: string; description: string; notice: string;
  scenarios: WorkbenchOption[]; roles: WorkbenchOption[];
  defaultQuestion: string; suggestedQuestions: string[];
}
export type WorkbenchResult = { state: "ok"; view: ImpactView } | { state: "blocked"; reason: string };
export interface WorkbenchRequest { datasetId: string; scenarioId: string; roleId: string; question?: string }
