import { describe, expect, it, vi } from "vitest";
import { ROLES, SCENARIOS } from "../data";
import { runMeta, metaStatus } from "./adapter.server";
import { authorizedRecords, META_ENDPOINT, MAX_OUTPUT_TOKENS } from "./contract";

const READY = { META_MODEL_API_KEY: "test-key", META_MODEL_ENABLED: "true" };
const ALL = ROLES[0]!.workspaces;
const FIN = ROLES.find((r) => r.id === "finance")!.workspaces;
const req = (roleId: string = "exec", scenarioId = "baseline") => ({ scenarioId, roleId, ownerConfirmed: true });

function mockFetch(content: unknown, extra: Record<string, unknown> = {}) {
  return vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) }, finish_reason: "stop" }], usage: { prompt_tokens: 500, completion_tokens: 200, total_tokens: 700 }, ...extra }), { status: 200 }));
}
// v2 (three-lane) fixture. `id` may be a record id (mapped to that record's metric fact id) or a fact id / arbitrary ref.
// A record from a workspace the role cannot see maps to a fact the role does not have, so it must be rejected.
const toRef = (id: string) => { const rec = SCENARIOS.flatMap((s) => s.records).find((r) => r.id === id); return rec ? `F-${rec.metric}` : id; };
const good = (id: string) => ({
  interpretations: [{ text: "Lower demand may be related.", verified: false as const, refs: [toRef(id)] }],
  missing_evidence: ["No attribution data."],
  recommendations: [{ text: "Re-forecast next quarter.", requires_human_approval: true as const, refs: [toRef(id)] }],
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
    expect((await runMeta({ scenarioId: "baseline", roleId: "exec" }, READY, f as never)).state).toBe("blocked");
    expect(f).not.toHaveBeenCalled();
  });
  it("non-allowlisted scenario and unknown workspace are blocked", async () => {
    const f = vi.fn();
    expect((await runMeta(req("exec", "econest-prod"), READY, f as never)).state).toBe("blocked");
    expect((await runMeta(req("hr-admin"), READY, f as never)).state).toBe("blocked");
    expect(f).not.toHaveBeenCalled();
  });
  it("missing role sends nothing", async () => {
    const f = vi.fn();
    expect((await runMeta({ scenarioId: "baseline", ownerConfirmed: true }, READY, f as never)).state).toBe("blocked");
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
  it("hallucinated fact reference rejected", async () => {
    const o = good(finId()); o.interpretations[0]!.refs = ["F-fake-999"];
    const r = await runMeta(req("finance"), READY, mockFetch(o) as never);
    expect(r.state).toBe("rejected");
    // the rejection is generic: the unknown reference the model supplied is never echoed back
    if (r.state === "rejected") { expect(r.errors.join()).toContain("Unknown or unauthorized fact reference"); expect(JSON.stringify(r)).not.toContain("F-fake-999"); }
  });
  it("referencing a real but unauthorized fact is rejected (cross-workspace)", async () => {
    const hidden = SCENARIOS[0]!.records.find((x) => x.workspace === "ws-marketing")!.id;
    const o = good(finId()); o.interpretations[0]!.refs = [toRef(hidden)];
    expect((await runMeta(req("finance"), READY, mockFetch(o) as never)).state).toBe("rejected");
  });
  it("mentioning an unauthorized record in text is rejected", async () => {
    const hidden = SCENARIOS[0]!.records.find((x) => x.workspace === "ws-sales")!;
    const o = good(finId()); o.missing_evidence = [`See ${hidden.id}`];
    expect((await runMeta(req("finance"), READY, mockFetch(o) as never)).state).toBe("rejected");
  });
  it("verified hypothesis or auto-executed recommendation rejected", async () => {
    const a = good(finId()) as any; a.interpretations[0].verified = true;
    const b = good(finId()) as any; b.recommendations[0].requires_human_approval = false;
    expect((await runMeta(req("finance"), READY, mockFetch(a) as never)).state).toBe("rejected");
    expect((await runMeta(req("finance"), READY, mockFetch(b) as never)).state).toBe("rejected");
  });
  it("causal-proof language rejected", async () => {
    const o = good(finId()); o.interpretations[0]!.text = "Fulfillment delays caused the revenue drop.";
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
    expect(OutputSchema.safeParse({ ...o, interpretations: Array(LIMITS.interpretations + 1).fill(o.interpretations[0]) }).success).toBe(false);
    expect(OutputSchema.safeParse({ ...o, missing_evidence: ["x".repeat(LIMITS.text + 1)] }).success).toBe(false);
    expect(OutputSchema.safeParse(o).success).toBe(true);
    expect(RESPONSE_FORMAT.json_schema.schema.properties.interpretations.maxItems).toBe(LIMITS.interpretations);
  });
  it("Baseline (paid-social surge) × executive: valid compact reply passes; restricted role cannot reference hidden facts", async () => {
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

import { hasCausalClaim, SERVER_ROLE_WORKSPACES, workspacesForRole } from "./contract";

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
  it("interpretations stay strict even with investigative wording", async () => {
    expect(hasCausalClaim(exact, false)).toBe(true);
    const id = authorizedRecords(req("exec"))[0]!.id;
    const o = good(id); o.interpretations[0]!.text = "Possible causes include delays.";
    expect((await runMeta(req("exec"), READY, mockFetch(o) as never)).state).toBe("rejected");
  });
  it("investigative wording does not bypass fact-reference checks", async () => {
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
  it("forged workspaces/records/role claims are ignored — scope comes only from server role map", async () => {
    const ops = A.records.find((r) => r.workspace === "ws-ops")!, fin = A.records.find((r) => r.workspace === "ws-finance")!;
    for (const forged of [
      { ...req("marketing"), workspaces: ["ws-marketing", "ws-sales", "ws-ops", "ws-finance"] },
      { ...req("marketing"), records: A.records, role: "exec", isAdmin: true },
      { ...req("marketing"), authorizedIds: A.records.map((r) => r.id) },
    ]) {
      const p = (await sentPrompt(forged))!;
      expect(p).not.toContain(ops.id); expect(p).not.toContain(fin.id);
    }
  });
  it.each([undefined, "", "custom", "EXEC", "exec ", "__proto__", "constructor", "toString", 7, null])("unknown/missing role %s fails closed with no request", async (roleId) => {
    const f = vi.fn();
    expect((await runMeta({ scenarioId: "baseline", roleId, ownerConfirmed: true }, READY, f as never)).state).toBe("blocked");
    expect(f).not.toHaveBeenCalled();
  });
  it("server role map matches UI roles and is frozen", () => {
    expect(SERVER_ROLE_WORKSPACES).toEqual(Object.fromEntries(ROLES.map((r) => [r.id, r.workspaces])));
    expect(SERVER_ROLE_WORKSPACES["exec"]).toEqual(["ws-marketing", "ws-sales", "ws-ops", "ws-finance"]);
    expect(Object.isFrozen(SERVER_ROLE_WORKSPACES) && Object.isFrozen(SERVER_ROLE_WORKSPACES["exec"])).toBe(true);
  });
  it("mutating the UI ROLES array at runtime cannot widen server scope", () => {
    const mk = ROLES.find((r) => r.id === "marketing")!;
    mk.workspaces.push("ws-finance");
    try { expect(workspacesForRole("marketing")).toEqual(["ws-marketing", "ws-sales"]); }
    finally { mk.workspaces.pop(); }
  });
  it.each(ROLES.map((r) => r.id))("role %s: every scenario sends exactly its server-mapped records", async (roleId) => {
    for (const s of SCENARIOS) {
      const f = mockFetch(good(authorizedRecords(req(roleId, s.id))[0]!.id));
      await runMeta(req(roleId, s.id), READY, f as never);
      const p = JSON.parse((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).messages[1].content as string;
      for (const r of s.records) expect(p.includes(r.id)).toBe(workspacesForRole(roleId).includes(r.workspace));
    }
  });
  it("unknown, missing or malformed role/scenario input is blocked with no request", async () => {
    for (const bad of [{ scenarioId: "baseline", ownerConfirmed: true }, req("ws-marketing"), req("Marketing"), { ...req("marketing"), scenarioId: "real-econest" }]) {
      const f = vi.fn();
      expect((await runMeta(bad, READY, f as never)).state).toBe("blocked");
      expect(f).not.toHaveBeenCalled();
    }
  });
  it.each(["ws-ops", "ws-finance"])("response citing or naming a hidden %s record is rejected", async (ws) => {
    const hidden = A.records.find((r) => r.workspace === ws)!;
    const ok = authorizedRecords(req("marketing"))[0]!.id;
    const c = good(ok); c.interpretations[0]!.refs = [toRef(hidden.id)];
    const n = good(ok); n.missing_evidence = [`Need ${hidden.id}`];
    const s = good(ok); s.recommendations[0]!.text = `Check ${hidden.source} data.`;
    for (const o of [c, n, s]) expect((await runMeta(req("marketing"), READY, mockFetch(o) as never)).state).toBe("rejected");
  });
  it("valid reply referencing only Marketing/Sales facts passes", async () => {
    const ids = authorizedRecords(req("marketing")).map((r) => r.id);
    const o = good(ids[0]!); o.interpretations[0]!.refs = [...new Set(ids.map(toRef))].slice(0, 4);
    const r = await runMeta(req("marketing"), READY, mockFetch(o) as never);
    expect(r.state).toBe("ok");
    if (r.state === "ok") expect(r.authorizedIds.every((id) => MKT.includes(A.records.find((x) => x.id === id)!.workspace))).toBe(true);
  });
});
