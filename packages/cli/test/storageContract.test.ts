import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BrowserProvider,
  GoogleDriveProvider,
  MemoryNodeStorage,
  MemoryProvider,
  OneDriveProvider,
  StorageError,
  configureGraph,
  createSubfolder,
  isStorageError,
  setTokenProvider,
  type StorageProvider,
} from "@step-up/shared";
import { FakeDrive, testGoogleAuth } from "../../shared/test/fakeDrive.js";
import { FakeGraph, testAuth } from "../../shared/test/fakeGraph.js";
import { LOCAL_DRIVE, LocalFsProvider } from "../src/storage/localFs.js";

interface Harness {
  storage: StorageProvider;
  driveId: string;
  /** An empty folder to work in. */
  rootId: string;
  cleanup?: () => Promise<void>;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  configureGraph();
  while (cleanups.length) await cleanups.pop()!();
});

const makers: Record<string, () => Promise<Harness>> = {
  memory: async () => {
    const storage = new MemoryProvider();
    return { storage, driveId: "memory", rootId: storage.rootId };
  },
  "browser storage": async () => {
    const storage = await BrowserProvider.open(new MemoryNodeStorage());
    return { storage, driveId: "memory", rootId: storage.rootId };
  },
  "local folder": async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "stepup-storage-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    return { storage: new LocalFsProvider(dir), driveId: LOCAL_DRIVE, rootId: "" };
  },
  "google drive (fake Drive)": async () => {
    const drive = new FakeDrive();
    const storage = new GoogleDriveProvider(testGoogleAuth, { fetch: drive.fetch as typeof fetch, sleep: async () => {} });
    return { storage, driveId: "google", rootId: "root" };
  },
  "onedrive (fake Graph)": async () => {
    const g = new FakeGraph();
    setTokenProvider(async () => "token");
    configureGraph({ fetch: g.fetch as typeof fetch, sleep: async () => {} });
    return { storage: new OneDriveProvider(testAuth), driveId: "d", rootId: g.rootId };
  },
};

