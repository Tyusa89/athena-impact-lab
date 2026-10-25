import { STATUS_LABEL, type ImpactView, type ViewEdge, type ViewNode } from "@/lib/athena/workbench/view";
import { Badge, EvidenceTable, Section } from "./parts";
import type { Selection } from "./ImpactGraph";

const toneOf = (s: ViewEdge["status"]) => (s === "co_movement_observed" ? "verified" : s === "pattern_not_present" ? "neutral" : "unknown");
const EXPECT = { same: "expected to move the same way", opposite: "expected to move in opposite directions" } as const;
const label = (view: ImpactView, metric: string) => view.nodes.find((n) => n.metric === metric)?.label ?? "";
const arrow = (view: ImpactView, e: ViewEdge) => `${label(view, e.from)} → ${label(view, e.to)}`;

/** Accessible text version of the diagram: every metric and every relationship, each selectable. */
export function TextAlternative({ view, selection, onSelect }: { view: ImpactView; selection: Selection; onSelect: (s: Selection) => void }) {
  return (
    <div data-testid="text-alternative">
      <h3 className="text-sm font-semibold">Text version of the map</h3>
      <p className="mb-2 text-xs text-muted-foreground">The same metrics and relationships as the diagram, as a list.</p>
      <ul className="space-y-1 text-xs">
        {view.nodes.map((n) => (
          <li key={n.metric}>
            <button type="button" aria-pressed={selection?.kind === "node" && selection.id === n.metric} onClick={() => onSelect({ kind: "node", id: n.metric })} className="rounded px-1 text-left hover:bg-secondary aria-pressed:bg-secondary">
              <b>{n.label}</b>: {n.state === "verified" ? `verified, ${n.changeText}` : "no verified data in your authorized scope"}
            </button>
          </li>
        ))}
      </ul>
      {view.edges.length > 0 && <ul className="mt-2 space-y-1 border-t border-border pt-2 text-xs">
        {view.edges.map((e) => (
          <li key={e.id}>
            <button type="button" aria-pressed={selection?.kind === "edge" && selection.id === e.id} onClick={() => onSelect({ kind: "edge", id: e.id })} className="rounded px-1 text-left hover:bg-secondary aria-pressed:bg-secondary">
              <b>{arrow(view, e)}</b> ({EXPECT[e.expect]}): {STATUS_LABEL[e.status]}.{e.hasHypothesis ? " An unverified hypothesis is attached." : ""}
            </button>
          </li>
        ))}
      </ul>}
    </div>
  );
}

function NodeDetail({ view, node }: { view: ImpactView; node: ViewNode }) {
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2"><h3 className="text-base font-semibold">{node.label}</h3>{node.state === "verified" ? <Badge tone="verified">Verified</Badge> : <Badge tone="unknown">No verified data</Badge>}</div>
      {node.state === "verified" ? (
        <>
          <p className="mt-2 text-sm">{node.label} {node.direction === "flat" ? "was flat" : node.direction === "up" ? "increased" : "decreased"}: {node.changeText?.split(": ").slice(1).join(": ") ?? node.changeText}</p>
          <p className="mt-1 text-xs text-muted-foreground">{view.period}. Computed by the engine from the records below.</p>
          <div className="mt-3"><EvidenceTable ids={node.evidenceIds} evidence={view.evidence} caption={`Evidence for ${node.label}`} /></div>
          <p className="mt-3 text-xs text-muted-foreground">Limitation: a change between two periods. It does not say why the metric moved.</p>
        </>
      ) : (
        <p className="mt-2 text-sm text-muted-foreground">You may know this metric exists, but there are no verified records for it in your authorized scope for {view.period}, so no change is reported. See Missing evidence.</p>
      )}
    </div>
  );
}

function EdgeDetail({ view, edge }: { view: ImpactView; edge: ViewEdge }) {
  const hyp = view.hypotheses.find((h) => h.relationshipId === edge.id);
  const acts = view.actions.filter((a) => a.relationshipId === edge.id);
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2"><h3 className="text-base font-semibold">{arrow(view, edge)}</h3><Badge tone={toneOf(edge.status)}>{STATUS_LABEL[edge.status]}</Badge></div>
      <p className="mt-1 text-xs text-muted-foreground">Declared relationship: {EXPECT[edge.expect]}.</p>
      <p className="mt-2 text-sm">{edge.statement}</p>
      <p className="mt-2 rounded-md bg-secondary p-2 text-xs">Co-movement across two periods is not causation. It does not show that either change affects the other.</p>
      {edge.evidenceIds.length > 0 && <div className="mt-3"><EvidenceTable ids={edge.evidenceIds} evidence={view.evidence} caption={`Evidence for ${arrow(view, edge)}`} /></div>}
      {hyp && (
        <div className="mt-3 rounded-md border border-warning/40 bg-warning/5 p-3">
          <div className="flex flex-wrap items-center gap-2"><Badge tone="unverified">Unverified hypothesis</Badge><Badge>Plausibility: {hyp.plausibility}</Badge></div>
          <p className="mt-2 text-sm">{hyp.statement}</p>
          <p className="mt-2 text-xs font-semibold">Limitations: evidence that would be needed</p>
          <ul className="list-disc pl-5 text-xs text-muted-foreground">{hyp.missingEvidence.map((m) => <li key={m}>{m}</li>)}</ul>
        </div>
      )}
      {acts.map((a) => <p key={a.id} className="mt-3 text-xs"><Badge tone="unverified">Proposed action · requires human approval · not executable</Badge> <span className="ml-1">{a.title}</span></p>)}
    </div>
  );
}

