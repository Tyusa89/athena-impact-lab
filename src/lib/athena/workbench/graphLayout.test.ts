import { describe, expect, it } from "vitest";
import { NODE_H, NODE_W, layoutGraph } from "./graphLayout";

describe("layoutGraph (generic, deterministic)", () => {
  const E = (id: string, from: string, to: string) => ({ id, from, to });
  it("places a chain in successive columns and keeps every node inside the canvas", () => {
    const l = layoutGraph(["a", "b", "c"], [E("1", "a", "b"), E("2", "b", "c")]);
    const x = (id: string) => l.nodes.find((n) => n.id === id)!.x;
    expect(x("a")).toBeLessThan(x("b")); expect(x("b")).toBeLessThan(x("c"));
    for (const n of l.nodes) { expect(n.x + NODE_W).toBeLessThanOrEqual(l.width); expect(n.y + NODE_H).toBeLessThanOrEqual(l.height); expect(n.y).toBeGreaterThanOrEqual(0); }
  });
  it("does not stack two nodes of one column on top of each other", () => {
    const l = layoutGraph(["a", "b", "c", "d"], [E("1", "a", "c"), E("2", "b", "c"), E("3", "b", "d")]);
    for (const p of l.nodes) for (const q of l.nodes) if (p !== q && p.layer === q.layer) expect(Math.abs(p.y - q.y)).toBeGreaterThanOrEqual(NODE_H);
  });
  it("is deterministic", () => {
    const args = [["a", "b", "c"], [E("1", "a", "b"), E("2", "a", "c")]] as const;
    expect(layoutGraph(...args)).toEqual(layoutGraph(...args));
  });
  it("tolerates a cycle, a self-loop, duplicate nodes, an edge to an unknown node, and an empty graph", () => {
    const l = layoutGraph(["a", "b", "a"], [E("1", "a", "b"), E("2", "b", "a"), E("3", "a", "a"), E("4", "a", "zzz")]);
    expect(l.nodes.map((n) => n.id).sort()).toEqual(["a", "b"]);
    expect(l.edges.map((e) => e.id)).toEqual(["1", "2"]); // edges to nodes that are not drawn are dropped, never invented
    expect(layoutGraph([], []).nodes).toEqual([]);
  });
});