describe.each(Object.entries(makers))("StorageProvider contract: %s", (_name, make) => {
  it("writes, reads back, and reports the file as stored", async () => {
    const { storage, driveId, rootId } = await make();
    const stored = await storage.write(driveId, rootId, "a.txt", "hello");
    expect(stored.name).toBe("a.txt");
    expect(stored.size).toBe(5);
    expect(stored.eTag).toBeTruthy();
    const read = await storage.readText(driveId, stored.id);
    expect(read.text).toBe("hello");
    expect(read.eTag).toBe(stored.eTag);
    expect(await (await storage.download(driveId, stored.id)).text()).toBe("hello");
  });

  it("stores binary bodies byte for byte", async () => {
    const { storage, driveId, rootId } = await make();
    const bytes = new Uint8Array([0, 1, 2, 254, 255]);
    const stored = await storage.write(driveId, rootId, "b.bin", bytes);
    expect(new Uint8Array(await (await storage.download(driveId, stored.id)).arrayBuffer())).toEqual(bytes);
    const viaBlob = await storage.write(driveId, rootId, "c.bin", new Blob([bytes]));
    expect(new Uint8Array(await (await storage.download(driveId, viaBlob.id)).arrayBuffer())).toEqual(bytes);
  });

  it("replaces by default and changes the version", async () => {
    const { storage, driveId, rootId } = await make();
    const one = await storage.write(driveId, rootId, "a.txt", "one");
    const two = await storage.write(driveId, rootId, "a.txt", "two!");
    expect(two.eTag).not.toBe(one.eTag);
    expect((await storage.readText(driveId, two.id)).text).toBe("two!");
    expect((await storage.list(driveId, rootId)).filter((e) => e.name === "a.txt")).toHaveLength(1);
  });

  it("createOnly refuses an existing name with kind 'exists' and leaves it alone", async () => {
    const { storage, driveId, rootId } = await make();
    await storage.write(driveId, rootId, "a.txt", "first", { createOnly: true });
    const err = await storage.write(driveId, rootId, "a.txt", "second", { createOnly: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StorageError);
    expect(isStorageError(err, "exists")).toBe(true);
    const found = await storage.find(driveId, rootId, "a.txt");
    expect((await storage.readText(driveId, found!.id)).text).toBe("first");
  });

  it("ifMatch accepts the current version and refuses a stale one with kind 'changed'", async () => {
    const { storage, driveId, rootId } = await make();
    const v1 = await storage.write(driveId, rootId, "a.txt", "1");
    const v2 = await storage.write(driveId, rootId, "a.txt", "22", { ifMatch: v1.eTag });
    const err = await storage.write(driveId, rootId, "a.txt", "333", { ifMatch: v1.eTag }).catch((e: unknown) => e);
    expect(isStorageError(err, "changed")).toBe(true);
    expect((await storage.readText(driveId, v2.id)).text).toBe("22");
  });

  it("finds children by name, and reports a missing one as undefined", async () => {
    const { storage, driveId, rootId } = await make();
    await storage.write(driveId, rootId, "a.txt", "x");
    expect((await storage.find(driveId, rootId, "a.txt"))?.isFolder).toBe(false);
    expect(await storage.find(driveId, rootId, "nope.txt")).toBeUndefined();
  });

  it("names with spaces, parentheses and unicode round-trip", async () => {
    const { storage, driveId, rootId } = await make();
    const name = "Café receipt (2) – 07 28 2026.pdf";
    await storage.write(driveId, rootId, name, "x");
    expect((await storage.find(driveId, rootId, name))?.name).toBe(name);
    expect((await storage.list(driveId, rootId)).map((e) => e.name)).toContain(name);
  });

  it("ensureFolder creates once and returns the same folder after", async () => {
    const { storage, driveId, rootId } = await make();
    const a = await storage.ensureFolder(driveId, rootId, "_ledger");
    const b = await storage.ensureFolder(driveId, rootId, "_ledger");
    expect(b).toBe(a);
    expect((await storage.find(driveId, rootId, "_ledger"))?.isFolder).toBe(true);
    await storage.write(driveId, rootId, "file", "x");
    await expect(storage.ensureFolder(driveId, rootId, "file")).rejects.toThrow(/not a folder/);
  });

  it("lists a folder's own entries with folders marked, and parentOf walks back up", async () => {
    const { storage, driveId, rootId } = await make();
    const sub = await storage.ensureFolder(driveId, rootId, "sub");
    const inner = await storage.write(driveId, sub, "in.txt", "x");
    await storage.write(driveId, rootId, "top.txt", "x");
    const top = await storage.list(driveId, rootId);
    expect(top.map((e) => [e.name, e.isFolder]).sort()).toEqual([["sub", true], ["top.txt", false]]);
    expect((await storage.list(driveId, sub)).map((e) => e.name)).toEqual(["in.txt"]);
    expect(await storage.parentOf(driveId, inner.id)).toBe(sub);
    expect((await storage.stat(driveId, inner.id)).name).toBe("in.txt");
  });

  it("renames in place, refuses a taken name, and keeps the content", async () => {
    const { storage, driveId, rootId } = await make();
    const file = await storage.write(driveId, rootId, "old.txt", "keep");
    await storage.write(driveId, rootId, "taken.txt", "other");
    const id = await storage.rename(driveId, file.id, "new.txt");
    expect(await storage.find(driveId, rootId, "old.txt")).toBeUndefined();
    expect((await storage.readText(driveId, id)).text).toBe("keep");
    const err = await storage.rename(driveId, id, "taken.txt").catch((e: unknown) => e);
    expect(isStorageError(err, "exists")).toBe(true);
  });

  it("removes, honours ifMatch, and reports a missing item as 'not-found'", async () => {
    const { storage, driveId, rootId } = await make();
    const v1 = await storage.write(driveId, rootId, "a.txt", "1");
    const v2 = await storage.write(driveId, rootId, "a.txt", "2");
    const stale = await storage.remove(driveId, v2.id, v1.eTag).catch((e: unknown) => e);
    expect(isStorageError(stale, "changed")).toBe(true);
    await storage.remove(driveId, v2.id, v2.eTag);
    expect(await storage.find(driveId, rootId, "a.txt")).toBeUndefined();
    const gone = await storage.readText(driveId, v2.id).catch((e: unknown) => e);
    expect(isStorageError(gone, "not-found")).toBe(true);
  });

  it("validates folder names the same way everywhere", async () => {
    const { storage, driveId, rootId } = await make();
    const parent = { driveId, itemId: rootId, name: "root" };
    await expect(createSubfolder(storage, parent, "a/b")).rejects.toThrow();
    await expect(createSubfolder(storage, parent, "  ")).rejects.toThrow();
    const made = await createSubfolder(storage, parent, " Receipts ");
    expect(made.name).toBe("Receipts");
    expect((await storage.subfolders(parent)).map((f) => f.name)).toEqual(["Receipts"]);
  });
});

describe("browser storage persistence", () => {
  it("a new provider on the same backing sees what an earlier one saved, including renames and removals", async () => {
    const backing = new MemoryNodeStorage();
    const first = await BrowserProvider.open(backing);
    const drive = "memory";
    const folder = await first.ensureFolder(drive, first.rootId, "2026-2027");
    const keep = await first.write(drive, folder, "a.txt", "kept");
    const gone = await first.write(drive, folder, "b.txt", "dropped");
    await first.rename(drive, keep.id, "renamed.txt");
    await first.remove(drive, gone.id);

    const second = await BrowserProvider.open(backing);
    expect(second.rootId).toBe(first.rootId);
    expect((await second.list(drive, folder)).map((e) => e.name)).toEqual(["renamed.txt"]);
    expect((await second.readText(drive, keep.id)).text).toBe("kept");
    // New ids never collide with saved ones.
    const fresh = await second.write(drive, folder, "c.txt", "new");
    expect([keep.id, gone.id]).not.toContain(fresh.id);
  });
});

describe("local folder specifics", () => {
  it("refuses to leave its root", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "stepup-storage-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const storage = new LocalFsProvider(dir);
    await expect(storage.readText(LOCAL_DRIVE, "../etc/passwd")).rejects.toMatchObject({ kind: "forbidden" });
    await expect(storage.write(LOCAL_DRIVE, "", "../escape.txt", "x")).rejects.toThrow();
  });

  it("writes ordinary files a person can see, and hides its own settings folder from listings", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "stepup-storage-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const storage = new LocalFsProvider(dir);
    await storage.write(LOCAL_DRIVE, "", "a.txt", "plain");
    expect(await readFile(path.join(dir, "a.txt"), "utf-8")).toBe("plain");
    const app = await storage.appFolder();
    await storage.write(app!.driveId, app!.id, "pointer.json", "{}");
    expect((await storage.list(LOCAL_DRIVE, "")).map((e) => e.name)).toEqual(["a.txt"]);
  });
});
