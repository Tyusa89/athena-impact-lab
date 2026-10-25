// In-memory, tenant-partitioned evidence ledger and EvidenceStore. A reference implementation of "where imported evidence lives": a real
// deployment replaces it with durable storage that keeps the same rules. Pure and dependency-free (no I/O).
//
//  * Only results produced by `importSource` can be committed (a hand-built result, a copy, or another tenant's result is refused).
//  * A result is committed only under the tenant it was imported for.
//  * A later batch can never silently change a fact: a (metric, period) that already exists is a duplicate (identical) or a conflict (different),
//    and either makes the whole commit a no-op. Re-importing identical content is an idempotent no-op.
//  * The store view returns only the asking tenant's evidence for the named dataset; the engine still filters again in `authorizeEvidence`.
import type { EvidenceStore } from "../access";
import type { Evidence } from "../evidence";
import { AuthorizationError, type IdentityBoundary, type TrustedContext } from "../identity";
import { isImportResult } from "./normalize";
import type { ImportBatch, Provenance } from "./types";

export type CommitOutcome =
  | { committed: true; added: number }
  | { committed: false; reason: "already_imported" | "not_importable" | "duplicate_of_existing" | "conflicts_with_existing" | "duplicate_id"; added: 0 };

export interface EvidenceLedger {
  /** Add an import result's evidence for the context's tenant, in a named dataset. All or nothing. Throws `AuthorizationError` for a forged/foreign result or context. */
  commit(ctx: TrustedContext, result: unknown, dataset: string): CommitOutcome;
  /** The ledger as an `EvidenceStore`: only the asking tenant's evidence for the dataset. Throws `AuthorizationError` for a context this boundary did not issue. */
  readonly store: EvidenceStore<Evidence>;
  provenanceOf(ctx: TrustedContext, dataset: string, evidenceId: string): Provenance | undefined;
  batches(ctx: TrustedContext, dataset: string): readonly ImportBatch[];
}

interface Slot { records: Evidence[]; byKey: Map<string, Evidence>; ids: Set<string>; batches: ImportBatch[]; prov: Map<string, Provenance> }
const DATASET_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/;
const keyOf = (e: Evidence) => `${e.metric}\u0000${e.period}`;
const same = (a: Evidence, b: Evidence) => a.value === b.value && a.unit === b.unit && a.source === b.source && a.department === b.department && a.date === b.date;

export function createEvidenceLedger(identity: IdentityBoundary): EvidenceLedger {
  const tenants = new Map<string, Map<string, Slot>>();
  const slotFor = (tenantId: string, dataset: string, create: boolean): Slot | undefined => {
    let byDataset = tenants.get(tenantId);
    if (!byDataset) { if (!create) return undefined; byDataset = new Map(); tenants.set(tenantId, byDataset); }
    let slot = byDataset.get(dataset);
    if (!slot && create) { slot = { records: [], byKey: new Map(), ids: new Set(), batches: [], prov: new Map() }; byDataset.set(dataset, slot); }
    return slot;
  };
  const guard = (ctx: TrustedContext, dataset: string) => { if (!identity.owns(ctx) || !DATASET_RE.test(dataset)) throw new AuthorizationError(); };

  return {
    commit(ctx, result, dataset): CommitOutcome {
      guard(ctx, dataset);
      if (!isImportResult(result) || result.batch.tenantId !== ctx.tenantId) throw new AuthorizationError();
      if (result.status === "rejected" || result.accepted.length === 0) return { committed: false, reason: "not_importable", added: 0 };
      const slot = slotFor(ctx.tenantId, dataset, true)!;
      if (slot.batches.some((b) => b.batchId === result.batch.batchId)) return { committed: false, reason: "already_imported", added: 0 };
      let dup = false, conflict = false, idClash = false;
      for (const e of result.accepted) {
        const existing = slot.byKey.get(keyOf(e));
        if (existing) { if (same(existing, e)) dup = true; else conflict = true; }
        else if (slot.ids.has(e.id)) idClash = true;
      }
      if (conflict) return { committed: false, reason: "conflicts_with_existing", added: 0 };
      if (dup) return { committed: false, reason: "duplicate_of_existing", added: 0 };
      if (idClash) return { committed: false, reason: "duplicate_id", added: 0 };
      for (const e of result.accepted) {
        slot.records.push(e); slot.byKey.set(keyOf(e), e); slot.ids.add(e.id);
        const p = result.provenance[e.id]; if (p) slot.prov.set(e.id, p);
      }
      slot.batches.push(result.batch);
      return { committed: true, added: result.accepted.length };
    },
    store: {
      candidates(ctx, dataset): readonly Evidence[] {
        guard(ctx, dataset);
        return Object.freeze([...(slotFor(ctx.tenantId, dataset, false)?.records ?? [])]);
      },
    },
    provenanceOf(ctx, dataset, id) { guard(ctx, dataset); return slotFor(ctx.tenantId, dataset, false)?.prov.get(id); },
    batches(ctx, dataset) { guard(ctx, dataset); return Object.freeze([...(slotFor(ctx.tenantId, dataset, false)?.batches ?? [])]); },
  };
}
