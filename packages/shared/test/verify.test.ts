import { describe, expect, it } from "vitest";
import { formatHlc, HlcClock, Ledger, MemoryBackend, MemoryEventStore, addItem, createPurchase, hasErrors, verifyLedger, type LedgerEvent } from "../src/index.js";

const mk = () => new Ledger(new MemoryEventStore(new MemoryBackend(), "dev"), new HlcClock("dev"), "t");
const codes = (l: Ledger, events: LedgerEvent[] = []) => verifyLedger(l.state, events).map((f) => f.code);

describe("verifyLedger", () => {
  it("a consistent ledger passes", () => {
    const l = mk();
    l.set("child", "kid", { name: "Kid" });
    l.set("document", "r", { filename: "r.pdf", driveItemId: "x", sha256: "aa" });
    const p = createPurchase(l, { vendor: "A", receiptDocumentId: "r" });
    addItem(l, p, { childId: "kid", description: "Book", amountCents: 100 });
    const findings = verifyLedger(l.state, []);
    expect(hasErrors(findings)).toBe(false);
    expect(findings.map((f) => f.code)).toEqual(["all-good"]);
  });

  it("finds things that point at nothing", () => {
    const l = mk();
    l.set("item", "i1", { purchaseId: "gone", childId: "nobody", submissionId: "nope" });
    l.set("purchase", "p", { receiptDocumentId: "missing-doc" });
    l.set("additionalDoc", "a1", { ownerKind: "purchase", ownerId: "p", documentId: "also-missing" });
    l.set("document", "copy", { derivedFrom: "vanished", driveItemId: "z" });
    const c = codes(l);
    expect(c).toEqual(expect.arrayContaining(["item-without-purchase", "item-without-child", "item-without-submission", "receipt-missing", "broken-attachment", "copy-without-original"]));
    expect(hasErrors(verifyLedger(l.state, []))).toBe(true);
  });

  it("warns about duplicate files, files with no OneDrive id, and charges that left a statement", () => {
    const l = mk();
    l.set("document", "a", { driveItemId: "1", sha256: "same" });
    l.set("document", "b", { driveItemId: "2", sha256: "same" });
    l.set("document", "c", {});
    l.set("document", "stmt", { driveItemId: "3", statement: { transactions: [{ id: "t1", date: "2026-01-01", descriptor: "x", amountCents: 1, kind: "purchase", confidence: 1 }] } as never });
    l.set("purchase", "p", {});
    l.set("additionalDoc", "pr", { ownerKind: "purchase", ownerId: "p", documentId: "stmt", kind: "payment-proof", transactionId: "t-gone" });
    const c = codes(l);
    expect(c).toEqual(expect.arrayContaining(["duplicate-files", "document-without-file", "charge-not-on-statement"]));
  });

  it("catches clashing event ids, newer-version events and clocks far in the future", () => {
    const l = mk();
    const e = (id: string, extra: Partial<LedgerEvent> = {}): LedgerEvent => ({ id, hlc: id, clientId: "c", schemaVersion: 1, op: "set", entity: "child", entityId: "k", fields: { name: "A" }, ...extra });
    const future = formatHlc({ wall: Date.now() + 10 * 86_400_000, counter: 0, clientId: "c" });
    const events = [e("a"), e("a", { fields: { name: "B" } }), e("n", { schemaVersion: 99 }), e(future)];
    const c = verifyLedger(l.state, events).map((f) => f.code);
    expect(c).toEqual(expect.arrayContaining(["event-id-clash", "newer-events", "clock-ahead"]));
  });

  it("two StepUp line numbers claimed by two items is an error", () => {
    const l = mk();
    l.set("submission", "s", { reimbursementId: "R1" });
    l.set("item", "i1", { submissionId: "s", lineNumber: 1, purchaseId: "p" });
    l.set("item", "i2", { submissionId: "s", lineNumber: 1, purchaseId: "p" });
    l.set("purchase", "p", {});
    expect(codes(l)).toContain("duplicate-line-number");
  });
});
