import { constants } from "node:fs";
import { mkdir, open, readFile, readdir, rename as fsRename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import os from "node:os";
import { StorageError, bodyBytes, noSignIn, type AppFolder, type FileBody, type FolderEntry, type StorageAuth, type StorageEntry, type StorageProvider, type StoredFile, type WriteOptions } from "@step-up/shared";

/** The one "drive" a local provider has. */
export const LOCAL_DRIVE = "local";
/** Where this provider keeps its private settings, inside the root. */
const APP_DIR = ".stepup";

/**
 * A folder on this computer. An item's id is its path relative to the root ("" is the root itself), so renaming a file
 * changes its id (`rename` returns the new one). A version token is the file's modified time and size; `ifMatch` and
 * `createOnly` are enforced, though a second process writing in the same instant could slip between the check and the
 * write (there is no server to arbitrate), which is fine for one person on one computer.
 */
export class LocalFsProvider implements StorageProvider {
  readonly kind = "local-folder" as const;
  readonly label = "this computer";
  readonly auth: StorageAuth = noSignIn({ id: "local", name: os.userInfo().username });
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  /** Absolute path of an item, refusing anything that would leave the root. */
  private abs(itemId: string): string {
    const full = path.resolve(this.root, ...itemId.split("/").filter(Boolean));
    if (full !== this.root && !full.startsWith(this.root + path.sep)) throw new StorageError("forbidden", `"${itemId}" is outside the storage folder`);
    return full;
  }

  private rel(full: string): string {
    return path.relative(this.root, full).split(path.sep).join("/");
  }

  private childId(parentId: string, name: string): string {
    if (!name || name === "." || name === ".." || /[\\/]/.test(name)) throw new StorageError("other", `"${name}" is not a valid name`);
    return parentId ? `${parentId}/${name}` : name;
  }

  private async entryFor(full: string): Promise<StorageEntry> {
    let s;
    try {
      s = await stat(full, { bigint: true });
    } catch (err) {
      throw translate(err, full);
    }
    return {
      id: this.rel(full),
      name: full === this.root ? path.basename(this.root) : path.basename(full),
      isFolder: s.isDirectory(),
      size: Number(s.size),
      eTag: `${s.mtimeNs}-${s.size}`,
      webUrl: pathToFileURL(full).href,
      modified: new Date(Number(s.mtimeNs / 1_000_000n)).toISOString(),
    };
  }

  async list(_driveId: string, folderId: string): Promise<StorageEntry[]> {
    const dir = this.abs(folderId);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (err) {
      throw translate(err, dir);
    }
    return Promise.all(names.filter((n) => !n.startsWith(".")).map((n) => this.entryFor(path.join(dir, n))));
  }

  async find(_driveId: string, parentId: string, name: string): Promise<StorageEntry | undefined> {
    try {
      return await this.entryFor(this.abs(this.childId(parentId, name)));
    } catch (err) {
      if (err instanceof StorageError && err.kind === "not-found") return undefined;
      throw err;
    }
  }

  stat(_driveId: string, itemId: string): Promise<StorageEntry> {
    return this.entryFor(this.abs(itemId));
  }

  async parentOf(_driveId: string, itemId: string): Promise<string> {
    if (!itemId) throw new Error("Item has no parent folder");
    return this.rel(path.dirname(this.abs(itemId)));
  }

  async readText(_driveId: string, itemId: string): Promise<{ text: string; eTag?: string }> {
    const full = this.abs(itemId);
    try {
      const eTag = (await this.entryFor(full)).eTag;
      return { text: await readFile(full, "utf-8"), eTag };
    } catch (err) {
      throw translate(err, full);
    }
  }

  async download(_driveId: string, itemId: string): Promise<Blob> {
    const full = this.abs(itemId);
    try {
      return new Blob([await readFile(full)]);
    } catch (err) {
      throw translate(err, full);
    }
  }

  async ensureFolder(_driveId: string, parentId: string, name: string): Promise<string> {
    const id = this.childId(parentId, name);
    const full = this.abs(id);
    const existing = await this.find(LOCAL_DRIVE, parentId, name);
    if (existing && !existing.isFolder) throw new Error(`"${name}" exists but is not a folder`);
    await mkdir(full, { recursive: true });
    return id;
  }

  async write(_driveId: string, parentId: string, name: string, body: FileBody, options: WriteOptions = {}): Promise<StoredFile> {
    const id = this.childId(parentId, name);
    const full = this.abs(id);
    const bytes = await bodyBytes(body);
    await this.stat(LOCAL_DRIVE, parentId); // a missing parent folder is not-found, not a created path
    try {
      if (options.createOnly) {
        const handle = await open(full, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
        try {
          await handle.writeFile(bytes);
        } finally {
          await handle.close();
        }
      } else {
        if (options.ifMatch) {
          const current = await this.find(LOCAL_DRIVE, parentId, name);
          if (!current || current.eTag !== options.ifMatch) throw new StorageError("changed", `"${name}" changed since it was read`);
        }
        // Whole-file replace: write beside it, then move into place, so a crash never leaves half a log.
        const tmp = path.join(path.dirname(full), `.${name}.${process.pid}.tmp`);
        await writeFile(tmp, bytes);
        await fsRename(tmp, full);
      }
    } catch (err) {
      throw translate(err, full);
    }
    const e = await this.entryFor(full);
    return { id: e.id, name: e.name, eTag: e.eTag, size: e.size, webUrl: e.webUrl };
  }

  async rename(_driveId: string, itemId: string, name: string): Promise<string> {
    const from = this.abs(itemId);
    const nextId = this.childId(this.rel(path.dirname(from)), name);
    const to = this.abs(nextId);
    if (to !== from && (await this.find(LOCAL_DRIVE, this.rel(path.dirname(from)), name))) throw new StorageError("exists", `"${name}" already exists`);
    try {
      await fsRename(from, to);
    } catch (err) {
      throw translate(err, from);
    }
    return nextId;
  }

  async remove(_driveId: string, itemId: string, ifMatch?: string): Promise<void> {
    const full = this.abs(itemId);
    if (ifMatch) {
      const current = await this.entryFor(full);
      if (current.eTag !== ifMatch) throw new StorageError("changed", `"${current.name}" changed since it was read`);
    }
    try {
      await rm(full, { recursive: true });
    } catch (err) {
      throw translate(err, full);
    }
  }

  async appFolder(): Promise<AppFolder | undefined> {
    await mkdir(this.abs(APP_DIR), { recursive: true });
    return { driveId: LOCAL_DRIVE, id: APP_DIR };
  }

  async home(): Promise<FolderEntry> {
    return { driveId: LOCAL_DRIVE, itemId: "", name: path.basename(this.root) || this.root };
  }

  async sharedWithMe(): Promise<FolderEntry[]> {
    return [];
  }

  async subfolders(folder: FolderEntry): Promise<FolderEntry[]> {
    return (await this.list(folder.driveId, folder.itemId))
      .filter((e) => e.isFolder)
      .map((e) => ({ driveId: LOCAL_DRIVE, itemId: e.id, name: e.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
}

function translate(err: unknown, where: string): Error {
  if (err instanceof StorageError) return err;
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  const name = path.basename(where);
  if (code === "ENOENT" || code === "ENOTDIR") return new StorageError("not-found", `"${name}" was not found`);
  if (code === "EEXIST") return new StorageError("exists", `"${name}" already exists`);
  if (code === "EACCES" || code === "EPERM") return new StorageError("forbidden", `Not allowed to use "${name}"`);
  if (code === "EBUSY") return new StorageError("locked", `"${name}" is in use`);
  return err instanceof Error ? err : new Error(String(err));
}
