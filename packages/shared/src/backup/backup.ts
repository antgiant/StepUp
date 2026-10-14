import type { LedgerState } from "../domain/types.js";
import { sha256OfBytes } from "../util/sha256.js";
import type { StorageProvider } from "../storage/types.js";
import { openLedgerFolders } from "../workspace/workspace.js";
import { zipStore, type ZipEntry } from "../util/zip.js";

export interface BackupManifestFile {
  path: string;
  bytes: number;
  sha256: string;
}

export interface BackupManifest {
  year: string;
  takenAt: string;
  documents: boolean;
  files: BackupManifestFile[];
}

export interface BackupOptions {
  /** Also copy every receipt and statement file. */
  documents?: boolean;
  /** Called before each file, with how many are done of how many (the documents are counted once the logs are in). */
  progress?: (done: number, total: number, name: string) => void;
  now?: Date;
}

/**
 * Everything needed to rebuild a ledger year: every event log (the source of truth), the frozen category list, the mirror
 * spreadsheet and, when asked, every document, with a manifest of each file's SHA-256. Read-only on the storage. The same
 * code serves `npm run backup` and the web app's "Back up this year" (which hands it to `zipBackup`).
 */
export async function collectBackup(
  storage: StorageProvider,
  driveId: string,
  yearFolderId: string,
  yearLabel: string,
  state: LedgerState,
  options: BackupOptions = {},
): Promise<{ entries: ZipEntry[]; manifest: BackupManifest }> {
  const folders = await openLedgerFolders(storage, driveId, yearFolderId);
  if (!folders) throw new Error(`${yearLabel} has no ledger folders.`);
  const takenAt = (options.now ?? new Date()).toISOString();

  const wanted: Array<{ id: string; path: string }> = [];
  for (const f of (await storage.list(driveId, folders.eventsId)).filter((c) => !c.isFolder)) wanted.push({ id: f.id, path: `events/${f.name}` });
  for (const f of (await storage.list(driveId, folders.ledgerId)).filter((c) => !c.isFolder && c.name.endsWith(".json"))) wanted.push({ id: f.id, path: f.name }); // reference.snapshot.json
  for (const f of (await storage.list(driveId, folders.reportsId)).filter((c) => !c.isFolder && c.name.endsWith(".xlsx"))) wanted.push({ id: f.id, path: `reports/${f.name}` });
  if (options.documents) {
    const used = new Set<string>();
    for (const d of Object.values(state.documents)) {
      if (!d.driveItemId) continue;
      let name = d.filename ?? d.id;
      if (used.has(name)) name = `${d.id}-${name}`;
      used.add(name);
      wanted.push({ id: d.driveItemId, path: `documents/${name}` });
    }
  }

  const entries: ZipEntry[] = [];
  const files: BackupManifestFile[] = [];
  let done = 0;
  for (const w of wanted) {
    options.progress?.(done++, wanted.length, w.path);
    const blob = await storage.download(driveId, w.id);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    files.push({ path: w.path, bytes: bytes.byteLength, sha256: await sha256OfBytes(bytes) });
    entries.push({ name: w.path, data: bytes });
  }
  const manifest: BackupManifest = { year: yearLabel, takenAt, documents: Boolean(options.documents), files };
  entries.push({ name: "manifest.json", data: new TextEncoder().encode(JSON.stringify(manifest, null, 2)) });
  return { entries, manifest };
}

/** `collectBackup`, packed into one zip. */
export async function zipBackup(...args: Parameters<typeof collectBackup>): Promise<{ blob: Blob; manifest: BackupManifest }> {
  const { entries, manifest } = await collectBackup(...args);
  return { blob: await zipStore(entries), manifest };
}

/** The name a downloaded backup gets. */
export const backupFileName = (yearLabel: string, takenAt: string, documents: boolean): string =>
  `Step Up Helper backup ${yearLabel} ${takenAt.replace(/[:.]/g, "-").slice(0, 19)}${documents ? " (with documents)" : ""}.zip`;
