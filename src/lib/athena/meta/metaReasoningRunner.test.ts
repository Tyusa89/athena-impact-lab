import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ALLOWED_URL,
  CONFIRM_ENV,
  CONFIRM_PHRASE,
  DRY_RUN_REPLY,
  formatReport,
  guardedFetch,
  livePrerequisites,
  runReasoningTest,
  type Report,
} from "../../../../scripts/metaReasoningTest";
import type { ModelOutcome, ModelProvider, ModelRequest } from "./provider";
import { META_ENDPOINT, META_MODEL } from "./providers/muse";

// G4.1: the isolated local runner for the first Meta reasoning test. Everything here is offline: the "live" paths run against a local mock transport that returns a Meta-shaped reply, and the
// vitest global fetch is a tripwire. No test sends a request to Meta.
const tripwire = vi.fn(() => {
  throw new Error("network call attempted");
});
vi.stubGlobal("fetch", tripwire);
afterEach(() => tripwire.mockClear());

const KEY = "sk-test-SECRET-KEY-123456";
const LIVE_ENV = {
  META_MODEL_API_KEY: KEY,
  META_MODEL_ENABLED: "true",
  [CONFIRM_ENV]: CONFIRM_PHRASE,
};
const ctx = { liveFlag: true, inCi: false };
const metaBody = (content: string, finish = "stop") =>
  JSON.stringify({
    choices: [{ message: { content }, finish_reason: finish }],
    usage: { prompt_tokens: 700, completion_tokens: 200, total_tokens: 900 },
  });
const okResponse = (content = DRY_RUN_REPLY) => new Response(metaBody(content), { status: 200 });
const mock = (make: () => Response | Promise<Response>) => {
  const f = vi.fn(async (_u: unknown, _i?: unknown) => make());
  return f as unknown as typeof fetch & typeof f;
};
const report = (r: Awaited<ReturnType<typeof runReasoningTest>>): Report => {
  expect(r.ok).toBe(true);
  return r as Report;
};
const fakeProvider = (reply: string, seen: ModelRequest[] = []): ModelProvider => ({
  id: "t",
  model: "t",
  displayName: "T",
  status: () => ({ keyConfigured: true, ownerEnabled: true }),
  blockedCode: () => null,
  async complete(req): Promise<ModelOutcome> {
    seen.push(req);
    return {
      kind: "completion",
      content: reply,
      truncated: false,
      usage: { max_tokens_sent: 2000 },
    };
  },
});
const reply = (o: { i?: object[]; g?: string[]; r?: object[] }) =>
  JSON.stringify({
    interpretations: o.i ?? [],
    missing_evidence: o.g ?? [],
    recommendations: o.r ?? [],
  });

