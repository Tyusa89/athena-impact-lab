import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ROLES, SCENARIOS } from "@/lib/athena/data";
import { analyze } from "@/lib/athena/engine";

// No network: the server functions are replaced by controllable fakes. Nothing here can reach the Meta API.
const statusFn = vi.fn();
const runFn = vi.fn();
vi.mock("@tanstack/react-start", () => ({ useServerFn: (fn: unknown) => fn }));
vi.mock("@/lib/athena/meta.functions", () => ({ getMetaStatus: (...a: unknown[]) => statusFn(...a), runMetaComparison: (...a: unknown[]) => runFn(...a) }));

import { MetaPanel } from "./MetaPanel";
import type { MetaResult } from "@/lib/athena/meta/adapter.server";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const finding = (fact_id: string, text: string) => ({ fact_id, metric: "revenue" as const, department: "Finance" as const, direction: "down" as const, text, supporting_ids: ["R1", "R2"] });
const ok = (text: string): MetaResult => ({
  state: "ok", requestSent: true, authorizedIds: ["R1", "R2"],
  findings: [finding("F-revenue", "SERVER-RENDERED finding for " + text)],
  output: {
    interpretations: [{ text, verified: false, refs: ["F-revenue"], supporting_ids: ["R1", "R2"] }],
    missing_evidence: [],
    recommendations: [{ text: "Review " + text, requires_human_approval: true, refs: ["F-revenue"], supporting_ids: ["R1", "R2"] }],
  },
});

const scenario = SCENARIOS[0]!;
const role = (id: string) => ROLES.find((r) => r.id === id)!;
type Props = { scenarioId: string; roleId: string; workspaces: string[] };
const exec: Props = { scenarioId: "baseline", roleId: "exec", workspaces: role("exec").workspaces };
const finance: Props = { scenarioId: "baseline", roleId: "finance", workspaces: role("finance").workspaces };

function ui(p: Props) {
  return <MetaPanel {...p} analysis={analyze(scenario.records, p.workspaces)} />;
}
async function ready() {
  await waitFor(() => expect(screen.getByRole("button", { name: /Run one Meta comparison/ })).toBeInTheDocument());
}
const confirmAndRun = async () => {
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: /Run one Meta comparison/ }));
  await act(async () => {});
};
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

beforeEach(() => {
  statusFn.mockReset().mockResolvedValue({ keyConfigured: true, ownerEnabled: true, ready: true, model: "muse-spark-1.3", maxInputTokens: 3000, maxOutputTokens: 2000 });
  runFn.mockReset();
});
afterEach(cleanup);

