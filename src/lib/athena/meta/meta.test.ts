import { describe, expect, it, vi } from "vitest";
import { ROLES, SCENARIOS } from "../data";
import { runMeta, metaStatus } from "./adapter.server";
import { authorizedRecords, META_ENDPOINT, MAX_OUTPUT_TOKENS } from "./contract";

const READY = { META_MODEL_API_KEY: "test-key", META_MODEL_ENABLED: "true" };
const ALL = ROLES[0]!.workspaces;
const FIN = ROLES.find((r) => r.id === "finance")!.workspaces;
const req = (workspaces: string[] = ALL, scenarioId = "baseline") => ({ scenarioId, workspaces, ownerConfirmed: true });

function mockFetch(content: unknown, extra: Record<string, unknown> = {}) {
  return vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) }, finish_reason: "stop" }], usage: { prompt_tokens: 500, completion_tokens: 200, total_tokens: 700 }, ...extra }), { status: 200 }));
}
const good = (id: string) => ({
  observations: [{ text: "Revenue fell between periods.", cited_ids: [id] }],
  hypotheses: [{ text: "Lower demand may be related.", verified: false, cited_ids: [id] }],
  missing_evidence: ["No attribution data."],
  recommendations: [{ text: "Re-forecast next quarter.", requires_human_approval: true, cited_ids: [id] }],
});

describe("meta gating — no outbound calls", () => {
  it("missing secret blocks with no request", async () => {
    const f = vi.fn();
    const r = await runMeta(req(), { META_MODEL_ENABLED: "true" }, f as never);
    expect(r.state).toBe("blocked"); expect(r.requestSent).toBe(false); expect(f).not.toHaveBeenCalled();
  });
  it("blank secret counts as missing", () => expect(metaStatus({ META_MODEL_API_KEY: "  ", META_MODEL_ENABLED: "true" }).ready).toBe(false));
  it("disabled provider (no owner flag) blocks with no request", async () => {
    const f = vi.fn();
    for (const flag of [undefined, "false", "TRUE", "1"]) {
      const r = await runMeta(req(), { META_MODEL_API_KEY: "k", META_MODEL_ENABLED: flag }, f as never);
      expect(r.state).toBe("blocked");
    }
    expect(f).not.toHaveBeenCalled();
  });
  it("missing owner confirmation blocks", async () => {
    const f = vi.fn();
    expect((await runMeta({ scenarioId: "baseline", workspaces: ALL }, READY, f as never)).state).toBe("blocked");
    expect(f).not.toHaveBeenCalled();
  });
  it("non-allowlisted scenario and unknown workspace are blocked", async () => {
    const f = vi.fn();
    expect((await runMeta(req("exec", "econest-prod"), READY, f as never)).state).toBe("blocked");
    expect((await runMeta(req(["ws-hr"]), READY, f as never)).state).toBe("blocked");
    expect(f).not.toHaveBeenCalled();
  });
  it("empty authorized workspace set sends nothing", async () => {
    const f = vi.fn();
    expect((await runMeta(req([]), READY, f as never)).state).toBe("blocked");
    expect(f).not.toHaveBeenCalled();
  });
});

describe("meta request shape & role restrictions", () => {
  it("sends one request, only authorized records, with token cap", async () => {
    const id = authorizedRecords(req("finance"))[0]!.id;
    const f = mockFetch(good(id));
    const r = await runMeta(req("finance"), READY, f as never);
    expect(r.state).toBe("ok");
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(META_ENDPOINT);
    const body = JSON.parse(init.body as string);
    expect(body.max_tokens).toBe(MAX_OUTPUT_TOKENS);
    const sent = body.messages[1].content as string;
    for (const s of SCENARIOS) for (const rec of s.records) if (s.id === "baseline" && rec.workspace !== "ws-finance") expect(sent).not.toContain(rec.id);
  });
  it("HTTP error is reported and not retried", async () => {
    const f = vi.fn(async () => new Response("x", { status: 500 }));
    const r = await runMeta(req(), READY, f as never);
    expect(r.state).toBe("error"); expect(f).toHaveBeenCalledTimes(1);
  });
  it("network error is not retried", async () => {
    const f = vi.fn(async () => { throw new TypeError("fail"); });
    expect((await runMeta(req(), READY, f as never)).state).toBe("error"); expect(f).toHaveBeenCalledTimes(1);
  });
});

