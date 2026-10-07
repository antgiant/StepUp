import { describe, expect, it } from "vitest";
import {
  childBudget,
  daysUntil,
  displayStatus,
  estimateTaxCents,
  evaluateItem,
  formatCents,
  toCents,
  type CategoryInfo,
  type LedgerState,
  type RulesContext,
} from "../src/index.js";

const categories: Record<string, CategoryInfo> = {
  books: { id: "books", path: ["Curriculum"], requiresServiceDate: false, eligibleScholarships: ["FES-UA"], isActive: true },
  class: { id: "class", path: ["Classes"], requiresServiceDate: true, eligibleScholarships: ["FES-UA"], isActive: true },
  other: { id: "other", path: ["Other"], requiresServiceDate: false, eligibleScholarships: ["FTC"], isActive: true },
};
const ctx: RulesContext = { category: (id) => categories[id], today: "2026-10-07" };

function baseState(): LedgerState {
  return {
    children: { c1: { id: "c1", name: "Child A", scholarship: "FES-UA", capCents: 1_000_000 } },
    paymentMethods: {},
    purchases: { p1: { id: "p1", vendor: "Shop", date: "2026-09-01", receiptDocumentId: "d1", orderTotalCents: 5000 } },
    items: {
      i1: { id: "i1", purchaseId: "p1", childId: "c1", description: "Workbook", amountCents: 2000, taxShippingCents: 140, categoryId: "books", benefitMessage: "Used for math." },
    },
    documents: { d1: { id: "d1", filename: "receipt.pdf", sizeBytes: 100_000, paymentEvidenceConfidence: 0.95 } },
    additionalDocs: {},
    submissions: {},
    settings: { year: { id: "year", submissionDeadline: "2027-06-30" } },
  };
}
const codes = (s: LedgerState, id = "i1") => evaluateItem(s, id, ctx).reasons.map((r) => r.code);

describe("evaluateItem", () => {
  it("is ready when everything is present and the receipt shows payment", () => {
    expect(evaluateItem(baseState(), "i1", ctx)).toEqual({ readiness: "ready", reasons: [] });
  });

  it("requires proof of payment: weak receipt evidence blocks until a statement is attached", () => {
    const s = baseState();
    s.documents["d1"]!.paymentEvidenceConfidence = 0.3;
    expect(codes(s)).toEqual(["awaiting-proof"]);
    s.documents["st"] = { id: "st", filename: "statement.pdf", contentKind: "statement" };
    s.additionalDocs["a1"] = { id: "a1", ownerKind: "purchase", ownerId: "p1", documentId: "st", kind: "payment-proof" };
    expect(codes(s)).toEqual([]);
  });

  it("flags a missing or oversized receipt and a receipt listed as additional", () => {
    const s = baseState();
    s.purchases["p1"]!.receiptDocumentId = undefined;
    expect(codes(s)).toContain("missing-receipt");
    const t = baseState();
    t.documents["d1"]!.sizeBytes = 6 * 1024 * 1024;
    expect(codes(t)).toContain("receipt-too-large");
    const u = baseState();
    u.additionalDocs["a"] = { id: "a", ownerKind: "purchase", ownerId: "p1", documentId: "d1", kind: "other" };
    expect(codes(u)).toContain("receipt-also-additional");
  });

  it("applies category rules: service date and scholarship eligibility", () => {
    const s = baseState();
    s.items["i1"]!.categoryId = "class";
    expect(codes(s)).toContain("missing-service-date");
    s.items["i1"]!.serviceDate = "2026-09-05";
    expect(codes(s)).not.toContain("missing-service-date");
    s.items["i1"]!.categoryId = "other";
    expect(codes(s)).toContain("category-ineligible");
    s.items["i1"]!.categoryId = "ghost";
    expect(codes(s)).toContain("unknown-category");
  });

  it("blocks when items add up to more than the receipt total", () => {
    const s = baseState();
    s.items["i2"] = { ...s.items["i1"]!, id: "i2", amountCents: 3000 };
    expect(codes(s)).toContain("items-exceed-receipt-total");
  });

  it("lists every missing basic field", () => {
    const s = baseState();
    s.items["i1"] = { id: "i1" };
    expect(codes(s)).toEqual(
      expect.arrayContaining(["missing-child", "missing-description", "missing-amount", "missing-benefit-message", "missing-category", "missing-purchase"])
    );
  });
});

describe("displayStatus", () => {
  it("maps readiness to the old workbook vocabulary, then StepUp status, override and forfeiture", () => {
    const s = baseState();
    const ready = evaluateItem(s, "i1", ctx);
    const item = s.items["i1"]!;
    expect(displayStatus(item, ready, ctx)).toBe("Unfiled (Ready to Submit)");
    expect(displayStatus(item, { readiness: "blocked", reasons: [] }, ctx)).toBe("Unfiled (Missing Things)");
    expect(displayStatus({ ...item, submissionId: "s1" }, ready, ctx)).toBe("Submitted");
    expect(displayStatus({ ...item, stepUpStatus: "Paid" }, ready, ctx)).toBe("Paid");
    expect(displayStatus({ ...item, statusOverride: "Not Required" }, ready, ctx)).toBe("Not Required");
    expect(displayStatus(item, ready, { ...ctx, today: "2027-07-01" }, "2027-06-30")).toBe("Forfeited");
  });
});

describe("childBudget", () => {
  it("counts paid, approved and pending against the cap; unfiled and denied items do not count", () => {
    const s = baseState();
    delete s.items["i1"];
    const mk = (id: string, status: string | undefined, extra = {}) => {
      s.items[id] = { id, childId: "c1", amountCents: 10_000, taxShippingCents: 0, stepUpStatus: status, ...extra };
    };
    mk("paid", "Paid", { paidCents: 9_000 });
    mk("appr", "Approved", { approvedCents: 8_000 });
    mk("pend", "Submitted");
    mk("den", "Denied (Final)");
    mk("unf", undefined);
    const b = childBudget(s, "c1");
    expect(b).toMatchObject({ paidCents: 9_000, approvedCents: 8_000, pendingCents: 10_000, unfiledCents: 10_000 });
    expect(b.remainingCents).toBe(1_000_000 - 9_000 - 8_000 - 10_000);
  });

  it("counts days to the deadline", () => {
    expect(daysUntil("2027-06-30", "2027-06-20")).toBe(10);
    expect(daysUntil("2027-06-30", "2027-07-02")).toBe(-2);
  });
});

describe("money", () => {
  it("parses and formats cents without float drift", () => {
    expect(toCents("$1,234.50")).toBe(123_450);
    expect(toCents(0.1 + 0.2)).toBe(30);
    expect(toCents("abc")).toBeUndefined();
    expect(formatCents(123_450)).toBe("$1,234.50");
    expect(formatCents(-5)).toBe("-$0.05");
  });

  it("estimates tax at 7% by default and uses a given rate", () => {
    expect(estimateTaxCents(10_000)).toBe(700);
    expect(estimateTaxCents(10_000, 0.065)).toBe(650);
  });
});
