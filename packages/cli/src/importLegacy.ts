import "dotenv/config";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildLegacyImport, buildMirror, readLegacyWorkbook, renderMirrorXlsx, type LegacyInput } from "@step-up/shared";
import { resolveShareLink } from "./graph/onedrive.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name} (see .env.example).`);
  return value;
}

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

  const read = await readLegacyWorkbook(excelRef, folderRef, year);
  const receiptChoices = await readFile(path.resolve(process.cwd(), ".cache", "receipt-choice-cache.json"), "utf-8").then(JSON.parse).catch(() => ({}));

  const input: LegacyInput = { ...read, receiptChoices };
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