describe("meta output validation", () => {
  const finId = () => authorizedRecords(req("finance"))[0]!.id;
  it("malformed JSON rejected", async () => expect((await runMeta(req("finance"), READY, mockFetch("not json {") as never)).state).toBe("rejected"));
  it("missing fields / extra fields rejected", async () => {
    expect((await runMeta(req("finance"), READY, mockFetch({ observations: [] }) as never)).state).toBe("rejected");
    expect((await runMeta(req("finance"), READY, mockFetch({ ...good(finId()), execute: true }) as never)).state).toBe("rejected");
  });
  it("hallucinated citation rejected", async () => {
    const o = good(finId()); o.observations[0]!.cited_ids = ["VH-FAKE-999"];
    const r = await runMeta(req("finance"), READY, mockFetch(o) as never);
    expect(r.state).toBe("rejected"); if (r.state === "rejected") expect(r.errors.join()).toContain("VH-FAKE-999");
  });
  it("citing a real but unauthorized record is rejected (cross-workspace)", async () => {
    const hidden = SCENARIOS[0]!.records.find((x) => x.workspace === "ws-marketing")!.id;
    const o = good(finId()); o.hypotheses[0]!.cited_ids = [hidden];
    expect((await runMeta(req("finance"), READY, mockFetch(o) as never)).state).toBe("rejected");
  });
  it("mentioning an unauthorized record in text is rejected", async () => {
    const hidden = SCENARIOS[0]!.records.find((x) => x.workspace === "ws-sales")!;
    const o = good(finId()); o.missing_evidence = [`See ${hidden.id}`];
    expect((await runMeta(req("finance"), READY, mockFetch(o) as never)).state).toBe("rejected");
  });
  it("verified hypothesis or auto-executed recommendation rejected", async () => {
    const a = good(finId()) as any; a.hypotheses[0].verified = true;
    const b = good(finId()) as any; b.recommendations[0].requires_human_approval = false;
    expect((await runMeta(req("finance"), READY, mockFetch(a) as never)).state).toBe("rejected");
    expect((await runMeta(req("finance"), READY, mockFetch(b) as never)).state).toBe("rejected");
  });
  it("causal-proof language rejected", async () => {
    const o = good(finId()); o.observations[0]!.text = "Fulfillment delays caused the revenue drop.";
    expect((await runMeta(req("finance"), READY, mockFetch(o) as never)).state).toBe("rejected");
  });
  it("truncated or over-budget output rejected", async () => {
    const t = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "{}" }, finish_reason: "length" }] })));
    expect((await runMeta(req("finance"), READY, t as never)).state).toBe("rejected");
    const big = mockFetch(good(finId()), { usage: { completion_tokens: MAX_OUTPUT_TOKENS + 1 } });
    expect((await runMeta(req("finance"), READY, big as never)).state).toBe("rejected");
  });
  it("every role × scenario: valid output passes only with authorized ids", async () => {
    for (const s of SCENARIOS) for (const role of ROLES) {
      const recs = authorizedRecords(req(role.id, s.id));
      const r = await runMeta(req(role.id, s.id), READY, mockFetch(good(recs[0]!.id)) as never);
      expect(r.state).toBe("ok");
      if (r.state === "ok") for (const id of r.authorizedIds) expect(role.workspaces).toContain(s.records.find((x) => x.id === id)!.workspace);
    }
  });
});

import { buildBody, readUsage } from "./adapter.server";
import { LIMITS, OutputSchema, RESPONSE_FORMAT, REASONING_EFFORT } from "./contract";

