import type { ContentKind, LedgerState } from "../domain/types.js";
import type { Ledger } from "../events/ledger.js";
import { listFolderChildren, type DriveItemRef } from "../graph/onedrive.js";
import { hashString } from "../util/hash.js";
import { LEGACY_CHOICES_FILE } from "./workspace.js";

export interface LooseFile {
  id: string;
  name: string;
  size: number;
  webUrl?: string;
}

/** Files placed directly in a folder the old way (not sub-folders). Read-only. */
export async function listLooseFiles(driveId: string, folderId: string): Promise<LooseFile[]> {
  const ref: DriveItemRef = { driveId, itemId: folderId, name: "", isFolder: true };
  return (await listFolderChildren(ref)).filter((c) => !c.isFolder && c.name !== LEGACY_CHOICES_FILE).map((c) => ({ id: c.id, name: c.name, size: c.size, webUrl: c.webUrl }));
}

const DATE_IN_NAME = /(?<![0-9])(\d{2})[ ._-](\d{2})[ ._-](\d{4}|\d{2})(?![0-9])/;

export interface FileNameHints {
  vendor?: string;
  /** ISO date read from names like "Vendor 07 28 2026 description.pdf". */
  date?: string;
  description?: string;
}

/**
 * Reads the naming habit "<Vendor> <MM DD YYYY|YY> <description>.pdf" (an old "12,13 - " row-id prefix is ignored).
 * Only prefill suggestions: a person confirms or corrects them.
 */
export function fileNameHints(name: string): FileNameHints {
  const base = name.replace(/\.[A-Za-z0-9]{2,5}$/, "").replace(/^\s*[\d,\s]+-\s*/, "").trim();
  const m = DATE_IN_NAME.exec(base);
  if (!m) return {};
  const month = Number(m[1]);
  const day = Number(m[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return {};
  const year = m[3]!.length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  const vendor = base.slice(0, m.index).trim();
  const description = base.slice(m.index + m[0].length).trim();
  return {
    date: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    ...(vendor ? { vendor } : {}),
    ...(description ? { description } : {}),
  };
}

/** A hint only; a person can change it. A dated "<Vendor> <date> ..." name is treated as a receipt. */
export function guessContentKind(name: string): ContentKind {
  const n = name.toLowerCase();
  if (/statement/.test(n)) return "statement";
  if (/\.eml$/.test(n)) return "receipt-like"; // a saved order-confirmation email
  if (/(receipt|invoice|order)/.test(n) || fileNameHints(name).date) return "receipt-like";
  if (/(letter|explanation|form|reading list|guide|syllabus)/.test(n) || /\.docx?$/.test(n)) return "explanation";
  return "other";
}

export interface IngestPlan {
  toRegister: LooseFile[];
  alreadyKnown: number;
}

/** Which loose files are not yet documents in the ledger (matched by OneDrive item id). */
export function planIngest(state: LedgerState, files: LooseFile[]): IngestPlan {
  const known = new Set(Object.values(state.documents).map((d) => d.driveItemId).filter(Boolean));
  const toRegister = files.filter((f) => !known.has(f.id));
  return { toRegister, alreadyKnown: files.length - toRegister.length };
}

export const documentIdFor = (driveItemId: string) => `doc-${hashString(driveItemId)}`;

/** Registers files as documents so they show up in the entry queue. Deterministic ids make this safe to repeat. */
export function registerLooseFiles(ledger: Ledger, files: LooseFile[], source: "loose" | "inbox" = "loose"): string[] {
  return files.map((f) => {
    const id = documentIdFor(f.id);
    ledger.set(
      "document",
      id,
      { driveItemId: f.id, filename: f.name, sizeBytes: f.size, contentKind: guessContentKind(f.name), source, ...(f.webUrl ? { webUrl: f.webUrl } : {}) },
      { label: "document.registered" }
    );
    return id;
  });
}
