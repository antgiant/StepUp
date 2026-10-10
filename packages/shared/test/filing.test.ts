import { describe, expect, it } from "vitest";
import {
  HlcClock,
  Ledger,
  MemoryBackend,
  MemoryEventStore,
  addItem,
  setReadyToSubmit,
  applyStepUpStatuses,
  createPurchase,
  filingGroups,
  mapStepUpStatus,
  planSubmissions,
  recordCategoryFix,
  recordDraftNumber,
  recordNeedsAttention,
  recordSubmitted,
  type RulesContext,
} from "../src/index.js";

const ctx: RulesContext = {
  today: "2026-10-20",
  category: (id) => ({ id, path: id === "bad" ? [] : ["Curriculum", "Books"], requiresServiceDate: false, eligibleScholarships: [], isActive: id !== "bad" }),
};

function setup() {
  const l = new Ledger(new MemoryEventStore(new MemoryBackend(), "dev"), new HlcClock("dev"), "t");
  l.set("child", "kid", { name: "Kid", scholarship: "FES-UA" });
  l.set("paymentMethod", "visa", { label: "Visa 4242", kind: "card" });
  l.set("document", "rcpt", { filename: "Acme 10 01 2026.pdf", contentKind: "receipt-like", sizeBytes: 1000, driveItemId: "drv1", paymentEvidenceConfidence: 0.95 });
  const p = createPurchase(l, { vendor: "Acme", date: "2026-10-01", invoiceNo: "A-1", receiptDocumentId: "rcpt", orderTotalCents: 3200, paymentMethodId: "visa" });
  const common = { childId: "kid", categoryId: "books", benefitMessage: "learning" };
  const i1 = addItem(l, p, { ...common, description: "Workbook", amountCents: 1500, taxShippingCents: 105 });
  const i2 = addItem(l, p, { ...common, description: "Reader", amountCents: 1500, taxShippingCents: 95 });
  setReadyToSubmit(l, i1);
  setReadyToSubmit(l, i2);
  return { l, p, i1, i2 };
}

describe("filing rows", () => {
  it("shape ready items the way the StepUp automation reads them", () => {
    const { l, i1 } = setup();
    const { groups, blocked } = filingGroups(l.state, ctx);
    expect(blocked).toEqual([]);
    expect(groups).toHaveLength(1);
    const g = groups[0]!;
    expect(g).toMatchObject({ child: "Kid", program: "FES-UA", receipt: { id: "rcpt" } });
    expect(g.rows).toHaveLength(2);
    expect(g.rows.find((r) => r.itemId === i1)!.data).toMatchObject({
      ID: i1, Child: "Kid", Program: "FES-UA", Item: "Workbook", Date: "2026-10-01", "Invoice #": "A-1", Category: "Curriculum - Books",
      Amount: "15.00", "Tax, Shipping, etc.": "1.05", "Reim. $": "16.05", Vendor: "Acme", "Payment Method": "Visa 4242", "Benefit Message": "learning", Status: "Unfiled (Ready to Submit)",
    });
  });
});

describe("recording what the automation did", () => {
  it("submitted items leave the plan and keep their StepUp numbers", () => {
    const { l, i1, i2 } = setup();
    recordSubmitted(l, [i1, i2], { reimbursementId: "R-1001", submittedAt: "2026-10-21" });
    expect(l.state.items[i1]).toMatchObject({ lineNumber: 1, stepUpStatus: "Submitted" });
    expect(l.state.items[i2]).toMatchObject({ lineNumber: 2 });
    const sub = l.state.submissions[l.state.items[i1]!.submissionId!]!;
    expect(sub).toMatchObject({ reimbursementId: "R-1001", submittedAt: "2026-10-21" });
    expect(planSubmissions(l.state, ctx).groups).toEqual([]);
    recordSubmitted(l, [i1, i2], { reimbursementId: "R-1001", submittedAt: "2026-10-21" }); // repeat is harmless
    expect(Object.keys(l.state.submissions)).toHaveLength(1);
  });

  it("a draft number is remembered before anything is submitted", () => {
    const { l, i1, i2 } = setup();
    recordDraftNumber(l, [i1, i2], "R-2002");
    expect(l.state.submissions[l.state.items[i1]!.submissionId!]?.reimbursementId).toBe("R-2002");
    expect(l.state.items[i1]!.stepUpStatus).toBeUndefined();
  });

  it("'needs attention' holds the items out of the plan, with the reason, until a person clears it", () => {
    const { l, i1, i2 } = setup();
    recordNeedsAttention(l, [i1], "Receipt is 6.2 MB, over StepUp's 5 MB limit.", "2026-10-20");
    const plan = planSubmissions(l.state, ctx);
    expect(plan.groups[0]!.items.map((i) => i.id)).toEqual([i2]);
    expect(plan.blocked[0]!.reasons.map((r) => r.message).join()).toMatch(/6\.2 MB/);
    expect(l.state.items[i1]!.notes).toBe("[2026-10-20] Receipt is 6.2 MB, over StepUp's 5 MB limit.");
    recordNeedsAttention(l, [i1], "again", "2026-10-21");
    expect(l.state.items[i1]!.notes).toContain(" | [2026-10-21] again");
    l.set("item", i1, { hold: "" });
  });

  it("a category fixed on StepUp's live list is saved on the items", () => {
    const { l, i1 } = setup();
    recordCategoryFix(l, [i1], "Curriculum - Workbooks");
    expect(l.state.items[i1]).toMatchObject({ categoryPath: ["Curriculum", "Workbooks"], categoryId: "legacy-cat-curriculum-workbooks" });
  });
});

describe("StepUp status sync", () => {
  it("maps statuses and amounts", () => {
    expect(mapStepUpStatus("Denied", true)).toBe("Denied (Final)");
    expect(mapStepUpStatus("Denied", false)).toBe("Denied (Initial)");
    expect(mapStepUpStatus("Weird", false)).toBeUndefined();
  });

  it("updates submitted items from the reimbursements list, marking unexplained reductions Adjusted", () => {
    const { l, i1, i2 } = setup();
    recordSubmitted(l, [i1, i2], { reimbursementId: "R-1001", submittedAt: "2026-10-21" });
    const changed = applyStepUpStatuses(l, [
      { LineItemNumber: "R-1001-1", ExternalStatus: "Paid", Appealed: false, ItemAmount: 16.05 },
      { LineItemNumber: "R-1001-2", ExternalStatus: "Approved", Appealed: false, ItemAmount: 10 },
    ]);
    expect(changed).toBe(2);
    expect(l.state.items[i1]).toMatchObject({ stepUpStatus: "Paid", paidCents: 1605 });
    expect(l.state.items[i2]).toMatchObject({ stepUpStatus: "Adjusted", approvedCents: 1000 });
    expect(applyStepUpStatuses(l, [{ LineItemNumber: "R-1001-1", ExternalStatus: "Paid", Appealed: false, ItemAmount: 16.05 }])).toBe(0);
  });

  it("ignores items that were never submitted and lines it does not know", () => {
    const { l } = setup();
    expect(applyStepUpStatuses(l, [{ LineItemNumber: "R-9-1", ExternalStatus: "Paid", Appealed: false, ItemAmount: 1 }])).toBe(0);
  });
});
