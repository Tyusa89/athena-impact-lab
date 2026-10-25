import { afterEach, describe, expect, it, vi } from "vitest";
import { SCENARIOS } from "../data";
import { runMeta, type MetaResult } from "./adapter.server";
import { REQUEST_TIMEOUT_MS, authorizedRecords, leakKey, validateOutput } from "./contract";
import { numericTokens } from "./numericGrounding";

// Phase 2B-1 corrective pass (S1 leak normalization, S2 year exemption, S3 response deadline). No network.
const READY = { META_MODEL_API_KEY: "test-key", META_MODEL_ENABLED: "true" };
const req = (roleId = "exec", scenarioId = "baseline") => ({ scenarioId, roleId, ownerConfirmed: true });
const ALL = SCENARIOS.find((s) => s.id === "baseline")!.records;
const authFor = (role: string) => authorizedRecords(req(role));
const lane = (text: string, where: "interp" | "rec" | "gap" = "interp", refs = ["F-revenue"]) => ({
  interpretations: where === "interp" ? [{ text, verified: false, refs }] : [],
  missing_evidence: where === "gap" ? [text] : [],
  recommendations: where === "rec" ? [{ text, requires_human_approval: true, refs }] : [],
});
const check = (o: unknown, role = "exec") => validateOutput(JSON.stringify(o), authFor(role), ALL);
const errs = (o: unknown, role = "exec") => { const v = check(o, role); return v.ok ? "ACCEPTED" : v.errors.join(" | "); };

// ---------------------------------------------------------------- S1
describe("S1: hidden identifiers cannot be hidden by Unicode variation (finance role)", () => {
  const hidden = ALL.filter((r) => r.workspace !== "ws-finance");
  const bad = (s: string) => s.replace(/[A-Z0-9]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0)); // full-width
  const idVariants = (id: string): [string, string][] => [
    ["plain", id],
    ["lower-case", id.toLowerCase()],
    ["zero-width space", id.replace("-Q", "​-Q")],
    ["zero-width joiner", id.replace(/-/g, "-‍")],
    ["soft hyphen", id.replace(/-/g, "­")],
    ["word joiner", id.replace("VH", "V⁠H")],
    ["BOM", id.replace("VH", "V﻿H")],
    ["bidi controls", `‮${id}‬`],
    ["variation selector", id.replace("VH", "V️H")],
    ["combining dot above", id.replace("VH", "V̇H")],
    ["full-width", bad(id)],
    ["en dash", id.replace(/-/g, "–")],
    ["minus sign", id.replace(/-/g, "−")],
    ["non-breaking hyphen", id.replace(/-/g, "‑")],
    ["spaces for hyphens", id.replace(/-/g, " ")],
    ["underscores", id.replace(/-/g, "_")],
    ["newline inside", id.replace("-MKT", "\n-MKT")],
  ];
  const sampleIds = [hidden.find((r) => r.workspace === "ws-marketing")!, hidden.find((r) => r.workspace === "ws-ops")!, hidden.find((r) => r.workspace === "ws-sales")!];
  for (const rec of sampleIds) {
    it.each(idVariants(rec.id))(`hidden id ${rec.id}: %s is rejected`, (_n, text) => {
      expect(errs(lane(`See ${text} for context.`), "finance")).toContain("Cross-workspace leak");
    });
  }
  it("is rejected in every lane: interpretations, recommendations and gaps", () => {
    const id = sampleIds[0]!.id.replace("-Q", "​-Q");
    for (const where of ["interp", "rec", "gap"] as const) expect(errs(lane(`See ${id}.`, where), "finance")).toContain("Cross-workspace leak");
  });
  it("every hidden record's id is caught when obfuscated (all roles' hidden records)", () => {
    for (const r of hidden) expect(errs(lane(`See ${r.id.replace(/-/g, "​-")}.`), "finance")).toContain("Cross-workspace leak");
  });
  const srcVariants = (src: string): [string, string][] => [
    ["plain", src],
    ["lower-case", src.toLowerCase()],
    ["zero-width space", src.replace(" ", "​ ")],
    ["full-width", src.replace(/[A-Za-z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0))],
    ["non-breaking spaces", src.replace(/ /g, " ")],
    ["extra spacing and dashes swapped", src.replace(/-/g, "–").replace(/ /g, "  ")],
  ];
  it.each(srcVariants(sampleIds[0]!.source))("hidden source label: %s is rejected", (_n, text) => {
    expect(errs(lane(`Check ${text} data.`), "finance")).toContain("Cross-workspace leak");
  });
  it("controls: ordinary text, and the role's OWN ids and sources, are not flagged", () => {
    expect(errs(lane("Demand may be shifting."), "finance")).toBe("ACCEPTED");
    expect(errs(lane("See VH-FIN-001-Q3 for context."), "finance")).toBe("ACCEPTED");
    const own = authFor("finance")[0]!;
    expect(errs(lane(`Check ${own.source} data.`), "finance")).toBe("ACCEPTED");
    const mk = ALL.find((r) => r.workspace === "ws-marketing")!;
    expect(errs(lane(`See ${mk.id}.`, "interp", ["F-leads"]), "marketing")).toBe("ACCEPTED");
  });
  it("leakKey folds width, case, separators, invisibles and combining marks", () => {
    expect(leakKey("VH-MKT-001-Q3")).toBe("vhmkt001q3");
    expect(leakKey("ＶＨ–ＭＫＴ 001_Q3")).toBe("vhmkt001q3");
    expect(leakKey("V̇H​-M­KT-001-Q3")).toBe("vhmkt001q3");
  });
  it("KNOWN LIMITATION: cross-script confusables (e.g. Cyrillic letters) are not folded", () => {
    const id = sampleIds[0]!.id.replace("M", "М"); // Cyrillic capital EM
    expect(errs(lane(`See ${id}.`), "finance")).not.toContain("Cross-workspace leak");
  });
});

