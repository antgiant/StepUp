import { describe, expect, it } from "vitest";
import {
  NO_DATE,
  itemAmountCents,
  itemProblems,
  lineItemBody,
  newDraftBody,
  saveDraftBody,
  uploadAddressBody,
  uploadHeaders,
  wireDate,
  type FilingContext,
  type ItemInput,
  type ReceiptRef,
} from "../src/index.js";

// The field names of each request as recorded from StepUp's own page (2026-10), sorted. A change here means StepUp changed.
const DRAFT_KEYS = ["Id", "LineItemResults", "PartitionVersion", "additionalDocuments", "assignedToId", "assignedToName", "assignedToRoles", "createdOn", "displayInternalStatus", "documentHash", "excludeCompareFilter", "externalStatus", "guardianId", "guardianName", "guardianSequenceNumber", "hasAppealedItems", "hasDuplicate", "internalProgramId", "internalStatus", "lineItems", "lineItemsTotal", "modifiedOn", "ocrFormatted", "ocrResult", "ocrTimeToProcessInSeconds", "originalSubmitDate", "paymentDate", "processingCompleteDate", "processingStartDate", "programId", "programName", "programType", "providerCode", "providerName", "receipts", "resubmitted", "schoolYear", "sequenceNumber", "skipValidation", "studentId", "studentName", "studentSequenceNumber", "submitDate"];
const ENVELOPE_KEYS = ["ApplyDefaultFilters", "ContextBag", "CurrentPage", "Filters", "IncludeGlobalSearchTotal", "Keywords", "MultiOrderBy", "NextPageCriteria", "OrderBy", "PageCount", "PageSize", "PreviousPageCriteria", "SkipCount", "SortOrder", "TotalRecords"];
const ITEM_KEYS = ["AdditionalCosts", "CostPerItem", "EvaluationFields", "Id", "ItemUrl", "MatchedItemName", "PartitionVersion", "PreAuthSequenceNumber", "PurchaseMaxDate", "PurchaseMinDate", "Quantity", "ServiceMaxDate", "ServiceMinDate", "ServiceProviderPersonIdString", "additionalDocuments", "appealed", "approvedByName", "approvedDate", "approvedInvoiceGroupId", "assignedDate", "assignedToId", "assignedToName", "categoryDetailId", "categoryDetailName", "categoryId", "categoryName", "categoryTypeId", "categoryTypeName", "commentText", "commentType", "displayExternalStatus", "displayInternalStatus", "displayServiceDate", "doeCode", "duplicateLineItemIds", "educationalBenefit", "externalStatus", "internalStatus", "invoiceApprovalDate", "invoiceDate", "isDuplicate", "itemAmount", "lineItemNumber", "modifiedOn", "ocrMatchedItemId", "ocrServiceDate", "ocrValuesModified", "paymentDate", "pendingInvoiceGroupId", "purchaseDate", "reasonCode", "reasonDescription", "reassigned", "receiptId", "resubmitted", "serviceDate", "serviceInvoiceNumber", "serviceProviderCode", "serviceProviderName", "serviceProviderPersonId", "serviceProviderPersonName", "taxPercent", "vendorCode", "vendorName"];
const RECEIPT_KEYS = ["Id", "PartitionVersion", "blobSasUri", "fileData", "fileType", "generatedFileName", "isNew", "link", "modifiedOn", "schoolYear", "sourceFileName", "submitDate"];
const UPLOAD_KEYS = ["BusinessServiceOfferingDocuments", "ElaAssessmentDocuments", "EntityId", "GradeLevelRequestDocuments", "GraduationDocuments", "GuardianDocuments", "HouseholdMemberDocuments", "PCSVerificationDocuments", "PartnerDocuments", "PreAuthorizationDocuments", "ReimbursementDocuments", "ServiceOfferingDocuments", "ShouldUpload", "StandardWithdrawalFormsDocuments", "StudentDocuments", "StudentTestResultsDocuments"];

const sorted = (o: object) => Object.keys(o).sort();
const ctx: FilingContext = {
  guardian: { id: "g-1", sequenceNumber: 1111, name: "Parent Example" },
  student: { id: "s-1", sequenceNumber: 2222, name: "Child Example" },
  program: { internalProgramId: "prog-1", name: "FES-UA", code: 24 },
};
const receipt: ReceiptRef = { id: "r-1", blobSasUri: "https://store.example/c/blob?sig=x", fileName: "receipt.pdf", mediaType: "application/pdf" };
const item: ItemInput = {
  id: "i-1",
  lineNumber: 1,
  quantity: 2,
  costPerItemCents: 1000,
  additionalCostsCents: 500,
  purchaseDate: "2026-10-06",
  invoiceNo: "TEST-1",
  benefit: "test",
  itemUrl: "https://example.test/x",
  category: { categoryId: "c", categoryName: "Instructional Material", typeId: "t", typeName: "Digital Materials", detailId: "d", detailName: "Digital Documents", doeCode: "1234" },
  vendor: { code: "PC_Shop", name: "Shop" },
  receiptId: "r-1",
};

