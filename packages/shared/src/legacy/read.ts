import { CATEGORIES_TABLE, CHILDREN_TABLE, DOC_FILE_COLUMNS, TABLE1, WORKSHEET } from "../rules.js";
import { getTableHeaderRow, getTableRows, getUsedRange, listFolderChildren, listTables, type DriveItemRef } from "../graph/onedrive.js";
import { LEDGER_DIR, LEGACY_CHOICES_FILE } from "../workspace/workspace.js";
import { toIsoDate, type LegacyInput, type LegacyRow } from "../import/legacy.js";
import { fileNameHints } from "../workspace/ingest.js";

/** The old workbook's table of card-and-period labels with their statement files. */
export const PAYMENT_METHODS_TABLE = "Table6";

const text = (v: unknown) => (v === undefined || v === null ? "" : String(v).trim());

async function tableAsObjects(book: DriveItemRef, table: string): Promise<Array<Record<string, unknown>>> {
  const [headers, rows] = await Promise.all([getTableHeaderRow(book, table), getTableRows(book, table)]);
  return rows.map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i]])));
}

/**
 * Lists the receipts: files in the year folder and, a few levels down, in its sub-folders (the first year kept its
 * receipts in a "Gardiner" folder). Shallowest wins when two files share a name, so a "Probably Duplicate" folder does not
 * make every receipt ambiguous. This system's own folder and file are left out.
 */
export async function readReceiptFiles(folder: DriveItemRef, maxDepth = 3): Promise<LegacyInput["files"]> {
  const found = new Map<string, LegacyInput["files"][number]>();
  let level: DriveItemRef[] = [folder];
  for (let depth = 0; depth <= maxDepth && level.length; depth++) {
    const listings = await Promise.all(level.map((f) => listFolderChildren(f)));
    const next: DriveItemRef[] = [];
    for (const children of listings) {
      for (const c of children) {
        if (c.isFolder) {
          if (c.name !== LEDGER_DIR && depth < maxDepth) next.push({ driveId: folder.driveId, itemId: c.id, name: c.name, isFolder: true });
        } else if (c.name !== LEGACY_CHOICES_FILE && !found.has(c.name.toLowerCase())) {
          found.set(c.name.toLowerCase(), { name: c.name, id: c.id, webUrl: c.webUrl, size: c.size });
        }
      }
    }
    level = next;
  }
  return [...found.values()];
}

/** The Gardiner year's own table of rows (the first year, before the FES UA tracking sheet existed). */
export const GARDINER_TABLE = "Step_Up";

/**
 * The three layouts the old workbooks came in:
 * - `step-up-2025`: Table1 with "Documentation File 1-6" columns naming each row's files;
 * - `step-up-2024`: the same Table1 without those columns; a row's files carry its ID in their names ("12,13 - Vendor ...");
 * - `gardiner`: a `Step_Up` table (Cost, Aprvl Amnt, ...) with no IDs and no file columns.
 */
export type WorkbookLayout = "step-up-2025" | "step-up-2024" | "gardiner";

export function detectLayout(tableNames: readonly string[], hasDocumentColumns: boolean): WorkbookLayout {
  if (!tableNames.includes(TABLE1) && tableNames.includes(GARDINER_TABLE)) return "gardiner";
  return hasDocumentColumns ? "step-up-2025" : "step-up-2024";
}

/** Files named "12 - ..." or "12,13 - ..." belong to rows 12 (and 13). */
export function filesByIdPrefix(id: string, files: ReadonlyArray<{ name: string }>): string[] {
  if (!id) return [];
  const out: string[] = [];
  for (const f of files) {
    const m = /^\s*(\d+(?:\s*,\s*\d+)*)\s*-\s/.exec(f.name);
    if (m && m[1]!.split(",").some((n) => n.trim() === id)) out.push(f.name);
  }
  return out;
}

/**
 * The Gardiner year has nothing that ties a row to a file, only the habit of naming receipts "Vendor MM DD YY thing (Child)".
 * A file is offered for a row only when its date matches the row's and its vendor word appears in the row's vendor, and
 * it does not name another student. Anything less certain stays unlinked, so nothing is ever attached on a guess.
 */
