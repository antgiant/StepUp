import "dotenv/config";
import {
  getTableHeaderRow,
  getUsedRange,
  listFolderChildren,
  listTables,
  listWorksheets,
  resolveShareLink,
} from "./graph/onedrive.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name} in .env`);
  return value;
}

async function main() {
  console.log("Resolving the Excel workbook share link...");
  const excelRef = await resolveShareLink(requireEnv("ONEDRIVE_EXCEL_URL"));
  console.log(`  -> "${excelRef.name}" (driveId=${excelRef.driveId}, itemId=${excelRef.itemId})`);

  const worksheets = await listWorksheets(excelRef);
  console.log(`\nWorksheets (${worksheets.length}):`);
  for (const ws of worksheets) console.log(`  - ${ws.name}`);

  const tables = await listTables(excelRef);
  if (tables.length > 0) {
    console.log(`\nTables (${tables.length}):`);
    for (const t of tables) {
      const headers = await getTableHeaderRow(excelRef, t.name);
      console.log(`  - "${t.name}" columns: ${headers.join(" | ")}`);
    }
  }

  console.log(
    "\nFull used-range header row per worksheet (catches columns that sit outside any formal Table, e.g. to the right of one):"
  );
  for (const ws of worksheets) {
    try {
      const { headers, rows } = await getUsedRange(excelRef, ws.name);
      console.log(`  - "${ws.name}" columns: ${headers.join(" | ")} (${rows.length} data rows)`);
    } catch (err) {
      console.log(`  - "${ws.name}": (empty or unreadable: ${(err as Error).message})`);
    }
  }

  console.log("\nResolving the reference files folder share link...");
  const folderRef = await resolveShareLink(requireEnv("ONEDRIVE_FILES_FOLDER_URL"));
  console.log(`  -> "${folderRef.name}" (driveId=${folderRef.driveId}, itemId=${folderRef.itemId})`);

  const children = await listFolderChildren(folderRef);
  console.log(`\nTop-level contents (${children.length}):`);
  for (const c of children) {
    console.log(`  - ${c.isFolder ? "[folder]" : "[file]  "} ${c.name}`);
  }

  console.log(
    "\nNote: this printed structure only (worksheet/column/file names) — no applicant data rows were logged."
  );
}

main().catch((err) => {
  console.error("\nDiscovery failed:", err.message ?? err);
  process.exit(1);
});
