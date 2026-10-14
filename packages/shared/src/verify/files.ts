import type { LedgerState } from "../domain/types.js";
import { sha256OfBytes } from "../util/sha256.js";
import type { StorageProvider } from "../storage/types.js";
import type { Finding } from "./ledger.js";

export interface FileCheckOptions {
  /** Also download every file and compare its SHA-256 with the one recorded (slow). */
  hash?: boolean;
  progress?: (done: number, total: number) => void;
}

/**
 * Asks the storage whether every registered file still exists with the size recorded and, with `hash`, still has the
 * contents recorded. Read-only. The findings carry the same codes `npm run verify` has always reported.
 */
export async function verifyFiles(storage: StorageProvider, driveId: string, state: LedgerState, options: FileCheckOptions = {}): Promise<Finding[]> {
  const docs = Object.values(state.documents).filter((d) => d.driveItemId);
  const gone: string[] = [];
  const wrongSize: string[] = [];
  const wrongHash: string[] = [];
  let done = 0;
  for (const d of docs) {
    options.progress?.(done++, docs.length);
    try {
      const item = await storage.stat(driveId, d.driveItemId!);
      if (d.sizeBytes !== undefined && item.size !== undefined && item.size !== d.sizeBytes) wrongSize.push(d.id);
      if (options.hash && d.sha256) {
        const bytes = new Uint8Array(await (await storage.download(driveId, d.driveItemId!)).arrayBuffer());
        if ((await sha256OfBytes(bytes)) !== d.sha256) wrongHash.push(d.id);
      }
    } catch {
      gone.push(d.id);
    }
  }
  const out: Finding[] = [];
  const kept = (ids: string[]) => ids.slice(0, 10);
  if (gone.length) out.push({ severity: "error", code: "file-missing-in-onedrive", message: `${gone.length} registered file(s) can't be found in ${storage.label} (deleted or moved?).`, ids: kept(gone) });
  if (wrongSize.length) out.push({ severity: "warn", code: "file-size-changed", message: `${wrongSize.length} file(s) have a different size than when they were registered (edited?).`, ids: kept(wrongSize) });
  if (wrongHash.length) out.push({ severity: "error", code: "file-contents-changed", message: `${wrongHash.length} file(s) no longer match their recorded SHA-256 (changed or corrupted).`, ids: kept(wrongHash) });
  return out;
}
