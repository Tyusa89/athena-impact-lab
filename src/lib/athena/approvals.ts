// Simulated, local-only approval state. Pure functions: no network, no side effects.
export type Decision = "pending" | "approved" | "rejected";
export type ApprovalState = Readonly<Record<string, Decision>>;
export type ApprovalEvent =
  | { type: "approve"; id: string }
  | { type: "reject"; id: string }
  | { type: "undo"; id: string }
  | { type: "reset" };

/** Only pending → approved/rejected and approved/rejected → pending (undo) are allowed. */
export function approvalReducer(state: ApprovalState, ev: ApprovalEvent): ApprovalState {
  if (ev.type === "reset") return {};
  const cur = state[ev.id] ?? "pending";
  if (ev.type === "undo") {
    if (cur === "pending") return state;
    const { [ev.id]: _drop, ...rest } = state;
    return rest;
  }
  if (cur !== "pending") return state; // no direct approved ↔ rejected flips
  return { ...state, [ev.id]: ev.type === "approve" ? "approved" : "rejected" };
}

export const decisionOf = (s: ApprovalState, id: string): Decision => s[id] ?? "pending";
