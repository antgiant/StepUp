import { createHash } from "node:crypto";
import {
  LEDGER_DIR,
  STEPUP_DIR,
  STEPUP_INDEX_FILE,
  STEPUP_REIMBURSEMENTS_DIR,
  listYears,
  projectReimbursement,
  readStepUpIndex,
  reimbursementFileName,
  type StepUpIndex,
  type StepUpIndexEntry,
  type StepUpReimbursement,
  type StorageProvider,
  type YearInfo,
} from "@step-up/shared";
import { locateWorkspace } from "./storage/index.js";

/**
 * Keeps StepUp's list of reimbursements with the year each belongs to (layout: shared/stepup/archive.ts).
 *
 * One file per reimbursement, in that school year's own folder (Excel years included), plus a small index per year.
 * Which files changed is read off the year's index (a hash of each raw file), so a fresh copy of the whole list costs one
 * small download per year and one small upload per reimbursement that actually changed. Nothing changed, nothing sent.
 */
const CONCURRENCY = 6;

interface Workspace { storage: StorageProvider; driveId: string; years: Map<string, YearInfo> }
let workspace: Promise<Workspace> | undefined;
const folderIds = new Map<string, { dir: string; reimbursements: string }>();
const warned = new Set<string>();

async function open(): Promise<Workspace> {
  const { storage, driveId, rootId } = await locateWorkspace();
  return { storage, driveId, years: new Map((await listYears(storage, driveId, rootId)).map((y) => [y.label, y])) };
}

async function foldersFor(ws: Workspace, year: YearInfo): Promise<{ dir: string; reimbursements: string }> {
  const have = folderIds.get(year.label);
  if (have) return have;
  const dir = await ws.storage.ensureFolder(ws.driveId, year.folderId, STEPUP_DIR);
  const reimbursements = await ws.storage.ensureFolder(ws.driveId, dir, STEPUP_REIMBURSEMENTS_DIR);
  const made = { dir, reimbursements };
  folderIds.set(year.label, made);
  return made;
}

async function forEachLimited<T>(items: T[], work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (next < items.length) await work(items[next++]!);
  }));
}

/**
 * Applies a fresh copy of the list: each reimbursement whose content differs from what is kept is written to its own
 * file in its year's folder, and the year's index is updated. Best effort: a failure is reported, never fatal.
 */
export async function archiveSearchResults(results: unknown[]): Promise<void> {
  try {
    if (results.length === 0 || process.argv.includes("--dry-run")) return;
    workspace ??= open();
    const ws = await workspace;
    const byYear = new Map<string, Array<{ raw: unknown; p: StepUpReimbursement; hash: string }>>();
    for (const raw of results) {
      const p = projectReimbursement(raw);
      if (!p) continue;
      const list = byYear.get(p.schoolYear) ?? [];
      list.push({ raw, p, hash: createHash("sha256").update(JSON.stringify(raw)).digest("hex") });
      byYear.set(p.schoolYear, list);
    }
    for (const [label, list] of [...byYear].sort(([a], [b]) => a.localeCompare(b))) {
      const year = ws.years.get(label);
      if (!year) {
        if (!warned.has(label)) console.log(`[archive] There is no ${label} folder, so ${list.length} reimbursement(s) from that year are not kept. Create the folder to keep them.`);
        warned.add(label);
        continue;
      }
      const folders = await foldersFor(ws, year);
      const existing = await readStepUpIndex(ws.storage, ws.driveId, folders.dir);
      const entries = new Map<string, StepUpIndexEntry>((existing?.index.reimbursements ?? []).map((e) => [e.id, e]));
      const changed = list.filter((x) => entries.get(x.p.id)?.hash !== x.hash);
      if (changed.length === 0 && existing) continue;
      const seenAt = new Date().toISOString();
      await forEachLimited(changed, async (x) => {
        await ws.storage.write(ws.driveId, folders.reimbursements, reimbursementFileName(x.p), JSON.stringify({ seenAt, result: x.raw }));
        entries.set(x.p.id, { ...x.p, hash: x.hash });
      });
      const index: StepUpIndex = { v: 1, year: label, savedAt: seenAt, reimbursements: [...entries.values()].sort((a, b) => a.number - b.number) };
      await ws.storage.write(ws.driveId, folders.dir, STEPUP_INDEX_FILE, JSON.stringify(index));
      console.log(`[archive] ${label}: kept ${changed.length} changed reimbursement(s) of ${list.length} listed (${entries.size} on file).`);
    }
    await dropSingleFileArchive(ws);
  } catch (err) {
    console.log(`[archive] Could not keep the full list: ${(err as Error).message}`);
  }
}

/** The first version kept everything in one file in a ledger year; it is replaced by the per-reimbursement files. */
async function dropSingleFileArchive(ws: Workspace): Promise<void> {
  for (const year of ws.years.values()) {
    if (year.kind !== "ledger") continue;
    const ledger = await ws.storage.find(ws.driveId, year.folderId, LEDGER_DIR);
    const old = ledger ? await ws.storage.find(ws.driveId, ledger.id, "stepup-reimbursements.json") : undefined;
    if (old) {
      await ws.storage.remove(ws.driveId, old.id);
      console.log(`[archive] Removed the old single-file copy from ${year.label}.`);
    }
  }
}
