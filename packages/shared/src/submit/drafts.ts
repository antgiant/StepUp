import type { DraftEntry, LedgerState } from "../domain/types.js";
import type { Ledger } from "../events/ledger.js";

/** What the filing run remembers about a StepUp draft (the shape the CLI already used on disk). */
export interface DraftRecordData {
  guid: string;
  rowIds: string[];
  rowOrder?: string[];
  sequenceNumber?: string;
  lastStep?: string;
  scanOutcome?: string;
  attachedFiles?: string[];
  missingFiles?: string[];
  skipped?: boolean;
}

const key = (ids: string[]) => [...ids].sort().join(",");
const entryId = (guid: string) => `draft-${guid}`;

/** The newest unfinished draft for exactly this set of items, if any (drafts are looked up by their items, not their id). */
export function findDraft(state: LedgerState, itemIds: string[]): DraftRecordData | undefined {
  const want = key(itemIds);
  const found = Object.values(state.drafts)
    .filter((d) => d.guid && d.itemIds && key(d.itemIds) === want)
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))[0] as (DraftEntry & { guid: string; itemIds: string[] }) | undefined;
  if (!found) return undefined;
  return {
    guid: found.guid,
    rowIds: found.itemIds,
    ...(found.rowOrder ? { rowOrder: found.rowOrder } : {}),
    ...(found.sequenceNumber ? { sequenceNumber: found.sequenceNumber } : {}),
    ...(found.lastStep ? { lastStep: found.lastStep } : {}),
    ...(found.scanOutcome ? { scanOutcome: found.scanOutcome } : {}),
    ...(found.attachedFiles ? { attachedFiles: found.attachedFiles } : {}),
    ...(found.missingFiles ? { missingFiles: found.missingFiles } : {}),
    ...(found.skipped ? { skipped: true } : {}),
  };
}

export function saveDraft(ledger: Ledger, record: DraftRecordData, actor: string, now = new Date()): void {
  const { rowIds, guid, ...rest } = record;
  const fields = Object.fromEntries(Object.entries({ guid, itemIds: rowIds, ...rest, skipped: record.skipped ?? false, actor, updatedAt: now.toISOString() }).filter(([, v]) => v !== undefined));
  ledger.set("draft", entryId(guid), fields as never, { label: "draft.saved" });
}

/** Forgets the draft(s) for these items (submitted, abandoned or replaced). A new draft has a new guid, so this never blocks one. */
export function deleteDraft(ledger: Ledger, itemIds: string[]): void {
  const want = key(itemIds);
  for (const d of Object.values(ledger.state.drafts)) if (d.itemIds && key(d.itemIds) === want) ledger.delete("draft", d.id, { label: "draft.deleted" });
}
