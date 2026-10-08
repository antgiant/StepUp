import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configureGraph, createSubfolder, setTokenProvider, sharedFolders, subfolders } from "../src/index.js";

const responses: Record<string, unknown> = {
  "/me/drive/sharedWithMe?$top=200": {
    value: [
      { id: "x", name: "Zeta", remoteItem: { id: "r1", name: "Zeta", folder: {}, parentReference: { driveId: "other" } } },
      { id: "y", name: "report.pdf", remoteItem: { id: "r2", name: "report.pdf", parentReference: { driveId: "other" } } },
      { id: "z", name: "Alpha", remoteItem: { id: "r3", name: "Alpha", folder: {}, parentReference: { driveId: "other2" } } },
    ],
  },
  "/drives/d/items/f/children?$select=id,name,folder&$top=200": {
    value: [{ id: "b", name: "B", folder: {} }, { id: "file", name: "a.txt" }, { id: "a", name: "A", folder: {} }],
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

  it("lists only subfolders, sorted by name", async () => {
    expect((await subfolders({ driveId: "d", itemId: "f", name: "F" })).map((f) => f.name)).toEqual(["A", "B"]);
  });

  it("rejects folder names OneDrive cannot store", async () => {
    await expect(createSubfolder({ driveId: "d", itemId: "f", name: "F" }, "a/b")).rejects.toThrow();
    await expect(createSubfolder({ driveId: "d", itemId: "f", name: "F" }, "  ")).rejects.toThrow();
  });
});
