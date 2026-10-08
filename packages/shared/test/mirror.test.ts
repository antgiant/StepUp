import ExcelJS from "exceljs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAIN_SHEET,
  buildMirror,
  configureGraph,
  ensureFolder,
  publishMirror,
  renderMirrorXlsx,
  setTokenProvider,
  shortId,
  stateHash,
  type CategoryInfo,
  type LedgerState,
  type RulesContext,
} from "../src/index.js";
import { FakeGraph } from "./fakeGraph.js";

const categories: Record<string, CategoryInfo> = {
  books: { id: "books", path: ["Curriculum", "Workbooks"], requiresServiceDate: false, eligibleScholarships: ["FES-UA"], isActive: true },
};
const ctx: RulesContext = { category: (id) => categories[id], today: "2027-06-20" };
const opts = { generatedAt: "2026-10-07T12:00:00Z", eventCounts: { "dev-a": 4, "dev-b": 2 } };

function state(): LedgerState {
  return {
    children: {
      c1: { id: "c1", name: "Child A", scholarship: "FES-UA", capCents: 1_000_000 },
      c2: { id: "c2", name: "Child B", scholarship: "FES-UA", capCents: 500_000 },
    },
    paymentMethods: { pm1: { id: "pm1", label: "Card X" } },
    purchases: {
      p1: { id: "p1", vendor: "Shop", date: "2026-09-01", invoiceNo: "INV-1", paymentMethodId: "pm1", receiptDocumentId: "d1" },
      p2: { id: "p2", vendor: "Store", date: "2026-08-15", receiptDocumentId: "d2" },
    },
    items: {
      i1: { id: "i1", purchaseId: "p1", childId: "c1", description: "Workbook", amountCents: 2000, taxShippingCents: 140, categoryId: "books", benefitMessage: "Math.", submissionId: "s1", stepUpStatus: "Paid", paidCents: 2140, lineNumber: 1 },
      i2: { id: "i2", purchaseId: "p2", childId: "c2", description: "Notebook" },
    },
    documents: {
      d1: { id: "d1", filename: "receipt-1.pdf", webUrl: "https://onedrive.example/d1", sizeBytes: 2048, paymentEvidenceConfidence: 0.9 },
      d2: { id: "d2", filename: "receipt-2.pdf", sizeBytes: 100 },
      d3: { id: "d3", filename: "statement.pdf", webUrl: "https://onedrive.example/d3", contentKind: "statement" },
      d4: { id: "d4", filename: "orphan.pdf" },
    },
    additionalDocs: { a1: { id: "a1", ownerKind: "purchase", ownerId: "p1", documentId: "d3", kind: "payment-proof" } },
    submissions: { s1: { id: "s1", reimbursementId: "R-100", purchaseId: "p1", childId: "c1", submittedAt: "2026-09-10" } },
    settings: { year: { id: "year", year: "2026-2027", submissionDeadline: "2027-06-30" } },
    categories: {},
  };
}

describe("buildMirror", () => {
  const model = buildMirror(state(), ctx, opts);
  const main = model.sheets.find((s) => s.name === MAIN_SHEET)!;
  const col = (name: string) => main.columns.findIndex((c) => c.header === name);

  it("has the expected sheets, with the main sheet named like the old workbook", () => {
    expect(model.sheets.map((s) => s.name)).toEqual([MAIN_SHEET, "Summary", "Needs Attention", "Documents", "Info"]);
  });

  it("orders rows by purchase date and fills the familiar columns", () => {
    expect(main.rows.map((r) => r[col("Item")]?.v)).toEqual(["Notebook", "Workbook"]);
    const r = main.rows[1]!;
    expect(r[col("ID")]?.v).toBe(shortId("i1"));
    expect(r[col("Child")]?.v).toBe("Child A");
    expect(r[col("Category")]?.v).toBe("Curriculum - Workbooks");
    expect(r[col("Reim. $")]?.v).toBe(21.4);
    expect(r[col("Status")]?.v).toBe("Paid");
    expect(r[col("Reimbursement ID")]?.v).toBe("R-100");
    expect(r[col("Payment Method")]?.v).toBe("Card X");
  });

  it("shows the receipt and additional documentation as filenames with hyperlinks", () => {
    const r = main.rows[1]!;
    expect(r[col("Receipt")]).toMatchObject({ v: "receipt-1.pdf", link: "https://onedrive.example/d1" });
    expect(r[col("Additional Documentation 1")]).toMatchObject({ v: "statement.pdf", link: "https://onedrive.example/d3" });
    expect(r[col("Documentation Count")]?.v).toBe(2);
    expect(main.rows[0]![col("Receipt")]).toEqual({ v: "receipt-2.pdf" });
  });

  it("lists blocked unfiled items with their reasons on Needs Attention", () => {
    const needs = model.sheets.find((s) => s.name === "Needs Attention")!;
    expect(needs.rows).toHaveLength(1);
    expect(needs.rows[0]![2]?.v).toBe("Notebook");
    expect(String(needs.rows[0]![5]?.v)).toContain("Choose a category");
  });

  it("summarizes budgets and the deadline countdown", () => {
    const summary = model.sheets.find((s) => s.name === "Summary")!;
    const total = summary.rows.find((r) => r[0]?.v === "Total")!;
    expect(total[1]?.v).toBe(15_000); // cap in dollars
    expect(total[2]?.v).toBe(21.4); // paid
    expect(summary.rows.find((r) => r[0]?.v === "Days remaining")![1]?.v).toBe(10);
  });

  it("flags unused documents and counts usage", () => {
    const docs = model.sheets.find((s) => s.name === "Documents")!;
    const orphan = docs.rows.find((r) => r[0]?.v === "orphan.pdf")!;
    expect(orphan[6]?.v).toBe("YES");
    expect(docs.rows.find((r) => r[0]?.v === "receipt-1.pdf")![4]?.v).toBe(1);
  });

  it("records provenance on the Info sheet and has a stable hash that changes with the data", () => {
    const info = model.sheets.find((s) => s.name === "Info")!;
    const keys = info.rows.map((r) => r[0]?.v);
    expect(keys).toEqual(expect.arrayContaining(["Generated at", "State hash", "Events from dev-a"]));
    expect(stateHash(state())).toBe(stateHash(state()));
    const changed = state();
    changed.items["i2"]!.description = "Different";
    expect(stateHash(changed)).not.toBe(stateHash(state()));
  });
});

