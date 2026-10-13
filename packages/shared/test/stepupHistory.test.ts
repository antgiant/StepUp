import { describe, expect, it } from "vitest";
import { deriveLegacyYear, projectReimbursement, reimbursementFileName, type LegacyInput, type LegacyRow, type StepUpReimbursement } from "../src/index.js";

const raw = (number: number, lines: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) => ({
  Id: `guid-${number}`,
  SequenceNumber: number,
  SchoolYear: "2025-2026",
  ExternalStatus: "Complete",
  StudentName: "Child A",
  SubmitDate: "2026-02-03T10:00:00Z",
  Receipts: [{ Id: "r1", SourceFileName: "216 - amazon.pdf" }],
  LineItems: lines.map((l, n) => ({ LineItemNumber: `${number}-${n + 1}`, ExternalStatus: "Submitted", Appealed: false, ItemAmount: 12.5, CategoryName: "Curriculum", CategoryTypeName: "Workbooks", ...l })),
  ...extra,
});

const row = (id: number, extra: Record<string, unknown>): LegacyRow => ({
  values: { ID: id, Child: "Child A", Item: `Item ${id}`, Vendor: "Shop", Amount: 12.5, Status: "", ...extra },
  docFiles: ["receipt.pdf"],
});

const input = (rows: LegacyRow[], stepUp: StepUpReimbursement[]): Omit<LegacyInput, "mode" | "receiptChoices"> => ({
  yearLabel: "2025-2026",
  rows,
  children: [{ name: "Child A" }],
  paymentMethods: [],
  files: [{ name: "receipt.pdf", id: "o1", size: 1 }],
  stepUp,
});

describe("StepUp's own list of a year", () => {
  it("is reduced to what the app shows, and each reimbursement has its own file", () => {
    const p = projectReimbursement(raw(36325766, [{ ReasonDescription: "Not an approved expense", CommentText: "No.\t", CommentType: "External", ServiceDate: "0001-01-01T00:00:00" }]))!;
    expect(reimbursementFileName(p)).toBe("36325766.json");
    expect(p.lines[0]).toMatchObject({ number: "36325766-1", amountCents: 1250, category: ["Curriculum", "Workbooks"], reason: "Not an approved expense", comment: "No." });
    expect(p.lines[0]!.serviceDate).toBeUndefined();
    expect(projectReimbursement({ Id: "x" })).toBeUndefined();
  });

  it("outranks what an Excel row says about an item, and leaves the rest of the row alone", () => {
    const stepUp = [projectReimbursement(raw(100, [{ ExternalStatus: "Paid", ReasonDescription: "Documentation received" }, { ExternalStatus: "Denied", ReasonDescription: "Duplicate request" }]))!];
    const rows = [
      row(1, { "Reimbursement ID": 100, "Line Number": 1, Status: "Submitted" }),
      row(2, { "Reimbursement ID": 100, "Line Number": 2, Status: "Approved", Notes: "mine" }),
    ];
    const { result } = deriveLegacyYear(input(rows, stepUp), {});
    expect(result.state.items["legacy-1"]).toMatchObject({ stepUpStatus: "Paid", statusOverride: "Paid", paidCents: 1250, stepUpMessage: "Documentation received" });
    expect(result.state.items["legacy-2"]).toMatchObject({ stepUpStatus: "Denied (Initial)", statusOverride: "Denied (Initial)", notes: "mine", stepUpMessage: "Duplicate request" });
    expect(result.state.submissions["sub-100"]?.guid).toBe("guid-100");
  });

  it("adds a reimbursement the sheet never recorded, as its own purchase", () => {
    const stepUp = [projectReimbursement(raw(200, [{ ExternalStatus: "Appealed", Appealed: true, MatchedItemName: "Fun card" }]))!];
    const { result } = deriveLegacyYear(input([row(1, {})], stepUp), {});
    expect(result.state.items["stepup-200-1"]).toMatchObject({ description: "Fun card", stepUpStatus: "Appealed", submissionId: "sub-200", amountCents: 1250 });
    expect(result.state.purchases["purchase-stepup-200"]).toBeDefined();
    expect(Object.values(result.state.children).map((c) => c.name)).toEqual(["Child A"]);
  });

  it("is a whole year on its own when there is no workbook", () => {
    const stepUp = [projectReimbursement(raw(300, [{ ExternalStatus: "Paid" }, { ExternalStatus: "Paid" }], { StudentName: "Child B" }))!];
    const { result } = deriveLegacyYear({ yearLabel: "2024-2025", rows: [], children: [], paymentMethods: [], files: [], stepUp }, {});
    expect(Object.values(result.state.items)).toHaveLength(2);
    expect(Object.values(result.state.children).map((c) => c.name)).toEqual(["Child B"]);
    expect(Object.values(result.state.purchases)).toHaveLength(1);
  });
});