describe("dry-run (the default): offline, no key, real strict validation", () => {
  it("works with an empty environment, accepts the fake reply and makes no request", async () => {
    const r = report(await runReasoningTest({ mode: "dry-run", env: {} }));
    expect(r.mode).toBe("dry-run");
    expect(r.model).toBe("dry-run-fake");
    expect(r.liveModelTarget).toBe(META_MODEL);
    expect(r.outcome).toBe("accepted");
    expect(r.diagnostics).toEqual([]);
    expect(r.outboundRequests).toBe(0);
    expect(r.blockedRequests).toBe(0);
    expect(r.allSafetyChecksPassed).toBe(true);
    expect(r.usage).toBe("n/a (dry-run)");
    expect(tripwire).not.toHaveBeenCalled();
  });
  it("the fake reply shows observations, a hedged hypothesis, missing evidence and a human-approved investigation", async () => {
    const r = report(await runReasoningTest({ mode: "dry-run", env: {} }));
    expect(r.usefulness).toEqual({
      observesLeads: true,
      observesConversion: true,
      observesCac: true,
      hasHypothesisMarkedUnverified: true,
      namesMissingEvidence: true,
      recommendsInvestigation: true,
    });
    const parsed = JSON.parse(DRY_RUN_REPLY);
    expect(parsed.interpretations.every((i: { verified: boolean }) => i.verified === false)).toBe(
      true,
    );
    expect(
      parsed.recommendations.every(
        (x: { requires_human_approval: boolean }) => x.requires_human_approval === true,
      ),
    ).toBe(true);
    expect(DRY_RUN_REPLY).not.toMatch(/\d/); // no numbers: Athena renders every number itself
  });
  it("the model sees only the three synthetic test metrics: no question, no record ids, no withheld metric", async () => {
    const seen: ModelRequest[] = [];
    report(
      await runReasoningTest({
        mode: "dry-run",
        env: {},
        provider: fakeProvider(DRY_RUN_REPLY, seen),
      }),
    );
    expect(seen.length).toBe(1);
    const sent = JSON.stringify(seen[0]!.messages);
    for (const id of ["F-leads", "F-conversion_rate", "F-cac"]) expect(sent).toContain(id);
    expect(sent).not.toMatch(
      /VH-|SYN-|revenue|mql_rate|closed_deals|fulfillment|backorder|F-revenue/i,
    );
    expect(sent).toContain("UNAVAILABLE_METRICS (JSON): []");
  });
  it("hidden metrics stay rejected: a reply about withheld Finance or same-department metrics is refused", async () => {
    for (const text of ["Recognized revenue declined.", "Lead quality declined."]) {
      const r = report(
        await runReasoningTest({
          mode: "dry-run",
          env: {},
          provider: fakeProvider(reply({ i: [{ text, verified: false, refs: ["F-leads"] }] })),
        }),
      );
      expect(r.outcome, text).toBe("rejected");
      expect(r.diagnostics, text).toEqual(["domain"]);
      expect(r.usefulness).toBeNull();
    }
  });
  it("rejected outputs stay safely rejected and are reported by category only", async () => {
    const causal = reply({
      i: [
        {
          text: "Revenue declined because marketing performed poorly.",
          verified: false,
          refs: ["F-leads"],
        },
      ],
    });
    const r = report(
      await runReasoningTest({ mode: "dry-run", env: {}, provider: fakeProvider(causal) }),
    );
    expect(r.outcome).toBe("rejected");
    expect(r.diagnostics.length).toBeGreaterThan(0);
    const text = formatReport(r);
    expect(text).toContain("outcome: rejected");
    expect(text).not.toMatch(/because marketing|performed poorly|F-leads|VH-/);
    expect("response" in r).toBe(false);
  });
  it("never hands the real environment to the model provider, even when a real key is present", async () => {
    const seenEnv: unknown[] = [];
    const spy: ModelProvider = {
      ...fakeProvider(DRY_RUN_REPLY),
      async complete(_req, call): Promise<ModelOutcome> {
        seenEnv.push({ ...call.env });
        return {
          kind: "completion",
          content: DRY_RUN_REPLY,
          truncated: false,
          usage: { max_tokens_sent: 2000 },
        };
      },
    };
    const r = report(await runReasoningTest({ mode: "dry-run", env: LIVE_ENV, provider: spy }));
    expect(r.outcome).toBe("accepted");
    expect(seenEnv.length).toBe(1);
    expect(JSON.stringify(seenEnv)).not.toContain(KEY);
    expect(JSON.stringify(seenEnv)).not.toContain(CONFIRM_PHRASE);
  });
  it("a misbehaving provider that tries to send a request is caught: counted, flagged, never forwarded", async () => {
    const sneaky: ModelProvider = {
      ...fakeProvider(DRY_RUN_REPLY),
      async complete(_req, call): Promise<ModelOutcome> {
        await call.fetch(META_ENDPOINT, { method: "POST" }).catch(() => {});
        await call.fetch("https://example.com/x", { method: "POST" }).catch(() => {});
        return {
          kind: "completion",
          content: DRY_RUN_REPLY,
          truncated: false,
          usage: { max_tokens_sent: 2000 },
        };
      },
    };
    const r = report(await runReasoningTest({ mode: "dry-run", env: {}, provider: sneaky }));
    expect(r.allSafetyChecksPassed).toBe(false);
    expect(r.checks.find((c) => c.name.startsWith("dry-run made no outbound"))!.pass).toBe(false);
    expect(r.blockedRequests).toBeGreaterThan(0);
    expect(tripwire).not.toHaveBeenCalled();
  });
});

