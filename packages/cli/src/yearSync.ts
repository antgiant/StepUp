import { getClientId } from "./clientId.js";
import { getSignedInName } from "./graph/auth.js";
import type { FilingStore } from "./filing/store.js";
import { openYearLedger } from "./ledgerYear.js";
import { diffExcel, readExcelSnapshot, snapshotExcel, writeExcelSnapshot, writeHistoryFile, type HistoryChange } from "@step-up/shared";
import { getTableHeaderRow, getTableRows } from "./graph/onedrive.js";
import { syncStatusesFromApiResponse, type ApiResponse } from "./statusSync.js";
import { workspaceYears } from "./stepUpArchive.js";

/** A workbook's tracking table as headers and rows; undefined when it has none (older layouts). */
async function readWorkbook(ref: never): Promise<{ headers: string[]; rows: unknown[][] } | undefined> {
  try {
    return { headers: await getTableHeaderRow(ref, "Table1"), rows: await getTableRows(ref, "Table1") };
  } catch {
    return undefined;
  }
}

/**
 * Brings every year's own record up to date from one copy of StepUp's list: a ledger year's ledger, an Excel year's
 * workbook. The list carries every school year, so each reimbursement goes to the year it belongs to, whichever year this
 * run happens to be working in.
 *
 * `active` is the store the run already has open; its own year is applied through it (so a run never holds two copies of
 * the same ledger). A year with neither a ledger nor a workbook is only archived, and one whose workbook has a layout
 * without Reimbursement ID / Line Number columns is reported and left alone.
 */
export async function syncStatusesAcrossYears(body: ApiResponse, active?: FilingStore): Promise<number> {
  const ws = await workspaceYears();
  const byYear = new Map<string, unknown[]>();
  for (const r of body.Results ?? []) {
    const label = String((r as unknown as { SchoolYear?: string }).SchoolYear ?? "");
    if (label) byYear.set(label, [...(byYear.get(label) ?? []), r]);
  }
  const dry = process.argv.includes("--dry-run");
  let changed = 0;
  for (const [label, results] of [...byYear].sort(([a], [b]) => a.localeCompare(b))) {
    const year = ws.years.get(label);
    const part = { Results: results } as unknown as ApiResponse;
    try {
      if (year?.kind === "ledger") {
        if (dry) {
          console.log(`[status sync] ${label}: ledger left alone in a dry run.`);
          continue;
        }
        if (active?.kind === "ledger" && active.yearLabel === label) {
          changed += await active.applyStatusResponse(part);
        } else {
          const { LedgerStore } = await import("./filing/ledgerStore.js");
          const store = new LedgerStore(await openYearLedger(label), { actor: await getSignedInName(), clientId: await getClientId() });
          const n = await store.applyStatusResponse(part);
          await store.finish();
          changed += n;
          if (n) console.log(`[status sync] ${label}: ${n} item(s) updated in the ledger.`);
        }
      } else if (year?.kind === "legacy-excel" && year.workbookName) {
        const book = await ws.storage.find(ws.driveId, year.folderId, year.workbookName);
        if (!book) continue;
        console.log(`[status sync] ${label}: ${year.workbookName}`);
        const ref = { driveId: ws.driveId, itemId: book.id, name: book.name, isFolder: false } as never;
        // The workbook is read before and after, so what a person changed in Excel and what the sync wrote are both kept.
        const watch = dry ? undefined : await readWorkbook(ref);
        const stored = watch ? await readExcelSnapshot(ws.storage, ws.driveId, year.folderId).catch(() => undefined) : undefined;
        // A layout the sync cannot match rows in is still followed for changes; its error is reported after.
        let n = 0;
        let syncError: unknown;
        try {
          n = await syncStatusesFromApiResponse(ref, part);
        } catch (err) {
          syncError = err;
        }
        changed += n;
        if (watch) {
          const mine: HistoryChange[] = [];
          const pre = snapshotExcel(watch.headers, watch.rows, new Date().toISOString());
          mine.push(...diffExcel(stored, pre, "edited in Excel"));
          let latest = pre;
          if (n > 0) {
            const after = await readWorkbook(ref);
            if (after) {
              latest = snapshotExcel(after.headers, after.rows, new Date(Date.now() + 1).toISOString());
              mine.push(...diffExcel(pre, latest, "status sync"));
            }
          }
          await writeHistoryFile(ws.storage, ws.driveId, year.folderId, "excel", mine).catch(() => undefined);
          if (!stored || mine.length) await writeExcelSnapshot(ws.storage, ws.driveId, year.folderId, latest).catch(() => undefined);
        }
        if (syncError) throw syncError;
      }
    } catch (err) {
      const why = (err as Error).message;
      // The 2023-24 and 2024-25 sheets have no Line Number (or no Table1 at all), so a reimbursement cannot be tied to a row.
      const layout = /Table1|404|ItemNotFound/.test(why);
      console.log(`[status sync] ${label}: skipped (${layout ? "this workbook's layout has no Reimbursement ID + Line Number to match rows by" : why})`);
    }
  }
  return changed;
}