describe("renderMirrorXlsx", () => {
  it("writes values only, native hyperlinks, formats, frozen header and filters", async () => {
    const bytes = await renderMirrorXlsx(buildMirror(state(), ctx, opts));
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(bytes as unknown as ArrayBuffer);
    const ws = wb.getWorksheet(MAIN_SHEET)!;
    const header = ws.getRow(1).values as unknown[];
    const colOf = (name: string) => header.indexOf(name);

    const row = ws.getRow(3); // second data row = Workbook (sorted by date)
    expect(row.getCell(colOf("Reim. $")).value).toBe(21.4);
    expect(row.getCell(colOf("Reim. $")).numFmt).toBe('"$"#,##0.00');
    expect(row.getCell(colOf("Date")).value).toBeInstanceOf(Date);
    const receipt = row.getCell(colOf("Receipt")).value as { text: string; hyperlink: string };
    expect(receipt).toMatchObject({ text: "receipt-1.pdf", hyperlink: "https://onedrive.example/d1" });

    // No formulas anywhere.
    ws.eachRow((r) => r.eachCell((c) => expect(typeof c.value === "object" && c.value !== null && "formula" in c.value).toBe(false)));
    expect(ws.views[0]).toMatchObject({ state: "frozen", ySplit: 1 });
    expect(ws.autoFilter).toBeTruthy();
    expect(wb.worksheets.map((w) => w.name)).toContain("Needs Attention");
  });
});

describe("publishMirror", () => {
  let g: FakeGraph;
  beforeEach(() => {
    g = new FakeGraph();
    setTokenProvider(async () => "t");
    configureGraph({ fetch: g.fetch as typeof fetch, sleep: async () => {}, maxRetries: 1 });
  });
  afterEach(() => configureGraph());

  it("writes once, skips when the state is unchanged, rewrites when it changes", async () => {
    const reports = await ensureFolder("d", g.rootId, "reports");
    const model = buildMirror(state(), ctx, opts);
    expect((await publishMirror("d", reports, "mirror.xlsx", model)).status).toBe("written");
    expect((await publishMirror("d", reports, "mirror.xlsx", model)).status).toBe("unchanged");
    const s2 = state();
    s2.items["i2"]!.description = "Changed";
    expect((await publishMirror("d", reports, "mirror.xlsx", buildMirror(s2, ctx, opts))).status).toBe("written");
  });

  it("reports a locked workbook (open in Excel) instead of throwing", async () => {
    const reports = await ensureFolder("d", g.rootId, "reports");
    configureGraph({
      fetch: (async (u: RequestInfo | URL, i?: RequestInit) =>
        String(u).includes(".xlsx:/content") && i?.method === "PUT" ? new Response("locked", { status: 423 }) : g.fetch(u, i)) as typeof fetch,
      sleep: async () => {},
    });
    expect((await publishMirror("d", reports, "mirror.xlsx", buildMirror(state(), ctx, opts))).status).toBe("locked");
  });
});
