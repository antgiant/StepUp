import type { StorageProvider } from "../storage/types.js";
import type { HistoryChange, HistoryFile } from "./types.js";
import type { ExcelSnapshot } from "./sources.js";

/**
 * Where StepUp's and Excel's changes are kept: `<year>/_history/<time>-<source>.json`, one small file per run that saw
 * any change (a new name each time, so nothing is ever rewritten and two machines never clash), and the one snapshot the
 * workbook is compared to next time. Ledger changes are not kept here: the ledger's event log is already their history.
 */
export const HISTORY_DIR = "_history";
export const EXCEL_SNAPSHOT_FILE = "excel-snapshot.json";
const FILE_RE = /^\d{4}-\d{2}-\d{2}T[\d-]+Z-(stepup|excel)(-\w+)?\.json$/;

export async function writeHistoryFile(storage: StorageProvider, driveId: string, yearFolderId: string, source: HistoryFile["source"], changes: HistoryChange[], at = new Date().toISOString()): Promise<void> {
  if (changes.length === 0) return;
  const dir = await storage.ensureFolder(driveId, yearFolderId, HISTORY_DIR);
  const file: HistoryFile = { v: 1, source, at, changes };
  const name = `${at.replace(/[:.]/g, "-")}-${source}-${Math.random().toString(36).slice(2, 6)}.json`;
  await storage.write(driveId, dir, name, JSON.stringify(file));
}

/** Files already read are kept by id (a history file never changes), so a refresh reads only the new ones. */
export type HistoryReadCache = Map<string, HistoryChange[]>;

/** Every StepUp and Excel change kept for the year, oldest first. Unreadable files are skipped. */
export async function readHistoryFiles(storage: StorageProvider, driveId: string, yearFolderId: string, cache: HistoryReadCache = new Map()): Promise<HistoryChange[]> {
  const dir = await storage.find(driveId, yearFolderId, HISTORY_DIR);
  if (!dir?.isFolder) return [];
  const files = (await storage.list(driveId, dir.id)).filter((f) => !f.isFolder && FILE_RE.test(f.name));
  let next = 0;
  const todo = files.filter((f) => !cache.has(f.id));
  const worker = async () => {
    while (next < todo.length) {
      const f = todo[next++]!;
      try {
        const parsed = JSON.parse((await storage.readText(driveId, f.id)).text) as HistoryFile;
        cache.set(f.id, parsed?.v === 1 && Array.isArray(parsed.changes) ? parsed.changes : []);
      } catch {
        cache.set(f.id, []);
      }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return files.flatMap((f) => cache.get(f.id) ?? []).sort((a, b) => a.at.localeCompare(b.at));
}

export async function readExcelSnapshot(storage: StorageProvider, driveId: string, yearFolderId: string): Promise<ExcelSnapshot | undefined> {
  const dir = await storage.find(driveId, yearFolderId, HISTORY_DIR);
  const file = dir?.isFolder ? await storage.find(driveId, dir.id, EXCEL_SNAPSHOT_FILE) : undefined;
  if (!file) return undefined;
  try {
    const snap = JSON.parse((await storage.readText(driveId, file.id)).text) as ExcelSnapshot;
    return snap?.v === 1 && snap.rows ? snap : undefined;
  } catch {
    return undefined;
  }
}

export async function writeExcelSnapshot(storage: StorageProvider, driveId: string, yearFolderId: string, snapshot: ExcelSnapshot): Promise<void> {
  const dir = await storage.ensureFolder(driveId, yearFolderId, HISTORY_DIR);
  await storage.write(driveId, dir, EXCEL_SNAPSHOT_FILE, JSON.stringify(snapshot));
}
