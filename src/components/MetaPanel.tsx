import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { getMetaStatus, runMetaComparison } from "@/lib/athena/meta.functions";
import type { MetaResult, MetaStatus } from "@/lib/athena/meta/adapter.server";
import type { Analysis } from "@/lib/athena/engine";
import { META_MODEL } from "@/lib/athena/meta/contract";

export function MetaPanel({ scenarioId, workspaces, analysis }: { scenarioId: string; workspaces: string[]; analysis: Analysis }) {
  const statusFn = useServerFn(getMetaStatus);
  const runFn = useServerFn(runMetaComparison);
  const [status, setStatus] = useState<MetaStatus | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<MetaResult | null>(null);

  useEffect(() => { statusFn().then(setStatus).catch(() => setStatus(null)); }, [statusFn]);
  useEffect(() => { setResult(null); setConfirm(false); }, [scenarioId, workspaces]);

  const canRun = !!status?.ready && confirm && !busy && workspaces.length > 0;
  const run = async () => {
    if (!canRun) return;
    setBusy(true);
    try { setResult(await runFn({ data: { scenarioId, workspaces, ownerConfirmed: true } })); }
    catch { setResult({ state: "error", reason: "Server function failed.", requestSent: false }); }
    finally { setBusy(false); }
  };

  const Row = ({ k, ok }: { k: string; ok: boolean | undefined }) => (
    <li className="flex justify-between"><span>{k}</span><span className={ok ? "text-success" : "text-warning"}>{ok ? "yes" : "no"}</span></li>
  );

  return (
    <div className="space-y-4 text-sm">
      <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-xs text-warning">
        Meta {META_MODEL} scaffold. <b>Disabled by default.</b> Requests run only on the server, with no retries, when the key and owner activation are set on the server <i>and</i> you confirm below. Only synthetic records from your visible workspaces are sent.
      </div>
      <ul className="space-y-1 rounded-md bg-secondary p-3 text-xs">
        <Row k="Server key META_MODEL_API_KEY configured" ok={status?.keyConfigured} />
        <Row k="Owner activation META_MODEL_ENABLED=true" ok={status?.ownerEnabled} />
        <li className="flex justify-between text-muted-foreground"><span>Token budget (input / output)</span><span>{status ? `${status.maxInputTokens} / ${status.maxOutputTokens}` : "—"}</span></li>
        <li className="flex justify-between text-muted-foreground"><span>Cost per run</span><span>Unknown — pricing not verified</span></li>
      </ul>
      <label className="flex items-start gap-2 text-xs">
        <input type="checkbox" disabled={!status?.ready} checked={confirm} onChange={(e) => setConfirm(e.target.checked)} className="mt-0.5" />
        <span className={status?.ready ? "" : "text-muted-foreground"}>I confirm sending one paid request with {workspaces.length} visible workspace(s) of synthetic data.</span>
      </label>
      <button onClick={run} disabled={!canRun} className="w-full rounded-md bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-40">
        {!status?.ready ? "Unavailable — not configured" : busy ? "Running…" : "Run one Meta comparison"}
      </button>

      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-md border border-border p-3">
          <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Deterministic (default)</p>
          <ul className="mt-2 list-disc space-y-1 pl-4 text-xs">
            {analysis.signals.filter((s) => s.status === "observed").map((s) => <li key={s.key}>{s.title}</li>)}
            {analysis.hypotheses.map((h) => <li key={h.title} className="text-warning">Unverified: {h.title}</li>)}
          </ul>
        </div>
        <div className="rounded-md border border-border p-3">
          <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Meta {META_MODEL}</p>
          {!result && <p className="mt-2 text-xs text-muted-foreground">No output. Nothing has been sent.</p>}
          {result && result.state !== "ok" && (
            <div className="mt-2 text-xs text-destructive">
              <b>{result.state}</b>{"reason" in result ? `: ${result.reason}` : ""}
              {"errors" in result && <ul className="list-disc pl-4">{result.errors.map((e) => <li key={e}>{e}</li>)}</ul>}
            </div>
          )}
          {result?.state === "ok" && (
            <div className="mt-2 space-y-2 text-xs">
              <ul className="list-disc pl-4">{result.output.observations.map((o) => <li key={o.text}>{o.text} <span className="font-mono text-accent">[{o.cited_ids.join(", ")}]</span></li>)}</ul>
              <ul className="list-disc pl-4 text-warning">{result.output.hypotheses.map((o) => <li key={o.text}>Unverified: {o.text}</li>)}</ul>
              <ul className="list-disc pl-4 text-muted-foreground">{result.output.missing_evidence.map((o) => <li key={o}>Missing: {o}</li>)}</ul>
              <ul className="list-disc pl-4">{result.output.recommendations.map((o) => <li key={o.text}>{o.text} <i className="text-muted-foreground">(needs human approval; not executable)</i></li>)}</ul>
            </div>
          )}
          {result && "usage" in result && result.usage && <p className="mt-2 text-[10px] text-muted-foreground">Tokens used: {result.usage.prompt_tokens ?? "?"} in / {result.usage.completion_tokens ?? "?"} out</p>}
        </div>
      </div>
    </div>
  );
}
