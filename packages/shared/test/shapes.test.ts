import { describe, expect, it } from "vitest";
import { checkStepUpShape } from "../src/index.js";

// Made-up responses in the shape the code reads today.
const good = {
  reimbursements: { Results: [{ LineItems: [{ LineItemNumber: "4521-1", ExternalStatus: "Paid", Appealed: false, ItemAmount: 16.05, Extra: "ignored" }] }] },
  categories: { Results: [{ Id: "g1", Name: "Curriculum", Types: ["t1"], IsActive: true, IsDeleted: false, ApprovedPrograms: [{ PartnerId: 24 }] }] },
  draft: { sequenceNumber: 4521, externalStatus: "Draft", submitDate: "0001-01-01T00:00:00", lineItems: [{}], additionalDocuments: [] },
};

describe("StepUp response shapes", () => {
  it("accept the shapes the code was written against, with extra fields", () => {
    expect(checkStepUpShape("reimbursements-search", good.reimbursements)).toEqual([]);
    expect(checkStepUpShape("categories-search", good.categories)).toEqual([]);
    expect(checkStepUpShape("draft", good.draft)).toEqual([]);
    expect(checkStepUpShape("draft", {})).toEqual([]); // every draft field is optional
  });

  it("say which field changed when StepUp renames or retypes something", () => {
    const renamed = { Results: [{ LineItems: [{ LineItemNo: "4521-1", ExternalStatus: "Paid", Appealed: false, ItemAmount: 16.05 }] }] };
    expect(checkStepUpShape("reimbursements-search", renamed)).toEqual(["response.Results[0].LineItems[0].LineItemNumber: expected text, got undefined"]);
    const retyped = { Results: [{ LineItems: [{ LineItemNumber: "1-1", ExternalStatus: "Paid", Appealed: "no", ItemAmount: "16.05" }] }] };
    expect(checkStepUpShape("reimbursements-search", retyped)).toHaveLength(2);
    expect(checkStepUpShape("categories-search", { Results: { Id: "x" } })).toEqual(["response.Results: expected a list, got an object"]);
    expect(checkStepUpShape("categories-search", null)).toEqual(["response: expected an object, got null"]);
  });
});
