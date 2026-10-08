import type { Page } from "playwright";
import type { FolderChild } from "../graph/onedrive.js";
import type { ReimbursementGroup, ResolveAmbiguousMainReceipt, ScholarshipMismatch, Table1Row } from "../reimbursements.js";

/**
 * Where the automation gets what to file and where it records what happened. The StepUp form-filling code does not care:
 * `ExcelStore` is the original spreadsheet behaviour, `LedgerStore` reads and writes the ledger (plan phase 3).
 */
export interface FilingStore {
  readonly kind: "excel" | "ledger";
  readonly describe: string;

  /** Rows that are ready to file, shaped like the old Table1 rows. */
  loadRows(): Promise<Table1Row[]>;
  /** One group per StepUp submission. `resolveAmbiguous` is only used by the spreadsheet (a ledger purchase names its receipt). */
  buildGroups(rows: Table1Row[], resolveAmbiguous: ResolveAmbiguousMainReceipt): Promise<ReimbursementGroup[]>;
  /** Documents available to upload, by the names the groups use. */
  files(): Promise<FolderChild[]>;
  download(fileId: string, destPath: string): Promise<void>;

  childScholarships(): Promise<Map<string, string>>;
  eligibilityMismatches(rows: Table1Row[]): Promise<ScholarshipMismatch[]>;
  /** Throws if the store cannot record a submission (e.g. the spreadsheet's status list lacks "Submitted"). */
  checkReady(): Promise<void>;

  /** The rows could not be filed: record why so they are not offered again until a person fixes them. */
  markNeedsAttention(rows: Table1Row[], note: string): Promise<void>;
  /** The rows (in line order) are now line items 1..n of this StepUp reimbursement. */
  markSubmitted(rows: Table1Row[], reimbursementId: string, submittedDate: string): Promise<void>;
  /** A draft with this number exists for the rows; remembered so a crash loses nothing. */
  recordDraftNumber(rows: Table1Row[], reimbursementId: string): Promise<void>;
  /** The live category list showed the rows' category under a different name. */
  fixCategory(rows: Table1Row[], newValue: string): Promise<void>;
  renameCategory(oldPath: string, newPath: string): Promise<void>;

  /** Passive listeners on StepUp's own API responses (statuses, categories, pre-auths). */
  attachListeners(page: Page): void;
  /** Called once at the end of a run. */
  finish(): Promise<void>;
}
