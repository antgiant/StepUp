import fc from "fast-check";
import { beforeEach, describe, expect, it } from "vitest";
import {
  HlcClock,
  Ledger,
  MemoryBackend,
  MemoryEventStore,
  addItem,
  allocateProportionally,
  attachAdditional,
  attachAsReceipt,
  buildQueue,
  copyChildren,
  setPurchaseArchived,
  createPurchase,
  detachAdditional,
  duplicateItem,
  evaluateItem,
  planIngest,
  registerLooseFiles,
  reallocateTax,
  remainingToItemize,
  startPurchaseFromDocument,
  suggestNextItem,
  suggestTargets,
  guessContentKind,
  fileNameHints,
  type CategoryInfo,
  type RulesContext,
} from "../src/index.js";

const categories: Record<string, CategoryInfo> = {
  books: { id: "books", path: ["Curriculum"], requiresServiceDate: false, eligibleScholarships: ["FES-UA"], isActive: true },
};
const ctx: RulesContext = { category: (id) => categories[id], today: "2026-10-07" };

let ledger: Ledger;
beforeEach(() => {
  ledger = new Ledger(new MemoryEventStore(new MemoryBackend(), "dev-a"), new HlcClock("dev-a", { now: () => 1000 }), "alice");
  ledger.set("child", "c1", { name: "Child A", scholarship: "FES-UA" });
  ledger.set("child", "c2", { name: "Child B", scholarship: "FES-UA" });
  ledger.set("setting", "year", { defaultTaxRate: 0.07 });
});

describe("allocateProportionally", () => {
  it("always sums exactly to the total and never goes negative", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100_000 }), fc.array(fc.integer({ min: 0, max: 50_000 }), { minLength: 1, maxLength: 12 }), (total, weights) => {
        const parts = allocateProportionally(total, weights);
        expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
        expect(parts.every((p) => p >= 0)).toBe(true);
        expect(parts).toHaveLength(weights.length);
      })
    );
  });

  it("splits 100 cents three ways as 34/33/33 and respects proportions", () => {
    expect(allocateProportionally(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocateProportionally(70, [1000, 3000])).toEqual([18, 52]);
  });
});

describe("one receipt, many StepUp entries", () => {
  it("itemizes a receipt without re-entering vendor, date, invoice # or payment method", () => {
    ledger.set("document", "d1", { filename: "Acme order 12345.pdf", paymentEvidenceConfidence: 0.95, sizeBytes: 1000 });
    const p = startPurchaseFromDocument(ledger, "d1", { vendor: "Acme", date: "2026-09-01", invoiceNo: "12345", orderTotalCents: 10_700, taxShippingTotalCents: 700 });

    const first = addItem(ledger, p, { childId: "c1", description: "Math book", amountCents: 4_000, categoryId: "books", benefitMessage: "Used for math." });
    // The next item starts from what is left on the receipt and the same child.
    expect(suggestNextItem(ledger.state, p)).toEqual({ childId: "c1", amountCents: 10_700 - 4_280 });
    const second = addItem(ledger, p, { childId: "c2", description: "Reader", amountCents: 6_000, categoryId: "books", benefitMessage: "Reading." });
    const third = addItem(ledger, p, { childId: "c2", description: "Pencils", amountCents: 0 });

    // Vendor/date/invoice live on the purchase once; each item inherits them.
    for (const id of [first, second]) expect(ledger.state.items[id]).not.toHaveProperty("vendor");
    expect(evaluateItem(ledger.state, first, ctx).readiness).toBe("ready");
    expect(evaluateItem(ledger.state, second, ctx).readiness).toBe("ready");
    expect(evaluateItem(ledger.state, third, ctx).reasons.map((r) => r.code)).toContain("missing-amount");

    // Real tax total replaces the estimates and sums exactly.
    expect(ledger.state.items[first]).toMatchObject({ taxShippingCents: 280, taxShippingEstimated: true });
    reallocateTax(ledger, p);
    const taxes = [first, second, third].map((id) => ledger.state.items[id]!.taxShippingCents!);
    expect(taxes.reduce((a, b) => a + b, 0)).toBe(700);
    expect(ledger.state.items[first]!.taxShippingEstimated).toBe(false);
    expect(remainingToItemize(ledger.state, p)).toBe(10_700 - (4_000 + 6_000 + 0) - 700);
  });

  it("duplicates an item within the same receipt without carrying over StepUp state", () => {
    const p = createPurchase(ledger, { vendor: "Acme", date: "2026-09-01" });
    const a = addItem(ledger, p, { childId: "c1", description: "Notebook", amountCents: 500, categoryId: "books", benefitMessage: "Writing." });
    ledger.set("item", a, { submissionId: "s1", stepUpStatus: "Submitted", hold: "needs-split" });
    const b = duplicateItem(ledger, a)!;
    expect(ledger.state.items[b]).toMatchObject({ purchaseId: p, childId: "c1", description: "Notebook", amountCents: 500 });
    expect(ledger.state.items[b]).not.toHaveProperty("submissionId");
    expect(ledger.state.items[b]).not.toHaveProperty("hold");
  });
});

