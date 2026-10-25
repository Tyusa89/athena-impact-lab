import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { COMPANY, METRIC_LABELS, ROLES, SCENARIOS, WORKSPACES, type EvidenceRecord } from "@/lib/athena/data";
import { analyze, filterVisible, DEMO_QUESTION, type Signal } from "@/lib/athena/engine";
import { approvalReducer, decisionOf } from "@/lib/athena/approvals";
import { useReducer } from "react";
import { PROVIDERS } from "@/lib/athena/provider";
import { MetaPanel } from "@/components/MetaPanel";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Athena Business Impact Engine — Hackathon Lab" },
      { name: "description", content: "Evidence-linked cross-department reasoning demo on synthetic data. Not connected to EcoNest." },
      { property: "og:title", content: "Athena Business Impact Engine — Hackathon Lab" },
      { property: "og:description", content: "Synthetic-data demo: why sales decline while leads rise." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Index,
});

const statusStyle: Record<Signal["status"], string> = {
  observed: "border-success/50 bg-success/10 text-success",
  "not-observed": "border-muted-foreground/30 bg-muted text-muted-foreground",
  "not-visible": "border-warning/50 bg-warning/10 text-warning",
};

function Pill({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${className}`}>{children}</span>;
}
function Ids({ ids }: { ids: string[] }) {
  return (
    <div className="mt-2 flex flex-wrap gap-1">
      {ids.map((id) => (
        <a key={id} href={`#rec-${id}`} className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-accent hover:underline">{id}</a>
      ))}
    </div>
  );
}
function Section({ title, tag, children }: { title: string; tag?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-border bg-card p-5">
      <div className="mb-4 flex items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">{title}</h2>
        {tag && <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">{tag}</span>}
      </div>
      {children}
    </section>
  );
}

function fmt(r: { value: number; unit: string }) {
  return r.unit === "USD" ? `$${r.value.toLocaleString()}` : `${r.value.toLocaleString()} ${r.unit}`;
}

function Index() {
  const [scenarioId, setScenarioId] = useState(SCENARIOS[0]!.id);
  const [roleId, setRoleId] = useState(ROLES[0]!.id);
  const [ws, setWs] = useState<string[]>(ROLES[0]!.workspaces);
  const [approvals, dispatch] = useReducer(approvalReducer, {});
  const [providerId, setProviderId] = useState("deterministic");

  const scenario = SCENARIOS.find((s) => s.id === scenarioId)!;
  const a = useMemo(() => analyze(scenario.records, ws), [scenario, ws]);
  const visible: EvidenceRecord[] = filterVisible(scenario.records, ws);
  const provider = PROVIDERS.find((p) => p.id === providerId)!;

  const tests = useMemo(() => {
    return SCENARIOS.flatMap((s) =>
      ROLES.map((r) => {
        const out = JSON.stringify(analyze(s.records, r.workspaces));
        const leaked = s.records.filter((x) => !r.workspaces.includes(x.workspace) && (out.includes(x.id) || out.includes(x.source) && !filterVisible(s.records, r.workspaces).some((v) => v.source === x.source))).length;
        return { name: `${s.name} × ${r.label}`, pass: leaked === 0 };
      }),
    );
  }, []);

  const pickRole = (id: string) => { setRoleId(id); setWs(ROLES.find((r) => r.id === id)!.workspaces); dispatch({ type: "reset" }); };
  const toggleWs = (id: string) => { setRoleId("custom"); dispatch({ type: "reset" }); setWs((w) => (w.includes(id) ? w.filter((x) => x !== id) : [...w, id])); };

  return (
    <div className="min-h-screen bg-background bg-hero font-sans">
      <div className="sticky top-0 z-20 border-b border-destructive/40 bg-destructive/90 py-1.5 text-center font-mono text-xs font-semibold tracking-widest text-destructive-foreground">
        SIMULATED DATA — NOT CONNECTED TO ECONEST
      </div>
      <main className="mx-auto max-w-7xl space-y-6 px-4 py-8 sm:px-6">
        <header className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="font-mono text-xs uppercase tracking-[0.3em] text-primary">EcoNest · Hackathon Lab · Prototype</p>
            <h1 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">Athena Business Impact Engine</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Company: <span className="font-semibold text-foreground">{COMPANY.name}</span> <Pill className="ml-1 border-warning/50 text-warning">{COMPANY.label}</Pill>
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs text-muted-foreground">Scenario
              <select value={scenarioId} onChange={(e) => { setScenarioId(e.target.value); dispatch({ type: "reset" }); }} className="mt-1 block w-full rounded-md border border-input bg-secondary px-3 py-2 text-sm text-foreground">
                {SCENARIOS.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </label>
            <label className="text-xs text-muted-foreground">Simulated role
              <select value={roleId} onChange={(e) => pickRole(e.target.value)} className="mt-1 block w-full rounded-md border border-input bg-secondary px-3 py-2 text-sm text-foreground">
                {ROLES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
                {roleId === "custom" && <option value="custom">Custom</option>}
              </select>
            </label>
          </div>
        </header>

        <div className="rounded-xl border border-primary/40 bg-primary/5 p-5">
          <p className="font-mono text-xs uppercase tracking-widest text-primary">Question</p>
          <p className="mt-1 text-xl font-semibold">“{DEMO_QUESTION}”</p>
          <p className="mt-2 text-sm text-muted-foreground">{scenario.description}</p>
          <div className="mt-3 flex flex-wrap gap-2 text-xs">
            <Pill className="border-border">Evidence coverage: <b className="ml-1 text-foreground">{a.evidenceCoverage}</b></Pill>
            <Pill className="border-border">{a.visibleRecordCount} records in your visible workspaces</Pill>
            <Pill className="border-warning/50 text-warning">Causal links unverified</Pill>
          </div>
        </div>

        <Section title="Evidence-linked business signals" tag="observed metric changes · not causal">
          <p className="-mt-2 mb-4 text-xs text-muted-foreground">Each card reports whether an expected metric change was observed in visible records. Observing a change does not establish that it caused the next one — see the unverified hypotheses below.</p>
          <ol className="grid gap-3 md:grid-cols-5">
            {a.signals.map((c, i) => (
              <li key={c.key} className={`relative rounded-lg border p-3 ${statusStyle[c.status]}`}>
                <div className="font-mono text-[10px] uppercase tracking-widest opacity-80">Signal {i + 1} · {c.status.replace(/-/g, " ")}</div>
                <div className="mt-1 font-semibold text-foreground">{c.title}</div>
                <p className="mt-1 text-xs text-muted-foreground">{c.detail}</p>
                <Ids ids={c.evidenceIds} />
              </li>
            ))}
          </ol>
        </Section>

        <div className="grid gap-6 lg:grid-cols-3">
          <Section title="Observed facts" tag="from records">
            <ul className="space-y-3">
              {a.facts.map((f) => (
                <li key={f.metric} className="rounded-md bg-secondary p-3">
                  <div className="flex justify-between text-sm"><span>{f.label}</span>
                    <span className={f.direction === "flat" ? "text-muted-foreground" : f.direction === "up" ? "text-accent" : "text-destructive"}>{f.changePct === null ? "n/a" : `${f.changePct > 0 ? "+" : ""}${f.changePct}%`}{f.changePp !== null && ` (${f.changePp > 0 ? "+" : ""}${f.changePp} pp)`}</span></div>
                  <Ids ids={f.evidenceIds} />
                </li>
              ))}
              {a.facts.length === 0 && <p className="text-sm text-muted-foreground">No visible records.</p>}
            </ul>
          </Section>
          <Section title="Hypotheses (UNVERIFIED)" tag="not causal evidence">
            <ul className="space-y-3">
              {a.hypotheses.map((h) => (
                <li key={h.title} className="rounded-md bg-secondary p-3">
                  <div className="flex items-start justify-between gap-2"><span className="text-sm font-semibold">{h.title}</span><Pill className="shrink-0 border-warning/50 text-warning">Unverified · {h.plausibility} plausibility</Pill></div>
                  <p className="mt-1 text-xs text-muted-foreground">{h.reasoning}</p>
                  <Ids ids={h.evidenceIds} />
                </li>
              ))}
              {a.hypotheses.length === 0 && <p className="text-sm text-muted-foreground">No hypotheses: visible records do not show the required co-movement.</p>}
            </ul>
            <h3 className="mt-5 text-sm font-semibold">Alternative explanations</h3>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-muted-foreground">{a.alternatives.map((x) => <li key={x}>{x}</li>)}</ul>
          </Section>
          <Section title="Recommended actions" tag="human approval required">
            <p className="-mt-2 mb-3 rounded-md border border-warning/40 bg-warning/10 p-2 text-xs text-warning">Simulation only. Approve/Reject change a local on-screen status and execute nothing — no system, person, budget or order is affected.</p>
            <ul className="space-y-3">
              {a.actions.map((x) => {
                const st = decisionOf(approvals, x.id);
                return (
                  <li key={x.id} className="rounded-md bg-secondary p-3">
                    <div className="font-mono text-[10px] text-muted-foreground">{x.id} · {x.owner}</div>
                    <div className="text-sm font-semibold">{x.title}</div>
                    <p className="text-xs text-muted-foreground">{x.rationale}</p>
                    <Ids ids={x.evidenceIds} />
                    <div className="mt-3 flex items-center gap-2">
                      {st !== "pending" ? <><Pill className={st === "approved" ? "border-success/50 text-success" : "border-destructive/50 text-destructive"}>Simulated {st} · nothing executed</Pill>
                        <button onClick={() => dispatch({ type: "undo", id: x.id })} className="text-[10px] text-muted-foreground underline">Undo</button></> : <>
                        <button onClick={() => dispatch({ type: "approve", id: x.id })} className="rounded-md bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground hover:opacity-90">Simulate approve</button>
                        <button onClick={() => dispatch({ type: "reject", id: x.id })} className="rounded-md border border-border px-3 py-1 text-xs hover:bg-muted">Simulate reject</button>
                        <span className="text-[10px] text-warning">Pending (simulated)</span></>}
                    </div>
                  </li>
                );
              })}
              {a.actions.length === 0 && <p className="text-sm text-muted-foreground">No actions proposed.</p>}
            </ul>
          </Section>
        </div>

        <Section title="Confidence & limitations">
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">{a.limitations.map((l) => <li key={l}>{l}</li>)}</ul>
        </Section>

        <Section title="Department evidence cards" tag="visible records only">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {(["Marketing", "Sales", "Operations", "Finance"] as const).map((d) => {
              const rs = visible.filter((r) => r.department === d);
              return (
                <div key={d} className="rounded-lg border border-border bg-secondary/50 p-3">
                  <h3 className="font-semibold">{d}</h3>
                  {rs.length === 0 ? <p className="mt-2 text-xs text-warning">Not in your visible workspaces (simulated).</p> :
                    <ul className="mt-2 space-y-2">{rs.map((r) => (
                      <li id={`rec-${r.id}`} key={r.id} className="scroll-mt-16 rounded border border-border bg-card p-2 text-xs target:border-primary">
                        <div className="flex justify-between font-mono text-[10px] text-accent"><span>{r.id}</span><span className="text-muted-foreground">{r.date}</span></div>
                        <div className="mt-1 text-foreground">{METRIC_LABELS[r.metric]} ({r.period === "prior" ? "Q2" : "Q3"} 2026): <b>{fmt(r)}</b></div>
                        <div className="text-[10px] text-muted-foreground">Source: {r.source}</div>
                        {r.note && <div className="mt-1 text-[10px] italic text-muted-foreground">{r.note}</div>}
                      </li>))}</ul>}
                </div>
              );
            })}
          </div>
        </Section>

        <div className="grid gap-6 lg:grid-cols-2">
          <Section title="Workspace visibility (simulated)" tag="no real auth">
            <p className="mb-3 text-sm text-muted-foreground">Roles map to workspaces. Records outside visible workspaces are filtered <i>before</i> analysis, so they can never be cited. <b className="text-warning">This is a client-side simulation only. No real server authorization is provided</b>; anyone with the page code could read all synthetic records. The optional Meta path re-derives its scope on the server from a fixed demo role list, but there is no sign-in, so anyone can claim any role. Neither is production authorization; a production system must authenticate users and enforce access on the server.</p>
            <div className="flex flex-wrap gap-2">
              {WORKSPACES.map((w) => (
                <button key={w.id} onClick={() => toggleWs(w.id)} className={`rounded-full border px-3 py-1 text-xs ${ws.includes(w.id) ? "border-accent bg-accent/15 text-accent" : "border-border text-muted-foreground line-through"}`}>{w.label}</button>
              ))}
            </div>
          </Section>
          <Section title="Analysis source" tag="local by default">
            <select value={providerId} onChange={(e) => setProviderId(e.target.value)} className="w-full rounded-md border border-input bg-secondary px-3 py-2 text-sm">
              {PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
            <p className="mt-3 text-sm text-muted-foreground">
              {provider.status === "active"
                ? "Active: all analysis above is computed locally by the deterministic rules engine in your browser. It makes no network or API calls."
                : "Placeholder only: this summary-provider slot is not wired to any model, and selecting it changes nothing. Optional live Meta API analysis is a separate, off-by-default, per-run confirmed action in the comparison panel below. The analysis above stays local and deterministic."}
            </p>
          </Section>
        </div>

        <Section title="Deterministic vs Meta comparison" tag="disabled unless owner-activated">
          <MetaPanel scenarioId={scenarioId} roleId={roleId} workspaces={ws} analysis={a} />
        </Section>

        <Section title="Permission leak checks (live, in-browser)" tag={`${tests.filter((t) => t.pass).length}/${tests.length} passing`}>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {tests.map((t) => (
              <div key={t.name} className="flex items-center justify-between rounded-md bg-secondary px-3 py-2 text-xs">
                <span>{t.name}</span><Pill className={t.pass ? "border-success/50 text-success" : "border-destructive/50 text-destructive"}>{t.pass ? "PASS" : "FAIL"}</Pill>
              </div>
            ))}
          </div>
        </Section>

        <footer className="pb-6 text-center text-xs text-muted-foreground">Isolated prototype · synthetic data · no EcoNest connection · analysis runs locally; the optional live Meta call is off by default</footer>
      </main>
    </div>
  );
}
