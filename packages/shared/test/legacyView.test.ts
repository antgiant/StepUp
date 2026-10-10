import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LEGACY_CHOICES_FILE,
  LegacyLedger,
  ReadOnlyYearError,
  configureGraph,
  deriveLegacyYear,
  detectLayout,
  filesByIdPrefix,
  filesByNameHints,
  gardinerRow,
  readReceiptFiles,
  listLooseFiles,
  listYears,
  readReceiptChoices,
  setTokenProvider,
  writeReceiptChoices,
  type LegacyInput,
  type LegacyRow,
} from "../src/index.js";
import { FakeGraph } from "./fakeGraph.js";

const row = (id: number, extra: Record<string, unknown>, docs: string[] = ["receipt.pdf"]): LegacyRow => ({
  values: {
    ID: id, Child: "Child A", Item: `Item ${id}`, Date: 45901, Vendor: "Shop", "Invoice #": "INV-1", Category: "Curriculum - Workbooks",
    Quantity: 1, Amount: 20, "Tax, Shipping, etc.": 1.4, "Payment Method": "Card X (Sep)", Status: "Unfiled (Ready to Submit)",
    ...extra,
  },
  docFiles: docs,
});

const base = (rows: LegacyRow[]): Omit<LegacyInput, "mode" | "receiptChoices"> => ({
  yearLabel: "2025-2026",
  rows,
  children: [{ name: "Child A", scholarship: "FES-UA", capDollars: 100 }],
  paymentMethods: [{ label: "Card X (Sep)", file: "statement-sep.pdf" }],
  files: ["receipt.pdf", "statement-sep.pdf", "a.pdf", "b.pdf"].map((name, n) => ({ name, id: `o${n}`, size: 1 })),
  categories: [{ path: "Curriculum - Workbooks", eligible: ["FES-UA"] }],
});

describe("a year viewed from Excel", () => {
  it("shows the sheet's status exactly as written, even where the new rules would say otherwise", () => {
    const { result } = deriveLegacyYear(base([row(1, { Status: "Unfiled (Missing Things)", "Benefit Message": "" }), row(2, { Status: "Paid", "Reimbursed Amount": 21.4 })]), {});
    expect(result.state.items["legacy-1"]!.statusOverride).toBe("Unfiled (Missing Things)");
    expect(result.state.items["legacy-2"]).toMatchObject({ statusOverride: "Paid", stepUpStatus: "Paid", paidCents: 2140 });
  });

  it("never guesses an unclear receipt: every candidate is additional documentation until a person picks", () => {
    const rows = [row(1, {}, ["a.pdf", "b.pdf"]), row(2, {}, ["b.pdf", "a.pdf"])];
    const year = deriveLegacyYear(base(rows), {});
    expect(year.unclear).toHaveLength(1);
    expect(year.unclear[0]).toMatchObject({ candidates: ["a.pdf", "b.pdf"], key: "a.pdf b.pdf" });
    const purchases = Object.values(year.result.state.purchases);
    expect(purchases).toHaveLength(1); // both rows share the same unclear files, so one purchase
    expect(purchases[0]!.receiptDocumentId).toBeUndefined();
    const names = Object.values(year.result.state.additionalDocs).map((a) => year.result.state.documents[a.documentId!]?.filename).sort();
    expect(names).toEqual(["a.pdf", "b.pdf"]);
  });

  it("uses a remembered pick, and the pick survives when the key is built from the same files", () => {
    const year = deriveLegacyYear(base([row(1, {}, ["a.pdf", "b.pdf"])]), { "a.pdf b.pdf": "b.pdf" });
    expect(year.unclear).toEqual([]);
    const p = Object.values(year.result.state.purchases)[0]!;
    expect(year.result.state.documents[p.receiptDocumentId!]!.filename).toBe("b.pdf");
  });

  it("keeps statement files as documents so proof of payment can open them", () => {
    const { result } = deriveLegacyYear(base([row(1, { "Payment File": "statement-sep.pdf" })]), {});
    const statements = Object.values(result.state.documents).filter((d) => d.contentKind === "statement");
    expect(statements.map((d) => d.filename)).toEqual(["statement-sep.pdf"]);
  });

  it("refuses every kind of change on its ledger, and replace shows a newer reading", async () => {
    const first = deriveLegacyYear(base([row(1, {})]), {});
    const ledger = new LegacyLedger(first.result.events);
    expect(Object.keys(ledger.state.items)).toEqual(["legacy-1"]);
    expect(() => ledger.set("item", "legacy-1", { description: "x" })).toThrow(ReadOnlyYearError);
    expect(() => ledger.delete("item", "legacy-1")).toThrow(ReadOnlyYearError);
    expect(() => ledger.restore("item", "legacy-1")).toThrow(ReadOnlyYearError);
    await expect(ledger.store.appendOwn([])).rejects.toThrow(ReadOnlyYearError);
    ledger.replace(deriveLegacyYear(base([row(1, {}), row(2, {})]), {}).result.events);
    expect(Object.keys(ledger.state.items).sort()).toEqual(["legacy-1", "legacy-2"]);
  });
});

