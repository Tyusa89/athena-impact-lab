// Pure, client-safe guard that lets an async Meta response update the UI only if it still belongs to the
// current role, scenario and request. Any state change (or a newer request) invalidates every earlier request.

export type RequestScope = { scenarioId: string; roleId: string; workspaces: readonly string[] };

/** Stable identity for the state a response must belong to. */
export const scopeKey = (s: RequestScope) => JSON.stringify([s.scenarioId, s.roleId, [...s.workspaces].sort()]);

export interface RequestGate {
  /** Start a request for `key`. Supersedes all earlier requests and returns its ticket. */
  begin(key: string): number;
  /** True only if `ticket` is the latest request and the live scope still equals the scope it started in. */
  isCurrent(ticket: number, liveKey: string): boolean;
  /** Invalidate every in-flight request (scope change, unmount). */
  invalidate(): void;
}

export function createRequestGate(): RequestGate {
  let latest = 0;
  let startedKey: string | null = null;
  return {
    begin(key) {
      latest += 1;
      startedKey = key;
      return latest;
    },
    isCurrent(ticket, liveKey) {
      return ticket === latest && startedKey !== null && startedKey === liveKey;
    },
    invalidate() {
      latest += 1;
      startedKey = null;
    },
  };
}

/** A stored result tagged with the scope it was produced for; shown only while that scope is still live. */
export type Tagged<T> = { key: string; value: T };
export const visibleFor = <T,>(tagged: Tagged<T> | null, liveKey: string): T | null =>
  tagged && tagged.key === liveKey ? tagged.value : null;
