import "dotenv/config";
import { mkdir, writeFile as writeLocal } from "node:fs/promises";
import path from "node:path";
import { collectBackup } from "@step-up/shared";
import { openYearLedger } from "./ledgerYear.js";

/**
 * npm run backup -- 2026-2027 --to ~/Backups/stepup [--documents]
 * Copies a year to a folder outside OneDrive: every event log (the source of truth), the frozen category list, the
 * mirror spreadsheet, and with --documents every receipt/statement file. A manifest records what was copied and each
 * file's SHA-256. Read-only on OneDrive. A year can be rebuilt from the logs and documents alone.
 * (The web app's Advanced -> Back up this year does the same and downloads it as one zip.)
 */
async function main() {
  const args = process.argv.slice(2);
  const label = args.find((a) => /^\d{4}-\d{4}$/.test(a));
  const toAt = args.indexOf("--to");
  const to = toAt >= 0 ? args[toAt + 1] : undefined;
  if (!label || !to) throw new Error("Usage: npm run backup -- <year> --to <folder> [--documents]");

  const opened = await openYearLedger(label);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const dest = path.resolve(to.replace(/^~/, process.env["HOME"] ?? "~"), `${label}-${stamp}`);
  console.log(`Backing up ${label} to ${dest}`);
  const { entries, manifest } = await collectBackup(opened.storage, opened.driveId, opened.year.folderId, label, opened.ledger.state, { documents: args.includes("--documents") });
  for (const e of entries) {
    const file = path.join(dest, e.name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeLocal(file, e.data instanceof Blob ? new Uint8Array(await e.data.arrayBuffer()) : e.data);
  }
  const docs = manifest.files.filter((f) => f.path.startsWith("documents/")).length;
  console.log(`Done: ${manifest.files.length} file(s)${docs ? ` (${docs} document(s))` : " (no documents; add --documents for those)"}. Manifest: ${path.join(dest, "manifest.json")}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