describe("the receipt choices file beside the workbook", () => {
  let g: FakeGraph;
  beforeEach(() => {
    g = new FakeGraph();
    setTokenProvider(async () => "t");
    configureGraph({ fetch: g.fetch as typeof fetch, sleep: async () => {}, maxRetries: 1 });
  });
  afterEach(() => configureGraph());

  it("is written into the year folder, read back, and never makes the year a ledger year or a receipt", async () => {
    const root = g.add(g.rootId, "Docs", true).id;
    const year = g.add(root, "2025-2026", true);
    g.add(year.id, "2025-2026 - FES UA Tracking Spreadsheet.xlsx", false);
    g.add(year.id, "receipt.pdf", false);

    expect(await readReceiptChoices("d", year.id)).toEqual({});
    await writeReceiptChoices("d", year.id, { "a.pdf b.pdf": "b.pdf" });
    expect(g.child(year.id, LEGACY_CHOICES_FILE)).toBeDefined();
    expect(await readReceiptChoices("d", year.id)).toEqual({ "a.pdf b.pdf": "b.pdf" });

    const [info] = await listYears("d", root);
    expect(info).toMatchObject({ kind: "legacy-excel", looseFileCount: 2 }); // the workbook and the receipt, not the choices file
    expect((await listLooseFiles("d", year.id)).map((f) => f.name).sort()).toEqual(["2025-2026 - FES UA Tracking Spreadsheet.xlsx", "receipt.pdf"]);
  });

  it("treats an unreadable file as no answers", async () => {
    const year = g.add(g.rootId, "2025-2026", true);
    g.add(year.id, LEGACY_CHOICES_FILE, false, new TextEncoder().encode("not json"));
    expect(await readReceiptChoices("d", year.id)).toEqual({});
  });
});

describe("older workbook layouts", () => {
  it("tells the three layouts apart", () => {
    expect(detectLayout(["Table1", "Table2"], true)).toBe("step-up-2025");
    expect(detectLayout(["Table1", "Table2"], false)).toBe("step-up-2024");
    expect(detectLayout(["Step_Up", "Table2", "Table4"], false)).toBe("gardiner");
    expect(detectLayout(["Table1", "Step_Up"], true)).toBe("step-up-2025");
  });

  it("matches a row's files by the ID in their names, and not by a longer number that ends the same", () => {
    const files = [{ name: "7 - Hats.jpeg" }, { name: "6,7,8 - Citi August.pdf" }, { name: "17 - Other.pdf" }, { name: "70 - Other.pdf" }];
    expect(filesByIdPrefix("7", files)).toEqual(["7 - Hats.jpeg", "6,7,8 - Citi August.pdf"]);
    expect(filesByIdPrefix("", files)).toEqual([]);
  });

  it("takes a row's own numbered file as the receipt and the shared one as proof, instead of calling it unclear", () => {
    const rows = [row(7, {}, ["6,7,8 - Citi August.pdf", "7 - Hats.jpeg"])];
    const files = ["6,7,8 - Citi August.pdf", "7 - Hats.jpeg"].map((name, n) => ({ name, id: `f${n}`, size: 1 }));
    const year = deriveLegacyYear({ ...base(rows), files }, {});
    expect(year.unclear).toEqual([]);
    const p = Object.values(year.result.state.purchases)[0]!;
    expect(year.result.state.documents[p.receiptDocumentId!]!.filename).toBe("7 - Hats.jpeg");
  });

  it("links a Gardiner-year file only when its date and vendor agree and it names no other student", () => {
    const files = [
      { name: "Amazon 01 05 24 took kit (Jeslyn).pdf" },
      { name: "Amazon 01 05 24 hose (Brook).pdf" },
      { name: "Abeka 01 05 24 order.pdf" },
      { name: "EBF 01 05 2024 Jeslyn Amazon thing.docx" },
    ];
    const students = ["Jeslyn", "Brook"];
    const r = { Child: "Jeslyn", Item: "Tool kit", Date: 45296, Vendor: "Amazon", Cost: 25, Status: "Approved", "Aprvl Amnt": 20 };
    const out = gardinerRow(r, 3, files, students);
    expect(out.docFiles).toEqual(["Amazon 01 05 24 took kit (Jeslyn).pdf"]);
    expect(out.values).toMatchObject({ ID: 3, Amount: 25, "Reimbursed Amount": 20, Status: "Approved" });
    expect(filesByNameHints({ date: undefined, vendor: "Amazon", child: "Jeslyn" }, files, students)).toEqual([]);
  });

  it("keeps denial reasons and what was collected visible in the notes", () => {
    const out = gardinerRow({ Child: "Brook", Item: "x", Cost: 5, "Denial Reason": "Ticket 1", "Documentation Collected": "True: Citi", Notes: "n" }, 1, [], []);
    expect(out.values["Notes"]).toBe("n\nDenial reason: Ticket 1\nDocumentation: True: Citi");
  });
});