export function filesByNameHints(row: { date?: string; vendor: string; child: string }, files: ReadonlyArray<{ name: string }>, students: readonly string[]): string[] {
  if (!row.date) return [];
  const vendor = row.vendor.toLowerCase();
  const others = students.map((n) => n.toLowerCase()).filter((n) => n && n !== row.child.toLowerCase());
  return files
    .filter((f) => {
      if (/\.xlsx?$/i.test(f.name)) return false;
      const h = fileNameHints(f.name);
      // The "NN - " row-id prefix is not used in this year, but a hint is read the same way.
      if (h.date !== row.date || !h.vendor) return false;
      const word = h.vendor.toLowerCase().split(/\s+/)[0]!;
      if (!word || !(vendor.includes(word) || h.vendor.toLowerCase().includes(vendor.split(/\s+/)[0] ?? "\u0000"))) return false;
      const lower = f.name.toLowerCase();
      return !others.some((o) => lower.includes(o));
    })
    .map((f) => f.name);
}

/** Maps a Gardiner-year row into the names the importer reads, so one importer serves every layout. */
export function gardinerRow(r: Record<string, unknown>, n: number, files: ReadonlyArray<{ name: string }>, students: readonly string[]): LegacyRow {
  const notes = [text(r["Notes"]), text(r["Denial Reason"]) && `Denial reason: ${text(r["Denial Reason"])}`, text(r["Documentation Collected"]) && `Documentation: ${text(r["Documentation Collected"])}`].filter(Boolean).join("\n");
  const values: Record<string, unknown> = {
    ID: n,
    Child: r["Child"],
    Item: r["Item"],
    Date: r["Date"],
    "Invoice #": r["Invoice #"],
    Category: r["Category"],
    Amount: r["Cost"],
    Vendor: r["Vendor"],
    "Benefit Message": r["Benefit Message"],
    Status: r["Status"],
    Submitted: r["Submitted Date"],
    "Reimbursed Amount": r["Aprvl Amnt"],
    "Reimbursement ID": r["Reimbursement Number"],
    Notes: notes,
  };
  const docFiles = filesByNameHints({ date: toIsoDate(r["Date"]), vendor: text(r["Vendor"]), child: text(r["Child"]) }, files, students);
  return { values, docFiles };
}

/**
 * Reads an old tracking workbook (read-only: only GETs) and the receipts folder into the importer's input, whichever of
 * the three layouts it uses. Used by the command line's dry run and by the web app's read-only view of a year Excel owns.
 */
export async function readLegacyWorkbook(book: DriveItemRef, folder: DriveItemRef, yearLabel: string): Promise<LegacyInput> {
  const [tables, files] = await Promise.all([listTables(book), readReceiptFiles(folder)]);
  const names = tables.map((t) => t.name);

  if (detectLayout(names, true) === "gardiner") {
    const [rows, childTable, categoryTable] = await Promise.all([
      tableAsObjects(book, GARDINER_TABLE),
      tableAsObjects(book, CHILDREN_TABLE).catch(() => [] as Array<Record<string, unknown>>),
      tableAsObjects(book, CATEGORIES_TABLE).catch(() => [] as Array<Record<string, unknown>>),
    ]);
    const children = childTable.map((r) => ({ name: text(r["Children"]), scholarship: "Gardiner" })).filter((c) => c.name);
    const students = children.map((c) => c.name);
    return {
      yearLabel,
      rows: rows.map((r, i) => gardinerRow(r, i + 1, files, students)),
      children,
      paymentMethods: [],
      files,
      categories: categoryTable.map((r) => ({ path: text(r["Categories"]), eligible: [] as string[] })).filter((c) => c.path),
    };
  }

  const [headers, table1, used, childTable, summary, methodTable, categoryTable] = await Promise.all([
    getTableHeaderRow(book, TABLE1),
    getTableRows(book, TABLE1),
    getUsedRange(book, WORKSHEET).catch(() => undefined),
    tableAsObjects(book, CHILDREN_TABLE),
    getUsedRange(book, "Summary").catch(() => undefined),
    tableAsObjects(book, PAYMENT_METHODS_TABLE).catch(() => [] as Array<Record<string, unknown>>),
    tableAsObjects(book, CATEGORIES_TABLE).catch(() => [] as Array<Record<string, unknown>>),
  ]);
  const docIdx = DOC_FILE_COLUMNS.map((c) => used?.headers.indexOf(c) ?? -1).filter((i) => i !== -1);
  const layout = detectLayout(names, docIdx.length > 0);
  if (layout === "step-up-2025" && used && table1.length !== used.rows.length) {
    throw new Error(`Table1 has ${table1.length} rows but the worksheet used range has ${used.rows.length}; refusing to guess the alignment.`);
  }
  const rows: LegacyRow[] = table1.map((values, r) => {
    const record = Object.fromEntries(headers.map((h, i) => [h, values[i]]));
    const docFiles = layout === "step-up-2025" ? docIdx.map((i) => text(used!.rows[r]?.[i])).filter(Boolean) : filesByIdPrefix(text(record["ID"]), files);
    return { values: record, docFiles };
  });

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
