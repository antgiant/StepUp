import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { listYears, openLedgerFolders, type StorageProvider } from "@step-up/shared";
import { locateWorkspace } from "./storage/index.js";

/**
 * A full copy of what StepUp's reimbursements list returns, kept with the ledger data.
 *
 * The list carries far more than the app uses today (OCR text, reviewer comments, reason codes, ids, dates, who
 * touched what), and it only comes from StepUp's own page. Keeping all of it means a new idea later is a matter of
 * reading this file, not of capturing again. One file in the newest ledger year's `_ledger` folder, merged by
 * reimbursement id so nothing that StepUp stops listing is lost; each reimbursement keeps the latest copy seen.
 */
export const ARCHIVE_FILE = "stepup-reimbursements.json";

export interface StepUpArchive {
  /** What produced it, so a reader knows what the entries are. */
  source: "reimbursementapi-prod.stepupforstudents.org/api/reimbursements/V2/search";
  savedAt: string;
  /** Raw results, exactly as StepUp sent them, by the reimbursement's `Id`. */
  reimbursements: Record<string, { seenAt: string; result: unknown }>;
}

interface Target { storage: StorageProvider; driveId: string; ledgerFolderId: string; label: string }

const HASH_FILE = path.resolve(process.cwd(), ".cache", "stepup-archive-hash.json");
let explicit: Target | undefined;
let resolved: Promise<Target | undefined> | undefined;

/** Pins the ledger year the archive is written to (a run that already has one open). */
export async function useArchiveYear(storage: StorageProvider, driveId: string, yearFolderId: string, label: string): Promise<void> {
  const folders = await openLedgerFolders(storage, driveId, yearFolderId);
  if (folders) explicit = { storage, driveId, ledgerFolderId: folders.ledgerId, label };
}

/** The newest year that is a ledger year, for runs against a spreadsheet year. */
async function newestLedgerYear(): Promise<Target | undefined> {
  const { storage, driveId, rootId } = await locateWorkspace();
  const years = (await listYears(storage, driveId, rootId)).filter((y) => y.kind === "ledger").sort((a, b) => b.label.localeCompare(a.label));
  for (const y of years) {
    const folders = await openLedgerFolders(storage, driveId, y.folderId);
    if (folders) return { storage, driveId, ledgerFolderId: folders.ledgerId, label: y.label };
  }
  return undefined;
}

const idOf = (r: Record<string, unknown>): string => String(r["Id"] ?? r["SequenceNumber"] ?? JSON.stringify(r).slice(0, 80));

/**
 * Merges a response into the ledger's copy. Skipped when this machine already saved an identical response, so the
 * dashboard loading again does not upload 6 MB again. Best effort: a failure is reported and never stops a sync.
 */
export async function archiveSearchResults(results: unknown[]): Promise<void> {
  try {
    if (results.length === 0) return;
    if (process.argv.includes("--dry-run")) return;
    const hash = createHash("sha256").update(JSON.stringify(results)).digest("hex");
    let last = "";
    try {
      last = (JSON.parse(await readFile(HASH_FILE, "utf-8")) as { hash?: string }).hash ?? "";
    } catch {
      /* none yet */
    }
    if (hash === last) return;
    resolved ??= newestLedgerYear();
    const target = explicit ?? (await resolved);
    if (!target) {
      console.log("[archive] No ledger year to keep StepUp's full list in yet.");
      return;
    }
    const { storage, driveId, ledgerFolderId } = target;
    const existing = await storage.find(driveId, ledgerFolderId, ARCHIVE_FILE);
    let archive: StepUpArchive = { source: "reimbursementapi-prod.stepupforstudents.org/api/reimbursements/V2/search", savedAt: "", reimbursements: {} };
    if (existing) {
      try {
        archive = JSON.parse((await storage.readText(driveId, existing.id)).text) as StepUpArchive;
      } catch {
        console.log("[archive] The saved copy could not be read; starting it again from this list.");
      }
    }
    const seenAt = new Date().toISOString();
    for (const r of results) archive.reimbursements[idOf(r as Record<string, unknown>)] = { seenAt, result: r };
    archive.savedAt = seenAt;
    await storage.write(driveId, ledgerFolderId, ARCHIVE_FILE, JSON.stringify(archive));
    await mkdir(path.dirname(HASH_FILE), { recursive: true });
    await writeFile(HASH_FILE, JSON.stringify({ hash }), "utf-8");
    console.log(`[archive] Kept ${results.length} reimbursement(s) (${Object.keys(archive.reimbursements).length} in all) in ${target.label}'s ledger as ${ARCHIVE_FILE}.`);
  } catch (err) {
    console.log(`[archive] Could not keep the full list: ${(err as Error).message}`);
  }
}
