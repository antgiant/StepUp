import "dotenv/config";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  CATEGORIES_TABLE,
  CHILDREN_TABLE,
  DOC_FILE_COLUMNS,
  TABLE1,
  WORKSHEET,
  buildLegacyImport,
  buildMirror,
  renderMirrorXlsx,
  type LegacyInput,
  type LegacyRow,
} from "@step-up/shared";
import {
  getTableHeaderRow,
  getTableRows,
  getUsedRange,
  listFolderChildren,
  resolveShareLink,
} from "./graph/onedrive.js";

const PAYMENT_METHODS_TABLE = "Table6";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name} (see .env.example).`);
  return value;
}

async function tableAsObjects(excelRef: Awaited<ReturnType<typeof resolveShareLink>>, table: string) {
  const headers = await getTableHeaderRow(excelRef, table);
  const rows = await getTableRows(excelRef, table);
  return rows.map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i]])) as Record<string, unknown>);
}

const text = (v: unknown) => (v === undefined || v === null ? "" : String(v).trim());

/**
 * Read-only dry run: converts the old Excel workbook + receipts folder into ledger events and writes them, a
 * report and a mirror spreadsheet to data/import/<year>/ (gitignored) so the result can be compared with the
 * original by eye. Nothing is written to OneDrive.
 */
async function main() {
  const excelRef = await resolveShareLink(requireEnv("ONEDRIVE_EXCEL_URL"));
  const folderRef = await resolveShareLink(requireEnv("ONEDRIVE_FILES_FOLDER_URL"));
  const yearArg = process.argv.find((a) => a.startsWith("--year="))?.slice("--year=".length);
  const year = yearArg ?? /(\d{4}-\d{4})/.exec(excelRef.name)?.[1] ?? "legacy";
  console.log(`Reading "${excelRef.name}" as year ${year} (read-only)...`);

  const headers = await getTableHeaderRow(excelRef, TABLE1);
  const table1 = await getTableRows(excelRef, TABLE1);
  const { headers: wsHeaders, rows: wsRows } = await getUsedRange(excelRef, WORKSHEET);
  if (table1.length !== wsRows.length) {
    throw new Error(`Table1 has ${table1.length} rows but the worksheet used range has ${wsRows.length}; refusing to guess the alignment.`);
  }
  const docIdx = DOC_FILE_COLUMNS.map((c) => wsHeaders.indexOf(c)).filter((i) => i !== -1);
  const rows: LegacyRow[] = table1.map((values, r) => ({
    values: Object.fromEntries(headers.map((h, i) => [h, values[i]])),
    docFiles: docIdx.map((i) => text(wsRows[r]?.[i])).filter(Boolean),
  }));

  const childTable = await tableAsObjects(excelRef, CHILDREN_TABLE);
  const summary = await getUsedRange(excelRef, "Summary").catch(() => undefined);
  const capByName = new Map<string, number>();
  for (const r of summary?.rows ?? []) {
    const cap = Number(r[2]);
    if (text(r[0]) && Number.isFinite(cap) && cap > 0) capByName.set(text(r[0]).toLowerCase(), cap);
  }
  const children = childTable
    .map((r) => ({ name: text(r["Children"]), scholarship: text(r["Scholarship"]) || undefined }))
    .filter((c) => c.name)
    .map((c) => ({ ...c, capDollars: capByName.get(c.name.toLowerCase()) }));

  const paymentMethods = (await tableAsObjects(excelRef, PAYMENT_METHODS_TABLE))
    .map((r) => ({ label: text(r["Credit Cards"]), file: text(r["File"]) || undefined }))
    .filter((p) => p.label);
  const categories = (await tableAsObjects(excelRef, CATEGORIES_TABLE))
    .map((r) => ({ path: text(r["Categories"]), eligible: text(r["Eligible Scholarships"]).split(",").map((s) => s.trim()).filter(Boolean) }))
    .filter((c) => c.path);

  const files = (await listFolderChildren(folderRef)).filter((c) => !c.isFolder).map((c) => ({ name: c.name, id: c.id, webUrl: c.webUrl, size: c.size }));
  const receiptChoices = await readFile(path.resolve(process.cwd(), ".cache", "receipt-choice-cache.json"), "utf-8").then(JSON.parse).catch(() => ({}));

  const input: LegacyInput = { yearLabel: year, rows, children, paymentMethods, files, receiptChoices, categories };
  const { events, state, report, rules } = buildLegacyImport(input);

  const outDir = path.resolve(process.cwd(), "data", "import", year);
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  await writeFile(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));
  const mirror = buildMirror(state, { ...rules, today: new Date().toISOString().slice(0, 10) }, { generatedAt: new Date().toISOString(), eventCounts: { "legacy-import": events.length } });
  await writeFile(path.join(outDir, "mirror.xlsx"), await renderMirrorXlsx(mirror));

  const some = <T>(list: T[], fmt: (x: T) => string, n = 8) => (list.length === 0 ? "none" : list.slice(0, n).map(fmt).join("; ") + (list.length > n ? `; ... (+${list.length - n} more)` : ""));
  console.log(`\nImported ${report.itemsImported} item(s) from ${report.rowsRead} row(s): ${report.purchases} purchase(s), ${report.submissions} submission(s), ${report.documents} document(s).`);
  console.log("Status counts:", JSON.stringify(report.statusCounts));
  console.log(`Rows skipped: ${some(report.rowsSkipped, (s) => `row ${s.row} (${s.reason})`)}`);
  console.log(`Files named in the sheet but missing from the folder: ${some(report.missingFiles, (f) => f)}`);
  console.log(`Items without documentation: ${some(report.itemsWithoutDocuments, (i) => i)}`);
  console.log(`Ambiguous receipts: ${report.ambiguousReceipts.length} (${report.ambiguousReceipts.filter((a) => a.resolvedFromCache).length} resolved from your earlier answers)`);
  console.log(`Unrecognized statuses (kept as overrides): ${some(report.unknownStatuses, (u) => `${u.itemId}="${u.status}"`)}`);
  console.log(`Items on hold (from the old automation notes): ${some(report.holds, (h) => `${h.itemId}=${h.hold}`)}`);
  console.log(`Items whose date/invoice/vendor differ from their receipt's first row (kept per item): ${report.purchaseDisagreements.length}`);
  console.log(`New readiness rules vs. old hand-set status disagree on ${report.readinessMismatches.length} unfiled item(s): ${some(report.readinessMismatches, (m) => `${m.itemId} old="${m.legacy}" new="${m.computed}" [${m.reasons.join(",")}]`, 6)}`);
  console.log(`\nWrote events.jsonl, report.json and mirror.xlsx to ${outDir}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