describe("truncation fix — token accounting & compact schema", () => {
  const finId = () => authorizedRecords(req("finance"))[0]!.id;
  it("body sends hard cap 2000 as max_tokens and minimal reasoning effort", () => {
    const b = buildBody([]);
    expect(b.max_tokens).toBe(2000); expect(MAX_OUTPUT_TOKENS).toBe(2000);
    expect(b.reasoning_effort).toBe("minimal"); expect(REASONING_EFFORT).toBe("minimal");
    expect(b.stream).toBe(false);
  });
  it("sent request body carries the exact cap", async () => {
    const f = mockFetch(good(finId()));
    await runMeta(req("finance"), READY, f as never);
    const body = JSON.parse((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.max_tokens).toBe(2000); expect(body.reasoning_effort).toBe("minimal");
  });
  it("reads reasoning tokens and derives visible output tokens", () => {
    const u = readUsage({ usage: { prompt_tokens: 1008, completion_tokens: 1200, completion_tokens_details: { reasoning_tokens: 900 } } }, "length");
    expect(u).toEqual({ prompt_tokens: 1008, completion_tokens: 1200, reasoning_tokens: 900, visible_output_tokens: 300, finish_reason: "length", max_tokens_sent: 2000 });
  });
  it("missing reasoning breakdown is reported as unknown, not zero", () => {
    const u = readUsage({ usage: { completion_tokens: 50 } });
    expect(u.reasoning_tokens).toBeUndefined(); expect(u.visible_output_tokens).toBeUndefined();
  });
  it("truncated reply is rejected even if content is valid JSON, with usage surfaced, no retry", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(good(finId())) }, finish_reason: "length" }], usage: { prompt_tokens: 1008, completion_tokens: 2000, completion_tokens_details: { reasoning_tokens: 1800 } } })));
    const r = await runMeta(req("finance"), READY, f as never);
    expect(r.state).toBe("rejected"); expect(f).toHaveBeenCalledTimes(1);
    if (r.state === "rejected") { expect(r.usage?.reasoning_tokens).toBe(1800); expect(r.errors[0]).toContain("max_tokens=2000"); }
  });
  it("compact schema limits enforced (counts & text length)", () => {
    const o = good(finId());
    expect(OutputSchema.safeParse({ ...o, observations: Array(LIMITS.observations + 1).fill(o.observations[0]) }).success).toBe(false);
    expect(OutputSchema.safeParse({ ...o, missing_evidence: ["x".repeat(LIMITS.text + 1)] }).success).toBe(false);
    expect(OutputSchema.safeParse(o).success).toBe(true);
    expect(RESPONSE_FORMAT.json_schema.schema.properties.observations.maxItems).toBe(LIMITS.observations);
  });
  it("Baseline (paid-social surge) × executive: valid compact reply passes; restricted role cannot cite hidden ids", async () => {
    const s = SCENARIOS.find((x) => x.id === "baseline")!;
    const allIds = authorizedRecords(req("exec", s.id)).map((r) => r.id);
    expect((await runMeta(req("exec", s.id), READY, mockFetch(good(allIds[0]!)) as never)).state).toBe("ok");
    const hidden = s.records.find((r) => r.workspace !== "ws-finance")!.id;
    expect((await runMeta(req("finance", s.id), READY, mockFetch(good(hidden)) as never)).state).toBe("rejected");
  });
  it("logging never includes the key", async () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    await runMeta(req("finance"), { ...READY, META_MODEL_API_KEY: "SECRET-XYZ" }, mockFetch(good(finId())) as never);
    expect(JSON.stringify(spy.mock.calls)).not.toContain("SECRET-XYZ"); spy.mockRestore();
  });
});

import { hasCausalClaim } from "./contract";

describe("causal wording validator (Test 002 regression)", () => {
  const exact = "Investigate fulfillment delays and backorder causes promptly";
  it("exact Test 002 recommendation passes end-to-end", async () => {
    const id = authorizedRecords(req("exec"))[0]!.id;
    const o = good(id); o.recommendations[0]!.text = exact;
    expect((await runMeta(req("exec"), READY, mockFetch(o) as never)).state).toBe("ok");
  });
  it.each([
    exact,
    "Identify the root cause of the conversion decline.",
    "Review possible causes of longer fulfillment times.",
    "Determine whether lead mix causes lower conversion.",
    "Examine potential causes of the backorder rise.",
  ])("investigative recommendation allowed: %s", (t) => expect(hasCausalClaim(t, true)).toBe(false));
  it.each([
    "Fulfillment delays caused the revenue drop.",
    "Lead mix proves the conversion decline.",
    "This proof is definitive: data proves it.",
    "Backorders are the cause of lost sales.",
    "Backorders is the cause of lost sales.",
    "Higher leads causes lower conversion.",
    "FULFILLMENT DELAYS CAUSED THE DROP.",
    "Delays ca\u200Bused the drop.",
    "Delays ｃａｕｓｅｄ the drop.",
    "Data confirms that delays hurt sales.",
    "Investigate delays. Backorder causes lost revenue.",
  ])("strong/unsupported claim rejected in recommendations: %s", (t) => {
    // "the cause of" without investigative cue: still rejected via CAUSE_WORD? only "cause" token
    expect(hasCausalClaim(t, true)).toBe(true);
  });
  it("hypotheses and observations stay strict even with investigative wording", async () => {
    expect(hasCausalClaim(exact, false)).toBe(true);
    const id = authorizedRecords(req("exec"))[0]!.id;
    const o = good(id); o.hypotheses[0]!.text = "Possible causes include delays.";
    expect((await runMeta(req("exec"), READY, mockFetch(o) as never)).state).toBe("rejected");
  });
  it("investigative wording does not bypass citation checks", async () => {
    const o = good("VH-FAKE-1"); o.recommendations[0]!.text = exact;
    expect((await runMeta(req("finance"), READY, mockFetch(o) as never)).state).toBe("rejected");
  });
});

