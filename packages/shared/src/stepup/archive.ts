import type { StorageEntry, StorageProvider } from "../storage/types.js";
import { STEPUP_DIR } from "../workspace/workspace.js";

/**
 * StepUp's own record of a year's reimbursements, kept beside the year's other data.
 *
 *   <year>/_stepup/reimbursements/<number>.json   one file per reimbursement: StepUp's response, whole and untouched
 *   <year>/_stepup/index.json                     a small summary of all of them, so a year opens from one download
 *
 * One file per reimbursement means a change to one reimbursement rewrites one small file. The index carries only what
 * the app shows, plus a hash of each raw file so the command line can tell what changed without reading them again.
 * It is derived: if it is missing, the files are the truth.
 */
export const STEPUP_REIMBURSEMENTS_DIR = "reimbursements";
export const STEPUP_INDEX_FILE = "index.json";
/** Rewritten (a few bytes) every time a fresh copy of the list is read, even when nothing in it changed. */
export const STEPUP_SYNCED_FILE = "synced.json";

/** One line item of a reimbursement, reduced to what the app uses. Money in cents, dates as `YYYY-MM-DD`. */
export interface StepUpLine {
  /** `<reimbursement number>-<line>`: the key the spreadsheet's Reimbursement ID + Line Number makes. */
  number: string;
  /** StepUp's own status word: Submitted, Approved, Paid, Denied, Appealed, ... */
  status: string;
  appealed: boolean;
  amountCents: number;
  additionalCostsCents?: number;
  quantity?: number;
  purchaseDate?: string;
  serviceDate?: string;
  paymentDate?: string;
  approvedDate?: string;
  /** Category, type and detail names. */
  category: string[];
  vendor?: string;
  provider?: string;
  /** What StepUp matched the item to, or the benefit message when it did not. */
  name?: string;
  benefit?: string;
  itemUrl?: string;
  invoiceNo?: string;
  receiptId?: string;
  reasonCode?: string;
  reason?: string;
  comment?: string;
}

export interface StepUpReimbursement {
  /** StepUp's guid; its status page address is built from it. */
  id: string;
  /** The number people see (and the spreadsheet's Reimbursement ID). */
  number: number;
  schoolYear: string;
  status: string;
  submittedAt?: string;
  createdAt?: string;
  modifiedAt?: string;
  student?: string;
  program?: string;
  provider?: string;
  receipts: Array<{ id?: string; fileName: string }>;
  lines: StepUpLine[];
}

export interface StepUpIndexEntry extends StepUpReimbursement {
  /** Hash of the raw file's content, to see what changed. */
  hash: string;
}

export interface StepUpIndex {
  v: 1;
  year: string;
  savedAt: string;
  reimbursements: StepUpIndexEntry[];
}

const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const cents = (v: unknown): number | undefined => (num(v) === undefined ? undefined : Math.round((v as number) * 100));
/** StepUp's empty date is year 1. */
const day = (v: unknown): string | undefined => {
  const s = text(v);
  return s && /^\d{4}-\d{2}-\d{2}/.test(s) && !s.startsWith("0001") ? s.slice(0, 10) : undefined;
};

/** The file name a reimbursement is kept under. */
export const reimbursementFileName = (r: { number?: number; id?: string }): string => `${r.number ?? r.id}.json`;

/** Reduces one raw search result to what the app shows. Undefined when it is not a reimbursement. */
export function projectReimbursement(raw: unknown): StepUpReimbursement | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const id = text(r["Id"]);
  const number = num(r["SequenceNumber"]);
  const schoolYear = text(r["SchoolYear"]);
  if (!id || number === undefined || !schoolYear) return undefined;
  const lines = (Array.isArray(r["LineItems"]) ? (r["LineItems"] as Array<Record<string, unknown>>) : []).map((li): StepUpLine => {
    const q = num(li["Quantity"]);
    return {
      number: String(li["LineItemNumber"] ?? ""),
      status: String(li["ExternalStatus"] ?? ""),
      appealed: li["Appealed"] === true,
      amountCents: cents(li["ItemAmount"]) ?? 0,
      ...(cents(li["AdditionalCosts"]) ? { additionalCostsCents: cents(li["AdditionalCosts"])! } : {}),
      ...(q !== undefined ? { quantity: q } : {}),
      ...(day(li["PurchaseDate"]) ? { purchaseDate: day(li["PurchaseDate"])! } : {}),
      ...(day(li["ServiceDate"]) ? { serviceDate: day(li["ServiceDate"])! } : {}),
      ...(day(li["PaymentDate"]) ? { paymentDate: day(li["PaymentDate"])! } : {}),
      ...(day(li["ApprovedDate"]) ? { approvedDate: day(li["ApprovedDate"])! } : {}),
      category: [li["CategoryName"], li["CategoryTypeName"], li["CategoryDetailName"]].map(text).filter((s): s is string => Boolean(s)),
      ...(text(li["VendorName"]) ? { vendor: text(li["VendorName"])! } : {}),
      ...((text(li["ServiceProviderName"]) ?? text(li["ServiceProviderPersonName"])) ? { provider: (text(li["ServiceProviderName"]) ?? text(li["ServiceProviderPersonName"]))! } : {}),
      ...(text(li["MatchedItemName"]) ? { name: text(li["MatchedItemName"])! } : {}),
      ...(text(li["EducationalBenefit"]) ? { benefit: text(li["EducationalBenefit"])! } : {}),
      ...(text(li["ItemUrl"]) ? { itemUrl: text(li["ItemUrl"])! } : {}),
      ...(text(li["ServiceInvoiceNumber"]) ? { invoiceNo: text(li["ServiceInvoiceNumber"])! } : {}),
      ...(text(li["ReceiptId"]) ? { receiptId: text(li["ReceiptId"])! } : {}),
      ...(text(li["ReasonCode"]) ? { reasonCode: text(li["ReasonCode"])! } : {}),
      ...(text(li["ReasonDescription"]) ? { reason: text(li["ReasonDescription"])!.replace(/\s+/g, " ") } : {}),
      // Reviewers' internal comments are never kept for display.
      ...(li["CommentType"] !== "Internal" && text(li["CommentText"]) ? { comment: text(li["CommentText"])!.replace(/\s+/g, " ") } : {}),
    };
  });
  return {
    id,
    number,
    schoolYear,
    status: String(r["ExternalStatus"] ?? ""),
    ...((day(r["SubmitDate"]) ?? day(r["OriginalSubmitDate"])) ? { submittedAt: (day(r["SubmitDate"]) ?? day(r["OriginalSubmitDate"]))! } : {}),
    ...(day(r["CreatedOn"]) ? { createdAt: day(r["CreatedOn"])! } : {}),
    ...(day(r["ModifiedOn"]) ? { modifiedAt: day(r["ModifiedOn"])! } : {}),
    ...(text(r["StudentName"]) ? { student: text(r["StudentName"])! } : {}),
    ...(text(r["ProgramName"]) ? { program: text(r["ProgramName"])! } : {}),
    ...(text(r["ProviderName"]) ? { provider: text(r["ProviderName"])! } : {}),
    receipts: (Array.isArray(r["Receipts"]) ? (r["Receipts"] as Array<Record<string, unknown>>) : [])
      .map((x) => ({ ...(text(x["Id"]) ? { id: text(x["Id"])! } : {}), fileName: text(x["SourceFileName"]) ?? "" }))
      .filter((x) => x.fileName),
    lines,
  };
}

