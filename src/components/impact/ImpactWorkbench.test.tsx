import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CAUSAL_WORDS } from "@/lib/athena/meta/impact";
import { runWorkbench, workbenchOptions } from "@/lib/athena/workbench/workbench.server";
import type { WorkbenchRequest, WorkbenchResult } from "@/lib/athena/workbench/view";
import { ImpactWorkbench } from "./ImpactWorkbench";

// The interface presents server results and decides nothing. Here `run` is the real server module (no network, no model) unless a test substitutes a fake.
const tripwire = vi.fn(() => { throw new Error("network call attempted"); });
vi.stubGlobal("fetch", tripwire);
afterEach(() => { cleanup(); tripwire.mockClear(); });

const datasets = workbenchOptions();
const real = (req: WorkbenchRequest) => runWorkbench(req);
const FULL = "Give me the complete picture of this period.";
const deferred = <T,>() => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };

async function open(run = real) {
  render(<ImpactWorkbench datasets={datasets} run={run} />);
}
const choose = (label: RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const ask = async (q = FULL) => {
  fireEvent.change(screen.getByLabelText(/Business question/), { target: { value: q } });
  fireEvent.click(screen.getByRole("button", { name: "Run impact analysis" }));
  await waitFor(() => expect(screen.queryByText("Running the engine…")).not.toBeInTheDocument());
};
const headings = () => screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);

describe("the five sections and the relationship map", () => {
  it("starts idle with labelled controls, then shows the map and the five separate sections", async () => {
    await open();
    expect(screen.getByText(/Choose a dataset, scenario, role and question/)).toBeInTheDocument();
    for (const l of [/^Dataset/, /^Scenario/, /^Simulated role/, /Business question/]) expect(screen.getByLabelText(l)).toBeInTheDocument();
    choose(/^Simulated role/, "exec");
    await ask();
    expect(headings()).toEqual(expect.arrayContaining(["Relationship map", "Verified changes", "Observed relationships", "Hypotheses", "Missing evidence", "Proposed actions", "Notices"]));
    expect(screen.getByTestId("node-revenue")).toBeInTheDocument();
    expect(screen.getByTestId("edge-closed-deals-vs-revenue")).toBeInTheDocument();
  });

  it("labels each lane for what it is", async () => {
    await open(); choose(/^Simulated role/, "exec"); await ask();
    const sec = (id: string) => within(document.getElementById(id)!);
    expect(sec("verified-changes").getByText(/Verified · computed from authorized records/)).toBeInTheDocument();
    expect(sec("observed-relationships").getByText(/Co-movement, not causation/)).toBeInTheDocument();
    expect(sec("hypotheses").getAllByText("Unverified hypothesis").length).toBeGreaterThan(0);
    expect(sec("missing-evidence").getByText(/Unknown · unresolved/)).toBeInTheDocument();
    expect(sec("proposed-actions").getAllByText("Requires human approval").length).toBeGreaterThan(0);
    // a hypothesis never appears among the verified changes
    expect(document.getElementById("verified-changes")!.textContent).not.toMatch(/hypothes|possible implication/i);
  });

  it("shows the exact metric, period comparison, direction and change, with supporting records", async () => {
    await open(); choose(/^Simulated role/, "exec"); await ask();
    const vc = within(document.getElementById("verified-changes")!);
    expect(vc.getByText("Recognized revenue decreased: $1,240,000 → $1,018,000 (-17.9% relative)")).toBeInTheDocument();
    expect(document.getElementById("verified-changes")!.textContent).toContain("Q2 2026 → Q3 2026");
  });

  it("never describes a relationship as caused or proven anywhere on the page", async () => {
    await open(); choose(/^Simulated role/, "exec"); await ask();
    const text = document.body.textContent!;
    expect(text).not.toMatch(CAUSAL_WORDS);
    expect(text).toMatch(/not causation/i);
    expect(text).toMatch(/Co-movement across two periods is not causation|does not show that either change affects the other/);
  });

  it("distinguishes supported, unsupported and unassessable relationships in words, not only colour", async () => {
    await open(); choose(/^Scenario/, "quality-only"); choose(/^Simulated role/, "exec"); await ask();
    const sec = within(document.getElementById("observed-relationships")!);
    expect(sec.getAllByText("Supported: co-movement observed").length).toBeGreaterThan(0);
    expect(sec.getAllByText("Not supported: pattern not present").length).toBeGreaterThan(0);
    expect(sec.getAllByText("Cannot be assessed: no verified data").length).toBe(1);
    expect(screen.getByTestId("node-cac")).toHaveAccessibleName(/no verified data/);
  });
});

