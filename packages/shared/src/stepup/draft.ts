/**
 * The requests that make a StepUp reimbursement draft, built as plain data. Nothing here sends anything: it is the
 * knowledge, recorded from StepUp's own page (2026-10), of what a draft, its receipt and its items look like on the wire,
 * so the filing step can show a dry run and, once the owner agrees, send exactly these.
 *
 * Everything below was observed, not guessed: field names and their order of appearance from recordings, fixed words
 * from sampled settings, and the arithmetic and date formats from a recording made with made-up values.
 */

/** A date StepUp uses for "not set". */
export const NO_DATE = "0001-01-01T00:00:00";

/** "2026-10-06" -> "2026-10-06T00:00:00" (what a purchase or service date looks like on the wire); anything else is "not set". */
export function wireDate(day: string | undefined): string {
  return day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? `${day}T00:00:00` : NO_DATE;
}

const dollars = (cents: number): number => Math.round(cents) / 100;

/**
 * An item's amount as StepUp keeps it: quantity times the cost of one, plus additional costs (tax, shipping, ...).
 * Observed: 2 x 10.00 + 5.00 = 25.00, with `taxPercent` 0.
 */
export function itemAmountCents(quantity: number, costPerItemCents: number, additionalCostsCents: number): number {
  return Math.round(quantity * costPerItemCents) + Math.round(additionalCostsCents);
}

/** Who and what a draft is for. All of it is already in StepUp's own responses (see the origins in docs/AGENT_PLAN.md). */
export interface FilingContext {
  guardian: { id: string; sequenceNumber: number; name: string };
  student: { id: string; sequenceNumber: number; name: string };
  program: {
    /** The program's id (a scholarship's `internalProgramId`); used for both `programId` and `internalProgramId`. */
    internalProgramId: string;
    /** Its display name, as the draft shows it ("FES-UA"). */
    name: string;
    /** The program's number (24 for FES-UA): what a saved draft's `programType` holds. */
    code: number;
  };
}

/** The envelope StepUp wraps a draft's (empty) line-item search in; observed unchanged on create, save and delete. */
const lineItemResults = () => ({
  Info: {
    ApplyDefaultFilters: true,
    ContextBag: {},
    CurrentPage: null,
    Filters: {},
    IncludeGlobalSearchTotal: false,
    Keywords: null,
    MultiOrderBy: {},
    NextPageCriteria: null,
    OrderBy: null,
    PageCount: 0,
    PageSize: null,
    PreviousPageCriteria: null,
    SkipCount: false,
    SortOrder: 0,
    TotalRecords: 0,
  },
  Results: [],
});

/** `POST …/reimbursements/v2`: a new, empty draft. `draftId` is a new GUID chosen by the caller (the page chooses its own). */
export function newDraftBody(ctx: FilingContext, draftId: string): Record<string, unknown> {
  return {
    Id: draftId,
    LineItemResults: lineItemResults(),
    PartitionVersion: 0,
    additionalDocuments: [],
    assignedToId: null,
    assignedToName: null,
    assignedToRoles: null,
    createdOn: null,
    displayInternalStatus: null,
    documentHash: null,
    excludeCompareFilter: null,
    externalStatus: "Draft",
    guardianId: ctx.guardian.id,
    guardianName: ctx.guardian.name,
    guardianSequenceNumber: ctx.guardian.sequenceNumber,
    hasAppealedItems: false,
    hasDuplicate: false,
    internalProgramId: ctx.program.internalProgramId,
    internalStatus: "Draft",
    lineItems: [],
    lineItemsTotal: 0,
    modifiedOn: null,
    ocrFormatted: null,
    ocrResult: null,
    ocrTimeToProcessInSeconds: null,
    originalSubmitDate: null,
    paymentDate: null,
    processingCompleteDate: null,
    processingStartDate: null,
    programId: ctx.program.internalProgramId,
    programName: ctx.program.name,
    programType: 0,
    providerCode: null,
    providerName: null,
    receipts: [],
    resubmitted: false,
    schoolYear: null,
    sequenceNumber: 0,
    skipValidation: false,
    studentId: ctx.student.id,
    studentName: ctx.student.name,
    studentSequenceNumber: ctx.student.sequenceNumber,
    submitDate: NO_DATE,
  };
}

