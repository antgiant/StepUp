import type { StorageProvider } from "../storage/types.js";

/** Everything this system adds to a year folder lives under this subfolder; its presence marks a year as ledger-based. */
export const LEDGER_DIR = "_ledger";
export const LEDGER_SUBDIRS = ["events", "documents", "inbox", "reports"] as const;
/**
 * A year still kept in Excel is viewed read-only. The one thing written beside its workbook is this small file of
 * answers ("which file is the receipt?"), so archiving the year takes it along. It is never treated as a receipt.
 */
export const LEGACY_CHOICES_FILE = "Step Up Helper - receipt choices.json";
export const YEAR_FOLDER_RE = /^\d{4}-\d{4}$/;
/** The old tracking workbooks: "... FES UA Tracking Spreadsheet ...xlsx", and the first year'"'"'s "Home School - Gardiner Scholarship ...xlsx". */
const TRACKING_WORKBOOK_RE = /(tracking|gardiner).*\.xlsx$/i;
const OFFICE_LOCK_RE = /^~\$/;

export type YearKind = "ledger" | "legacy-excel" | "empty";

export interface YearInfo {
  label: string;
  folderId: string;
  kind: YearKind;
  /** Files directly in the year folder (the old way of dropping receipts); candidates for ingestion. */
  looseFileCount: number;
  /** The tracking workbook the year is read from: of several copies, the most recently edited one. */
  workbookName?: string;
  workbookModified?: string;
  /** How many tracking workbook copies the folder holds (the others are ignored). */
  workbookCopies?: number;
}

export interface YearFolders {
  yearFolderId: string;
  ledgerId: string;
  eventsId: string;
  documentsId: string;
  inboxId: string;
  reportsId: string;
}

/** Lists the year folders (`YYYY-YYYY`) under the workspace root and classifies each. Read-only. */
export async function listYears(storage: StorageProvider, driveId: string, rootId: string): Promise<YearInfo[]> {
  const years: YearInfo[] = [];
  for (const child of await storage.list(driveId, rootId)) {
    if (!child.isFolder || !YEAR_FOLDER_RE.test(child.name)) continue;
    const inside = await storage.list(driveId, child.id);
    const files = inside.filter((c) => !c.isFolder && c.name !== LEGACY_CHOICES_FILE);
    // Several copies are common (Excel "(1)", dated saves): the most recently edited one is the authoritative one.
    const copies = files.filter((f) => TRACKING_WORKBOOK_RE.test(f.name) && !OFFICE_LOCK_RE.test(f.name));
    const workbook = [...copies].sort((a, b) => (b.modified ?? "").localeCompare(a.modified ?? "") || a.name.localeCompare(b.name))[0];
    const hasLedger = inside.some((c) => c.isFolder && c.name === LEDGER_DIR);
    years.push({
      label: child.name,
      folderId: child.id,
      kind: hasLedger ? "ledger" : workbook ? "legacy-excel" : "empty",
      looseFileCount: files.length,
      workbookName: workbook?.name,
      ...(workbook?.modified ? { workbookModified: workbook.modified } : {}),
      ...(copies.length ? { workbookCopies: copies.length } : {}),
    });
  }
  return years.sort((a, b) => a.label.localeCompare(b.label));
}

/** Which ledger folders do not exist yet (nothing is created). */
export async function planLedgerFolders(storage: StorageProvider, driveId: string, yearFolderId: string): Promise<string[]> {
  const ledger = await storage.find(driveId, yearFolderId, LEDGER_DIR);
  if (!ledger?.isFolder) return [LEDGER_DIR, ...LEDGER_SUBDIRS.map((d) => `${LEDGER_DIR}/${d}`)];
  const missing: string[] = [];
  for (const d of LEDGER_SUBDIRS) if (!(await storage.find(driveId, ledger.id, d))) missing.push(`${LEDGER_DIR}/${d}`);
  return missing;
}

/** Creates `_ledger/` and its subfolders if needed (idempotent, safe if two clients race). Existing files are never touched. */
export async function ensureLedgerFolders(storage: StorageProvider, driveId: string, yearFolderId: string): Promise<YearFolders> {
  const ledgerId = await storage.ensureFolder(driveId, yearFolderId, LEDGER_DIR);
  const ids: Record<string, string> = {};
  for (const d of LEDGER_SUBDIRS) ids[d] = await storage.ensureFolder(driveId, ledgerId, d);
  return {
    yearFolderId,
    ledgerId,
    eventsId: ids["events"]!,
    documentsId: ids["documents"]!,
    inboxId: ids["inbox"]!,
    reportsId: ids["reports"]!,
  };
}

/** Folder ids of an existing ledger year, or undefined when the year has no `_ledger/` yet. */
export async function openLedgerFolders(storage: StorageProvider, driveId: string, yearFolderId: string): Promise<YearFolders | undefined> {
  const ledger = await storage.find(driveId, yearFolderId, LEDGER_DIR);
  if (!ledger?.isFolder) return undefined;
  const ids: Record<string, string> = {};
  for (const d of LEDGER_SUBDIRS) {
    const c = await storage.find(driveId, ledger.id, d);
    if (!c?.isFolder) return undefined;
    ids[d] = c.id;
  }
  return { yearFolderId, ledgerId: ledger.id, eventsId: ids["events"]!, documentsId: ids["documents"]!, inboxId: ids["inbox"]!, reportsId: ids["reports"]! };
}
