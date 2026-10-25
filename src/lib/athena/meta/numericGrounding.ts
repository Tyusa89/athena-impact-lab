// Verified facts + numeral policy for Meta output. Pure + client-safe (no secrets, no I/O).
// Verified facts come from the SAME calculation the local engine uses (computeFacts) over server-authorized
// records only. The model never states a number: it refers to a fact by id, and Athena renders every number itself
// (see findings.ts). Free model text may therefore contain no numerals at all, so a number can never be attached
// to the wrong metric, period or direction by the model. Anything unverifiable is rejected (fail closed).
// Text is NFKC-normalized before scanning; numeric characters that stay non-ASCII are rejected outright.
import type { EvidenceRecord, MetricKey } from "../data";
import { computeFacts } from "../engine";

export interface VerifiedFact {
  fact_id: string;
  metric: MetricKey;
  department: string;
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
    department: f.department,
    unit: f.unit,
    prior: { id: f.evidenceIds[0]!, value: f.prior },
    current: { id: f.evidenceIds[1]!, value: f.current },
    change_pct: f.changePct,
    change_pp: f.changePp,
    direction: f.direction,
  }));
}

/** Authorized records that no verified fact represents. Facts-only prompting is allowed only when this is empty. */
export function uncoveredRecordIds(records: readonly EvidenceRecord[], facts: readonly VerifiedFact[]): string[] {
  const covered = new Set(facts.flatMap((f) => [f.prior.id, f.current.id]));
  return records.filter((r) => !covered.has(r.id)).map((r) => r.id);
}

/** Supporting record ids for referenced facts, derived server-side (never taken from the model). Order-preserving, de-duplicated. */
export function supportingIdsFor(refs: readonly string[], facts: readonly VerifiedFact[]): string[] {
  const out: string[] = [];
  for (const ref of refs) {
    const f = facts.find((x) => x.fact_id === ref);
    if (f) for (const id of [f.prior.id, f.current.id]) if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** NFKC-normalize (folds full-width digits, circled digits, vulgar fractions to ASCII) and drop invisible characters, then
 * remove the intentionally exempt tokens: record ids, quarter labels and years. */
function scannable(text: string, recordIds: readonly string[]): string {
  let t = text.normalize("NFKC").replace(/[­​-‏⁠﻿]/g, "");
  for (const id of recordIds) t = t.split(id).join(" ");
  return t.replace(/\bq[1-4]\b/gi, " ").replace(/\b20\d{2}\b/g, " ");
}

/** ASCII numeric tokens in free text after normalization and exemptions. Commas and sign are ignored. */
export function numericTokens(text: string, recordIds: readonly string[]): number[] {
  return (scannable(text, recordIds).match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((m) => Number(m.replace(/,/g, "")));
}

/** Numeric characters (\p{N}) that remain non-ASCII after NFKC, e.g. Arabic-Indic or Devanagari digits. Their value is not
 * interpreted: any such character in free text is rejected (fail closed). */
export function nonAsciiNumerics(text: string, recordIds: readonly string[]): string[] {
  return (scannable(text, recordIds).match(/\p{N}/gu) ?? []).filter((ch) => !/^[0-9]$/.test(ch));
}

/** Strict numeral rule: model-authored text may contain no numerals (record ids, Q1-Q4 labels and years are exempt). */
export function verifyNoNumerals(text: string, recordIds: readonly string[]): string[] {
  const errs: string[] = [];
  const shown = text.slice(0, 40);
  const odd = nonAsciiNumerics(text, recordIds);
  if (odd.length) errs.push(`Non-ASCII numeric character(s) ${odd.slice(0, 3).map((c) => `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`).join(",")} in text "${shown}": rejected`);
  const nums = numericTokens(text, recordIds);
  if (nums.length) errs.push(`Numeral ${nums[0]} not allowed in model text "${shown}": numbers appear only in Athena-computed findings`);
  return errs;
}
