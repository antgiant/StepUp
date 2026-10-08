import type { Page } from "playwright";
import { applyCategoryRename, attachCategoryTreeListener } from "../categorySync.js";
import {
  downloadItem,
  getTableHeaderRow,
  getTableRows,
  listFolderChildren,
  updateTableRowByIndex,
  type DriveItemRef,
  type FolderChild,
} from "../graph/onedrive.js";
import { deleteDraftRecord, loadDraftRecord, saveDraftRecord } from "../draftTracker.js";
import { attachPreauthSyncListener } from "../preauthSync.js";
import {
  buildGroups,
  checkScholarshipEligibility,
  loadUnfiledRows,
  type ReimbursementGroup,
  type ResolveAmbiguousMainReceipt,
  type ScholarshipMismatch,
  type Table1Row,
} from "../reimbursements.js";
import { attachStatusSyncListener } from "../statusSync.js";
import type { FilingStore } from "./store.js";

const TABLE1 = "Table1";
const STATUSES_TABLE = "Table3";
const CHILDREN_TABLE = "Table2";
const SUBMITTED_STATUS = "Submitted";
const MISSING_THINGS_STATUS = "Unfiled (Missing Things)";

/** The original behaviour: rows come from the Excel workbook's Table1 and every result is written back to it. */
export class ExcelStore implements FilingStore {
  readonly kind = "excel" as const;
  readonly describe = "the Excel workbook";
  private headers?: string[];

  /** The spreadsheet flow keeps resume state in .cache/drafts.json, as it always has. */
  readonly drafts = { load: loadDraftRecord, save: saveDraftRecord, delete: deleteDraftRecord };

  /** One person at a time is already enforced by the session lock; the spreadsheet has nowhere to record claims. */
  async claim(): Promise<{ ok: true }> {
    return { ok: true };
  }

  async release(): Promise<void> {}

  constructor(private readonly excelRef: DriveItemRef, private readonly folderRef: DriveItemRef) {}

  private async table1Headers(): Promise<string[]> {
    return (this.headers ??= await getTableHeaderRow(this.excelRef, TABLE1));
  }

  /** Writes the changes to the row's Table1 line and keeps the in-memory copies of that row in step with it. */
  private async write(row: Table1Row, changes: Record<string, string | number>): Promise<void> {
    const headers = await this.table1Headers();
    await updateTableRowByIndex(this.excelRef, TABLE1, row.rowIndex, row.rawValues, headers, changes);
    // Later write-backs reuse rawValues as "currentValues"; without this they would silently revert an earlier change.
    for (const [key, value] of Object.entries(changes)) {
      const idx = headers.indexOf(key);
      if (idx !== -1) row.rawValues[idx] = value;
      row.data[key] = String(value);
    }
  }

  loadRows() {
    return loadUnfiledRows(this.excelRef);
  }

  buildGroups(rows: Table1Row[], resolveAmbiguous: ResolveAmbiguousMainReceipt): Promise<ReimbursementGroup[]> {
    return buildGroups(rows, resolveAmbiguous);
  }

  files(): Promise<FolderChild[]> {
    return listFolderChildren(this.folderRef);
  }

  download(fileId: string, destPath: string): Promise<void> {
    return downloadItem(this.folderRef.driveId, fileId, destPath);
  }

  async childScholarships(): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const r of await getTableRows(this.excelRef, CHILDREN_TABLE)) {
      const name = String(r[0] ?? "").trim();
      const scholarship = String(r[1] ?? "").trim();
      if (name && scholarship) out.set(name, scholarship);
    }
    return out;
  }

  eligibilityMismatches(rows: Table1Row[]): Promise<ScholarshipMismatch[]> {
    return checkScholarshipEligibility(this.excelRef, rows);
  }

  async checkReady(): Promise<void> {
    const valid = (await getTableRows(this.excelRef, STATUSES_TABLE)).map((r) => String(r[0] ?? "")).filter(Boolean);
    if (!valid.includes(SUBMITTED_STATUS)) throw new Error(`"${SUBMITTED_STATUS}" isn't one of ${STATUSES_TABLE}'s valid Status values: ${valid.join(" | ")}`);
  }

  async markNeedsAttention(rows: Table1Row[], note: string): Promise<void> {
    const today = new Date().toISOString().slice(0, 10);
    for (const row of rows) {
      const existing = (row.data["Notes"] ?? "").trim();
      const dated = `[${today}] ${note}`;
      await this.write(row, { Notes: existing ? `${existing} | ${dated}` : dated, Status: MISSING_THINGS_STATUS });
    }
  }

  async markSubmitted(rows: Table1Row[], reimbursementId: string, submittedDate: string): Promise<void> {
    for (const [idx, row] of rows.entries()) {
      await this.write(row, { Status: SUBMITTED_STATUS, Submitted: submittedDate, "Reimbursement ID": reimbursementId, "Line Number": String(idx + 1) });
    }
  }

  async recordDraftNumber(rows: Table1Row[], reimbursementId: string): Promise<void> {
    for (const row of rows) await this.write(row, { "Reimbursement ID": reimbursementId });
  }

  async fixCategory(rows: Table1Row[], newValue: string): Promise<void> {
    for (const row of rows) await this.write(row, { Category: newValue });
  }

  renameCategory(oldPath: string, newPath: string): Promise<void> {
    return applyCategoryRename(this.excelRef, oldPath, newPath);
  }

  attachListeners(page: Page): void {
    attachStatusSyncListener(page, this.excelRef);
    attachCategoryTreeListener(page, this.excelRef);
    attachPreauthSyncListener(page, this.excelRef);
  }

  async finish(): Promise<void> {}
}