/** The year's `_stepup` folder, or undefined when nothing has been kept for the year. */
export async function findStepUpFolder(storage: StorageProvider, driveId: string, yearFolderId: string): Promise<StorageEntry | undefined> {
  const folder = await storage.find(driveId, yearFolderId, STEPUP_DIR);
  return folder?.isFolder ? folder : undefined;
}

/** The year's index file, if there is one. */
export async function readStepUpIndex(storage: StorageProvider, driveId: string, folderId: string): Promise<{ index: StepUpIndex; entry: StorageEntry } | undefined> {
  const entry = await storage.find(driveId, folderId, STEPUP_INDEX_FILE);
  if (!entry) return undefined;
  try {
    const index = JSON.parse((await storage.readText(driveId, entry.id)).text) as StepUpIndex;
    return index?.v === 1 && Array.isArray(index.reimbursements) ? { index, entry } : undefined;
  } catch {
    return undefined;
  }
}

/** A year's reimbursements and when StepUp's list was last read for them (ms; undefined when that is not known). */
export interface StepUpYear {
  reimbursements: StepUpReimbursement[];
  readAt?: number;
}

/** When StepUp's list was last read for the year: the later of the sync marker and the index's own save time. */
async function readSyncedAt(storage: StorageProvider, driveId: string, folderId: string, indexSavedAt?: string): Promise<number | undefined> {
  let at = indexSavedAt ? Date.parse(indexSavedAt) : NaN;
  try {
    const marker = await storage.find(driveId, folderId, STEPUP_SYNCED_FILE);
    if (marker) {
      const t = Date.parse((JSON.parse((await storage.readText(driveId, marker.id)).text) as { at?: string }).at ?? "");
      if (Number.isFinite(t) && !(t < at)) at = t;
    }
  } catch {
    /* no marker: the index's own time stands */
  }
  return Number.isFinite(at) ? at : undefined;
}

/**
 * Every reimbursement kept for a year: one download of the index, or (if it is missing) the files themselves, read a few
 * at a time. Empty when the year has none.
 */
export async function readStepUpYear(storage: StorageProvider, driveId: string, yearFolderId: string): Promise<StepUpYear> {
  const folder = await findStepUpFolder(storage, driveId, yearFolderId);
  if (!folder) return { reimbursements: [] };
  const fromIndex = await readStepUpIndex(storage, driveId, folder.id);
  if (fromIndex) {
    const readAt = await readSyncedAt(storage, driveId, folder.id, fromIndex.index.savedAt);
    return { reimbursements: fromIndex.index.reimbursements.map(({ hash: _hash, ...r }) => r), ...(readAt !== undefined ? { readAt } : {}) };
  }
  const readAt = await readSyncedAt(storage, driveId, folder.id);
  return { reimbursements: await readReimbursementFiles(storage, driveId, folder.id), ...(readAt !== undefined ? { readAt } : {}) };
}

export async function readStepUpReimbursements(storage: StorageProvider, driveId: string, yearFolderId: string): Promise<StepUpReimbursement[]> {
  return (await readStepUpYear(storage, driveId, yearFolderId)).reimbursements;
}

async function readReimbursementFiles(storage: StorageProvider, driveId: string, folderId: string): Promise<StepUpReimbursement[]> {
  const folder = { id: folderId };
  const dir = await storage.find(driveId, folder.id, STEPUP_REIMBURSEMENTS_DIR);
  if (!dir?.isFolder) return [];
  const files = (await storage.list(driveId, dir.id)).filter((f) => !f.isFolder && f.name.endsWith(".json"));
  const out: StepUpReimbursement[] = [];
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const f = files[next++]!;
      try {
        const wrapped = JSON.parse((await storage.readText(driveId, f.id)).text) as { result?: unknown };
        const p = projectReimbursement(wrapped.result);
        if (p) out.push(p);
      } catch {
        /* an unreadable file is skipped, never fatal */
      }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return out.sort((a, b) => a.number - b.number);
}