describe("investigating a node or relationship", () => {
  it("selecting a metric shows its evidence table and its limitation", async () => {
    await open(); choose(/^Simulated role/, "exec"); await ask();
    expect(within(screen.getByTestId("detail-panel")).getByText(/Select a metric or a relationship/)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("node-revenue"));
    const panel = within(screen.getByTestId("detail-panel"));
    expect(panel.getByRole("heading", { name: "Recognized revenue" })).toBeInTheDocument();
    expect(panel.getByRole("table", { name: "Evidence for Recognized revenue" })).toBeInTheDocument();
    expect(panel.getAllByRole("row")).toHaveLength(3);
    expect(panel.getByText("$1,240,000")).toBeInTheDocument();
    expect(panel.getAllByText(/SYN-GL Revenue Summary/).length).toBeGreaterThan(0);
    expect(panel.getByText(/does not say why the metric moved/)).toBeInTheDocument();
    expect(screen.getByTestId("node-revenue")).toHaveAttribute("aria-pressed", "true");
  });

  it("selecting a relationship shows its status, the co-movement caveat, its hypothesis as unverified, its limitations and its proposed action", async () => {
    await open(); choose(/^Simulated role/, "exec"); await ask();
    fireEvent.click(screen.getByTestId("edge-leads-vs-lead-quality"));
    const panel = within(screen.getByTestId("detail-panel"));
    expect(panel.getByText("Supported: co-movement observed")).toBeInTheDocument();
    expect(panel.getByText(/Co-movement across two periods is not causation/)).toBeInTheDocument();
    expect(panel.getByText("Unverified hypothesis")).toBeInTheDocument();
    expect(panel.getByText(/Plausibility: Medium/)).toBeInTheDocument();
    expect(panel.getByText(/Lead source or channel mix by period/)).toBeInTheDocument();
    expect(panel.getByText(/not executable/)).toBeInTheDocument();
    expect(panel.getByRole("table")).toBeInTheDocument();
  });

  it("is operable by keyboard: nodes and relationships are focusable buttons that respond to Enter and Space", async () => {
    await open(); choose(/^Simulated role/, "exec"); await ask();
    const edge = screen.getByTestId("edge-conversion-vs-closed-deals");
    expect(edge).toHaveAttribute("role", "button"); expect(edge).toHaveAttribute("tabindex", "0");
    fireEvent.keyDown(edge, { key: "Enter" });
    expect(edge).toHaveAttribute("aria-pressed", "true");
    const node = screen.getByTestId("node-leads");
    fireEvent.keyDown(node, { key: " " });
    expect(node).toHaveAttribute("aria-pressed", "true");
    expect(edge).toHaveAttribute("aria-pressed", "false");
    fireEvent.keyDown(node, { key: "Enter" }); // toggles off
    expect(node).toHaveAttribute("aria-pressed", "false");
  });

  it("every drawn node and relationship has an accessible name, and the diagram has a text alternative with the same items", async () => {
    await open(); choose(/^Simulated role/, "exec"); await ask();
    const svg = document.querySelector("svg")!;
    expect(svg).toHaveAttribute("aria-label", expect.stringMatching(/text version follows/i));
    const interactive = [...svg.querySelectorAll("[role=button]")];
    expect(interactive).toHaveLength(8 + 8);
    for (const el of interactive) expect(el.getAttribute("aria-label")).toMatch(/\S{3,}/);
    const alt = within(screen.getByTestId("text-alternative"));
    expect(alt.getAllByRole("button")).toHaveLength(16);
    fireEvent.click(alt.getByRole("button", { name: /Marketing leads → Lead quality/ }));
    expect(within(screen.getByTestId("detail-panel")).getByRole("heading", { name: /Marketing leads → Lead quality/ })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Legend" })).toBeInTheDocument();
  });

  it("marks relationships that carry an unverified hypothesis", async () => {
    await open(); choose(/^Simulated role/, "exec"); await ask();
    expect(screen.getByTestId("edge-leads-vs-lead-quality")).toHaveAccessibleName(/Has an unverified hypothesis/);
  });
});

describe("proposed actions cannot be executed or approved here", () => {
  it("offers no approve, reject, run or execute control; each action says it requires human approval", async () => {
    await open(); choose(/^Simulated role/, "exec"); await ask();
    const section = within(document.getElementById("proposed-actions")!);
    expect(section.queryAllByRole("button")).toEqual([]);
    expect(section.queryAllByRole("checkbox")).toEqual([]);
    expect(section.getAllByText("Requires human approval").length).toBe(4);
    expect(section.getAllByText(/Proposal only. Not executable; no approval is recorded here./).length).toBe(4);
    expect(screen.queryByRole("button", { name: /approve|reject|execute|run action|send|apply/i })).toBeNull();
    expect(section.getByText(/Responsible domain: Marketing/)).toBeInTheDocument();
  });
});

describe("two unrelated datasets through one interface", () => {
  it("switching dataset swaps scenarios, roles and the default question and clears the old result", async () => {
    await open(); choose(/^Simulated role/, "exec"); await ask();
    expect(screen.getByTestId("node-revenue")).toBeInTheDocument();
    choose(/^Dataset/, "customer-support");
    expect(screen.queryByTestId("node-revenue")).toBeNull();
    expect(screen.getByLabelText(/Business question/)).toHaveValue("Why is customer satisfaction falling while ticket volume rises?");
    expect(within(screen.getByLabelText(/^Simulated role/)).getAllByRole("option").map((o) => o.textContent)).toEqual(datasets[1]!.roles.map((r) => r.label));
    fireEvent.click(screen.getByRole("button", { name: "Run impact analysis" }));
    await screen.findByTestId("node-csat");
    expect(screen.getByTestId("node-tickets_opened")).toBeInTheDocument();
    expect(screen.queryByTestId("node-revenue")).toBeNull();
    expect(screen.getByTestId("result-context")).toHaveTextContent("Jan 2027 → Feb 2027");
    expect(headings()).toEqual(expect.arrayContaining(["Verified changes", "Observed relationships", "Hypotheses", "Missing evidence", "Proposed actions"]));
  });

  it("a role with a policy-granted metric and no data sees an unknown node, a cannot-be-assessed relationship and the missing-evidence entry", async () => {
    await open(); choose(/^Dataset/, "customer-support"); choose(/^Simulated role/, "support-lead"); await ask(FULL);
    expect(screen.getByTestId("node-csat")).toHaveAccessibleName(/no verified data/);
    expect(within(document.getElementById("missing-evidence")!).getByText("Verified data for Customer satisfaction.")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("node-csat"));
    expect(within(screen.getByTestId("detail-panel")).getByText(/no verified records for it in your authorized scope/)).toBeInTheDocument();
  });
});

describe("restricted roles", () => {
  it("shows no restricted metric, relationship, label or record anywhere, and an empty relationship state", async () => {
    await open(); choose(/^Dataset/, "customer-support"); choose(/^Simulated role/, "cx-analyst"); await ask("Why are tickets opened rising and is resolution time slower?");
    expect(screen.getByTestId("node-csat")).toBeInTheDocument();
    for (const m of ["tickets_opened", "first_response_hours", "resolution_hours"]) expect(screen.queryByTestId(`node-${m}`)).toBeNull();
    const text = screen.getByTestId("result").textContent!;
    expect(text).not.toMatch(/Tickets opened|First response time|Resolution time|desk-export:L[2-7]\b/);
    expect(screen.getByText(/No relationship could be assessed within your authorized scope/)).toBeInTheDocument();
    expect(screen.getByText(/No hypotheses/)).toBeInTheDocument();
    expect(screen.getByText(/No actions are proposed/)).toBeInTheDocument();
  });
  it("finance sees only its own metric in the business-operations dataset", async () => {
    await open(); choose(/^Simulated role/, "finance"); await ask();
    expect(document.querySelectorAll("svg [role=button]")).toHaveLength(1);
    expect(screen.getByTestId("result").textContent).not.toMatch(/Marketing leads|Lead quality|fulfillment|Backorder|acquisition/i);
  });
});

describe("what the browser sends", () => {
  it("only dataset, scenario and role ids and the question: no tenant, workspace, metric scope or record", async () => {
    const run = vi.fn(real);
    await open(run); choose(/^Simulated role/, "marketing"); await ask("What happened to lead volume this period?");
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]![0]).toEqual({ datasetId: "business-operations", scenarioId: "baseline", roleId: "marketing", question: "What happened to lead volume this period?" });
  });
  it("omits a blank question so the server default applies", async () => {
    const run = vi.fn(real);
    await open(run);
    fireEvent.change(screen.getByLabelText(/Business question/), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Run impact analysis" }));
    await waitFor(() => expect(run).toHaveBeenCalled());
    expect(run.mock.calls[0]![0]).not.toHaveProperty("question");
  });
  it("calls no network and no model", async () => {
    await open(); await ask();
    expect(tripwire).not.toHaveBeenCalled();
  });
});