describe("loose files: need data, or belong to something already entered", () => {
  it("registers loose files once and shows them in the queue with both options", () => {
    const files = [
      { id: "o1", name: "Acme order 12345.pdf", size: 100 },
      { id: "o2", name: "Card statement October.pdf", size: 100 },
    ];
    expect(planIngest(ledger.state, files).toRegister).toHaveLength(2);
    registerLooseFiles(ledger, files);
    registerLooseFiles(ledger, files); // idempotent: same deterministic ids
    expect(Object.keys(ledger.state.documents)).toHaveLength(2);
    expect(planIngest(ledger.state, files)).toEqual({ toRegister: [], alreadyKnown: 2 });

    const queue = buildQueue(ledger.state, ctx);
    const receiptLike = queue.find((q) => q.title === "Acme order 12345.pdf")!;
    expect(receiptLike.actions).toEqual(["start-purchase", "attach-receipt", "attach-additional"]);
    expect(queue.find((q) => q.title === "Card statement October.pdf")!.actions).toEqual(["attach-additional", "start-purchase"]);
    expect(guessContentKind("Card statement October.pdf")).toBe("statement");
  });

  it("suggests the purchase that is still missing its receipt, and maps the file to it", () => {
    const waiting = createPurchase(ledger, { vendor: "Acme Books", date: "2026-09-01", invoiceNo: "12345" });
    const other = createPurchase(ledger, { vendor: "Zed", date: "2026-09-02", receiptDocumentId: "d-other" });
    ledger.set("document", "d-other", { filename: "zed.pdf" });
    ledger.set("document", "new", { filename: "Acme Books order 12345.pdf", contentKind: "receipt-like" });

    const suggestions = suggestTargets(ledger.state, "new", ctx);
    expect(suggestions[0]).toMatchObject({ target: { kind: "purchase", id: waiting }, role: "receipt" });
    expect(suggestions[0]!.why).toEqual(expect.arrayContaining(["has no receipt yet", "file name mentions the vendor", "file name contains the invoice number"]));
    expect(suggestions.some((s) => s.target.id === other)).toBe(false);

    expect(attachAsReceipt(ledger, waiting, "new")).toEqual({ ok: true });
    expect(ledger.state.purchases[waiting]!.receiptDocumentId).toBe("new");
    expect(buildQueue(ledger.state, ctx).some((q) => q.kind === "unattached-document" && q.id === "new")).toBe(false);
    // A second file cannot silently replace the receipt.
    ledger.set("document", "second", { filename: "another.pdf" });
    expect(attachAsReceipt(ledger, waiting, "second")).toEqual({ ok: false, reason: "purchase-has-receipt" });
    expect(attachAsReceipt(ledger, waiting, "second", { replace: true })).toEqual({ ok: true });
  });

  it("suggests a statement for purchases awaiting proof, attaches it, and the items become ready", () => {
    ledger.set("paymentMethod", "pm1", { label: "Citi Card" });
    ledger.set("document", "r", { filename: "receipt.pdf", sizeBytes: 100 }); // no payment evidence
    const p = createPurchase(ledger, { vendor: "Shop", date: "2026-09-01", receiptDocumentId: "r", paymentMethodId: "pm1" });
    const item = addItem(ledger, p, { childId: "c1", description: "Thing", amountCents: 1000, categoryId: "books", benefitMessage: "Use." });
    expect(evaluateItem(ledger.state, item, ctx).reasons.map((r) => r.code)).toEqual(["awaiting-proof"]);

    registerLooseFiles(ledger, [{ id: "o9", name: "Citi statement 2026-09.pdf", size: 10 }]);
    const docId = Object.values(ledger.state.documents).find((d) => d.filename?.startsWith("Citi"))!.id;
    const [top] = suggestTargets(ledger.state, docId, ctx);
    expect(top).toMatchObject({ target: { kind: "purchase", id: p }, role: "additional" });
    expect(top!.why).toContain("items are waiting for proof of payment");

    expect(attachAdditional(ledger, top!.target, docId, "payment-proof")).toEqual({ ok: true });
    expect(evaluateItem(ledger.state, item, ctx).readiness).toBe("ready");

    detachAdditional(ledger, top!.target, docId);
    expect(evaluateItem(ledger.state, item, ctx).readiness).toBe("blocked");
  });

  it("refuses to attach the receipt to itself as additional documentation", () => {
    ledger.set("document", "r", { filename: "r.pdf" });
    const p = createPurchase(ledger, { receiptDocumentId: "r" });
    expect(attachAdditional(ledger, { kind: "purchase", id: p }, "r")).toEqual({ ok: false, reason: "is-the-receipt" });
    expect(attachAdditional(ledger, { kind: "purchase", id: "nope" }, "r")).toEqual({ ok: false, reason: "target-missing" });
  });

  it("lists receipts with no items and blocked items after the unattached files", () => {
    ledger.set("document", "d", { filename: "a.pdf" });
    const empty = createPurchase(ledger, { vendor: "Empty" });
    const p = createPurchase(ledger, { vendor: "Shop" });
    const item = addItem(ledger, p, { childId: "c1", description: "Thing", amountCents: 100 });
    const kinds = buildQueue(ledger.state, ctx).map((q) => [q.kind, q.id]);
    expect(kinds[0]).toEqual(["unattached-document", "d"]);
    expect(kinds).toContainEqual(["purchase-needs-items", empty]);
    expect(kinds).toContainEqual(["item-blocked", item]);
  });
});