describe("live mode is refused unless every prerequisite holds (nothing is sent)", () => {
  const attempt = async (env: Record<string, string | undefined>, c = ctx) => {
    const f = mock(() => okResponse());
    const r = await runReasoningTest({ mode: "live", env, fetchImpl: f }, c);
    expect(f).not.toHaveBeenCalled();
    return r;
  };
  const missing = async (env: Record<string, string | undefined>, c = ctx) => {
    const r = await attempt(env, c);
    expect(r.ok).toBe(false);
    return r.ok ? [] : r.missing;
  };
  it("without the explicit --live flag", async () => {
    expect(await missing(LIVE_ENV, { liveFlag: false, inCi: false })).toEqual(["live-flag"]);
  });
  it("without the per-run confirmation phrase", async () => {
    expect(await missing({ ...LIVE_ENV, [CONFIRM_ENV]: undefined })).toEqual(["confirmation"]);
    expect(await missing({ ...LIVE_ENV, [CONFIRM_ENV]: "yes" })).toEqual(["confirmation"]);
    expect(await missing({ ...LIVE_ENV, [CONFIRM_ENV]: CONFIRM_PHRASE.toLowerCase() })).toEqual([
      "confirmation",
    ]);
  });
  it("without the credential, or with a blank one", async () => {
    expect(await missing({ ...LIVE_ENV, META_MODEL_API_KEY: undefined })).toEqual(["credential"]);
    expect(await missing({ ...LIVE_ENV, META_MODEL_API_KEY: "   " })).toEqual(["credential"]);
  });
  it("without the existing activation flag set to exactly 'true'", async () => {
    expect(await missing({ ...LIVE_ENV, META_MODEL_ENABLED: undefined })).toEqual(["activation"]);
    expect(await missing({ ...LIVE_ENV, META_MODEL_ENABLED: "1" })).toEqual(["activation"]);
  });
  it("in CI, and without a transport", async () => {
    expect(await missing(LIVE_ENV, { liveFlag: true, inCi: true })).toEqual(["not-in-ci"]);
    expect(livePrerequisites({ env: LIVE_ENV }, true, false)).toEqual(["transport"]);
  });
  it("lists every missing prerequisite explicitly and never a value", async () => {
    const r = await attempt({}, { liveFlag: false, inCi: true });
    const text = formatReport(r);
    expect(text).toContain("LIVE RUN REFUSED");
    for (const needle of ["--live", "CI", CONFIRM_ENV, "META_MODEL_API_KEY", "META_MODEL_ENABLED"])
      expect(text).toContain(needle);
    expect(text).not.toContain(CONFIRM_PHRASE);
  });
});