/** A receipt as the draft's save carries it, after it has been uploaded to the address `documents-sasuri` gave. */
export interface ReceiptRef {
  /** A new GUID, the same one used in the upload-address request. */
  id: string;
  /** The upload address returned for it (`blobSasUri`). */
  blobSasUri: string;
  /** The original file's name. */
  fileName: string;
  /** The file's media type: "application/pdf", "image/jpeg". */
  mediaType: string;
}

const receiptItem = (r: ReceiptRef, withAddress: boolean) => ({
  Id: r.id,
  PartitionVersion: 0,
  blobSasUri: withAddress ? r.blobSasUri : null,
  fileData: null,
  // Observed: a data-URI prefix, not a media type, when registered on a save; null in the upload-address request.
  fileType: withAddress ? `data:${r.mediaType};base64,` : null,
  generatedFileName: null,
  isNew: null,
  link: null,
  modifiedOn: null,
  schoolYear: null,
  sourceFileName: r.fileName,
  submitDate: null,
});

/** `POST …/documents-sasuri`: ask for an address to upload one receipt to. */
export function uploadAddressBody(draftId: string, receipt: ReceiptRef): Record<string, unknown> {
  return {
    BusinessServiceOfferingDocuments: null,
    ElaAssessmentDocuments: null,
    EntityId: draftId,
    GradeLevelRequestDocuments: null,
    GraduationDocuments: null,
    GuardianDocuments: null,
    HouseholdMemberDocuments: null,
    PCSVerificationDocuments: null,
    PartnerDocuments: null,
    PreAuthorizationDocuments: null,
    ReimbursementDocuments: { AdditionalDocuments: [], LineItemDocuments: [], ReceiptDocuments: [receiptItem(receipt, false)], ReimbursementId: draftId },
    ServiceOfferingDocuments: null,
    ShouldUpload: true,
    StandardWithdrawalFormsDocuments: null,
    StudentDocuments: null,
    StudentTestResultsDocuments: null,
  };
}

/** The headers of the upload to the address (`PUT <blobSasUri>`): a plain Azure blob write. */
export const uploadHeaders = (mediaType: string): Record<string, string> => ({ "x-ms-blob-type": "BlockBlob", "content-type": mediaType });

/** What a person chose for one item. Money is in cents; dates are "YYYY-MM-DD". */
export interface ItemInput {
  /** A new GUID for the item. */
  id: string;
  /** 1, 2, ...: the item's place in the reimbursement (its line number once filed). */
  lineNumber: number;
  quantity: number;
  costPerItemCents: number;
  /** Tax, shipping and other costs added to the item. */
  additionalCostsCents: number;
  purchaseDate: string;
  serviceDate?: string;
  invoiceNo?: string;
  /** The benefit message ("how does this help learning"). */
  benefit: string;
  itemUrl?: string;
  category: {
    categoryId: string;
    categoryName: string;
    typeId?: string;
    typeName?: string;
    detailId?: string;
    detailName?: string;
    /** The category's `DoeCode`, which the saved item repeats. */
    doeCode?: string;
  };
  /** The provider chosen in "Who did you pay?": its `ProviderCode` and `Name`. */
  vendor?: { code: string; name: string };
  /** Which receipt (its `Id`) this item is on. */
  receiptId: string;
}

