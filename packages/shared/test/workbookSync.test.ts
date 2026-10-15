import { describe, expect, it } from "vitest";
import { mapApiStatus, planWorkbookStatusSync } from "../src/stepup/workbookSync.js";

const headers = ["ID", "Status", "Reimbursement ID", "Line Number", "Amount", "Reim. $", "Reimbursed Amount", "Notes"];
const row = (over: Partial<Record<string, string | number>> = {}): unknown[] => {
  const base: Record<string, string | number> = { ID: "1", Status: "Submitted", "Reimbursement ID": "5000", "Line Number": "1", Amount: 10, "Reim. $": 10, "Reimbursed Amount": "", Notes: "", ...over };
  return headers.map((h) => base[h]);
};
const list = (items: Array<Record<string, unknown>>): unknown[] => [{ Id: "g", LineItems: items }];
const valid = ["Submitted", "Approved", "Denied (Initial)", "Denied (Final)", "Adjusted"];

describe("mapApiStatus", () => {
  it("maps the four raw values and splits a denial by appeal; anything else is left alone", () => {
    expect(mapApiStatus("Paid", false)).toBe("Paid");
    expect(mapApiStatus("Denied", false)).toBe("Denied (Initial)");
    expect(mapApiStatus("Denied", true)).toBe("Denied (Final)");
    expect(mapApiStatus("Pending", false)).toBeUndefined();
  });
});

describe("planWorkbookStatusSync", () => {
  it("sets the status and the reimbursed amount for an approved item matched by id and line", () => {
    const plan = planWorkbookStatusSync(headers, [row()], valid, list([{ LineItemNumber: "5000-1", ExternalStatus: "Approved", Appealed: false, ItemAmount: 10 }]));
    expect(plan.updates).toEqual([{ rowIndex: 0, label: "5000-1", changes: { Status: "Approved", "Reimbursed Amount": 10 } }]);
  });

  it("calls an amount that matches neither Amount nor Reim. $ Adjusted", () => {
    const plan = planWorkbookStatusSync(headers, [row()], valid, list([{ LineItemNumber: "5000-1", ExternalStatus: "Approved", ItemAmount: 7 }]));
    expect(plan.updates[0]!.changes).toMatchObject({ Status: "Adjusted", "Reimbursed Amount": 7 });
  });

  it("adds a status the app defines to the list, and leaves rows alone for one it does not", () => {
    const paid = planWorkbookStatusSync(headers, [row()], valid, list([{ LineItemNumber: "5000-1", ExternalStatus: "Paid", ItemAmount: 10 }]));
    expect(paid.addStatuses).toEqual(["Paid"]);
    expect(paid.updates[0]!.changes["Status"]).toBe("Paid");
    const odd = planWorkbookStatusSync(headers, [row()], ["Submitted"], list([{ LineItemNumber: "5000-1", ExternalStatus: "Approved", ItemAmount: 10 }]));
    expect(odd.unknownStatuses).toEqual(["Approved"]);
    expect(odd.updates).toEqual([]);
  });

  it("changes nothing when the row is already as StepUp says, and ignores rows that were never submitted", () => {
    const same = planWorkbookStatusSync(headers, [row({ Status: "Submitted" }), row({ ID: "2", "Reimbursement ID": "", "Line Number": "" })], valid, list([{ LineItemNumber: "5000-1", ExternalStatus: "Submitted", ItemAmount: 10 }]));
    expect(same.updates).toEqual([]);
  });

  it("puts a denial's reason on the notes once", () => {
    const item = { LineItemNumber: "5000-1", ExternalStatus: "Denied", Appealed: false, ItemAmount: 0, ReasonDescription: "Not an approved expense" };
    const first = planWorkbookStatusSync(headers, [row()], valid, list([item]));
    const note = String(first.updates[0]!.changes["Notes"]);
    expect(note).toMatch(/^StepUp: /);
    const again = planWorkbookStatusSync(headers, [row({ Status: "Denied (Initial)", Notes: note })], valid, list([item]));
    expect(again.updates).toEqual([]);
  });

  it("refuses a layout without the matching columns", () => {
    expect(() => planWorkbookStatusSync(["ID", "Status"], [], valid, [])).toThrow(/missing/);
  });
});