describe("file name hints", () => {
  it("reads vendor, date and description from the '<Vendor> <MM DD YYYY> <description>' habit", () => {
    expect(fileNameHints("Acme 07 28 2026 School Books (10th grade).pdf")).toEqual({ vendor: "Acme", date: "2026-07-28", description: "School Books (10th grade)" });
    expect(fileNameHints("Apple 02 19 26 Procreate.pdf")).toMatchObject({ vendor: "Apple", date: "2026-02-19" });
    expect(fileNameHints("12,13 - Apple 03 11 26 Thing.pdf")).toMatchObject({ vendor: "Apple", date: "2026-03-11" });
    expect(fileNameHints("Reading list.pdf")).toEqual({});
    expect(fileNameHints("Odd 13 45 2026 nonsense.pdf")).toEqual({});
  });

  it("classifies dated names as receipts and surfaces the hints in the queue", () => {
    expect(guessContentKind("Acme 07 28 2026 Books.pdf")).toBe("receipt-like");
    expect(guessContentKind("History reading list.pdf")).toBe("explanation");
    expect(guessContentKind("Mystery.pdf")).toBe("other");
    ledger.set("document", "d", { filename: "Acme 07 28 2026 Books.pdf", contentKind: "receipt-like" });
    expect(buildQueue(ledger.state, ctx)[0]!.hints).toMatchObject({ vendor: "Acme", date: "2026-07-28" });
  });

  it("archives a purchase and its items out of the queue, and restores them", () => {
    const p = createPurchase(ledger, { vendor: "Acme" });
    addItem(ledger, p, { description: "Book", amountCents: 1000 });
    expect(buildQueue(ledger.state, ctx).length).toBeGreaterThan(0);
    setPurchaseArchived(ledger, p);
    expect(buildQueue(ledger.state, ctx)).toEqual([]);
    expect(ledger.state.purchases[p]!.archived).toBe(true);
    setPurchaseArchived(ledger, p, false);
    expect(buildQueue(ledger.state, ctx).length).toBeGreaterThan(0);
  });

  it("copies children from an earlier year once, keeping ids and not overwriting", () => {
    const last = new Ledger(new MemoryEventStore(new MemoryBackend(), "old"), new HlcClock("old"), "test");
    last.set("child", "c9", { name: "Ann", scholarship: "FES-UA", capCents: 5000 });
    expect(copyChildren(ledger, last.state)).toBe(1);
    expect(ledger.state.children["c9"]).toMatchObject({ name: "Ann", scholarship: "FES-UA" });
    expect(ledger.state.children["c9"]!.capCents).toBeUndefined();
    expect(copyChildren(ledger, last.state)).toBe(0);
  });
});

describe("pending persistence", () => {
  it("reports changes to unflushed events and restores them into a fresh ledger", async () => {
    const backend = new MemoryBackend();
    const a = new Ledger(new MemoryEventStore(backend, "dev-a"), new HlcClock("dev-a", { now: () => 1000 }), "alice");
    let saved: unknown[] = [];
    a.onPendingChange = (p) => (saved = JSON.parse(JSON.stringify(p)));
    a.set("child", "kid", { name: "Kid" });
    expect(saved).toHaveLength(1);

    // The tab closed before the upload; a later session restores and uploads once.
    const b = new Ledger(new MemoryEventStore(backend, "dev-a"), new HlcClock("dev-a", { now: () => 1000 }), "alice");
    b.restorePending(saved as never);
    b.restorePending(saved as never); // idempotent
    expect(b.unflushedCount).toBe(1);
    expect(b.state.children["kid"]?.name).toBe("Kid");
    let after: unknown[] = ["unset"];
    b.onPendingChange = (p) => (after = [...p]);
    await b.flush();
    expect(after).toEqual([]);
    const c = new Ledger(new MemoryEventStore(backend, "dev-a"), new HlcClock("dev-a"), "alice");
    await c.refresh();
    expect(c.state.children["kid"]?.name).toBe("Kid");
  });
});