/** One line item as a save carries it. `sequenceNumber` is the draft's reimbursement number (the item's number is `<it>-<line>`). */
export function lineItemBody(item: ItemInput, sequenceNumber: number): Record<string, unknown> {
  const amount = itemAmountCents(item.quantity, item.costPerItemCents, item.additionalCostsCents);
  return {
    // StepUp's model spells these in PascalCase; everything else is camelCase. Both spellings were observed in one object.
    AdditionalCosts: dollars(item.additionalCostsCents),
    CostPerItem: dollars(item.costPerItemCents),
    EvaluationFields: [],
    Id: item.id,
    ItemUrl: item.itemUrl ?? "",
    MatchedItemName: null,
    PartitionVersion: 0,
    PreAuthSequenceNumber: null,
    PurchaseMaxDate: NO_DATE,
    PurchaseMinDate: NO_DATE,
    Quantity: item.quantity,
    ServiceMaxDate: NO_DATE,
    ServiceMinDate: NO_DATE,
    ServiceProviderPersonIdString: "",
    additionalDocuments: [],
    appealed: false,
    approvedByName: null,
    approvedDate: null,
    approvedInvoiceGroupId: null,
    assignedDate: NO_DATE,
    assignedToId: null,
    assignedToName: null,
    categoryDetailId: item.category.detailId ?? null,
    categoryDetailName: item.category.detailName ?? "",
    categoryId: item.category.categoryId,
    categoryName: item.category.categoryName,
    categoryTypeId: item.category.typeId ?? null,
    categoryTypeName: item.category.typeName ?? "",
    commentText: null,
    commentType: null,
    displayExternalStatus: "Draft",
    displayInternalStatus: "Draft",
    displayServiceDate: null,
    doeCode: item.category.doeCode ?? "",
    duplicateLineItemIds: [],
    educationalBenefit: item.benefit,
    externalStatus: "Draft",
    internalStatus: "Draft",
    invoiceApprovalDate: null,
    invoiceDate: null,
    isDuplicate: false,
    itemAmount: dollars(amount),
    lineItemNumber: `${sequenceNumber}-${item.lineNumber}`,
    modifiedOn: null,
    ocrMatchedItemId: null,
    ocrServiceDate: null,
    ocrValuesModified: null,
    paymentDate: NO_DATE,
    pendingInvoiceGroupId: null,
    purchaseDate: wireDate(item.purchaseDate),
    reasonCode: null,
    reasonDescription: null,
    reassigned: false,
    receiptId: item.receiptId,
    resubmitted: null,
    serviceDate: wireDate(item.serviceDate),
    serviceInvoiceNumber: item.invoiceNo ?? "",
    serviceProviderCode: null,
    serviceProviderName: null,
    serviceProviderPersonId: null,
    serviceProviderPersonName: null,
    taxPercent: 0,
    vendorCode: item.vendor?.code ?? null,
    vendorName: item.vendor?.name ?? null,
  };
}

/**
 * `PUT …/reimbursements/v2/{id}`: the draft as the server last returned it, with the receipt(s) and item(s) set. The page
 * always saves the whole object; `server` is what the last `POST`/`GET`/`PUT` replied (lower-case keys, as StepUp returns it).
 */
export function saveDraftBody(server: Record<string, unknown>, ctx: FilingContext, change: { receipts?: ReceiptRef[]; items?: ItemInput[] }): Record<string, unknown> {
  const sequenceNumber = typeof server["sequenceNumber"] === "number" ? (server["sequenceNumber"] as number) : 0;
  const inputs = change.items ?? [];
  const items = inputs.map((i) => lineItemBody(i, sequenceNumber));
  const totalCents = inputs.reduce((n, i) => n + itemAmountCents(i.quantity, i.costPerItemCents, i.additionalCostsCents), 0);
  const keep = <T>(k: string, fallback: T): unknown => (server[k] !== undefined ? server[k] : fallback);
  return {
    ...(newDraftBody(ctx, String(server["id"] ?? ""))),
    // Everything the server decided stands as it returned it:
    createdOn: keep("createdOn", null),
    displayInternalStatus: keep("displayInternalStatus", "Draft"),
    modifiedOn: keep("modifiedOn", null),
    externalStatus: keep("externalStatus", "Draft"),
    internalStatus: keep("internalStatus", "Draft"),
    schoolYear: keep("schoolYear", null),
    sequenceNumber,
    // ...except the program, which a saved draft states as its number:
    programType: ctx.program.code,
    lineItems: items,
    lineItemsTotal: dollars(totalCents),
    receipts: (change.receipts ?? []).map((r) => receiptItem(r, true)),
  };
}

/** What stops an item being written: the category's own rules, as StepUp reports them, against what was chosen. */
export interface CategoryRules {
  requiresServiceDate?: boolean | null;
  requiresVendor?: boolean | null;
  requiresServiceProvider?: boolean | null;
  requiresDocumentation?: boolean | null;
  requiresAdditionalInfo?: boolean | null;
}

export function itemProblems(item: ItemInput, rules: CategoryRules): string[] {
  const out: string[] = [];
  if (!(item.quantity > 0)) out.push("Quantity must be at least 1.");
  if (!(item.costPerItemCents > 0)) out.push("The cost of one item is missing.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(item.purchaseDate)) out.push("The purchase date is missing.");
  if (!item.benefit.trim()) out.push("The benefit message is missing.");
  if (!item.category.categoryId) out.push("A category is needed.");
  if (rules.requiresServiceDate && !item.serviceDate) out.push("This category needs a service date.");
  if (rules.requiresVendor && !item.vendor) out.push("This category needs the provider paid.");
  // Writing a service provider (a person) is not supported yet: nothing about it has been recorded.
  if (rules.requiresServiceProvider) out.push("This category needs a service provider, which filing does not write yet.");
  return out;
}
