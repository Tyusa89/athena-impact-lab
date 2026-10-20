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
    expect((await runMeta(req(ALL, "econest-prod"), READY, f as never)).state).toBe("blocked");
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
    const id = authorizedRecords(req(FIN))[0]!.id;
    const f = mockFetch(good(id));
    const r = await runMeta(req(FIN), READY, f as never);
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
  const finId = () => authorizedRecords(req(FIN))[0]!.id;
  it("malformed JSON rejected", async () => expect((await runMeta(req(FIN), READY, mockFetch("not json {") as never)).state).toBe("rejected"));
  it("missing fields / extra fields rejected", async () => {
    expect((await runMeta(req(FIN), READY, mockFetch({ observations: [] }) as never)).state).toBe("rejected");
    expect((await runMeta(req(FIN), READY, mockFetch({ ...good(finId()), execute: true }) as never)).state).toBe("rejected");
  });
  it("hallucinated citation rejected", async () => {
    const o = good(finId()); o.observations[0]!.cited_ids = ["VH-FAKE-999"];
    const r = await runMeta(req(FIN), READY, mockFetch(o) as never);
    expect(r.state).toBe("rejected"); if (r.state === "rejected") expect(r.errors.join()).toContain("VH-FAKE-999");
  });
  it("citing a real but unauthorized record is rejected (cross-workspace)", async () => {
    const hidden = SCENARIOS[0]!.records.find((x) => x.workspace === "ws-marketing")!.id;
    const o = good(finId()); o.hypotheses[0]!.cited_ids = [hidden];
    expect((await runMeta(req(FIN), READY, mockFetch(o) as never)).state).toBe("rejected");
  });
  it("mentioning an unauthorized record in text is rejected", async () => {
    const hidden = SCENARIOS[0]!.records.find((x) => x.workspace === "ws-sales")!;
    const o = good(finId()); o.missing_evidence = [`See ${hidden.id}`];
    expect((await runMeta(req(FIN), READY, mockFetch(o) as never)).state).toBe("rejected");
  });
  it("verified hypothesis or auto-executed recommendation rejected", async () => {
    const a = good(finId()) as any; a.hypotheses[0].verified = true;
    const b = good(finId()) as any; b.recommendations[0].requires_human_approval = false;
    expect((await runMeta(req(FIN), READY, mockFetch(a) as never)).state).toBe("rejected");
    expect((await runMeta(req(FIN), READY, mockFetch(b) as never)).state).toBe("rejected");
  });
  it("causal-proof language rejected", async () => {
    const o = good(finId()); o.observations[0]!.text = "Fulfillment delays caused the revenue drop.";
    expect((await runMeta(req(FIN), READY, mockFetch(o) as never)).state).toBe("rejected");
  });
  it("truncated or over-budget output rejected", async () => {
    const t = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "{}" }, finish_reason: "length" }] })));
    expect((await runMeta(req(FIN), READY, t as never)).state).toBe("rejected");
    const big = mockFetch(good(finId()), { usage: { completion_tokens: MAX_OUTPUT_TOKENS + 1 } });
    expect((await runMeta(req(FIN), READY, big as never)).state).toBe("rejected");
  });
  it("every role × scenario: valid output passes only with authorized ids", async () => {
    for (const s of SCENARIOS) for (const role of ROLES) {
      const recs = authorizedRecords(req(role.workspaces, s.id));
      const r = await runMeta(req(role.workspaces, s.id), READY, mockFetch(good(recs[0]!.id)) as never);
      expect(r.state).toBe("ok");
      if (r.state === "ok") for (const id of r.authorizedIds) expect(role.workspaces).toContain(s.records.find((x) => x.id === id)!.workspace);
    }
  });
});
