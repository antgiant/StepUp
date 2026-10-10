import { graphJson } from "../graph/client.js";
import { ensureFolder, findChild } from "../graph/files.js";

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

interface ChildrenPage {
  value: Array<{ id: string; name: string; folder?: unknown; lastModifiedDateTime?: string }>;
  "@odata.nextLink"?: string;
}

async function listChildren(driveId: string, folderId: string) {
  const out: ChildrenPage["value"] = [];
  let url: string | undefined = `/drives/${driveId}/items/${folderId}/children?$select=id,name,folder,lastModifiedDateTime&$top=200`;
  while (url) {
    const page: ChildrenPage = await graphJson<ChildrenPage>(url);
    out.push(...page.value);
    url = page["@odata.nextLink"];
  }
  return out;
}

/** Parent folder id of an item (used to derive the workspace root from a known year folder). */
export async function parentOf(driveId: string, itemId: string): Promise<string> {
  const item = await graphJson<{ parentReference?: { id?: string } }>(`/drives/${driveId}/items/${itemId}?$select=parentReference`);
  const id = item.parentReference?.id;
  if (!id) throw new Error("Item has no parent folder");
  return id;
}

/** Lists the year folders (`YYYY-YYYY`) under the workspace root and classifies each. Read-only. */
export async function listYears(driveId: string, rootId: string): Promise<YearInfo[]> {
  const years: YearInfo[] = [];
  for (const child of await listChildren(driveId, rootId)) {
    if (!child.folder || !YEAR_FOLDER_RE.test(child.name)) continue;
    const inside = await listChildren(driveId, child.id);
    const files = inside.filter((c) => !c.folder && c.name !== LEGACY_CHOICES_FILE);
    // Several copies are common (Excel "(1)", dated saves): the most recently edited one is the authoritative one.
    const copies = files.filter((f) => TRACKING_WORKBOOK_RE.test(f.name) && !OFFICE_LOCK_RE.test(f.name));
    const workbook = [...copies].sort((a, b) => (b.lastModifiedDateTime ?? "").localeCompare(a.lastModifiedDateTime ?? "") || a.name.localeCompare(b.name))[0];
    const hasLedger = inside.some((c) => c.folder && c.name === LEDGER_DIR);
    years.push({
      label: child.name,
      folderId: child.id,
      kind: hasLedger ? "ledger" : workbook ? "legacy-excel" : "empty",
      looseFileCount: files.length,
      workbookName: workbook?.name,
      ...(workbook?.lastModifiedDateTime ? { workbookModified: workbook.lastModifiedDateTime } : {}),
      ...(copies.length ? { workbookCopies: copies.length } : {}),
    });
  }
  return years.sort((a, b) => a.label.localeCompare(b.label));
}

/** Which ledger folders do not exist yet (nothing is created). */
export async function planLedgerFolders(driveId: string, yearFolderId: string): Promise<string[]> {
  const ledger = await findChild(driveId, yearFolderId, LEDGER_DIR);
  if (!ledger?.isFolder) return [LEDGER_DIR, ...LEDGER_SUBDIRS.map((d) => `${LEDGER_DIR}/${d}`)];
  const missing: string[] = [];
  for (const d of LEDGER_SUBDIRS) if (!(await findChild(driveId, ledger.id, d))) missing.push(`${LEDGER_DIR}/${d}`);
  return missing;
}

/** Creates `_ledger/` and its subfolders if needed (idempotent, safe if two clients race). Existing files are never touched. */
export async function ensureLedgerFolders(driveId: string, yearFolderId: string): Promise<YearFolders> {
  const ledgerId = await ensureFolder(driveId, yearFolderId, LEDGER_DIR);
  const ids: Record<string, string> = {};
  for (const d of LEDGER_SUBDIRS) ids[d] = await ensureFolder(driveId, ledgerId, d);
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
export async function openLedgerFolders(driveId: string, yearFolderId: string): Promise<YearFolders | undefined> {
  const ledger = await findChild(driveId, yearFolderId, LEDGER_DIR);
  if (!ledger?.isFolder) return undefined;
  const ids: Record<string, string> = {};
  for (const d of LEDGER_SUBDIRS) {
    const c = await findChild(driveId, ledger.id, d);
    if (!c?.isFolder) return undefined;
    ids[d] = c.id;
  }
  return { yearFolderId, ledgerId: ledger.id, eventsId: ids["events"]!, documentsId: ids["documents"]!, inboxId: ids["inbox"]!, reportsId: ids["reports"]! };
}
