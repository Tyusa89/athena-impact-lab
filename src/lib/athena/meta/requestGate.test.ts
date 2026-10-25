import { describe, expect, it } from "vitest";
import { createRequestGate, scopeKey, visibleFor } from "./requestGate";

const scope = (roleId: string, scenarioId = "baseline", workspaces: string[] = ["ws-sales"]) => ({ roleId, scenarioId, workspaces });

describe("scopeKey", () => {
  it("differs by role, scenario and workspace set", () => {
    const base = scopeKey(scope("exec"));
    expect(scopeKey(scope("finance"))).not.toBe(base);
    expect(scopeKey(scope("exec", "ops-only"))).not.toBe(base);
    expect(scopeKey(scope("exec", "baseline", ["ws-sales", "ws-ops"]))).not.toBe(base);
  });
  it("ignores workspace order", () => {
    expect(scopeKey(scope("custom", "baseline", ["ws-a", "ws-b"]))).toBe(scopeKey(scope("custom", "baseline", ["ws-b", "ws-a"])));
  });
});

describe("request gate", () => {
  it("accepts the latest request while the scope is unchanged", () => {
    const g = createRequestGate();
    const k = scopeKey(scope("exec"));
    const t = g.begin(k);
    expect(g.isCurrent(t, k)).toBe(true);
  });
  it("rejects a request after the live scope changed", () => {
    const g = createRequestGate();
    const t = g.begin(scopeKey(scope("exec")));
    expect(g.isCurrent(t, scopeKey(scope("finance")))).toBe(false);
  });
  it("rejects a request after invalidate()", () => {
    const g = createRequestGate();
    const k = scopeKey(scope("exec"));
    const t = g.begin(k);
    g.invalidate();
    expect(g.isCurrent(t, k)).toBe(false);
  });
  it("rejects an older request once a newer one began, even for the same scope", () => {
    const g = createRequestGate();
    const k = scopeKey(scope("exec"));
    const a = g.begin(k);
    const b = g.begin(k);
    expect(g.isCurrent(a, k)).toBe(false);
    expect(g.isCurrent(b, k)).toBe(true);
  });
  it("never accepts a ticket before any request began", () => {
    const g = createRequestGate();
    expect(g.isCurrent(0, scopeKey(scope("exec")))).toBe(false);
  });
});

describe("visibleFor", () => {
  it("shows a stored value only for the scope it was produced under", () => {
    const tagged = { key: scopeKey(scope("exec")), value: "x" };
    expect(visibleFor(tagged, scopeKey(scope("exec")))).toBe("x");
    expect(visibleFor(tagged, scopeKey(scope("finance")))).toBeNull();
    expect(visibleFor(null, scopeKey(scope("exec")))).toBeNull();
  });
});