describe("a permitted live run (against a LOCAL mock transport) is one request to the Meta endpoint", () => {
  it("sends exactly one POST to the allowlisted endpoint with the documented body, and accepts a valid reply", async () => {
    const f = mock(() => okResponse());
    const r = report(await runReasoningTest({ mode: "live", env: LIVE_ENV, fetchImpl: f }, ctx));
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = (f as unknown as { mock: { calls: [string, RequestInit][] } }).mock
      .calls[0]!;
    expect(url).toBe(META_ENDPOINT);
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe(META_MODEL);
    expect(body.max_tokens).toBe(2000);
    expect(body.stream).toBe(false);
    expect(JSON.stringify(body)).not.toMatch(/VH-|revenue|mql_rate/i);
    expect(r.mode).toBe("live");
    expect(r.model).toBe(META_MODEL);
    expect(r.outcome).toBe("accepted");
    expect(r.outboundRequests).toBe(1);
    expect(r.blockedRequests).toBe(0);
    expect(r.usage).toMatchObject({
      prompt_tokens: 700,
      completion_tokens: 200,
      total_tokens: 900,
      max_tokens_sent: 2000,
    });
    expect(r.allSafetyChecksPassed).toBe(true);
    expect(tripwire).not.toHaveBeenCalled();
  });
  it("ignores a provider override in live mode: it always uses the Meta provider", async () => {
    const f = mock(() => okResponse());
    const r = report(
      await runReasoningTest(
        { mode: "live", env: LIVE_ENV, fetchImpl: f, provider: fakeProvider("{}") },
        ctx,
      ),
    );
    expect(r.model).toBe(META_MODEL);
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("never retries: an HTTP error, a thrown transport error, a truncated reply and a malformed body each cost exactly one request", async () => {
    const cases: [string, () => Response | Promise<Response>, Report["outcome"]][] = [
      ["http 500", () => new Response("upstream says " + KEY, { status: 500 }), "error"],
      ["http 429", () => new Response("", { status: 429 }), "error"],
      [
        "transport error",
        () => {
          throw new TypeError("fetch failed");
        },
        "error",
      ],
      [
        "truncated",
        () => new Response(metaBody(DRY_RUN_REPLY, "length"), { status: 200 }),
        "rejected",
      ],
      ["malformed body", () => new Response("not json", { status: 200 }), "error"],
      [
        "empty content",
        () =>
          new Response(JSON.stringify({ choices: [{ message: {}, finish_reason: "stop" }] }), {
            status: 200,
          }),
        "rejected",
      ],
    ];
    for (const [name, make, outcome] of cases) {
      const f = mock(make);
      const r = report(
        await runReasoningTest(
          { mode: "live", env: LIVE_ENV, fetchImpl: f, showResponse: true },
          ctx,
        ),
      );
      expect(f, name).toHaveBeenCalledTimes(1);
      expect(r.outcome, name).toBe(outcome);
      expect(JSON.stringify(r) + formatReport(r), name).not.toContain(KEY);
    }
  });
  it("a live reply that fails strict validation is rejected, not shown, and reported by category", async () => {
    const f = mock(() =>
      okResponse(
        reply({
          i: [{ text: "Revenue declined because of churn.", verified: false, refs: ["F-leads"] }],
        }),
      ),
    );
    const r = report(await runReasoningTest({ mode: "live", env: LIVE_ENV, fetchImpl: f }, ctx));
    expect(r.outcome).toBe("rejected");
    expect(r.diagnostics.length).toBeGreaterThan(0);
    expect(formatReport(r)).not.toMatch(/churn|F-leads/);
  });
});

describe("the outbound guard: one request, one destination", () => {
  const real = () => mock(() => new Response("{}", { status: 200 }));
  it("forwards the first POST to the Meta endpoint and blocks a second one", async () => {
    const f = real();
    const g = guardedFetch(f);
    await g.fetch(ALLOWED_URL, { method: "POST" });
    await expect(g.fetch(ALLOWED_URL, { method: "POST" })).rejects.toThrow(/blocked/);
    expect(f).toHaveBeenCalledTimes(1);
    expect(g.state).toEqual({ forwarded: 1, blocked: 1 });
  });
  it("blocks every other destination, scheme, method and look-alike, even as the first request", async () => {
    for (const url of [
      "https://example.com/v1/chat/completions",
      "http://api.meta.ai/v1/chat/completions",
      "https://api.meta.ai/v1/models",
      "https://api.meta.ai.evil.test/v1/chat/completions",
      "https://sub.api.meta.ai/v1/chat/completions",
      "https://api.meta.ai/v1/chat/completions?x=1",
      "https://api.meta.ai:8443/v1/chat/completions",
      "https://api.openai.com/v1/chat/completions",
    ]) {
      const f = real();
      const g = guardedFetch(f);
      await expect(g.fetch(url, { method: "POST" }), url).rejects.toThrow(/blocked/);
      expect(f, url).not.toHaveBeenCalled();
      expect(g.state.forwarded).toBe(0);
    }
    const f = real();
    await expect(guardedFetch(f).fetch(ALLOWED_URL)).rejects.toThrow(/blocked/); // GET
    await expect(guardedFetch(f).fetch(ALLOWED_URL, { method: "GET" })).rejects.toThrow(/blocked/);
    expect(f).not.toHaveBeenCalled();
  });
  it("the allowlist is exactly the Meta chat-completions endpoint", () => {
    expect(ALLOWED_URL).toBe("https://api.meta.ai/v1/chat/completions");
    expect(ALLOWED_URL).toBe(META_ENDPOINT);
  });
});

describe("credentials and payloads stay out of routine output", () => {
  it("the credential and the confirmation phrase never appear in a report, a refusal or a failure", async () => {
    const outputs: string[] = [];
    const ok = report(
      await runReasoningTest(
        { mode: "live", env: LIVE_ENV, fetchImpl: mock(() => okResponse()), showResponse: true },
        ctx,
      ),
    );
    outputs.push(JSON.stringify(ok), formatReport(ok));
    const refused = await runReasoningTest(
      {
        mode: "live",
        env: { ...LIVE_ENV, META_MODEL_ENABLED: "false" },
        fetchImpl: mock(() => okResponse()),
      },
      ctx,
    );
    outputs.push(JSON.stringify(refused), formatReport(refused));
    const failed = report(
      await runReasoningTest(
        {
          mode: "live",
          env: LIVE_ENV,
          fetchImpl: mock(() => new Response("key " + KEY, { status: 401 })),
        },
        ctx,
      ),
    );
    outputs.push(JSON.stringify(failed), formatReport(failed));
    for (const o of outputs) {
      expect(o).not.toContain(KEY);
      expect(o).not.toContain(CONFIRM_PHRASE);
    }
  });
  it("routine output carries no prompt or model reply; the reply appears only when explicitly requested", async () => {
    const plain = report(await runReasoningTest({ mode: "dry-run", env: {} }));
    expect("response" in plain).toBe(false);
    expect(formatReport(plain)).not.toMatch(
      /Lead volume increased|Investigate whether|F-leads|VERIFIED_FACTS|Brief:/,
    );
    const shown = report(await runReasoningTest({ mode: "dry-run", env: {}, showResponse: true }));
    expect(shown.response).toBe(DRY_RUN_REPLY);
    expect(formatReport(shown)).toContain("Lead volume increased");
    expect(formatReport(shown)).not.toMatch(/VERIFIED_FACTS|Brief:/); // the prompt is never shown
  });
  it("repeated dry runs are identical", async () => {
    const a = JSON.stringify(await runReasoningTest({ mode: "dry-run", env: {} }));
    expect(JSON.stringify(await runReasoningTest({ mode: "dry-run", env: {} }))).toBe(a);
  });
});

const hasBun = spawnSync("bun", ["--version"]).status === 0;
describe.skipIf(!hasBun)(
  "the command line (subprocess; never given a usable live configuration)",
  () => {
    const cli = (args: string[], env: Record<string, string> = {}) =>
      spawnSync("bun", ["scripts/run-meta-reasoning-test.ts", ...args], {
        env: { PATH: process.env["PATH"] ?? "", ...env },
        encoding: "utf8",
        timeout: 60_000,
      });
    it("defaults to the dry run, needs no key and exits 0", () => {
      const r = cli([]);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("mode: dry-run");
      expect(r.stdout).toContain("outbound requests: 0");
      expect(r.stdout).toContain("safety checks: ALL PASSED");
      expect(r.stdout).not.toMatch(/Lead volume increased|F-leads/);
    });
    it("--show-response prints the synthetic reply only when asked", () => {
      expect(cli(["--show-response"]).stdout).toContain("Lead volume increased");
    });
    it("--live without the prerequisites is refused with exit 2 and nothing is sent", () => {
      const r = cli(["--live"]);
      expect(r.status).toBe(2);
      expect(r.stdout).toContain("LIVE RUN REFUSED");
      expect(r.stdout).toContain(CONFIRM_ENV);
      expect(r.stdout).toContain("META_MODEL_API_KEY");
    });
    it("--live with a confirmation but no key is still refused", () => {
      const r = cli(["--live"], { [CONFIRM_ENV]: CONFIRM_PHRASE });
      expect(r.status).toBe(2);
      expect(r.stdout).toContain("META_MODEL_API_KEY is not set");
    });
    it("--live in CI is refused even with every variable present (the dummy value is never used)", () => {
      const r = cli(["--live"], {
        CI: "true",
        META_MODEL_API_KEY: KEY,
        META_MODEL_ENABLED: "true",
        [CONFIRM_ENV]: CONFIRM_PHRASE,
      });
      expect(r.status).toBe(2);
      expect(r.stdout).toContain("CI");
      expect(r.stdout + r.stderr).not.toContain(KEY);
    });
    it("an unknown argument is refused", () => {
      expect(cli(["--lvie"]).status).toBe(2);
    });
  },
);

describe("isolation: the runner is not part of the application", () => {
  const walk = (d: string): string[] =>
    readdirSync(d).flatMap((f) =>
      statSync(`${d}/${f}`).isDirectory() ? walk(`${d}/${f}`) : [`${d}/${f}`],
    );
  const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\/|(?<!:)\/\/[^\n]*/g, " ");
  it("no application source (outside tests) imports or names the runner, and no route or server function exposes it", () => {
    const app = walk("src").filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\./.test(f));
    expect(
      app.filter((f) =>
        /metaReasoningTest|run-meta-reasoning-test|G41_LIVE_CONFIRM|scripts\//.test(
          strip(readFileSync(f, "utf8")),
        ),
      ),
    ).toEqual([]);
    expect(readFileSync("package.json", "utf8")).not.toMatch(/meta-reasoning|metaReasoning/);
    expect(readFileSync("vite.config.ts", "utf8")).not.toMatch(/scripts/);
  });
  it("the runner uses only the existing strict runtime and provider, writes nothing and never calls the global fetch itself", () => {
    const lib = strip(readFileSync("scripts/metaReasoningTest.ts", "utf8"));
    const cliSrc = strip(readFileSync("scripts/run-meta-reasoning-test.ts", "utf8"));
    expect(lib).toMatch(/runStrictAnalysis/);
    expect(lib).toMatch(/museSpark/);
    for (const src of [lib, cliSrc])
      expect(src).not.toMatch(
        /node:fs|writeFile|appendFile|node:child_process|localStorage|\.insert\(|INSERT INTO|createServerFn/,
      );
    expect(lib).not.toMatch(/\bfetch\(/); // the library only ever receives a transport
    expect(cliSrc.match(/\bfetch\b/g)?.length).toBe(1); // the CLI hands the global fetch over in live mode only
    expect(cliSrc).toMatch(/live \? \{ fetchImpl: fetch \}/);
  });
  it("the legacy Meta comparison path is untouched: the server function still calls the legacy runMeta", () => {
    const fns = strip(readFileSync("src/lib/athena/meta.functions.ts", "utf8"));
    expect(fns).toMatch(/runMeta\(data/);
    expect(fns).not.toMatch(/strictRuntime|runStrictAnalysis|validateStrictOutput|metaReasoning/);
  });
});
