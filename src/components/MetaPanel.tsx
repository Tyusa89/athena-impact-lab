import { useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { getMetaStatus, runMetaComparison } from "@/lib/athena/meta.functions";
import type { MetaResult, MetaStatus } from "@/lib/athena/meta/adapter.server";
import type { Analysis } from "@/lib/athena/engine";
import { META_MODEL } from "@/lib/athena/meta/contract";
import { createRequestGate, scopeKey, visibleFor, type Tagged } from "@/lib/athena/meta/requestGate";

export function MetaPanel({ scenarioId, roleId, workspaces, analysis }: { scenarioId: string; roleId: string; workspaces: string[]; analysis: Analysis }) {
  const statusFn = useServerFn(getMetaStatus);
  const runFn = useServerFn(runMetaComparison);
  const [status, setStatus] = useState<MetaStatus | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tagged, setTagged] = useState<Tagged<MetaResult> | null>(null);
  const gate = useRef(createRequestGate()).current;

  // A response may only be shown for the exact role/scenario/workspace scope it was requested under.
  const liveKey = scopeKey({ scenarioId, roleId, workspaces });
  const liveKeyRef = useRef(liveKey);
  liveKeyRef.current = liveKey;
  const result = visibleFor(tagged, liveKey);

  useEffect(() => { statusFn().then(setStatus).catch(() => setStatus(null)); }, [statusFn]);
  // Scope change: drop any in-flight request (its late response is ignored), clear output, confirmation and busy state.
  useEffect(() => { gate.invalidate(); setTagged(null); setConfirm(false); setBusy(false); }, [liveKey, gate]);
  useEffect(() => () => gate.invalidate(), [gate]);

  const isCustom = roleId === "custom";
  const canRun = !!status?.ready && confirm && !busy && !isCustom;
  const run = async () => {
    if (!canRun) return;
    const key = liveKey;
    const ticket = gate.begin(key);
    setBusy(true);
    let next: MetaResult;
    try { next = await runFn({ data: { scenarioId, roleId, ownerConfirmed: true } }); }
    catch { next = { state: "error", reason: "Server function failed.", requestSent: false }; }
    if (!gate.isCurrent(ticket, liveKeyRef.current)) return; // stale: role, scenario or request changed while in flight
    setTagged({ key, value: next });
    setBusy(false);
  };

  const Row = ({ k, ok }: { k: string; ok: boolean | undefined }) => (
    <li className="flex justify-between"><span>{k}</span><span className={ok ? "text-success" : "text-warning"}>{ok ? "yes" : "no"}</span></li>
  );

  return (
    <div className="space-y-4 text-sm">
      <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-xs text-warning">
        <b>Optional live Meta API analysis ({META_MODEL}) — off by default.</b> The deterministic analysis on the left runs locally and never calls any API. A live Meta request is made only if the server key and owner activation are set <i>and</i> you confirm below; it runs on the server, once, with no retries, and sends only synthetic records from your visible workspaces to the Meta API. It is a paid call.
      </div>
      <ul className="space-y-1 rounded-md bg-secondary p-3 text-xs">
        <Row k="Server key META_MODEL_API_KEY configured" ok={status?.keyConfigured} />
        <Row k="Owner activation META_MODEL_ENABLED=true" ok={status?.ownerEnabled} />
        <li className="flex justify-between text-muted-foreground"><span>Hard token cap (input / output incl. hidden reasoning)</span><span>{status ? `${status.maxInputTokens} / ${status.maxOutputTokens}` : "—"}</span></li>
        <li className="flex justify-between text-muted-foreground"><span>Cost per run</span><span>Unknown — pricing not verified</span></li>
      </ul>
      <p className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive"><b>DEMO ROLE FILTERING ONLY — NOT REAL AUTHORIZATION.</b> The server sends only the records its own fixed role list allows, and ignores any workspace list from the browser. But there is no sign-in, so anyone can claim any demo role. Not safe for real data.</p>
      {isCustom && <p className="text-xs text-warning">Custom workspace toggles are on-screen only. Pick a named role to run Meta.</p>}
      <label className="flex items-start gap-2 text-xs">
        <input type="checkbox" disabled={!status?.ready || isCustom} checked={confirm} onChange={(e) => setConfirm(e.target.checked)} className="mt-0.5" />
        <span className={status?.ready ? "" : "text-muted-foreground"}>I confirm sending one paid request with {workspaces.length} visible workspace(s) of synthetic data.</span>
      </label>
      <button onClick={run} disabled={!canRun} className="w-full rounded-md bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-40">
        {!status?.ready ? "Unavailable — not configured" : busy ? "Running…" : "Run one Meta comparison"}
      </button>

      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-md border border-border p-3">
          <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Local deterministic analysis (default · no network)</p>
          <ul className="mt-2 list-disc space-y-1 pl-4 text-xs">
            {analysis.signals.filter((s) => s.status === "observed").map((s) => <li key={s.key}>{s.title}</li>)}
            {analysis.hypotheses.map((h) => <li key={h.title} className="text-warning">Unverified: {h.title}</li>)}
          </ul>
        </div>
        <div className="rounded-md border border-border p-3">
          <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Live Meta API analysis · {META_MODEL} (optional)</p>
          {!result && <p className="mt-2 text-xs text-muted-foreground">No Meta output for this role and scenario.</p>}
          {result && result.state !== "ok" && (
            <div className="mt-2 text-xs text-destructive">
              <b>{result.state}</b>{"reason" in result ? `: ${result.reason}` : ""}
              {"errors" in result && <ul className="list-disc pl-4">{result.errors.map((e) => <li key={e}>{e}</li>)}</ul>}
            </div>
          )}
          {result?.state === "ok" && (
            <div className="mt-2 space-y-2 text-xs">
              <ul className="list-disc pl-4">{result.output.observations.map((o) => <li key={o.text}>{o.text} <span className="font-mono text-accent">[{o.cited_ids.join(", ")}]</span>{o.claims.map((c) => <span key={`${c.fact_id}-${c.kind}-${c.period ?? ""}`} className="ml-1 rounded bg-success/10 px-1 font-mono text-[10px] text-success">✓ verified {c.metric} {c.kind}{c.period ? ` ${c.period}` : ""} = {c.value} {c.unit}</span>)}</li>)}</ul>
              <ul className="list-disc pl-4 text-warning">{result.output.hypotheses.map((o) => <li key={o.text}>Unverified: {o.text}</li>)}</ul>
              <ul className="list-disc pl-4 text-muted-foreground">{result.output.missing_evidence.map((o) => <li key={o}>Missing: {o}</li>)}</ul>
              <ul className="list-disc pl-4">{result.output.recommendations.map((o) => <li key={o.text}>{o.text} <i className="text-muted-foreground">(needs human approval; not executable)</i></li>)}</ul>
            </div>
          )}
          {result && "usage" in result && result.usage && <p className="mt-2 text-[10px] text-muted-foreground">Tokens: {result.usage.prompt_tokens ?? "?"} in / {result.usage.completion_tokens ?? "?"} out of {result.usage.max_tokens_sent} cap (hidden reasoning: {result.usage.reasoning_tokens ?? "not reported"}; visible: {result.usage.visible_output_tokens ?? "?"}) · finish: {result.usage.finish_reason ?? "?"}</p>}
        </div>
      </div>
    </div>
  );
}
