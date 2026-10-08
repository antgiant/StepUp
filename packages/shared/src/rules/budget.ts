import type { LedgerState } from "../domain/types.js";
import { isFiled, requestedCents } from "./readiness.js";

export interface ChildBudget {
  childId: string;
  capCents: number;
  paidCents: number;
  approvedCents: number;
  pendingCents: number;
  /** Not yet filed; informational, not counted against the cap. */
  unfiledCents: number;
  remainingCents: number;
}

const PENDING = new Set(["Submitted", "Re-Submitted"]);
const APPROVED = new Set(["Approved", "Adjusted"]);

/** remaining = cap - paid - approved - pending(filed, awaiting decision). Denied and unfiled items do not count. */
export function childBudget(state: LedgerState, childId: string): ChildBudget {
  const child = state.children[childId];
  const budget: ChildBudget = {
    childId,
    capCents: child?.capCents ?? 0,
    paidCents: 0,
    approvedCents: 0,
    pendingCents: 0,
    unfiledCents: 0,
    remainingCents: 0,
  };
  for (const item of Object.values(state.items)) {
    if (item.childId !== childId || item.archived) continue;
    const status = item.stepUpStatus ?? (item.submissionId ? "Submitted" : "");
    if (status === "Paid") budget.paidCents += item.paidCents ?? item.approvedCents ?? requestedCents(item);
    else if (APPROVED.has(status)) budget.approvedCents += item.approvedCents ?? requestedCents(item);
    else if (PENDING.has(status)) budget.pendingCents += requestedCents(item);
    else if (!isFiled(item)) budget.unfiledCents += requestedCents(item);
  }
  budget.remainingCents = budget.capCents - budget.paidCents - budget.approvedCents - budget.pendingCents;
  return budget;
}

/** Whole days from `today` to `deadline` (negative once passed). */
export function daysUntil(deadline: string, today: string): number {
  const ms = Date.parse(`${deadline}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}
