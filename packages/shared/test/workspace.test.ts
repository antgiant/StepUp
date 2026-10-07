import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LEDGER_DIR,
  configureGraph,
  ensureLedgerFolders,
  listYears,
  newClientId,
  openLedgerFolders,
  parentOf,
  planLedgerFolders,
  setTokenProvider,
} from "../src/index.js";
import { FakeGraph } from "./fakeGraph.js";

let g: FakeGraph;
let root: string;

beforeEach(() => {
  g = new FakeGraph();
  setTokenProvider(async () => "t");
  configureGraph({ fetch: g.fetch as typeof fetch, sleep: async () => {}, maxRetries: 1 });
  root = g.add(g.rootId, "Step Up Documentation", true).id;
  const old = g.add(root, "2025-2026", true);
  g.add(old.id, "2025-2026 - FES UA Tracking Spreadsheet (1).xlsx", false);
  g.add(old.id, "1 - receipt.pdf", false);
  const next = g.add(root, "2026-2027", true);
  g.add(next.id, "loose receipt.pdf", false);
  g.add(root, "2024-2025", true); // empty year
  g.add(root, "Not a year", true);
  g.add(root, "stray.pdf", false);
});
afterEach(() => configureGraph());

describe("workspace years", () => {
  it("discovers year folders by name and classifies them", async () => {
    const years = await listYears("d", root);
    expect(years.map((y) => [y.label, y.kind, y.looseFileCount])).toEqual([
      ["2024-2025", "empty", 0],
      ["2025-2026", "legacy-excel", 2],
      ["2026-2027", "empty", 1],
    ]);
    expect(years[1]!.workbookName).toContain("Tracking");
  });

  it("plans setup without creating anything, then creates it idempotently without touching existing files", async () => {
    const next = (await listYears("d", root)).find((y) => y.label === "2026-2027")!;
    const before = g.nodes.size;
    expect(await planLedgerFolders("d", next.folderId)).toEqual([LEDGER_DIR, "_ledger/events", "_ledger/documents", "_ledger/inbox", "_ledger/reports"]);
    expect(g.nodes.size).toBe(before);
    expect(await openLedgerFolders("d", next.folderId)).toBeUndefined();

    const first = await ensureLedgerFolders("d", next.folderId);
    const second = await ensureLedgerFolders("d", next.folderId);
    expect(second).toEqual(first);
    expect(await planLedgerFolders("d", next.folderId)).toEqual([]);
    expect(await openLedgerFolders("d", next.folderId)).toEqual(first);
    expect(g.child(next.folderId, "loose receipt.pdf")).toBeDefined();

    const after = (await listYears("d", root)).find((y) => y.label === "2026-2027")!;
    expect(after).toMatchObject({ kind: "ledger", looseFileCount: 1 });
  });

  it("finds a folder's parent", async () => {
    const y = (await listYears("d", root))[0]!;
    expect(await parentOf("d", y.folderId)).toBe(root);
  });
});

describe("newClientId", () => {
  it("is filename-safe and unique enough", () => {
    const a = newClientId("web");
    expect(a).toMatch(/^web-[0-9a-f]{8}$/);
    expect(newClientId("web")).not.toBe(a);
  });
});
