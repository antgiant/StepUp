import "dotenv/config";
import {
  clockLooksWrong,
  graphJson,
  hasErrors,
  openLedgerFolders,
  serverClockSkewMs,
  sha256OfBytes,
  verifyLedger,
  writeFile,
  type Finding,
} from "@step-up/shared";
import { downloadItem } from "./graph/onedrive.js";
import { openYearLedger } from "./ledgerYear.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * npm run verify -- 2026-2027 [--files] [--hash]
 *   (always)  checks the ledger makes sense: nothing points at something that isn't there, logs are clean, no duplicate files
 *   --files   also asks OneDrive whether every registered file still exists and has the size recorded
 *   --hash    also downloads each file and checks its SHA-256 (slow; implies --files)
 * Read-only. Exits with an error status if anything is inconsistent.
 */
async function main() {
  const args = process.argv.slice(2);
  const label = args.find((a) => /^\d{4}-\d{4}$/.test(a));
  if (!label) throw new Error("Usage: npm run verify -- <year> [--files] [--hash]");
  const hash = args.includes("--hash");
  const files = hash || args.includes("--files");

  const opened = await openYearLedger(label);
  const events = await opened.ledger.store.readAll();
  const findings: Finding[] = verifyLedger(opened.ledger.state, events);

  if (files) {
    const docs = Object.values(opened.ledger.state.documents).filter((d) => d.driveItemId);
    console.log(`Checking ${docs.length} file(s) in OneDrive${hash ? " (downloading each to check its contents)" : ""}...`);
    const gone: string[] = [];
    const wrongSize: string[] = [];
    const wrongHash: string[] = [];
    const tmp = hash ? await mkdtemp(path.join(os.tmpdir(), "stepup-verify-")) : undefined;
    for (const d of docs) {
      try {
        const item = await graphJson<{ size?: number }>(`/drives/${opened.driveId}/items/${d.driveItemId}?$select=size`);
        if (d.sizeBytes !== undefined && item.size !== undefined && item.size !== d.sizeBytes) wrongSize.push(d.id);
        if (hash && d.sha256 && tmp) {
          const dest = path.join(tmp, "f");
          await downloadItem(opened.driveId, d.driveItemId!, dest);
          const bytes = await readFile(dest);
          if ((await sha256OfBytes(bytes)) !== d.sha256) wrongHash.push(d.id);
        }
      } catch {
        gone.push(d.id);
      }
    }
    if (tmp) await rm(tmp, { recursive: true, force: true });
    if (gone.length) findings.push({ severity: "error", code: "file-missing-in-onedrive", message: `${gone.length} registered file(s) can't be found in OneDrive (deleted or moved?).`, ids: gone.slice(0, 10) });
    if (wrongSize.length) findings.push({ severity: "warn", code: "file-size-changed", message: `${wrongSize.length} file(s) have a different size than when they were registered (edited?).`, ids: wrongSize.slice(0, 10) });
    if (wrongHash.length) findings.push({ severity: "error", code: "file-contents-changed", message: `${wrongHash.length} file(s) no longer match their recorded SHA-256 (changed or corrupted).`, ids: wrongHash.slice(0, 10) });
  }

  // A tiny write is the only way to learn OneDrive's idea of the time; do it in the reports folder, and only for the clock check.
  const folders = await openLedgerFolders(opened.driveId, opened.year.folderId);
  if (folders) {
    await writeFile(opened.driveId, folders.reportsId, ".clock-check", new Date().toISOString());
    if (clockLooksWrong()) findings.push({ severity: "warn", code: "clock-skew", message: `This computer's clock is ${Math.round(Math.abs(serverClockSkewMs()!) / 60000)} minute(s) ${serverClockSkewMs()! > 0 ? "behind" : "ahead of"} OneDrive's. Edits made on different devices may be ordered wrongly.` });
  }

  const icon = { error: "ERROR", warn: "warn ", info: "info " } as const;
  console.log(`\n${opened.year.label}: ${events.length} event(s), ${Object.keys(opened.ledger.state.items).length} item(s), ${Object.keys(opened.ledger.state.documents).length} document(s)\n`);
  for (const f of findings) console.log(`${icon[f.severity]}  ${f.message}${f.ids ? `\n        e.g. ${f.ids.slice(0, 3).join(", ")}` : ""}`);
  if (hasErrors(findings)) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
