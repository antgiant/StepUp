import type { CachedLog, CategoryReference, LedgerEvent, LegacyYear, YearInfo } from "@step-up/shared/web";

/**
 * What the browser remembers about a workspace between visits so the app can paint instantly and then ask OneDrive
 * only what changed. It holds the same private data as the ledger, so it is cleared on sign-out and disconnect.
 */
export interface WorkspaceCache {
  v: 1;
  years: YearInfo[];
  yearLabel: string;
  eventsId: string;
  logs: CachedLog[];
  /** The year's frozen category list, so categories work at once and offline. */
  snapshot?: CategoryReference;
  /** For a year still kept in Excel: what was last read from the workbook, so switching to it does not wait on Excel. */
  legacy?: {
    input: LegacyYear["input"];
    choices: LegacyYear["choices"];
    workbook: { itemId: string; name: string; eTag?: string; webUrl?: string };
    readAt: number;
  };
  savedAt: number;
}

const DB = "stepup-cache";
const STORE = "workspaces";
/** Edits made but not yet uploaded, so a reload, a crash or a lost connection never loses them. */
const OUTBOX = "outbox";
/** Receipt files chosen while offline, waiting to be uploaded. */
const UPLOADS = "uploads";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 3);
    req.onupgradeneeded = () => {
      for (const name of [STORE, OUTBOX, UPLOADS]) if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>, store = STORE): Promise<T | undefined> {
  try {
    const db = await open();
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const req = fn(tx.objectStore(store));
      tx.oncomplete = () => {
        db.close();
        resolve(req.result);
      };
      tx.onerror = tx.onabort = () => {
        db.close();
        reject(tx.error);
      };
    });
  } catch {
    return undefined; // private window / blocked storage: the app just works without a cache
  }
}

export const cacheKey = (accountId: string, driveId: string, rootId: string, year: string) => `${accountId}|${driveId}|${rootId}|${year}`;

export async function readCache(key: string): Promise<WorkspaceCache | undefined> {
  const rec = (await run("readonly", (s) => s.get(key))) as WorkspaceCache | undefined;
  return rec?.v === 1 ? rec : undefined;
}

export async function writeCache(key: string, rec: WorkspaceCache): Promise<void> {
  await run("readwrite", (s) => s.put(rec, key));
}

export async function deleteCache(key: string): Promise<void> {
  await run("readwrite", (s) => s.delete(key));
}

export async function clearCache(): Promise<void> {
  await run("readwrite", (s) => s.clear());
  await run("readwrite", (s) => s.clear(), OUTBOX);
  await run("readwrite", (s) => s.clear(), UPLOADS);
}

export async function readOutbox(key: string): Promise<LedgerEvent[]> {
  return ((await run("readonly", (s) => s.get(key), OUTBOX)) as LedgerEvent[] | undefined) ?? [];
}

/** Saves the current unflushed events (an empty list clears the entry). */
export async function writeOutbox(key: string, events: readonly LedgerEvent[]): Promise<void> {
  if (events.length === 0) await run("readwrite", (s) => s.delete(key), OUTBOX);
  else await run("readwrite", (s) => s.put([...events], key), OUTBOX);
}

export interface QueuedUpload {
  id: string;
  name: string;
  blob: Blob;
  sha256?: string;
  queuedAt: number;
}

/** Keeps a file on this device until it can be uploaded. */
export async function queueUpload(key: string, file: { name: string; blob: Blob; sha256?: string }): Promise<void> {
  const id = `${key}|${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await run("readwrite", (s) => s.put({ id, name: file.name, blob: file.blob, ...(file.sha256 ? { sha256: file.sha256 } : {}), queuedAt: Date.now() } satisfies QueuedUpload, id), UPLOADS);
}

export async function listQueuedUploads(key: string): Promise<QueuedUpload[]> {
  return ((await run("readonly", (s) => s.getAll(IDBKeyRange.bound(`${key}|`, `${key}|\uffff`)), UPLOADS)) as QueuedUpload[] | undefined) ?? [];
}

export async function removeQueuedUpload(id: string): Promise<void> {
  await run("readwrite", (s) => s.delete(id), UPLOADS);
}
