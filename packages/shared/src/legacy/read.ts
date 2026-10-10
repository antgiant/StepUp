import { CATEGORIES_TABLE, CHILDREN_TABLE, DOC_FILE_COLUMNS, TABLE1, WORKSHEET } from "../rules.js";
import { getTableHeaderRow, getTableRows, getUsedRange, listFolderChildren, type DriveItemRef } from "../graph/onedrive.js";
import { LEGACY_CHOICES_FILE } from "../workspace/workspace.js";
import type { LegacyInput, LegacyRow } from "../import/legacy.js";

/** The old workbook's table of card-and-period labels with their statement files. */
export const PAYMENT_METHODS_TABLE = "Table6";

const text = (v: unknown) => (v === undefined || v === null ? "" : String(v).trim());

async function tableAsObjects(book: DriveItemRef, table: string): Promise<Array<Record<string, unknown>>> {
  const [headers, rows] = await Promise.all([getTableHeaderRow(book, table), getTableRows(book, table)]);
  return rows.map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i]])));
}

/** Reads the receipts folder listing (the year folder), leaving out this system's own small file. */
export async function readReceiptFiles(folder: DriveItemRef): Promise<LegacyInput["files"]> {
  return (await listFolderChildren(folder))
    .filter((c) => !c.isFolder && c.name !== LEGACY_CHOICES_FILE)
    .map((c) => ({ name: c.name, id: c.id, webUrl: c.webUrl, size: c.size }));
}

/**
 * Reads the old tracking workbook (read-only: only GETs) and the receipts folder into the importer's input. Used by the
 * command line's dry run and by the web app's read-only view of a year Excel still owns.
 */
export async function readLegacyWorkbook(book: DriveItemRef, folder: DriveItemRef, yearLabel: string): Promise<LegacyInput> {
  const [headers, table1, used, childTable, summary, methodTable, categoryTable, files] = await Promise.all([
    getTableHeaderRow(book, TABLE1),
    getTableRows(book, TABLE1),
    getUsedRange(book, WORKSHEET),
    tableAsObjects(book, CHILDREN_TABLE),
    getUsedRange(book, "Summary").catch(() => undefined),
    tableAsObjects(book, PAYMENT_METHODS_TABLE).catch(() => [] as Array<Record<string, unknown>>),
    tableAsObjects(book, CATEGORIES_TABLE).catch(() => [] as Array<Record<string, unknown>>),
    readReceiptFiles(folder),
  ]);
  if (table1.length !== used.rows.length) {
    throw new Error(`Table1 has ${table1.length} rows but the worksheet used range has ${used.rows.length}; refusing to guess the alignment.`);
  }
  const docIdx = DOC_FILE_COLUMNS.map((c) => used.headers.indexOf(c)).filter((i) => i !== -1);
  const rows: LegacyRow[] = table1.map((values, r) => ({
    values: Object.fromEntries(headers.map((h, i) => [h, values[i]])),
    docFiles: docIdx.map((i) => text(used.rows[r]?.[i])).filter(Boolean),
  }));

  const capByName = new Map<string, number>();
  for (const r of summary?.rows ?? []) {
    const cap = Number(r[2]);
    if (text(r[0]) && Number.isFinite(cap) && cap > 0) capByName.set(text(r[0]).toLowerCase(), cap);
  }
  const children = childTable
    .map((r) => ({ name: text(r["Children"]), scholarship: text(r["Scholarship"]) || undefined }))
    .filter((c) => c.name)
    .map((c) => ({ ...c, capDollars: capByName.get(c.name.toLowerCase()) }));
  const paymentMethods = methodTable.map((r) => ({ label: text(r["Credit Cards"]), file: text(r["File"]) || undefined })).filter((p) => p.label);
  const categories = categoryTable
    .map((r) => ({ path: text(r["Categories"]), eligible: text(r["Eligible Scholarships"]).split(",").map((s) => s.trim()).filter(Boolean) }))
    .filter((c) => c.path);

  return { yearLabel, rows, children, paymentMethods, files, categories };
}
