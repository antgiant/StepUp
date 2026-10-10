import { MemoryProvider, type StoredNode } from "./memory.js";
import { noSignIn, type StorageAuth } from "./types.js";

/** Where a browser store keeps its nodes between visits. IndexedDB in the app; an in-memory one in tests. */
export interface NodeStorage {
  loadAll(): Promise<StoredNode[]>;
  /** Writes (inserts or replaces) and deletes in one transaction. */
  apply(put: StoredNode[], remove: string[]): Promise<void>;
}

/** A NodeStorage that lives only as long as the object (tests, and browsers with IndexedDB blocked). */
export class MemoryNodeStorage implements NodeStorage {
  private readonly data = new Map<string, StoredNode>();
  async loadAll(): Promise<StoredNode[]> {
    return [...this.data.values()];
  }
  async apply(put: StoredNode[], remove: string[]): Promise<void> {
    for (const n of put) this.data.set(n.id, { ...n });
    for (const id of remove) this.data.delete(id);
  }
}

const STORE = "nodes";

/** IndexedDB-backed NodeStorage. Blobs are stored as Blobs, so the browser keeps file contents on disk, not in memory. */
export function indexedDbNodeStorage(dbName: string): NodeStorage {
  let opened: Promise<IDBDatabase> | undefined;
  const open = (): Promise<IDBDatabase> =>
    (opened ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("Could not open this browser's storage"));
    }));
  const done = (tx: IDBTransaction): Promise<void> =>
    new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("Could not save to this browser's storage"));
      tx.onabort = () => reject(tx.error ?? new Error("Saving to this browser's storage was cancelled"));
    });
  return {
    async loadAll() {
      const db = await open();
      const req = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
      return new Promise<StoredNode[]>((resolve, reject) => {
        req.onsuccess = () => resolve(req.result as StoredNode[]);
        req.onerror = () => reject(req.error);
      });
    },
    async apply(put, remove) {
      const db = await open();
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      for (const n of put) store.put(n);
      for (const id of remove) store.delete(id);
      await done(tx);
    },
  };
}

/**
 * Files kept inside this browser, so the app works with no account at all ("Local only"). It is the same tree the
 * memory provider models, saved after every change. The data lives only on this device and browser profile: clearing
 * site data deletes it, so the app also offers an export.
 */
export class BrowserProvider extends MemoryProvider {
  override readonly kind = "browser" as const;
  override readonly label = "this device";
  override readonly auth: StorageAuth = noSignIn({ id: "local", name: "This device" });

  private constructor(private readonly backing: NodeStorage, initial?: StoredNode[]) {
    super(initial);
  }

  static async open(backing: NodeStorage): Promise<BrowserProvider> {
    const saved = await backing.loadAll();
    const provider = new BrowserProvider(backing, saved.length ? saved : undefined);
    // A brand-new store saves its root so the next visit finds it.
    if (!saved.length) await backing.apply(provider.snapshot(), []);
    return provider;
  }

  protected override async commit(changed: StoredNode[], removed: string[]): Promise<void> {
    await this.backing.apply(changed, removed);
  }
}
