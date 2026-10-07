import { describe, expect, it } from "vitest";
import { Ledger, HlcClock, MemoryBackend, MemoryEventStore, buildLegacyImport, buildMirror, evaluateItem, foldEvents, materialize, toIsoDate, type LegacyInput, type LegacyRow } from "../src/index.js";

// Excel serial for 2025-09-01 is 45901.
const row = (id: number, extra: Record<string, unknown>, docs: string[] = ["receipt.pdf"]): LegacyRow => ({
  values: {
    ID: id, Child: "Child A", Item: `Item ${id}`, Date: 45901, Vendor: "Shop", "Invoice #": "INV-1", Category: "Curriculum - Workbooks",
    Quantity: 1, Amount: 20, "Tax, Shipping, etc.": 1.4, "Payment Method": "Card X (Sep)", "Benefit Message": "Used for math.", Status: "Unfiled (Ready to Submit)",
    ...extra,
  },
  docFiles: docs,
});

const input = (rows: LegacyRow[]): LegacyInput => ({
  yearLabel: "2025-2026",
  rows,
  children: [{ name: "Child A", scholarship: "FES-UA", capDollars: 9000 }, { name: "Child B", scholarship: "FES-UA" }],
  paymentMethods: [{ label: "Card X (Sep)", file: "statement-sep.pdf" }],
  files: [
    { name: "receipt.pdf", id: "o1", webUrl: "https://x/o1", size: 1000 },
    { name: "statement-sep.pdf", id: "o2", webUrl: "https://x/o2", size: 2000 },
    { name: "other.pdf", id: "o3", size: 10 },
    { name: "order-confirmation.pdf", id: "o4", size: 10 },
  ],
  categories: [{ path: "Curriculum - Workbooks", eligible: ["FES-UA"] }],
});

describe("toIsoDate", () => {
  it("handles Excel serials, ISO, and US formats", () => {
    expect(toIsoDate(45901)).toBe("2025-09-01");
    expect(toIsoDate("45901")).toBe("2025-09-01");
    expect(toIsoDate("2025-09-01T00:00:00")).toBe("2025-09-01");
    expect(toIsoDate("9/1/2025")).toBe("2025-09-01");
    expect(toIsoDate("")).toBeUndefined();
  });
});

describe("buildLegacyImport", () => {
  it("turns rows sharing a receipt and vendor into one purchase with several items", () => {
    const { state, report } = buildLegacyImport(input([row(1, {}), row(2, {})]));
    expect(report.itemsImported).toBe(2);
    expect(Object.keys(state.purchases)).toHaveLength(1);
    const purchase = Object.values(state.purchases)[0]!;
    expect(purchase).toMatchObject({ vendor: "Shop", date: "2025-09-01", invoiceNo: "INV-1" });
    expect(state.items["legacy-1"]).toMatchObject({ amountCents: 2000, taxShippingCents: 140, childId: "child-child-a", categoryPath: ["Curriculum", "Workbooks"] });
    expect(state.documents[purchase.receiptDocumentId!]).toMatchObject({ filename: "receipt.pdf", webUrl: "https://x/o1", sizeBytes: 1000 });
  });

  it("splits the same receipt used by two vendors and one receipt across two children stays one purchase", () => {
    const split = buildLegacyImport(input([row(1, {}), row(2, { Vendor: "Other Co" })]));
    expect(Object.keys(split.state.purchases)).toHaveLength(2);
    const shared = buildLegacyImport(input([row(1, {}), row(2, { Child: "Child B" })]));
    expect(Object.keys(shared.state.purchases)).toHaveLength(1);
  });

  it("makes the payment file a payment-proof and other documents additional", () => {
    const { state } = buildLegacyImport(input([row(1, { "Payment File": "statement-sep.pdf" }, ["receipt.pdf", "other.pdf"])]));
    const kinds = Object.values(state.additionalDocs).map((a) => [state.documents[a.documentId!]?.filename, a.kind]);
    expect(kinds).toEqual(expect.arrayContaining([["statement-sep.pdf", "payment-proof"], ["other.pdf", "other"]]));
    expect(kinds).toHaveLength(2);
  });

  it("picks the receipt by keyword, then by remembered choice, then flags it as ambiguous", () => {
    const keyword = buildLegacyImport(input([row(1, {}, ["other.pdf", "order-confirmation.pdf"])]));
    expect(keyword.report.ambiguousReceipts).toEqual([]);
    expect(Object.values(keyword.state.documents).some((d) => d.filename === "order-confirmation.pdf")).toBe(true);

    const files = ["other.pdf", "extra.pdf"];
    const remembered = buildLegacyImport({ ...input([row(1, {}, files)]), receiptChoices: { "extra.pdf other.pdf": "other.pdf" } });
    expect(remembered.report.ambiguousReceipts[0]).toMatchObject({ chosen: "other.pdf", resolvedFromCache: true });

    const ambiguous = buildLegacyImport(input([row(1, {}, files)]));
    expect(ambiguous.report.ambiguousReceipts[0]).toMatchObject({ resolvedFromCache: false });
  });

  it("maps StepUp statuses, submissions and amounts; keeps unknown statuses as overrides", () => {
    const rows = [
      row(1, { Status: "Paid", "Reimbursement ID": "35958661", "Line Number": 1, Submitted: 45910, "Reimbursed Amount": 21.4 }),
      row(2, { Status: "Approved", "Reimbursement ID": "35958661", "Line Number": 2, "Reimbursed Amount": 10 }),
      row(3, { Status: "Not Required" }),
    ];
    const { state, report } = buildLegacyImport(input(rows));
    expect(state.items["legacy-1"]).toMatchObject({ stepUpStatus: "Paid", paidCents: 2140, submissionId: "sub-35958661", lineNumber: 1 });
    expect(state.items["legacy-2"]).toMatchObject({ stepUpStatus: "Approved", approvedCents: 1000 });
    expect(state.items["legacy-3"]).toMatchObject({ statusOverride: "Not Required" });
    expect(state.submissions["sub-35958661"]).toMatchObject({ reimbursementId: "35958661", submittedAt: "2025-09-10" });
    expect(report.submissions).toBe(1);
    expect(report.unknownStatuses).toEqual([{ itemId: "legacy-3", status: "Not Required" }]);
  });

  it("reports missing files, rows without documents, and rows that disagree about a receipt", () => {
    const { report } = buildLegacyImport(input([row(1, {}, ["gone.pdf"]), row(2, {}, []), row(3, { Date: 45902 }, ["receipt.pdf"]), row(4, {}, ["receipt.pdf"])]));
    expect(report.missingFiles).toEqual(["gone.pdf"]);
    expect(report.itemsWithoutDocuments).toEqual(["legacy-2"]);
    expect(report.purchaseDisagreements).toEqual([{ receipt: "receipt.pdf", field: "date", values: ["2025-09-02", "2025-09-01"] }]);
  });

  it("checks the new readiness rules against the old hand-set status", () => {
    const rows = [
      row(1, { "Payment File": "statement-sep.pdf" }), // complete -> ready, agrees
      row(2, { "Benefit Message": "" }, ["receipt.pdf"]), // legacy says ready but benefit message missing
      row(3, { Status: "Unfiled (Missing Things)", "Payment File": "statement-sep.pdf" }), // legacy says missing but looks complete
    ];
    const { report } = buildLegacyImport(input(rows));
    const byId = Object.fromEntries(report.readinessMismatches.map((m) => [m.itemId, m]));
    expect(byId["legacy-1"]).toBeUndefined();
    expect(byId["legacy-2"]).toMatchObject({ legacy: "Unfiled (Ready to Submit)", computed: "Unfiled (Missing Things)" });
    expect(byId["legacy-2"]!.reasons).toContain("missing-benefit-message");
    expect(byId["legacy-3"]).toMatchObject({ computed: "Unfiled (Ready to Submit)" });
  });

  it("is deterministic and idempotent, and later human edits beat imported values", async () => {
    const rows = [row(1, { "Payment File": "statement-sep.pdf" })];
    const a = buildLegacyImport(input(rows));
    const b = buildLegacyImport(input(rows));
    expect(a.events).toEqual(b.events);
    expect(foldEvents([...a.events, ...b.events])).toEqual(foldEvents(a.events));

    const backend = new MemoryBackend();
    await new MemoryEventStore(backend, "legacy-import").appendOwn(a.events);
    const human = new Ledger(new MemoryEventStore(backend, "dev-a"), new HlcClock("dev-a"));
    await human.refresh();
    human.set("item", "legacy-1", { description: "Edited by a person" });
    await human.flush();
    await human.refresh();
    expect(human.state.items["legacy-1"]?.description).toBe("Edited by a person");
    // Re-running the import afterwards must not undo the edit.
    await new MemoryEventStore(backend, "legacy-import").appendOwn(b.events);
    await human.refresh();
    expect(materialize(foldEvents([...a.events, ...b.events])).items["legacy-1"]?.description).toBe("Item 1");
    expect(human.state.items["legacy-1"]?.description).toBe("Edited by a person");
  });
});

