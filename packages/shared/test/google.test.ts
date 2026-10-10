import { describe, expect, it } from "vitest";
import { GOOGLE_SIMPLE_UPLOAD_LIMIT, GoogleDriveProvider, isStorageError } from "../src/index.js";
import { FakeDrive, testGoogleAuth } from "./fakeDrive.js";

const D = "google";
function setup() {
  const drive = new FakeDrive();
  const sleeps: number[] = [];
  const storage = new GoogleDriveProvider(testGoogleAuth, { fetch: drive.fetch as typeof fetch, sleep: async (ms) => void sleeps.push(ms), maxRetries: 3 });
  return { drive, storage, sleeps };
}

describe("Google Drive provider", () => {
  it("pages through a folder listing", async () => {
    const { drive, storage } = setup();
    drive.pageSize = 2;
    for (let i = 0; i < 5; i++) drive.add(`f${i}.txt`, ["root"]);
    expect((await storage.list(D, "root")).map((e) => e.name).sort()).toEqual(["f0.txt", "f1.txt", "f2.txt", "f3.txt", "f4.txt"]);
  });

  it("finds names containing quotes and backslashes", async () => {
    const { drive, storage } = setup();
    drive.add("Bob's \\ receipt.pdf", ["root"]);
    expect((await storage.find(D, "root", "Bob's \\ receipt.pdf"))?.name).toBe("Bob's \\ receipt.pdf");
  });

  it("treats the oldest of two same-named files as the file, and a losing create-only as 'exists'", async () => {
    const { drive, storage } = setup();
    const older = drive.add("lock.json", ["root"], "text/plain", new TextEncoder().encode("A"));
    drive.add("lock.json", ["root"], "text/plain", new TextEncoder().encode("B"));
    expect((await storage.find(D, "root", "lock.json"))?.id).toBe(older.id);
    expect((await storage.readText(D, older.id)).text).toBe("A");
  });

  it("removes its own copy when another client created the same name first (create-only race)", async () => {
    const { drive, storage } = setup();
    // The other client's file appears between our "is it there?" check and our create.
    let injected = false;
    const real = drive.fetch;
    drive.fetch = async (input, init) => {
      const res = await real(input, init);
      if (!injected && String(input).includes("uploadType=multipart") && (init?.method ?? "GET") === "POST") {
        injected = true;
        const older = drive.add("lock.json", ["root"], "text/plain", new TextEncoder().encode("theirs"));
        older.created = -5; // created before ours
      }
      return res;
    };
    const racing = new GoogleDriveProvider(testGoogleAuth, { fetch: drive.fetch as typeof fetch, sleep: async () => {} });
    const err = await racing.write(D, "root", "lock.json", "mine", { createOnly: true }).catch((e: unknown) => e);
    expect(isStorageError(err, "exists")).toBe(true);
    const remaining = [...drive.nodes.values()].filter((n) => n.name === "lock.json");
    expect(remaining).toHaveLength(1);
    expect(drive.text(remaining[0]!.id)).toBe("theirs");
  });

  it("settles on one folder when two clients create it at once", async () => {
    const { drive, storage } = setup();
    let injected = false;
    const real = drive.fetch;
    const racing = new GoogleDriveProvider(testGoogleAuth, {
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const res = await real(input, init);
        if (!injected && (init?.method ?? "GET") === "POST" && String(input).includes("/drive/v3/files?")) {
          injected = true;
          drive.add("_ledger", ["root"], "application/vnd.google-apps.folder").created = -5;
        }
        return res;
      }) as typeof fetch,
      sleep: async () => {},
    });
    const id = await racing.ensureFolder(D, "root", "_ledger");
    const folders = [...drive.nodes.values()].filter((n) => n.name === "_ledger");
    expect(folders).toHaveLength(1);
    expect(folders[0]!.id).toBe(id);
    void storage;
  });

  it("uploads large files through a resumable session in chunks", async () => {
    const { drive, storage } = setup();
    const big = new Uint8Array(GOOGLE_SIMPLE_UPLOAD_LIMIT + 1234).map((_, i) => i % 251);
    const stored = await storage.write(D, "root", "big.bin", big);
    expect(stored.size).toBe(big.byteLength);
    const got = drive.nodes.get(stored.id)!.content;
    expect(got.byteLength).toBe(big.byteLength);
    expect(got.every((b, i) => b === big[i])).toBe(true);
    expect(drive.requests.some((r) => r.url.includes("uploadType=resumable"))).toBe(true);
    // Replacing it again goes through the same path and keeps the id.
    const again = await storage.write(D, "root", "big.bin", big);
    expect(again.id).toBe(stored.id);
  });

  it("retries rate limits and server errors, then succeeds", async () => {
    const { drive, storage, sleeps } = setup();
    drive.add("a.txt", ["root"], "text/plain", new TextEncoder().encode("x"));
    drive.failNext = [{ status: 429 }, { status: 403, body: JSON.stringify({ error: { errors: [{ reason: "userRateLimitExceeded" }] } }) }, { status: 503 }];
    expect((await storage.find(D, "root", "a.txt"))?.name).toBe("a.txt");
    expect(sleeps).toHaveLength(3);
  });

  it("does not retry a real permission failure", async () => {
    const { drive, storage } = setup();
    drive.failNext = [{ status: 403, body: JSON.stringify({ error: { message: "no", errors: [{ reason: "forbidden" }] } }) }];
    const err = await storage.list(D, "root").catch((e: unknown) => e);
    expect(isStorageError(err, "forbidden")).toBe(true);
  });

  it("asks for a fresh token once after a 401", async () => {
    const drive = new FakeDrive();
    drive.failNext = [{ status: 401 }];
    const asked: boolean[] = [];
    const storage = new GoogleDriveProvider({ ...testGoogleAuth, getToken: async (refresh?: boolean) => (asked.push(Boolean(refresh)), "t") }, { fetch: drive.fetch as typeof fetch, sleep: async () => {} });
    await storage.list(D, "root");
    expect(asked).toEqual([false, true]);
  });

  it("follows shortcuts to folders and lists folders shared with the person", async () => {
    const { drive, storage } = setup();
    const target = drive.add("Family", ["elsewhere"], "application/vnd.google-apps.folder");
    target.sharedWithMe = true;
    const stub = drive.add("Family (shortcut)", ["root"], "application/vnd.google-apps.shortcut");
    stub.shortcut = { targetId: target.id, targetMimeType: "application/vnd.google-apps.folder" };
    drive.add("note.txt", ["root"]);
    expect(await storage.subfolders({ driveId: D, itemId: "root", name: "My Drive" })).toEqual([{ driveId: D, itemId: target.id, name: "Family (shortcut)" }]);
    expect(await storage.sharedWithMe()).toEqual([{ driveId: D, itemId: target.id, name: "Family" }]);
  });

  it("opens folders from links of the usual shapes, and refuses files", async () => {
    const { drive, storage } = setup();
    const folder = drive.add("Receipts", ["root"], "application/vnd.google-apps.folder");
    const file = drive.add("a.pdf", ["root"], "application/pdf");
    for (const link of [`https://drive.google.com/drive/folders/${folder.id}?usp=sharing`, `https://drive.google.com/open?id=${folder.id}`, `https://drive.google.com/drive/u/0/folders/${folder.id}`]) {
      expect((await storage.folderFromLink!(link)).itemId).toBe(folder.id);
    }
    await expect(storage.folderFromLink!(`https://drive.google.com/file/d/${file.id}/view`)).rejects.toThrow(/file/);
    await expect(storage.folderFromLink!("https://example.com/nothing")).rejects.toThrow(/Google Drive folder link/);
  });

  it("invites as an editor and validates the address", async () => {
    const { drive, storage } = setup();
    const folder = drive.add("Receipts", ["root"], "application/vnd.google-apps.folder");
    await storage.invite!({ driveId: D, itemId: folder.id, name: "Receipts" }, " a@b.com ", "Hi");
    expect(drive.permissions[0]).toMatchObject({ fileId: folder.id, body: { type: "user", role: "writer", emailAddress: "a@b.com" }, query: { sendNotificationEmail: "true", emailMessage: "Hi" } });
    await expect(storage.invite!({ driveId: D, itemId: folder.id, name: "R" }, "nope")).rejects.toThrow();
  });

  it("keeps its settings in the app data folder", async () => {
    const { storage } = setup();
    const app = await storage.appFolder();
    expect(app).toEqual({ driveId: D, id: "appDataFolder" });
    await storage.write(app!.driveId, app!.id, "pointer.json", "{}");
    expect((await storage.find(app!.driveId, app!.id, "pointer.json"))?.name).toBe("pointer.json");
  });

  it("reports an unavailable app data folder as none", async () => {
    const { drive, storage } = setup();
    drive.nodes.delete("appDataFolder");
    expect(await storage.appFolder()).toBeUndefined();
  });
});
