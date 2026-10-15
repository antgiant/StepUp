import { appendTableRows, getTableHeaderRow, getTableRows, updateTableRowByIndex, type DriveItemRef, type FilingGroup } from "@step-up/shared/web";
import type { FilingJob } from "./agent/engine.js";

/**
 * The app's side of filing: making a job out of a group that is ready (the receipt and documents, with their bytes), and
 * writing results back to an Excel year's workbook the way the command line always did (Status, Submitted, Reimbursement
 * ID, Line Number, Notes). Ledger years record through the ledger instead; that is in main.ts.
 */

const MIME: Record<string, string> = { pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg" };
/** StepUp's stated limit for one document. */
export const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;
const TABLE = "Table1";

export const extensionOf = (name: string): string => name.split(".").pop()?.toLowerCase() ?? "";

/** The group's receipt and additional documents with their bytes, or what is wrong with them (nothing is sent then). */
export async function buildJob(group: FilingGroup, download: (itemId: string) => Promise<Blob>): Promise<{ job: FilingJob } | { problem: string }> {
  const load = async (doc: FilingGroup["receipt"]): Promise<{ name: string; mime: string; bytes: ArrayBuffer } | { problem: string }> => {
    const name = doc.filename ?? doc.id;
    const mime = MIME[extensionOf(name)];
    if (!mime) return { problem: `"${name}" is not a PNG, JPG, JPEG or PDF, which are the only kinds StepUp takes.` };
    if (!doc.driveItemId) return { problem: `"${name}" has not been uploaded yet.` };
    const bytes = await (await download(doc.driveItemId)).arrayBuffer();
    if (bytes.byteLength > MAX_DOCUMENT_BYTES) return { problem: `"${name}" is over StepUp's 5 MB limit for one document.` };
    return { name, mime, bytes };
  };
  const receipt = await load(group.receipt);
  if ("problem" in receipt) return receipt;
  const additional: Array<{ name: string; mime: string; bytes: ArrayBuffer }> = [];
  for (const doc of group.additionalDocs) {
    const f = await load(doc);
    if ("problem" in f) return f;
    additional.push(f);
  }
  return { job: { child: group.child, program: group.program, receipt, additional, rows: group.rows.map((r) => ({ id: r.itemId, data: r.data })) } };
}

/** The workbook's own ID for a ledger item that came from it (`legacy-<ID>`); undefined for any other id. */
export const workbookIdOf = (itemId: string): string | undefined => (itemId.startsWith("legacy-") ? itemId.slice("legacy-".length) : undefined);

/**
 * Sets columns on the workbook rows for these items (found by the ID column). `changes` may depend on the item's place in
 * the list (the line number). Notes are appended to, never replaced. Returns what was written and what was not found.
 */
export async function writeWorkbookRows(
  book: DriveItemRef,
  itemIds: string[],
  changes: (position: number, itemId: string) => Record<string, string | number>,
  appendNote?: string,
): Promise<{ written: number; missing: string[] }> {
  const headers = await getTableHeaderRow(book, TABLE);
  const rows = await getTableRows(book, TABLE);
  const idCol = headers.indexOf("ID");
  const notesCol = headers.indexOf("Notes");
  if (idCol === -1) throw new Error(`The workbook's ${TABLE} has no ID column, so its rows cannot be found.`);
  let written = 0;
  const missing: string[] = [];
  for (let n = 0; n < itemIds.length; n++) {
    const id = workbookIdOf(itemIds[n]!);
    const at = id === undefined ? -1 : rows.findIndex((r) => String(r[idCol] ?? "").trim() === id.trim());
    if (at === -1) {
      missing.push(itemIds[n]!);
      continue;
    }
    const set = { ...changes(n, itemIds[n]!) };
    if (appendNote && notesCol !== -1) {
      const existing = String(rows[at]![notesCol] ?? "").trim();
      set["Notes"] = existing ? `${existing} | ${appendNote}` : appendNote;
    }
    await updateTableRowByIndex(book, TABLE, at, rows[at]!, headers, set);
    // Later writes start from this row as it now is, so an earlier change is not silently put back.
    for (const [col, v] of Object.entries(set)) {
      const i = headers.indexOf(col);
      if (i !== -1) rows[at]![i] = v;
    }
    written++;
  }
  return { written, missing };
}

/**
 * The workbook's list of categories (Table5): the row for `from` takes StepUp's words `to`, keeping its other columns. When
 * `from` is not there, `to` is added if missing, as the command line did. Returns what happened.
 */
export async function renameCategoryRow(book: DriveItemRef, from: string, to: string): Promise<"renamed" | "added" | "present"> {
  const a = from.trim();
  const b = to.trim();
  const headers = await getTableHeaderRow(book, "Table5");
  const rows = await getTableRows(book, "Table5");
  const at = rows.findIndex((r) => String(r[0] ?? "").trim() === a);
  if (at !== -1) {
    await updateTableRowByIndex(book, "Table5", at, rows[at]!, headers, { [headers[0]!]: b });
    return "renamed";
  }
  if (rows.some((r) => String(r[0] ?? "").trim() === b)) return "present";
  await appendTableRows(book, "Table5", [[b, ""]]);
  return "added";
}