describe("MetaPanel — stale responses", () => {
  it("shows the response when nothing changed (control)", async () => {
    const d = deferred<MetaResult>();
    runFn.mockReturnValueOnce(d.promise);
    render(ui(exec));
    await ready();
    await confirmAndRun();
    expect(screen.getByRole("button", { name: /Running/ })).toBeDisabled();
    await act(async () => { d.resolve(ok("exec answer")); await d.promise; });
    expect(screen.getByText("exec answer")).toBeInTheDocument();
  });

  it("ignores a response that arrives after the role changed", async () => {
    const d = deferred<MetaResult>();
    runFn.mockReturnValueOnce(d.promise);
    const { rerender } = render(ui(exec));
    await ready();
    await confirmAndRun();
    rerender(ui(finance));
    await flush();
    await act(async () => { d.resolve(ok("STALE exec answer")); await d.promise; });
    expect(screen.queryByText(/STALE exec answer/)).not.toBeInTheDocument();
    expect(screen.getByText(/No Meta output for this role and scenario/)).toBeInTheDocument();
  });

  it("ignores a response that arrives after the scenario changed", async () => {
    const d = deferred<MetaResult>();
    runFn.mockReturnValueOnce(d.promise);
    const { rerender } = render(ui(exec));
    await ready();
    await confirmAndRun();
    rerender(ui({ ...exec, scenarioId: "ops-only" }));
    await flush();
    await act(async () => { d.resolve(ok("STALE baseline answer")); await d.promise; });
    expect(screen.queryByText(/STALE baseline answer/)).not.toBeInTheDocument();
  });

  it("ignores a late failure after a state change (no stale error shown)", async () => {
    const d = deferred<MetaResult>();
    runFn.mockReturnValueOnce(d.promise);
    const { rerender } = render(ui(exec));
    await ready();
    await confirmAndRun();
    rerender(ui(finance));
    await flush();
    await act(async () => { d.reject(new Error("boom")); await d.promise.catch(() => {}); });
    expect(screen.queryByText(/Server function failed/)).not.toBeInTheDocument();
  });

  it("clears an already-displayed result immediately when the role changes", async () => {
    runFn.mockResolvedValueOnce(ok("exec answer"));
    const { rerender } = render(ui(exec));
    await ready();
    await confirmAndRun();
    await waitFor(() => expect(screen.getByText("exec answer")).toBeInTheDocument());
    rerender(ui(finance));
    expect(screen.queryByText(/exec answer/)).not.toBeInTheDocument();
    // Switching back must not resurrect the old result either.
    rerender(ui(exec));
    await flush();
    expect(screen.queryByText(/exec answer/)).not.toBeInTheDocument();
  });

  it("does not leave the panel stuck in Running after a state change", async () => {
    runFn.mockReturnValueOnce(new Promise(() => {})); // never settles
    const { rerender } = render(ui(exec));
    await ready();
    await confirmAndRun();
    expect(screen.getByRole("button", { name: /Running/ })).toBeDisabled();
    rerender(ui(finance));
    await flush();
    expect(screen.getByRole("button", { name: /Run one Meta comparison/ })).toBeInTheDocument();
    expect(screen.getByRole("checkbox")).not.toBeChecked(); // confirmation must be re-given per role/scenario
  });

  it("overlapping requests: the earlier request resolving last cannot overwrite the current one", async () => {
    const a = deferred<MetaResult>();
    const b = deferred<MetaResult>();
    runFn.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const { rerender } = render(ui(exec));
    await ready();
    await confirmAndRun(); // request A (exec)
    rerender(ui(finance));
    await flush();
    await confirmAndRun(); // request B (finance)
    expect(runFn).toHaveBeenCalledTimes(2);
    expect(runFn.mock.calls[1]![0]).toEqual({ data: { scenarioId: "baseline", roleId: "finance", ownerConfirmed: true } });
    await act(async () => { b.resolve(ok("finance answer")); await b.promise; });
    await act(async () => { a.resolve(ok("STALE exec answer")); await a.promise; });
    expect(screen.getByText("finance answer")).toBeInTheDocument();
    expect(screen.queryByText(/STALE exec answer/)).not.toBeInTheDocument();
  });

  it("overlapping requests: the earlier request resolving first is also discarded", async () => {
    const a = deferred<MetaResult>();
    const b = deferred<MetaResult>();
    runFn.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const { rerender } = render(ui(exec));
    await ready();
    await confirmAndRun();
    rerender(ui(finance));
    await flush();
    await confirmAndRun();
    await act(async () => { a.resolve(ok("STALE exec answer")); await a.promise; });
    expect(screen.queryByText(/STALE exec answer/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Running/ })).toBeDisabled(); // B still in flight
    await act(async () => { b.resolve(ok("finance answer")); await b.promise; });
    expect(screen.getByText("finance answer")).toBeInTheDocument();
  });

  it("does not apply a response after unmount", async () => {
    const d = deferred<MetaResult>();
    runFn.mockReturnValueOnce(d.promise);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { unmount } = render(ui(exec));
    await ready();
    await confirmAndRun();
    unmount();
    await act(async () => { d.resolve(ok("late")); await d.promise; });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("MetaPanel — three lanes", () => {
  const runOk = async () => {
    runFn.mockResolvedValueOnce(ok("exec answer"));
    render(ui(exec));
    await ready();
    await confirmAndRun();
    await waitFor(() => expect(screen.getByRole("region", { name: "Verified findings" })).toBeInTheDocument());
  };
  it("renders verified findings, interpretations and proposed actions as separate labelled sections", async () => {
    await runOk();
    expect(screen.getByRole("region", { name: "Verified findings" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Muse Spark interpretations" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Proposed actions" })).toBeInTheDocument();
  });
  it("verified findings come from the server result, not from client-computed analysis", async () => {
    await runOk();
    const findings = screen.getByRole("region", { name: "Verified findings" });
    expect(findings).toHaveTextContent("SERVER-RENDERED finding for exec answer");
    expect(findings).toHaveTextContent("✓ verified");
  });
  it("model interpretations are never inside the verified section and are labelled unverified", async () => {
    await runOk();
    const findings = screen.getByRole("region", { name: "Verified findings" });
    const interp = screen.getByRole("region", { name: "Muse Spark interpretations" });
    expect(findings).not.toHaveTextContent(/^exec answer$/);
    expect(within(findings).queryByText("exec answer")).not.toBeInTheDocument();
    expect(interp).toHaveTextContent("unverified");
    expect(interp).toHaveTextContent(/UNVERIFIED hypotheses, not facts/);
    expect(interp).not.toHaveTextContent("✓ verified exec");
  });
  it("shows the supporting verified facts for each interpretation and each proposed action", async () => {
    await runOk();
    for (const name of ["Muse Spark interpretations", "Proposed actions"]) {
      const lane = screen.getByRole("region", { name });
      expect(lane).toHaveTextContent("Model cites these verified findings");
      expect(lane).toHaveTextContent("SERVER-RENDERED finding for exec answer");
      expect(lane).toHaveTextContent("[R1, R2]");
    }
  });
  it("proposed actions state they need human approval and are not executable", async () => {
    await runOk();
    expect(screen.getByRole("region", { name: "Proposed actions" })).toHaveTextContent("needs human approval; not executable");
  });
});

describe("MetaPanel — accuracy of model-authored content (S4)", () => {
  const dup = (): MetaResult => ({
    state: "ok", requestSent: true, authorizedIds: ["R1", "R2"],
    findings: [finding("F-revenue", "SERVER-RENDERED finding")],
    output: {
      interpretations: Array(2).fill({ text: "same sentence", verified: false as const, refs: ["F-revenue"], supporting_ids: ["R1", "R2"] }),
      missing_evidence: ["same gap", "same gap"],
      recommendations: Array(2).fill({ text: "same action", requires_human_approval: true as const, refs: ["F-revenue"], supporting_ids: ["R1", "R2"] }),
    },
  });
  const show = async (r: MetaResult) => {
    runFn.mockResolvedValueOnce(r);
    render(ui(exec));
    await ready();
    await confirmAndRun();
    await waitFor(() => expect(screen.getByRole("region", { name: "Verified findings" })).toBeInTheDocument());
  };
  it("says the MODEL cites the findings, and no longer claims the items are 'based on' verified findings", async () => {
    await show(ok("exec answer"));
    expect(screen.getAllByText("Model cites these verified findings").length).toBeGreaterThan(0);
    expect(screen.queryByText(/Based on verified findings/)).not.toBeInTheDocument();
  });
  it("labels missing-evidence text as model-generated and unverified, outside the verified section", async () => {
    const r = ok("exec answer");
    if (r.state === "ok") r.output.missing_evidence = ["Need attribution data by channel."];
    await show(r);
    const gaps = screen.getByRole("region", { name: "Gaps noted by the model" });
    expect(gaps).toHaveTextContent("model-generated");
    expect(gaps).toHaveTextContent("unverified");
    expect(gaps).toHaveTextContent("Need attribution data by channel.");
    expect(within(screen.getByRole("region", { name: "Verified findings" })).queryByText(/attribution/)).not.toBeInTheDocument();
  });
  it("omits the gaps section when the model noted none", async () => {
    await show(ok("exec answer"));
    expect(screen.queryByRole("region", { name: "Gaps noted by the model" })).not.toBeInTheDocument();
  });
  it("repeated identical model output renders every item without duplicate-key warnings", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await show(dup());
    expect(within(screen.getByRole("region", { name: "Muse Spark interpretations" })).getAllByText("same sentence")).toHaveLength(2);
    expect(within(screen.getByRole("region", { name: "Proposed actions" })).getAllByText(/same action/)).toHaveLength(2);
    expect(within(screen.getByRole("region", { name: "Gaps noted by the model" })).getAllByText("same gap")).toHaveLength(2);
    expect(spy.mock.calls.filter((c) => /same key|unique "key"/i.test(String(c[0])))).toEqual([]);
    spy.mockRestore();
  });
  it("repeated identical validation errors also render without key collisions", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    runFn.mockResolvedValueOnce({ state: "rejected", requestSent: true, errors: ["same error", "same error"] } satisfies MetaResult);
    render(ui(exec));
    await ready();
    await confirmAndRun();
    await waitFor(() => expect(screen.getAllByText("same error")).toHaveLength(2));
    expect(spy.mock.calls.filter((c) => /same key|unique "key"/i.test(String(c[0])))).toEqual([]);
    spy.mockRestore();
  });
});

describe("MetaPanel — labels", () => {
  it("distinguishes local deterministic analysis from optional live Meta analysis, and keeps the role warning", async () => {
    render(ui(exec));
    await ready();
    expect(screen.getByText(/Local deterministic analysis/)).toBeInTheDocument();
    expect(screen.getByText(/no network/)).toBeInTheDocument();
    expect(screen.getByText(/Optional live Meta API analysis/)).toBeInTheDocument();
    expect(screen.getByText(/off by default/)).toBeInTheDocument();
    expect(screen.getByText(/It is a paid call/)).toBeInTheDocument();
    expect(screen.getByText(/NOT REAL AUTHORIZATION/)).toBeInTheDocument();
  });
});