// ---------------------------------------------------------------- S2
describe("S2: the year exemption covers only authorized reporting periods, only as a period reference", () => {
  it.each([
    "Revenue reached 2050 units.",
    "About 2024 deals closed.",
    "Revenue fell by 2090.",
    "Revenue was 2026 units.",
    "Pipeline held steady at 2026.",
    "Demand softened in 2026 units.",
    "Demand softened in 2026 dollars.",
    "Demand softened during 2026 deals.",
    "Demand softened in 2026 and 2050.",
    "Demand softened in Q3 2027.",
    "Demand softened in 2025.",
    "Compared with 2024 levels.",
    "Revenue was 2026.5 today.",
  ])("rejects unsupported year-shaped quantity: %s", (text) => {
    const v = check(lane(text));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors.join()).toMatch(/Numeral|Non-ASCII/);
  });
  it("rejects a reporting-period year mixed with a disguised quantity", () => {
    expect(errs(lane("In Q3 2026 revenue reached 2050 units."))).toContain("Numeral 2050");
  });
  it("rejects non-ASCII spellings of the year", () => {
    expect(errs(lane("Demand softened in Q3 ٢٠٢٦."))).toContain("Non-ASCII numeric");
  });
  it.each([
    "Demand softened in Q2 2026.",
    "Demand softened in Q3 2026.",
    "Demand softened in 2026 Q3.",
    "Compared with the Q2 2026 period.",
    "Demand softened in FY2026.",
    "Demand softened in fiscal 2026.",
    "Demand softened in FY 2026.",
    "Demand softened in 2026.",
    "Demand softened during 2026, then recovered.",
    "Demand softened (in 2026).",
    "Demand softened in Ｑ３ ２０２６.",
    "Demand softened in ２０２６.",
    "Between Q2 and Q3 2026 (VH-FIN-001-Q2, VH-FIN-001-Q3) demand may be shifting.",
  ])("keeps legitimate reporting-period reference: %s", (text) => {
    expect(errs(lane(text))).toBe("ACCEPTED");
  });
  it("applies in every lane", () => {
    for (const where of ["interp", "rec", "gap"] as const) {
      expect(errs(lane("Revenue reached 2050 units.", where))).toContain("Numeral 2050");
      expect(errs(lane("Compared with Q3 2026.", where))).toBe("ACCEPTED");
    }
  });
  it("numericTokens leaves only the disguised quantity", () => {
    expect(numericTokens("Q3 2026 and 2050 in 2026 units, FY2026", [])).toEqual([2050, 2026]);
  });
});

