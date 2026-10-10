import "dotenv/config";
import { mkdir, writeFile as writeLocal } from "node:fs/promises";
import path from "node:path";
import { openLedgerFolders, sha256OfBytes } from "@step-up/shared";
import { readFile } from "node:fs/promises";
import { openYearLedger } from "./ledgerYear.js";
import { downloadTo } from "./storage/index.js";

/**
 * npm run backup -- 2026-2027 --to ~/Backups/stepup [--documents]
 * Copies a year to a folder outside OneDrive: every event log (the source of truth), the frozen category list, the
 * mirror spreadsheet, and with --documents every receipt/statement file. A manifest records what was copied and each
 * file's SHA-256. Read-only on OneDrive. A year can be rebuilt from the logs and documents alone.
 */
async function main() {
  const args = process.argv.slice(2);
  const label = args.find((a) => /^\d{4}-\d{4}$/.test(a));
  const toAt = args.indexOf("--to");
  const to = toAt >= 0 ? args[toAt + 1] : undefined;
  if (!label || !to) throw new Error("Usage: npm run backup -- <year> --to <folder> [--documents]");

  const opened = await openYearLedger(label);
  const folders = await openLedgerFolders(opened.storage, opened.driveId, opened.year.folderId);
  if (!folders) throw new Error(`${label} has no ledger folders.`);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const dest = path.resolve(to.replace(/^~/, process.env["HOME"] ?? "~"), `${label}-${stamp}`);
  const manifest: Array<{ path: string; bytes: number; sha256: string }> = [];

  const grab = async (itemId: string, rel: string) => {
    const file = path.join(dest, rel);
    await mkdir(path.dirname(file), { recursive: true });
    await downloadTo(opened.storage, opened.driveId, itemId, file);
    const bytes = await readFile(file);
    manifest.push({ path: rel, bytes: bytes.byteLength, sha256: await sha256OfBytes(bytes) });
  };

  console.log(`Backing up ${label} to ${dest}`);
  for (const f of (await opened.storage.list(opened.driveId, folders.eventsId)).filter((c) => !c.isFolder)) await grab(f.id, `events/${f.name}`);
  const ledgerKids = await opened.storage.list(opened.driveId, folders.ledgerId);
  for (const f of ledgerKids.filter((c) => !c.isFolder && c.name.endsWith(".json"))) await grab(f.id, f.name); // reference.snapshot.json
  for (const f of (await opened.storage.list(opened.driveId, folders.reportsId)).filter((c) => !c.isFolder && c.name.endsWith(".xlsx"))) await grab(f.id, `reports/${f.name}`);

  let docs = 0;
  if (args.includes("--documents")) {
    const used = new Set<string>();
    for (const d of Object.values(opened.ledger.state.documents)) {
      if (!d.driveItemId) continue;
      let name = d.filename ?? d.id;
      if (used.has(name)) name = `${d.id}-${name}`;
      used.add(name);
      await grab(d.driveItemId, `documents/${name}`);
      docs++;
    }
  }

  await writeLocal(path.join(dest, "manifest.json"), JSON.stringify({ year: label, takenAt: new Date().toISOString(), documents: args.includes("--documents"), files: manifest }, null, 2));
  console.log(`Done: ${manifest.length} file(s)${docs ? ` (${docs} document(s))` : " (no documents; add --documents for those)"}. Manifest: ${path.join(dest, "manifest.json")}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