describe("per-item values and holds", () => {
  it("keeps a per-item date, invoice and vendor when rows on one receipt differ", () => {
    const { state, rules } = buildLegacyImport(input([row(1, {}), row(2, { Date: 45902, "Invoice #": "INV-2" })]));
    expect(state.items["legacy-1"]).not.toHaveProperty("date");
    expect(state.items["legacy-2"]).toMatchObject({ date: "2025-09-02", invoiceNo: "INV-2" });
    const sheet = buildMirror(state, rules, { generatedAt: "t" }).sheets[0]!;
    const col = (name: string) => sheet.columns.findIndex((c) => c.header === name);
    expect(sheet.rows.map((r) => [r[col("Date")]?.v, r[col("Invoice #")]?.v])).toEqual([
      ["2025-09-01", "INV-1"],
      ["2025-09-02", "INV-2"],
    ]);
  });

  it("turns the old automation notes into structured holds and learns which categories need a Service Date", () => {
    const rows = [
      row(1, { Status: "Unfiled (Missing Things)", Notes: "[2026-10-07] Missing Service Date — required for this category, needs filling in spreadsheet." }),
      row(2, { Status: "Unfiled (Missing Things)", Notes: "[2026-10-07] Needs to be split — the receipt has multiple items." }),
      row(3, { Status: "Submitted", Notes: "Missing Service Date mentioned but it was filed" }),
    ];
    const { state, report, rules } = buildLegacyImport(input(rows));
    expect(report.holds).toEqual([{ itemId: "legacy-1", hold: "missing-service-date" }, { itemId: "legacy-2", hold: "needs-split" }]);
    expect(state.items["legacy-3"]).not.toHaveProperty("hold");
    expect(rules.category("legacy-cat-curriculum-workbooks")?.requiresServiceDate).toBe(true);

    const reasons = (id: string) => evaluateItem(state, id, rules).reasons.map((r) => r.code);
    expect(reasons("legacy-1")).toContain("on-hold");
    expect(reasons("legacy-2")).toContain("on-hold");
    // Filling in the Service Date clears the missing-service-date hold (and the category rule is satisfied).
    state.items["legacy-1"]!.serviceDate = "2025-09-05";
    expect(reasons("legacy-1")).not.toContain("on-hold");
  });
});