// ---------------------------------------------------------------- S3
describe("S3: one deadline covers the whole response body (deterministic, no network)", () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  const okBody = { choices: [{ message: { content: JSON.stringify(lane("Demand may be shifting.")) }, finish_reason: "stop" }], usage: { prompt_tokens: 900, completion_tokens: 200 } };
  const never = () => new Promise<never>(() => {});
  /** A response whose headers arrive but whose body never completes. Ignores the abort signal, like a misbehaving fetch. */
  const stalledBody = () => ({ ok: true, status: 200, text: never, json: never, body: null }) as unknown as Response;
  const start = (f: unknown) => {
    const state: { result?: MetaResult } = {};
    const p = runMeta(req(), READY, f as never).then((r) => { state.result = r; return r; });
    return { state, p };
  };
  const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

  it("a stalled body ends exactly at the configured timeout, as a single non-retried error", async () => {
    vi.useFakeTimers();
    const f = vi.fn(async () => stalledBody());
    const { state, p } = start(f);
    await tick(REQUEST_TIMEOUT_MS - 1);
    expect(state.result).toBeUndefined();
    await tick(1);
    const r = await p;
    expect(r.state).toBe("error");
    expect(r.requestSent).toBe(true);
    expect(r.state === "error" && r.reason).toMatch(/timed out after 30000 ms \(not retried\)/);
    expect(f).toHaveBeenCalledTimes(1);
    expect((f.mock.calls[0] as unknown as [string, RequestInit])[1].signal!.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("stalled headers (fetch never resolves) also end at the timeout", async () => {
    vi.useFakeTimers();
    const f = vi.fn(() => never());
    const { state, p } = start(f);
    await tick(REQUEST_TIMEOUT_MS - 1);
    expect(state.result).toBeUndefined();
    await tick(1);
    expect((await p).state).toBe("error");
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("a body that drips one chunk and then stalls is also cut off", async () => {
    vi.useFakeTimers();
    const drip = { ok: true, status: 200, json: never, body: null, text: () => new Promise<string>(() => { /* first chunk read, remainder never arrives */ }) };
    const { p } = start(vi.fn(async () => drip));
    await tick(REQUEST_TIMEOUT_MS);
    const r = await p;
    expect(r.state === "error" && r.reason).toMatch(/timed out/);
  });
  it("is never retried, even if more time passes after the timeout", async () => {
    vi.useFakeTimers();
    const f = vi.fn(async () => stalledBody());
    const { p } = start(f);
    await tick(REQUEST_TIMEOUT_MS);
    await p;
    await tick(5 * REQUEST_TIMEOUT_MS);
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("a body that completes just before the deadline is accepted normally", async () => {
    vi.useFakeTimers();
    const slow = { ok: true, status: 200, json: never, body: null, text: () => new Promise<string>((res) => setTimeout(() => res(JSON.stringify(okBody)), REQUEST_TIMEOUT_MS - 1_000)) };
    const f = vi.fn(async () => slow);
    const { p } = start(f);
    await tick(REQUEST_TIMEOUT_MS - 1_000);
    const r = await p;
    expect(r.state).toBe("ok");
    expect(f).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("a normal fast response completes and leaves no timer behind", async () => {
    vi.useFakeTimers();
    const f = vi.fn(async () => new Response(JSON.stringify(okBody), { status: 200 }));
    const { p } = start(f);
    await tick(0);
    expect((await p).state).toBe("ok");
    expect(vi.getTimerCount()).toBe(0);
  });
  it("an HTTP error is reported immediately without waiting on its body", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const err = { ok: false, status: 500, text: never, json: never, body: null } as unknown as Response;
    const { p } = start(vi.fn(async () => err));
    await tick(0);
    const r = await p;
    expect(r.state === "error" && r.reason).toMatch(/HTTP 500/);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("non-JSON bodies and network errors keep their distinct, non-retried errors", async () => {
    vi.useFakeTimers();
    const nonJson = start(vi.fn(async () => new Response("not json", { status: 200 })));
    await tick(0);
    expect((await nonJson.p).state === "error" && ((await nonJson.p) as { reason: string }).reason).toMatch(/not JSON/);
    const net = vi.fn(async () => { throw new TypeError("fail"); });
    const n = start(net);
    await tick(0);
    expect(((await n.p) as { reason: string }).reason).toMatch(/Network error \(not retried\): TypeError/);
    expect(net).toHaveBeenCalledTimes(1);
  });
});