describe("year folders with several workbook copies", () => {
  let g: FakeGraph;
  beforeEach(() => {
    g = new FakeGraph();
    setTokenProvider(async () => "t");
    configureGraph({ fetch: g.fetch as typeof fetch, sleep: async () => {}, maxRetries: 1 });
  });
  afterEach(() => configureGraph());

  it("uses the most recently edited copy, ignoring Office lock files", async () => {
    const root = g.add(g.rootId, "Docs", true).id;
    const y = g.add(root, "2024-2025", true);
    g.add(y.id, "2024-2025 - FES UA Tracking Spreadsheet (2) 1.xlsx", false).modified = "2025-07-21T00:00:00Z";
    g.add(y.id, "2024-2025 - FES UA Tracking Spreadsheet.xlsx", false).modified = "2026-08-07T00:00:00Z";
    g.add(y.id, "2024-2025 - FES UA Tracking Spreadsheet (2).xlsx", false).modified = "2026-05-13T00:00:00Z";
    g.add(y.id, "~$2024-2025 - FES UA Tracking Spreadsheet.xlsx", false).modified = "2026-09-01T00:00:00Z";
    const g2 = g.add(root, "2023-2024", true);
    g.add(g2.id, "Home School - Gardiner Scholarship (2023-2024).xlsx", false);
    const years = await listYears("d", root);
    expect(years.find((x) => x.label === "2024-2025")).toMatchObject({ kind: "legacy-excel", workbookName: "2024-2025 - FES UA Tracking Spreadsheet.xlsx", workbookCopies: 3 });
    expect(years.find((x) => x.label === "2023-2024")).toMatchObject({ kind: "legacy-excel", workbookCopies: 1 });
  });

  it("lists receipts in sub-folders too, shallowest copy first, and skips the ledger and the choices file", async () => {
    const y = g.add(g.rootId, "2023-2024", true);
    g.add(y.id, "top.pdf", false);
    g.add(y.id, "same.pdf", false);
    const sub = g.add(y.id, "Gardiner", true);
    g.add(sub.id, "deep.pdf", false);
    g.add(sub.id, "same.pdf", false);
    g.add(g.add(sub.id, "Citi", true).id, "statement.pdf", false);
    g.add(g.add(y.id, "_ledger", true).id, "events.jsonl", false);
    g.add(y.id, LEGACY_CHOICES_FILE, false);
    const files = await readReceiptFiles({ driveId: "d", itemId: y.id, name: "", isFolder: true });
    expect(files.map((f) => f.name).sort()).toEqual(["deep.pdf", "same.pdf", "statement.pdf", "top.pdf"]);
    expect(files.find((f) => f.name === "same.pdf")!.id).toBe(g.child(y.id, "same.pdf")!.id);
  });
});