describe("Marketing Manager × Scenario A — local role-filter audit (no network)", () => {
  const MKT = ROLES.find((r) => r.id === "marketing")!.workspaces;
  const A = SCENARIOS.find((s) => s.id === "baseline")!;
  const sentPrompt = async (input: unknown) => {
    const f = mockFetch(good(authorizedRecords(req("marketing"))[0]!.id));
    await runMeta(input, READY, f as never);
    return f.mock.calls.length ? ((JSON.parse((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).messages[1].content) as string) : null;
  };
  it("Marketing Manager role maps to Marketing + Sales workspaces (as defined in data)", () => {
    expect([...MKT].sort()).toEqual(["ws-marketing", "ws-sales"]);
  });
  it("prompt contains every authorized record and no Operations/Finance id or source", async () => {
    const p = (await sentPrompt(req("marketing")))!;
    for (const r of A.records) {
      if (MKT.includes(r.workspace)) expect(p).toContain(r.id);
      else { expect(p).not.toContain(r.id); expect(p).not.toContain(r.source); }
    }
  });
  it("prompt never includes source names or notes (only id/department/date/metric/period/value/unit)", async () => {
    const p = (await sentPrompt(req("marketing")))!;
    for (const r of A.records) { expect(p).not.toContain(r.source); if (r.note) expect(p).not.toContain(r.note); }
  });
  it("extra client fields (forged role label) are ignored; only workspaces matter", async () => {
    const p = (await sentPrompt({ ...req("marketing"), role: "exec", records: A.records }))!;
    const ops = A.records.find((r) => r.workspace === "ws-ops")!;
    expect(p).not.toContain(ops.id);
  });
  it("LIMITATION: a forged workspace list is trusted — client can claim all workspaces", async () => {
    const p = (await sentPrompt(req(["ws-marketing", "ws-sales", "ws-ops", "ws-finance"])))!;
    expect(p).toContain(A.records.find((r) => r.workspace === "ws-finance")!.id);
  });
  it("unknown, missing or malformed workspace input is blocked with no request", async () => {
    for (const bad of [{ scenarioId: "baseline", ownerConfirmed: true }, req(["ws-hr"]), req(["WS-MARKETING"]), { ...req("marketing"), workspaces: "ws-marketing" }]) {
      const f = vi.fn();
      expect((await runMeta(bad, READY, f as never)).state).toBe("blocked");
      expect(f).not.toHaveBeenCalled();
    }
  });
  it("duplicated workspace entries do not widen access", async () => {
    const p = (await sentPrompt(req(["ws-marketing", "ws-marketing", "ws-sales"])))!;
    expect(p).not.toContain(A.records.find((r) => r.workspace === "ws-ops")!.id);
  });
  it.each(["ws-ops", "ws-finance"])("response citing or naming a hidden %s record is rejected", async (ws) => {
    const hidden = A.records.find((r) => r.workspace === ws)!;
    const ok = authorizedRecords(req("marketing"))[0]!.id;
    const c = good(ok); c.observations[0]!.cited_ids = [hidden.id];
    const n = good(ok); n.missing_evidence = [`Need ${hidden.id}`];
    const s = good(ok); s.recommendations[0]!.text = `Check ${hidden.source} data.`;
    for (const o of [c, n, s]) expect((await runMeta(req("marketing"), READY, mockFetch(o) as never)).state).toBe("rejected");
  });
  it("valid reply citing only Marketing/Sales records passes", async () => {
    const ids = authorizedRecords(req("marketing")).map((r) => r.id);
    const o = good(ids[0]!); o.observations[0]!.cited_ids = ids.slice(0, 6);
    const r = await runMeta(req("marketing"), READY, mockFetch(o) as never);
    expect(r.state).toBe("ok");
    if (r.state === "ok") expect(r.authorizedIds.every((id) => MKT.includes(A.records.find((x) => x.id === id)!.workspace))).toBe(true);
  });
});
