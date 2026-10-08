import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configureGraph, createSubfolder, inviteToFolder, loadRemotePointer, saveRemotePointer, setTokenProvider, sharedFolders, subfolders } from "../src/index.js";

const responses: Record<string, unknown> = {
  "/me/drive/sharedWithMe?$top=200": {
    value: [
      { id: "x", name: "Zeta", remoteItem: { id: "r1", name: "Zeta", folder: {}, parentReference: { driveId: "other" } } },
      { id: "y", name: "report.pdf", remoteItem: { id: "r2", name: "report.pdf", parentReference: { driveId: "other" } } },
      { id: "z", name: "Alpha", remoteItem: { id: "r3", name: "Alpha", folder: {}, parentReference: { driveId: "other2" } } },
    ],
  },
  "/drives/d/items/f/children?$select=id,name,folder,remoteItem&$top=200": {
    value: [
      { id: "b", name: "B", folder: {} },
      { id: "file", name: "a.txt" },
      { id: "a", name: "A", folder: {} },
      { id: "stub", name: "Shortcut", remoteItem: { id: "real", name: "Orig", folder: {}, parentReference: { driveId: "theirs" } } },
      { id: "stub2", name: "File shortcut", remoteItem: { id: "r2", name: "x.pdf", parentReference: { driveId: "theirs" } } },
    ],
  },
};

beforeEach(() => {
  setTokenProvider(async () => "token");
  configureGraph({
    fetch: (async (url: string) => {
      const path = String(url).replace("https://graph.microsoft.com/v1.0", "");
      const body = responses[path];
      return new Response(JSON.stringify(body ?? {}), { status: body ? 200 : 404 });
    }) as typeof fetch,
  });
});
afterEach(() => configureGraph());

describe("folder browsing", () => {
  it("lists only shared folders, addressed on their own drive, sorted by name", async () => {
    expect(await sharedFolders()).toEqual([
      { driveId: "other2", itemId: "r3", name: "Alpha" },
      { driveId: "other", itemId: "r1", name: "Zeta" },
    ]);
  });

  it("lists only subfolders, resolving shortcuts to the real folder, sorted by name", async () => {
    expect((await subfolders({ driveId: "d", itemId: "f", name: "F" })).map((f) => [f.name, f.driveId, f.itemId])).toEqual([["A", "d", "a"], ["B", "d", "b"], ["Shortcut", "theirs", "real"]]);
  });

  it("rejects folder names OneDrive cannot store", async () => {
    await expect(createSubfolder({ driveId: "d", itemId: "f", name: "F" }, "a/b")).rejects.toThrow();
    await expect(createSubfolder({ driveId: "d", itemId: "f", name: "F" }, "  ")).rejects.toThrow();
  });
});

describe("sharing and pointer", () => {
  it("invites with write access and required sign-in", async () => {
    let sent: { url: string; body: any } | undefined;
    configureGraph({ fetch: (async (url: string, init: RequestInit) => { sent = { url: String(url), body: JSON.parse(String(init.body)) }; return new Response("{}", { status: 200 }); }) as typeof fetch });
    await inviteToFolder({ driveId: "d", itemId: "f", name: "F" }, " a@b.com ");
    expect(sent!.url).toContain("/drives/d/items/f/invite");
    expect(sent!.body).toMatchObject({ recipients: [{ email: "a@b.com" }], requireSignIn: true, roles: ["write"] });
    await expect(inviteToFolder({ driveId: "d", itemId: "f", name: "F" }, "nope")).rejects.toThrow();
  });

  it("reports no pointer when the app folder is unavailable", async () => {
    configureGraph({ fetch: (async () => new Response("{}", { status: 404 })) as typeof fetch });
    expect(await loadRemotePointer()).toBeUndefined();
    expect(await saveRemotePointer({ driveId: "d", rootId: "r" })).toBe(false);
  });
});
