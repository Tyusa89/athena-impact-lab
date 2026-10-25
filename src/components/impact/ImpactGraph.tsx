import { useMemo } from "react";
import { NODE_H, NODE_W, layoutGraph } from "@/lib/athena/workbench/graphLayout";
import { STATUS_LABEL, type ImpactView } from "@/lib/athena/workbench/view";

export type Selection = { kind: "node" | "edge"; id: string } | null;
const ARROW = { up: "▲", down: "▼", flat: "▬" } as const;
const WORD = { up: "increased", down: "decreased", flat: "was flat" } as const;

/** The relationship map: authorized, discoverable metrics as nodes and the model's declared relationships as edges. Plain SVG; every node and edge is keyboard-operable.
 * Meaning is carried by shape and text as well as colour: solid = verified, dashed = not supported, dotted = cannot be assessed, "?" = unverified hypothesis. */
export function ImpactGraph({ view, selection, onSelect }: { view: ImpactView; selection: Selection; onSelect: (s: Selection) => void }) {
  const layout = useMemo(() => layoutGraph(view.nodes.map((n) => n.metric), view.edges), [view]);
  const pos = new Map(layout.nodes.map((n) => [n.id, n]));
  const nodeOf = new Map(view.nodes.map((n) => [n.metric, n]));
  const press = (s: Selection) => ({
    onClick: () => onSelect(s),
    onKeyDown: (e: React.KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(s); } },
  });
  if (!view.nodes.length) return <p className="text-sm text-muted-foreground">There are no metrics to draw within your authorized scope.</p>;

  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-background/40 p-2">
      <svg width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`} role="group" aria-label="Relationship map. A text version follows the diagram." className="mx-auto block max-w-none">
        <defs>
          <marker id="impact-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" className="fill-muted-foreground" /></marker>
        </defs>
        {layout.edges.map((le) => {
          const e = view.edges.find((x) => x.id === le.id)!;
          const sel = selection?.kind === "edge" && selection.id === e.id;
          const from = nodeOf.get(e.from)?.label, to = nodeOf.get(e.to)?.label;
          const style = e.status === "co_movement_observed" ? { cls: "stroke-success", dash: undefined } : e.status === "pattern_not_present" ? { cls: "stroke-muted-foreground", dash: "7 5" } : { cls: "stroke-warning", dash: "2 5" };
          return (
            <g key={e.id} role="button" tabIndex={0} aria-pressed={sel} data-testid={`edge-${e.id}`}
               aria-label={`Relationship from ${from} to ${to}: ${STATUS_LABEL[e.status]}.${e.hasHypothesis ? " Has an unverified hypothesis." : ""} Select to inspect.`} className="cursor-pointer outline-none focus-visible:[&_.ring]:stroke-primary" {...press({ kind: "edge", id: e.id })}>
              <path d={le.path} fill="none" strokeWidth={14} className="stroke-transparent" />
              <path d={le.path} fill="none" strokeWidth={sel ? 3.5 : 2} strokeDasharray={style.dash} markerEnd="url(#impact-arrow)" className={`${style.cls} ring`} />
              {e.hasHypothesis && (
                <g><circle cx={le.labelX} cy={le.labelY} r={9} className="fill-card stroke-warning" strokeWidth={1.5} /><text x={le.labelX} y={le.labelY + 4} textAnchor="middle" className="fill-warning text-[11px] font-bold">?</text></g>
              )}
            </g>
          );
        })}
        {view.nodes.map((n) => {
          const p = pos.get(n.metric)!;
          const sel = selection?.kind === "node" && selection.id === n.metric;
          const verified = n.state === "verified";
          return (
            <g key={n.metric} role="button" tabIndex={0} aria-pressed={sel} data-testid={`node-${n.metric}`} transform={`translate(${p.x} ${p.y})`}
               aria-label={verified ? `${n.label}: ${WORD[n.direction!]}, verified. Select to inspect evidence.` : `${n.label}: no verified data. Select for details.`} className="cursor-pointer outline-none focus-visible:[&_rect]:stroke-primary" {...press({ kind: "node", id: n.metric })}>
              <rect width={NODE_W} height={NODE_H} rx={10} strokeWidth={sel ? 3 : 1.5} strokeDasharray={verified ? undefined : "5 4"} className={`${verified ? "fill-card stroke-success" : "fill-background stroke-muted-foreground"} ${sel ? "stroke-primary" : ""}`} />
              <text x={10} y={22} className="fill-foreground text-[13px] font-semibold">{n.label}</text>
              <text x={10} y={42} className={`${verified ? "fill-muted-foreground" : "fill-warning"} text-[11px]`}>{verified ? `${ARROW[n.direction!]} ${WORD[n.direction!]}` : "? no verified data"}</text>
            </g>
          );
        })}
      </svg>
      <ul className="mt-2 flex flex-wrap gap-x-5 gap-y-1 px-2 text-[11px] text-muted-foreground" aria-label="Legend">
        <li>▬ solid green line: co-movement observed (verified)</li>
        <li>╌ dashed grey line: pattern not present</li>
        <li>┈ dotted amber line: cannot be assessed</li>
        <li>? on a line: unverified hypothesis attached</li>
        <li>dashed node: discoverable metric without verified data</li>
      </ul>
    </div>
  );
}
