/**
 * One thing that changed, from any source, in a form a person can read.
 *
 *  - "ledger": a change to the app's own record (derived from the ledger's event log, never stored twice);
 *  - "stepup": something StepUp itself changed (a status, an amount, a reason), seen when its list was read;
 *  - "excel": a change in the year's tracking workbook, seen when it was read (by a person, or by the status sync).
 */
export type HistorySource = "ledger" | "stepup" | "excel";

export interface HistoryDetail {
  /** A person's name for the field ("Amount", "Status"). */
  field: string;
  from?: string;
  to?: string;
}

export interface HistoryChange {
  /** Unique and stable, so a change is never listed twice. */
  id: string;
  /** When it happened (or, for StepUp and Excel, when it was first seen), ISO 8601. */
  at: string;
  source: HistorySource;
  /** Who or what did it, when known: an account, "status sync", "StepUp". */
  actor?: string;
  kind: "added" | "changed" | "removed" | "restored" | "note";
  /** What it happened to. `purchaseId` lets a screen link to it. */
  subject: { kind: string; id: string; label?: string; purchaseId?: string };
  summary: string;
  details?: HistoryDetail[];
}

/** The unit written to a year's `_history` folder: one run's changes from one source. */
export interface HistoryFile {
  v: 1;
  source: Exclude<HistorySource, "ledger">;
  at: string;
  changes: HistoryChange[];
}
