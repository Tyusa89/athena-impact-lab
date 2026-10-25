import type { ReactNode } from "react";
import type { ViewEvidence } from "@/lib/athena/workbench/view";

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "verified" | "unverified" | "unknown" | "warn" }) {
  const t = {
    neutral: "border-border text-muted-foreground",
    verified: "border-success/50 bg-success/10 text-success",
    unverified: "border-warning/50 bg-warning/10 text-warning",
    unknown: "border-muted-foreground/40 border-dashed text-muted-foreground",
    warn: "border-destructive/50 bg-destructive/10 text-destructive",
  }[tone];
  return <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${t}`}>{children}</span>;
}

export function Section({ id, title, badge, intro, children }: { id: string; title: string; badge: ReactNode; intro: string; children: ReactNode }) {
  return (
    <section aria-labelledby={`${id}-h`} id={id} className="rounded-xl border border-border bg-card p-5">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <h2 id={`${id}-h`} className="text-lg font-semibold">{title}</h2>
        {badge}
      </div>
      <p className="mb-4 text-xs text-muted-foreground">{intro}</p>
      {children}
    </section>
  );
}

export const formatValue = (e: Pick<ViewEvidence, "value" | "unit">) =>
  e.unit === "USD" ? `$${e.value.toLocaleString("en-US")}` : e.unit === "%" ? `${e.value}%` : `${e.value.toLocaleString("en-US")} ${e.unit}`;

/** The authorized records behind a statement. Ids that are not in `evidence` are not rendered (the server only sends records the caller may see). */
export function EvidenceTable({ ids, evidence, caption }: { ids: readonly string[]; evidence: Record<string, ViewEvidence>; caption: string }) {
  const rows = [...new Set(ids)].map((id) => evidence[id]).filter((e): e is ViewEvidence => !!e);
  if (!rows.length) return <p className="text-xs text-muted-foreground">No authorized records are cited here.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs">
        <caption className="sr-only">{caption}</caption>
        <thead className="text-[10px] uppercase tracking-widest text-muted-foreground">
          <tr><th scope="col" className="py-1 pr-3">Record</th><th scope="col" className="pr-3">Metric</th><th scope="col" className="pr-3">Period</th><th scope="col" className="pr-3">Value</th><th scope="col" className="pr-3">Date</th><th scope="col">Source</th></tr>
        </thead>
        <tbody>
          {rows.map((e) => (
            <tr key={e.id} className="border-t border-border/60 align-top">
              <th scope="row" className="py-1 pr-3 font-mono font-normal text-accent">{e.id}</th>
              <td className="pr-3">{e.metricLabel}</td><td className="pr-3">{e.periodLabel}</td><td className="pr-3 font-semibold">{formatValue(e)}</td><td className="pr-3">{e.date}</td><td className="text-muted-foreground">{e.source}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