describe("empty, loading, blocked and error states", () => {
  it("shows an alert with the engine's fixed reason for a refused question, and no stale map", async () => {
    await open(); choose(/^Simulated role/, "exec"); await ask();
    expect(screen.getByTestId("node-revenue")).toBeInTheDocument();
    await ask("<script>alert(1)</script> hello there");
    expect(screen.getByRole("alert")).toHaveTextContent("Invalid analysis question (bad_characters).");
    expect(screen.queryByTestId("node-revenue")).toBeNull();
    expect(screen.getByTestId("status").textContent).not.toContain("<script>");
  });
  it("shows a neutral alert when the server cannot be reached", async () => {
    await open(vi.fn(async () => { throw new Error("secret internal detail"); }));
    await ask();
    expect(screen.getByRole("alert")).toHaveTextContent("The analysis could not be reached. Nothing was computed.");
    expect(document.body.textContent).not.toContain("secret internal detail");
  });
  it("shows a busy state, disables the button while running, and ignores a second submit", async () => {
    const d = deferred<WorkbenchResult>();
    const run = vi.fn(() => d.promise);
    await open(run);
    fireEvent.click(screen.getByRole("button", { name: "Run impact analysis" }));
    expect(screen.getByRole("button", { name: "Running…" })).toBeDisabled();
    fireEvent.submit(screen.getByRole("form", { name: "Ask the engine" }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(document.querySelector("[aria-busy=true]")).not.toBeNull();
    await act(async () => { d.resolve({ state: "blocked", reason: "x" }); });
  });
  it("ignores a late response after the role changed", async () => {
    const d = deferred<WorkbenchResult>();
    await open(vi.fn(() => d.promise));
    fireEvent.click(screen.getByRole("button", { name: "Run impact analysis" }));
    choose(/^Simulated role/, "finance");
    const late = await runWorkbench({ datasetId: "business-operations", scenarioId: "baseline", roleId: "exec" });
    await act(async () => { d.resolve(late); });
    expect(screen.queryByTestId("node-leads")).toBeNull();
    expect(screen.getByText(/Choose a dataset, scenario, role and question/)).toBeInTheDocument();
  });
  it("renders an alert when no dataset is available", () => {
    render(<ImpactWorkbench datasets={[]} run={real} />);
    expect(screen.getByRole("alert")).toHaveTextContent("No datasets are available.");
  });
  it("states plainly that roles are simulated and that no model is used", async () => {
    await open(); choose(/^Simulated role/, "exec"); await ask();
    expect(screen.getByTestId("result-context")).toHaveTextContent("simulated role, not authenticated");
    expect(screen.getByText(/No AI model is called/)).toBeInTheDocument();
  });
});