export function DetailPanel({ view, selection }: { view: ImpactView; selection: Selection }) {
  const node = selection?.kind === "node" ? view.nodes.find((n) => n.metric === selection.id) : undefined;
  const edge = selection?.kind === "edge" ? view.edges.find((e) => e.id === selection.id) : undefined;
  return (
    <div aria-live="polite" data-testid="detail-panel" className="rounded-lg border border-border bg-secondary/40 p-4">
      {node ? <NodeDetail view={view} node={node} /> : edge ? <EdgeDetail view={view} edge={edge} /> : <p className="text-sm text-muted-foreground">Select a metric or a relationship in the map, or in the text version, to see its evidence and limitations.</p>}
    </div>
  );
}

export function Sections({ view, onSelect }: { view: ImpactView; onSelect: (s: Selection) => void }) {
  return (
    <div className="space-y-6">
      <Section id="verified-changes" title="Verified changes" badge={<Badge tone="verified">Verified · computed from authorized records</Badge>} intro={`Facts, not interpretations. Each is computed by the engine for ${view.period} from the records listed under it.`}>
        {view.changes.length === 0 ? <p className="text-sm text-muted-foreground">No verified changes: there are no authorized records for this selection.</p> :
          <ul className="space-y-3">{view.changes.map((c) => (
            <li key={c.factId} className="rounded-md bg-secondary p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <button type="button" onClick={() => onSelect({ kind: "node", id: c.metric })} className="text-left text-sm font-semibold underline-offset-2 hover:underline">{c.text}</button>
                <Badge tone="verified">{c.direction === "up" ? "▲ up" : c.direction === "down" ? "▼ down" : "▬ flat"}</Badge>
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">{c.domain} · {view.period} · source{c.sources.length === 1 ? "" : "s"}: {c.sources.join("; ")}</p>
              <details className="mt-2"><summary className="cursor-pointer text-xs text-accent">Show {new Set(c.evidenceIds).size} supporting record{c.evidenceIds.length === 1 ? "" : "s"}</summary>
                <div className="mt-2"><EvidenceTable ids={c.evidenceIds} evidence={view.evidence} caption={`Records supporting ${c.label}`} /></div></details>
            </li>))}</ul>}
      </Section>

      <Section id="observed-relationships" title="Observed relationships" badge={<Badge tone="verified">Co-movement, not causation</Badge>} intro="Whether the data show the pattern each declared relationship looks for. A supported relationship means two metrics moved together between two periods. It never shows that one changed the other.">
        {view.edges.length === 0 ? <p className="text-sm text-muted-foreground">No relationship could be assessed within your authorized scope for this question.</p> :
          <ul className="space-y-3">{view.edges.map((e) => (
            <li key={e.id} className="rounded-md bg-secondary p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <button type="button" onClick={() => onSelect({ kind: "edge", id: e.id })} className="text-left text-sm font-semibold underline-offset-2 hover:underline">{arrow(view, e)}</button>
                <Badge tone={toneOf(e.status)}>{STATUS_LABEL[e.status]}</Badge>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{e.statement}</p>
            </li>))}</ul>}
      </Section>

      <Section id="hypotheses" title="Hypotheses" badge={<Badge tone="unverified">Unverified · operator-defined</Badge>} intro="Possibilities written by the operator in the relationship model and shown only where the co-movement was observed. They are not findings and are never promoted to one.">
        {view.hypotheses.length === 0 ? <p className="text-sm text-muted-foreground">No hypotheses: no relationship with an observed co-movement is in scope.</p> :
          <ul className="space-y-3">{view.hypotheses.map((h) => (
            <li key={h.relationshipId} className="rounded-md bg-secondary p-3">
              <div className="flex flex-wrap items-center gap-2"><Badge tone="unverified">Unverified hypothesis</Badge><Badge>Plausibility: {h.plausibility}</Badge></div>
              <p className="mt-2 text-sm">{h.statement}</p>
              <p className="mt-2 text-xs font-semibold">Limitations: what would be needed to go further</p>
              <ul className="list-disc pl-5 text-xs text-muted-foreground">{h.missingEvidence.map((m) => <li key={m}>{m}</li>)}</ul>
            </li>))}</ul>}
      </Section>

      <Section id="missing-evidence" title="Missing evidence" badge={<Badge tone="unknown">Unknown · unresolved</Badge>} intro="What would help answer the question further, and metrics you may know about but have no verified data for.">
        {view.missingEvidence.length === 0 ? <p className="text-sm text-muted-foreground">No missing evidence is listed.</p> :
          <ul className="list-disc space-y-1 pl-5 text-sm">{view.missingEvidence.map((m) => <li key={m}>{m}</li>)}</ul>}
      </Section>

      <Section id="proposed-actions" title="Proposed actions" badge={<Badge tone="unverified">Requires human approval · not executable</Badge>} intro="Suggestions tied to an unverified hypothesis. Nothing here can run: there is no approval or execution in this interface.">
        {view.actions.length === 0 ? <p className="text-sm text-muted-foreground">No actions are proposed.</p> :
          <ul className="space-y-3">{view.actions.map((a) => (
            <li key={a.id} className="rounded-md bg-secondary p-3">
              <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-sm font-semibold">{a.title}</span><Badge tone="unverified">Requires human approval</Badge></div>
              <p className="mt-1 text-xs text-muted-foreground">Responsible domain: {a.owner ?? "to be assigned"}</p>
              <p className="mt-1 text-xs text-muted-foreground">{a.rationale}</p>
              <p className="mt-1 text-[11px] text-warning">Proposal only. Not executable; no approval is recorded here.</p>
            </li>))}</ul>}
      </Section>
    </div>
  );
}
