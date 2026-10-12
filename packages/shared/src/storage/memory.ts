import { StorageError, noSignIn, type AppFolder, type FileBody, type FolderEntry, type StorageAuth, type StorageEntry, type StorageProvider, type StoredFile, type WriteOptions } from "./types.js";

/** One stored item, as a persistent backend keeps it. `content` is a Blob so large files are not held as bytes in memory. */
export interface StoredNode {
  id: string;
  name: string;
  parent: string | null;
  isFolder: boolean;
  content: Blob;
  version: number;
  modified: string;
}

const DRIVE = "memory";

/**
 * Files held in memory: for tests, and the base of the in-browser store. It behaves like a real provider (ids survive
 * renames, `ifMatch` and `createOnly` are enforced, a name can exist once per folder). Subclasses persist by overriding
 * `commit`, which receives everything a call changed or removed.
 */
export class MemoryProvider implements StorageProvider {
  readonly kind: StorageProvider["kind"] = "memory";
  readonly label: string = "memory";
  readonly auth: StorageAuth = noSignIn({ id: "memory", name: "Memory" });
  /** The root folder's id. */
  readonly rootId: string;
  protected readonly drive: string = DRIVE;
  private readonly nodes = new Map<string, StoredNode>();
  /** Clock for modified times (tests can pin it). */
  now: () => Date = () => new Date();

  /** `initial` is a saved tree (it must contain the root, the node with no parent); without it a new empty one is made. */
  constructor(initial?: StoredNode[]) {
    if (initial?.length) {
      let root: string | undefined;
      for (const n of initial) {
        this.nodes.set(n.id, n);
        if (n.parent === null) root = n.id;
      }
      if (!root) throw new Error("Saved storage has no root folder");
      this.rootId = root;
    } else {
      this.rootId = this.add(null, "", true).id;
    }
  }

  /** The nodes that exist now; a persistent subclass writes these once when it first creates its store. */
  protected snapshot(): StoredNode[] {
    return [...this.nodes.values()];
  }

  /** Called after every change with the nodes written and the ids removed, before the call returns. */
  protected async commit(_changed: StoredNode[], _removed: string[]): Promise<void> {}

  private add(parent: string | null, name: string, isFolder: boolean, content: Blob = new Blob()): StoredNode {
    // Random, never a counter: an id freed by a delete must not come back for a different file, because documents
    // remember their file by id.
    const node: StoredNode = { id: `m${globalThis.crypto.randomUUID()}`, name, parent, isFolder, content, version: 1, modified: this.now().toISOString() };
    this.nodes.set(node.id, node);
    return node;
  }

  private get(id: string): StoredNode {
    const n = this.nodes.get(id);
    if (!n) throw new StorageError("not-found", `No item ${id}`);
    return n;
  }

  private child(parent: string, name: string): StoredNode | undefined {
    for (const n of this.nodes.values()) if (n.parent === parent && n.name === name) return n;
    return undefined;
  }

  private entry(n: StoredNode): StorageEntry {
    return { id: n.id, name: n.name, isFolder: n.isFolder, size: n.content.size, eTag: `"${n.id}-${n.version}"`, webUrl: `${this.kind}://${n.id}`, modified: n.modified };
  }

  async list(_driveId: string, folderId: string): Promise<StorageEntry[]> {
    this.get(folderId);
    return [...this.nodes.values()].filter((n) => n.parent === folderId).map((n) => this.entry(n));
  }

  async find(_driveId: string, parentId: string, name: string): Promise<StorageEntry | undefined> {
    const n = this.child(parentId, name);
    return n ? this.entry(n) : undefined;
  }

  async stat(_driveId: string, itemId: string): Promise<StorageEntry> {
    return this.entry(this.get(itemId));
  }

  async parentOf(_driveId: string, itemId: string): Promise<string> {
    const parent = this.get(itemId).parent;
    if (!parent) throw new Error("Item has no parent folder");
    return parent;
  }

  async readText(_driveId: string, itemId: string): Promise<{ text: string; eTag?: string }> {
    const n = this.get(itemId);
    return { text: await n.content.text(), eTag: this.entry(n).eTag };
  }

  async download(_driveId: string, itemId: string): Promise<Blob> {
    return this.get(itemId).content;
  }

  async ensureFolder(_driveId: string, parentId: string, name: string): Promise<string> {
    this.get(parentId);
    const existing = this.child(parentId, name);
    if (existing) {
      if (!existing.isFolder) throw new Error(`"${name}" exists but is not a folder`);
      return existing.id;
    }
    const made = this.add(parentId, name, true);
    await this.commit([made], []);
    return made.id;
  }

  async write(_driveId: string, parentId: string, name: string, body: FileBody, options: WriteOptions = {}): Promise<StoredFile> {
    this.get(parentId);
    const existing = this.child(parentId, name);
    if (existing && options.createOnly) throw new StorageError("exists", `"${name}" already exists`);
    if (options.ifMatch && (!existing || this.entry(existing).eTag !== options.ifMatch)) throw new StorageError("changed", `"${name}" changed since it was read`);
    // A Blob is kept as given (the browser backs it with disk); bytes and text are wrapped.
    const content = body instanceof Blob ? body : new Blob([body as BlobPart]);
    const n = existing ?? this.add(parentId, name, false);
    if (existing) {
      n.version += 1;
      n.modified = this.now().toISOString();
    }
    n.content = content;
    await this.commit([n], []);
    const e = this.entry(n);
    return { id: n.id, name: n.name, eTag: e.eTag, size: e.size, webUrl: e.webUrl };
  }

  async rename(_driveId: string, itemId: string, name: string): Promise<string> {
    const n = this.get(itemId);
    const taken = n.parent !== null && this.child(n.parent, name);
    if (taken && taken.id !== n.id) throw new StorageError("exists", `"${name}" already exists`);
    n.name = name;
    await this.commit([n], []);
    return n.id;
  }

  async move(_driveId: string, itemId: string, parentId: string, name?: string): Promise<string> {
    const n = this.get(itemId);
    this.get(parentId);
    const next = name ?? n.name;
    const taken = this.child(parentId, next);
    if (taken && taken.id !== n.id) throw new StorageError("exists", `"${next}" already exists`);
    n.parent = parentId;
    n.name = next;
    await this.commit([n], []);
    return n.id;
  }

  async remove(_driveId: string, itemId: string, ifMatch?: string): Promise<void> {
    const n = this.get(itemId);
    if (ifMatch && this.entry(n).eTag !== ifMatch) throw new StorageError("changed", `"${n.name}" changed since it was read`);
    const gone: string[] = [];
    const drop = (id: string) => {
      for (const c of [...this.nodes.values()]) if (c.parent === id) drop(c.id);
      this.nodes.delete(id);
      gone.push(id);
    };
    drop(itemId);
    await this.commit([], gone);
  }

  async appFolder(): Promise<AppFolder | undefined> {
    const id = await this.ensureFolder(this.drive, this.rootId, ".app");
    return { driveId: this.drive, id };
  }

  async home(): Promise<FolderEntry> {
    return { driveId: this.drive, itemId: this.rootId, name: this.label };
  }

  async sharedWithMe(): Promise<FolderEntry[]> {
    return [];
  }

  async subfolders(folder: FolderEntry): Promise<FolderEntry[]> {
    return (await this.list(folder.driveId, folder.itemId))
      .filter((e) => e.isFolder && !e.name.startsWith("."))
      .map((e) => ({ driveId: folder.driveId, itemId: e.id, name: e.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
}
