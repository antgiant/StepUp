import { describe, expect, it } from "vitest";
import { planSubmissions, type CategoryInfo, type LedgerState, type RulesContext } from "../src/index.js";

const categories: Record<string, CategoryInfo> = {
  books: { id: "books", path: ["Curriculum"], requiresServiceDate: false, eligibleScholarships: ["FES-UA"], isActive: true },
};
const ctx: RulesContext = { category: (id) => categories[id], today: "2026-10-07" };

const item = (id: string, childId: string, lineNumber: number, extra = {}) => ({
  id, purchaseId: "p1", childId, lineNumber, description: id, amountCents: 1000, categoryId: "books", benefitMessage: "Used for math.", ...extra,
});

function state(): LedgerState {
  return {
    children: { c1: { id: "c1", name: "Child A", scholarship: "FES-UA" }, c2: { id: "c2", name: "Child B", scholarship: "FES-UA" } },
    paymentMethods: {},
    purchases: { p1: { id: "p1", vendor: "Shop", date: "2026-09-01", receiptDocumentId: "d1" } },
    items: {
      i1: item("i1", "c1", 1),
      i2: item("i2", "c1", 2),
      i3: item("i3", "c2", 3),
      i4: item("i4", "c1", 4, { description: "" }),
      i5: item("i5", "c1", 5, { submissionId: "s1" }),
    },
    documents: {
      d1: { id: "d1", filename: "receipt.pdf", paymentEvidenceConfidence: 0.95 },
      d2: { id: "d2", filename: "extra.pdf" },
    },
    additionalDocs: { a1: { id: "a1", ownerKind: "purchase", ownerId: "p1", documentId: "d2", kind: "other" } },
    submissions: {},
    settings: { year: { id: "year", submissionDeadline: "2027-06-30" } },
  };
}

describe("planSubmissions", () => {
  it("groups ready items one per purchase x child, lists blocked ones and skips filed ones", () => {
    const plan = planSubmissions(state(), ctx);
    expect(plan.groups.map((g) => [g.childName, g.items.map((i) => i.id)])).toEqual([["Child A", ["i1", "i2"]], ["Child B", ["i3"]]]);
    expect(plan.groups[0]!.additionalDocs.map((d) => d.id)).toEqual(["d2"]);
    expect(plan.blocked.map((b) => [b.item.id, b.reasons.map((r) => r.code)])).toEqual([["i4", ["missing-description"]]]);
    expect(plan.skipped).toBe(1);
  });

  it("skips items past the deadline as forfeited", () => {
    const plan = planSubmissions(state(), { ...ctx, today: "2027-07-01" });
    expect(plan.groups).toEqual([]);
    expect(plan.blocked).toEqual([]);
  });
});
