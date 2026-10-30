import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { ImpactWorkbench } from "@/components/impact/ImpactWorkbench";
import { getWorkbenchOptions, runImpactWorkbench } from "@/lib/athena/workbench/workbench.functions";
import type { WorkbenchDatasetInfo, WorkbenchRequest, WorkbenchResult } from "@/lib/athena/workbench/view";

export const Route = createFileRoute("/impact")({
  head: () => ({
    meta: [
      { title: "Business Impact Map — Tindara" },
      { name: "description", content: "Ask a business question and investigate verified changes, observed relationships, hypotheses, missing evidence and proposed actions. Synthetic data; no AI model." },
    ],
  }),
  component: ImpactPage,
});

function ImpactPage() {
  const optionsFn = useServerFn(getWorkbenchOptions);
  const runFn = useServerFn(runImpactWorkbench);
  const [datasets, setDatasets] = useState<WorkbenchDatasetInfo[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => { optionsFn().then(setDatasets).catch(() => setFailed(true)); }, [optionsFn]);
  const run = (req: WorkbenchRequest): Promise<WorkbenchResult> => runFn({ data: req });

  return (
    <div className="min-h-screen bg-background bg-hero font-sans">
      <div className="sticky top-0 z-20 border-b border-destructive/40 bg-destructive/90 py-1.5 text-center font-mono text-xs font-semibold tracking-widest text-destructive-foreground">
        SYNTHETIC DATA · SIMULATED ROLES (NOT AUTHENTICATED) · NO AI MODEL · NOT CONNECTED TO ECONEST
      </div>
      <main className="mx-auto max-w-6xl space-y-6 px-4 py-8 sm:px-6">
        <header>
          <p className="font-mono text-xs uppercase tracking-[0.3em] text-primary">Tindara · AI Business Reasoning Engine</p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">Business Impact Map</h1>
          <p className="mt-2 max-w-3xl text-sm text-muted-foreground">Ask a business question. The engine reports what the verified data show, which declared relationships moved together, what is only a hypothesis, what evidence is missing, and what could be proposed for human approval. Roles here are simulated to show scope: there is no sign-in. <Link to="/" className="text-accent underline">Back to the prototype</Link></p>
        </header>
        {failed && <p role="alert" className="rounded-xl border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">The available datasets could not be loaded.</p>}
        {!failed && !datasets && <p className="text-sm text-muted-foreground">Loading…</p>}
        {datasets && <ImpactWorkbench datasets={datasets} run={run} />}
      </main>
    </div>
  );
}
