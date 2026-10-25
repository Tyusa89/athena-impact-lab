import { useEffect, useRef, useState } from "react";
import type { WorkbenchDatasetInfo, WorkbenchRequest, WorkbenchResult, ImpactView } from "@/lib/athena/workbench/view";
import { createRequestGate } from "@/lib/athena/meta/requestGate";
import { Badge } from "./parts";
import { ImpactGraph, type Selection } from "./ImpactGraph";
import { DetailPanel, Sections, TextAlternative } from "./ImpactSections";

type State = { phase: "idle" } | { phase: "loading" } | { phase: "error"; message: string } | { phase: "blocked"; reason: string } | { phase: "ok"; view: ImpactView };
const QUESTION_MAX = 300;
const selectCls = "mt-1 block w-full rounded-md border border-input bg-secondary px-3 py-2 text-sm text-foreground";

/** The interactive Business Impact Map. It presents what the server returns and decides nothing: the dataset, scenario and role it sends are ids the server checks
 * against its own allowlists, and the roles are simulated (a claim, not authentication). Replaceable `run` makes it independent of how the server is reached. */
export function ImpactWorkbench({ datasets, run }: { datasets: WorkbenchDatasetInfo[]; run: (req: WorkbenchRequest) => Promise<WorkbenchResult> }) {
  const [datasetId, setDatasetId] = useState(datasets[0]?.id ?? "");
  const dataset = datasets.find((d) => d.id === datasetId) ?? datasets[0];
  const [scenarioId, setScenarioId] = useState(dataset?.scenarios[0]?.id ?? "");
  const [roleId, setRoleId] = useState(dataset?.roles[0]?.id ?? "");
  const [question, setQuestion] = useState(dataset?.defaultQuestion ?? "");
  const [state, setState] = useState<State>({ phase: "idle" });
  const [selection, setSelection] = useState<Selection>(null);
  const gate = useRef(createRequestGate()).current;
  useEffect(() => () => gate.invalidate(), [gate]);

  if (!dataset) return <p role="alert" className="p-6 text-sm">No datasets are available.</p>;

  const reset = () => { gate.invalidate(); setState({ phase: "idle" }); setSelection(null); };
  const pickDataset = (id: string) => {
    const d = datasets.find((x) => x.id === id)!;
    setDatasetId(id); setScenarioId(d.scenarios[0]?.id ?? ""); setRoleId(d.roles[0]?.id ?? ""); setQuestion(d.defaultQuestion); reset();
  };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (state.phase === "loading") return;
    const key = JSON.stringify([datasetId, scenarioId, roleId, question]);
    const ticket = gate.begin(key);
    setState({ phase: "loading" }); setSelection(null);
    let res: WorkbenchResult | null = null;
    try { res = await run({ datasetId, scenarioId, roleId, ...(question.trim() ? { question } : {}) }); } catch { res = null; }
    if (!gate.isCurrent(ticket, key)) return; // the selection changed while this was in flight: ignore the late answer
    setState(res === null ? { phase: "error", message: "The analysis could not be reached. Nothing was computed." } : res.state === "ok" ? { phase: "ok", view: res.view } : { phase: "blocked", reason: res.reason });
  };
  const select = (s: Selection) => setSelection((cur) => (cur && s && cur.kind === s.kind && cur.id === s.id ? null : s));

  return (
    <div className="space-y-6">
      <form onSubmit={submit} aria-label="Ask the engine" className="rounded-xl border border-primary/40 bg-primary/5 p-5">
        <div className="grid gap-3 md:grid-cols-3">
          <label className="text-xs text-muted-foreground">Dataset
            <select value={datasetId} onChange={(e) => pickDataset(e.target.value)} className={selectCls}>{datasets.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
          </label>
          <label className="text-xs text-muted-foreground">Scenario
            <select value={scenarioId} onChange={(e) => { setScenarioId(e.target.value); reset(); }} className={selectCls}>{dataset.scenarios.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select>
          </label>
          <label className="text-xs text-muted-foreground">Simulated role
            <select value={roleId} onChange={(e) => { setRoleId(e.target.value); reset(); }} className={selectCls}>{dataset.roles.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}</select>
          </label>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">{dataset.description} <Badge tone="unverified">{dataset.notice}</Badge></p>
        <p className="mt-1 text-xs text-muted-foreground">{dataset.scenarios.find((s) => s.id === scenarioId)?.description} {dataset.roles.find((r) => r.id === roleId)?.description}</p>
        <label className="mt-4 block text-xs font-semibold uppercase tracking-widest text-primary" htmlFor="impact-question">Business question</label>
        <textarea id="impact-question" value={question} maxLength={QUESTION_MAX} rows={2} onChange={(e) => { setQuestion(e.target.value); reset(); }} className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />
        <div className="mt-2 flex flex-wrap gap-2" aria-label="Suggested questions">
          {dataset.suggestedQuestions.map((q) => <button key={q} type="button" onClick={() => { setQuestion(q); reset(); }} className="rounded-full border border-border px-3 py-1 text-xs hover:bg-muted">{q}</button>)}
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button type="submit" disabled={state.phase === "loading"} className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-60">{state.phase === "loading" ? "Running…" : "Run impact analysis"}</button>
          <span className="text-xs text-muted-foreground">Deterministic: computed by the engine from authorized records. No AI model is called.</span>
        </div>
      </form>

      <div aria-live="polite" aria-busy={state.phase === "loading"} data-testid="status">
        {state.phase === "idle" && <p className="rounded-xl border border-dashed border-border p-6 text-sm text-muted-foreground">Choose a dataset, scenario, role and question, then run the analysis.</p>}
        {state.phase === "loading" && <p className="rounded-xl border border-border p-6 text-sm text-muted-foreground">Running the engine…</p>}
        {state.phase === "error" && <p role="alert" className="rounded-xl border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">{state.message}</p>}
        {state.phase === "blocked" && <p role="alert" className="rounded-xl border border-warning/50 bg-warning/10 p-4 text-sm text-warning">{state.reason}</p>}
      </div>

      {state.phase === "ok" && (
        <div className="space-y-6" data-testid="result">
          <p className="text-sm text-muted-foreground" data-testid="result-context">
            <b className="text-foreground">{state.view.context.datasetName}</b> · {state.view.context.scenarioName} · as <b className="text-foreground">{state.view.context.roleLabel}</b> (simulated role, not authenticated) · {state.view.period}
            {state.view.focus.length > 0 && <> · focus: {state.view.focus.join(", ")}</>}
          </p>
          <section aria-labelledby="map-h" className="rounded-xl border border-border bg-card p-5">
            <h2 id="map-h" className="text-lg font-semibold">Relationship map</h2>
            <p className="mb-3 text-xs text-muted-foreground">Metrics you are authorized to discover, and the relationships the operator declared between them. Select one to inspect it.</p>
            <ImpactGraph view={state.view} selection={selection} onSelect={select} />
            <div className="mt-4 grid gap-4 lg:grid-cols-2">
              <TextAlternative view={state.view} selection={selection} onSelect={select} />
              <DetailPanel view={state.view} selection={selection} />
            </div>
          </section>
          <Sections view={state.view} onSelect={select} />
          <aside aria-label="Notices" className="rounded-xl border border-border bg-card p-5">
            <h2 className="text-lg font-semibold">Notices</h2>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted-foreground">{state.view.notices.map((n) => <li key={n}>{n}</li>)}</ul>
          </aside>
        </div>
      )}
    </div>
  );
}