describe("the draft requests match what StepUp's page was recorded sending", () => {
  it("a new draft", () => {
    const b = newDraftBody(ctx, "draft-1");
    expect(sorted(b)).toEqual(DRAFT_KEYS);
    expect(sorted((b["LineItemResults"] as { Info: object }).Info)).toEqual(ENVELOPE_KEYS);
    expect(b).toMatchObject({ Id: "draft-1", externalStatus: "Draft", internalStatus: "Draft", displayInternalStatus: null, submitDate: NO_DATE, schoolYear: null, programType: 0, lineItems: [], receipts: [], guardianId: "g-1", studentId: "s-1", programId: "prog-1", internalProgramId: "prog-1" });
  });

  it("the upload-address request and its receipt item", () => {
    const b = uploadAddressBody("draft-1", receipt);
    expect(sorted(b)).toEqual(UPLOAD_KEYS);
    const docs = b["ReimbursementDocuments"] as { ReceiptDocuments: object[]; ReimbursementId: string };
    expect(sorted(docs.ReceiptDocuments[0]!)).toEqual(RECEIPT_KEYS);
    expect(docs.ReimbursementId).toBe("draft-1");
    expect(b).toMatchObject({ EntityId: "draft-1", ShouldUpload: true });
    expect(docs.ReceiptDocuments[0]).toMatchObject({ blobSasUri: null, fileType: null, sourceFileName: "receipt.pdf" });
    expect(uploadHeaders("application/pdf")).toEqual({ "x-ms-blob-type": "BlockBlob", "content-type": "application/pdf" });
  });

  it("a save with the receipt registered: the server's words stand, the program is its number, the file type a data-URI prefix", () => {
    const server = { id: "draft-1", sequenceNumber: 36525865, schoolYear: "2026-2027", createdOn: "2026-10-14T05:00:00Z", modifiedOn: "2026-10-14T05:01:00Z", displayInternalStatus: "Draft", externalStatus: "Draft", internalStatus: "Draft" };
    const b = saveDraftBody(server, ctx, { receipts: [receipt] });
    expect(sorted(b)).toEqual(DRAFT_KEYS);
    expect(b).toMatchObject({ Id: "draft-1", sequenceNumber: 36525865, schoolYear: "2026-2027", programType: 24, displayInternalStatus: "Draft" });
    const r = (b["receipts"] as Array<Record<string, unknown>>)[0]!;
    expect(sorted(r)).toEqual(RECEIPT_KEYS);
    expect(r).toMatchObject({ Id: "r-1", blobSasUri: receipt.blobSasUri, fileType: "data:application/pdf;base64,", generatedFileName: null });
  });

  it("an item: the observed arithmetic (2 x 10.00 + 5.00 = 25.00) and date format, with both spellings of its fields", () => {
    const li = lineItemBody(item, 36525865);
    expect(sorted(li)).toEqual(ITEM_KEYS);
    expect(li).toMatchObject({
      Quantity: 2, CostPerItem: 10, AdditionalCosts: 5, itemAmount: 25, taxPercent: 0,
      purchaseDate: "2026-10-06T00:00:00", serviceDate: NO_DATE, PurchaseMinDate: NO_DATE, ServiceMaxDate: NO_DATE,
      lineItemNumber: "36525865-1", serviceInvoiceNumber: "TEST-1", ItemUrl: "https://example.test/x", educationalBenefit: "test",
      vendorCode: "PC_Shop", vendorName: "Shop", receiptId: "r-1", externalStatus: "Draft", internalStatus: "Draft",
      categoryId: "c", categoryTypeId: "t", categoryDetailId: "d", doeCode: "1234",
    });
  });

  it("a save with items: the total is the items' amounts and each item is numbered from the reimbursement's number", () => {
    const b = saveDraftBody({ id: "draft-1", sequenceNumber: 77 }, ctx, {
      receipts: [receipt],
      items: [item, { ...item, id: "i-2", lineNumber: 2, quantity: 1, costPerItemCents: 999, additionalCostsCents: 0 }],
    });
    const items = b["lineItems"] as Array<Record<string, unknown>>;
    expect(items.map((i) => i["lineItemNumber"])).toEqual(["77-1", "77-2"]);
    expect(b["lineItemsTotal"]).toBe(25 + 9.99);
  });
});

describe("amounts and dates", () => {
  it("adds up as StepUp does and avoids floating-point drift", () => {
    expect(itemAmountCents(2, 1000, 500)).toBe(2500);
    expect(itemAmountCents(3, 1999, 0)).toBe(5997);
    expect(itemAmountCents(1, 1, 1)).toBe(2);
  });
  it("writes a day as StepUp does, and anything else as not set", () => {
    expect(wireDate("2026-10-06")).toBe("2026-10-06T00:00:00");
    expect(wireDate(undefined)).toBe(NO_DATE);
    expect(wireDate("10/06/2026")).toBe(NO_DATE);
  });
});

describe("what stops an item being written", () => {
  it("is the category's own rules against what was chosen", () => {
    expect(itemProblems(item, {})).toEqual([]);
    expect(itemProblems({ ...item, serviceDate: undefined }, { requiresServiceDate: true })).toEqual(["This category needs a service date."]);
    expect(itemProblems({ ...item, vendor: undefined }, { requiresVendor: true })).toEqual(["This category needs the provider paid."]);
    expect(itemProblems(item, { requiresServiceProvider: true })[0]).toMatch(/service provider/);
    expect(itemProblems({ ...item, quantity: 0, costPerItemCents: 0, benefit: " ", purchaseDate: "" }, {})).toHaveLength(4);
  });
});
