import "dotenv/config";
import { ensureLedgerFolders, listYears, parentOf, planLedgerFolders, resolveShareLink } from "@step-up/shared";
import "./graph/client.js"; // registers the Node token provider

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name} (see .env.example).`);
  return value;
}

/** The workspace root is the folder that holds the year folders: the parent of the current receipts folder. */
async function workspace() {
  const current = await resolveShareLink(requireEnv("ONEDRIVE_FILES_FOLDER_URL"));
  return { driveId: current.driveId, rootId: await parentOf(current.driveId, current.itemId) };
}

/**
 * npm run year -- list                      read-only: show year folders and how each is set up
 * npm run year -- init 2026-2027            show what would be created in that year folder (nothing is written)
 * npm run year -- init 2026-2027 --apply    create `_ledger/` and its subfolders (existing files are never touched)
 */
async function main() {
  const [command, label, ...flags] = process.argv.slice(2);
  const { driveId, rootId } = await workspace();
  const years = await listYears(driveId, rootId);

  if (command === "list" || !command) {
    for (const y of years) {
      console.log(`${y.label}  ${y.kind.padEnd(12)} ${String(y.looseFileCount).padStart(4)} loose file(s)${y.workbookName ? `   workbook: ${y.workbookName}` : ""}`);
    }
    return;
  }

  if (command === "init") {
    const year = years.find((y) => y.label === label);
    if (!year) throw new Error(`No year folder named "${label}" under the workspace root. Found: ${years.map((y) => y.label).join(", ")}`);
    const missing = await planLedgerFolders(driveId, year.folderId);
    if (missing.length === 0) {
      console.log(`${year.label} already has its ledger folders.`);
      return;
    }
    if (!flags.includes("--apply")) {
      console.log(`Would create in ${year.label} (${year.looseFileCount} existing loose file(s) stay untouched):\n  ${missing.join("\n  ")}\nRe-run with --apply to create them.`);
      return;
    }
    await ensureLedgerFolders(driveId, year.folderId);
    console.log(`Created ledger folders in ${year.label}.`);
    return;
  }

  throw new Error(`Unknown command "${command}". Use: list | init <year> [--apply]`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
