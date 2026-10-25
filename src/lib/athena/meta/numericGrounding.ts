// Deterministic numerical grounding for Meta output. Pure + client-safe (no secrets, no I/O).
// Verified facts come from the SAME calculation the local engine uses (computeFacts) over server-authorized
// records only. The model refers to a fact by id in a structured claim; the claim is checked against that exact
// fact (metric, period, kind, value, unit, direction) and the item must cite the fact's supporting record IDs.
// Numbers in free text must be backed by one of the item's claims. Anything unverifiable is rejected.
import { z } from "zod";
import { METRIC_LABELS, type EvidenceRecord, type MetricKey } from "../data";
import { computeFacts } from "../engine";

export const MAX_CLAIMS_PER_ITEM = 4;
const METRICS = Object.keys(METRIC_LABELS) as [MetricKey, ...MetricKey[]];
const EPS = 1e-9;

/** One numeric assertion, stated structurally so it can be checked without parsing prose. */
export const ClaimSchema = z
  .object({
    fact_id: z.string().min(1).max(40),
    metric: z.enum(METRICS),
    kind: z.enum(["level", "change_pct", "change_pp"]),
    /** Required for "level"; must be absent for change kinds. */
    period: z.enum(["prior", "current"]).optional(),
    value: z.number().finite(),
    /** "level": the metric's unit. "change_pct": "%". "change_pp": "pp". */
    unit: z.string().min(1).max(12),
    /** Required for change kinds; must be absent for "level". */
    direction: z.enum(["up", "down", "flat"]).optional(),
  })
  .strict();
export type Claim = z.infer<typeof ClaimSchema>;

export interface VerifiedFact {
  fact_id: string;
  metric: MetricKey;
  unit: string;
  prior: { id: string; value: number };
  current: { id: string; value: number };
  change_pct: number | null;
  change_pp: number | null;
  direction: "up" | "down" | "flat";
}

export const factIdFor = (m: MetricKey) => `F-${m}`;

/** Verified facts from authorized records only, via the engine's own computeFacts (one fact per metric). */
export function buildVerifiedFacts(authorized: EvidenceRecord[]): VerifiedFact[] {
  return computeFacts(authorized).map((f) => ({
    fact_id: factIdFor(f.metric),
    metric: f.metric,
    unit: f.unit,
    prior: { id: f.evidenceIds[0]!, value: f.prior },
    current: { id: f.evidenceIds[1]!, value: f.current },
    change_pct: f.changePct,
    change_pp: f.changePp,
    direction: f.direction,
  }));
}

const same = (a: number, b: number) => Math.abs(a - b) < EPS;

/** Errors for one claim; empty when the claim exactly matches a verified fact and is properly cited. */
export function verifyClaim(c: Claim, facts: VerifiedFact[], citedIds: readonly string[]): string[] {
  const tag = `Claim ${c.fact_id}/${c.kind}`;
  const f = facts.find((x) => x.fact_id === c.fact_id);
  if (!f) return [`${tag}: unknown or unauthorized fact`];
  if (c.metric !== f.metric) return [`${tag}: wrong metric (${c.metric} is not ${f.metric})`];
  const errs: string[] = [];
  let need: string[];
  if (c.kind === "level") {
    if (!c.period) return [`${tag}: period required`];
    if (c.direction !== undefined) errs.push(`${tag}: direction not allowed on a level claim`);
    const side = f[c.period];
    if (!same(c.value, side.value)) errs.push(`${tag}: value ${c.value} does not match ${c.period} ${side.value}`);
    if (c.unit !== f.unit) errs.push(`${tag}: unit ${c.unit} does not match ${f.unit}`);
    need = [side.id];
  } else {
    if (c.period !== undefined) errs.push(`${tag}: period not allowed on a change claim`);
    const expected = c.kind === "change_pct" ? f.change_pct : f.change_pp;
    const unit = c.kind === "change_pct" ? "%" : "pp";
    if (expected === null) return [...errs, `${tag}: change not defined for this metric`];
    if (!same(c.value, expected)) errs.push(`${tag}: value ${c.value} does not match verified ${expected}`);
    if (c.unit !== unit) errs.push(`${tag}: unit ${c.unit} does not match ${unit}`);
    if (c.direction === undefined) errs.push(`${tag}: direction required`);
    else if (c.direction !== f.direction) errs.push(`${tag}: direction ${c.direction} does not match verified ${f.direction}`);
    need = [f.prior.id, f.current.id];
  }
  for (const id of need) if (!citedIds.includes(id)) errs.push(`${tag}: item must cite supporting record ${id}`);
  return errs;
}

/** Numeric tokens in free text, after removing record ids, quarter labels and years. Commas and sign are ignored. */
export function numericTokens(text: string, recordIds: readonly string[]): number[] {
  let t = text;
  for (const id of recordIds) t = t.split(id).join(" ");
  t = t.replace(/\bq[1-4]\b/gi, " ").replace(/\b20\d{2}\b/g, " ");
  return (t.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((m) => Number(m.replace(/,/g, "")));
}

export interface GroundedItem { text: string; cited_ids?: readonly string[]; claims?: readonly Claim[] }

/** All numeric-grounding errors for one output item. */
export function verifyItem(item: GroundedItem, facts: VerifiedFact[], recordIds: readonly string[]): string[] {
  const claims = item.claims ?? [];
  const errs = claims.flatMap((c) => verifyClaim(c, facts, item.cited_ids ?? []));
  const backed = claims.map((c) => Math.abs(c.value));
  for (const n of numericTokens(item.text, recordIds)) {
    if (!backed.some((v) => same(v, n))) errs.push(`Unsupported number ${n} in text "${item.text.slice(0, 40)}": no matching verified claim`);
  }
  return errs;
}
