// A small, dependency-free layered layout for the relationship map. Generic: it knows nothing about any dataset, only node ids and directed edges.
// Nodes are placed in columns by the longest path from a source (cycles are tolerated: an edge that would close a cycle is ignored for layering),
// then ordered within a column by the average row of their neighbours to reduce crossings. Deterministic for a given input.
export const NODE_W = 168;
export const NODE_H = 56;
const COL_GAP = 96;
const ROW_GAP = 28;
const PAD = 16;

export interface LayoutNode { id: string; x: number; y: number; layer: number }
export interface LayoutEdge { id: string; from: string; to: string; path: string; labelX: number; labelY: number }
export interface Layout { width: number; height: number; nodes: LayoutNode[]; edges: LayoutEdge[] }

export function layoutGraph(nodeIds: readonly string[], edges: readonly { id: string; from: string; to: string }[]): Layout {
  const ids = [...new Set(nodeIds)];
  const index = new Map(ids.map((id, i) => [id, i]));
  const usable = edges.filter((e) => index.has(e.from) && index.has(e.to) && e.from !== e.to);

  // longest-path layering by relaxation, bounded so a cycle cannot loop forever
  const layer = new Map(ids.map((id) => [id, 0]));
  for (let pass = 0; pass < ids.length; pass++) {
    let changed = false;
    for (const e of usable) {
      const want = layer.get(e.from)! + 1;
      if (want > layer.get(e.to)! && want < ids.length) { layer.set(e.to, want); changed = true; }
    }
    if (!changed) break;
  }

  const columns: string[][] = [];
  for (const id of ids) { const l = layer.get(id)!; (columns[l] ??= []).push(id); }
  for (let l = 0; l < columns.length; l++) columns[l] ??= [];

  const row = new Map<string, number>();
  columns.forEach((col) => col.forEach((id, i) => row.set(id, i)));
  for (let l = 1; l < columns.length; l++) {
    const col = columns[l]!;
    const bary = (id: string) => {
      const ins = usable.filter((e) => e.to === id && layer.get(e.from)! < l).map((e) => row.get(e.from)!);
      return ins.length ? ins.reduce((a, b) => a + b, 0) / ins.length : row.get(id)!;
    };
    col.sort((a, b) => bary(a) - bary(b) || index.get(a)! - index.get(b)!);
    col.forEach((id, i) => row.set(id, i));
  }

  const tallest = Math.max(1, ...columns.map((c) => c.length));
  const height = PAD * 2 + tallest * NODE_H + (tallest - 1) * ROW_GAP;
  const width = PAD * 2 + columns.length * NODE_W + Math.max(0, columns.length - 1) * COL_GAP;
  const pos = new Map<string, LayoutNode>();
  columns.forEach((col, l) => {
    const colH = col.length * NODE_H + (col.length - 1) * ROW_GAP;
    const top = PAD + (height - PAD * 2 - colH) / 2;
    col.forEach((id, i) => pos.set(id, { id, layer: l, x: PAD + l * (NODE_W + COL_GAP), y: top + i * (NODE_H + ROW_GAP) }));
  });

  const laid: LayoutEdge[] = usable.map((e) => {
    const a = pos.get(e.from)!, b = pos.get(e.to)!;
    const forward = b.x > a.x;
    const x1 = forward ? a.x + NODE_W : a.x, y1 = a.y + NODE_H / 2;
    const x2 = forward ? b.x : b.x + NODE_W, y2 = b.y + NODE_H / 2;
    const mx = (x1 + x2) / 2;
    return { id: e.id, from: e.from, to: e.to, path: `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`, labelX: mx, labelY: (y1 + y2) / 2 };
  });
  return { width, height, nodes: ids.map((id) => pos.get(id)!), edges: laid };
}
