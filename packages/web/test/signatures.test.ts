import { describe, expect, it } from "vitest";
import type { FormMap, MappedControl } from "../src/agent/form.js";
import { isSubmitWords, recognise, summaryTotal } from "../src/agent/signatures.js";

// Maps below have the shape of the recorded ones (October 2026) with invented words; none holds a real value.
const chrome: MappedControl[] = [
  { kind: "dropdown", id: "notificationDropDown", label: "Toggle notifications dropdown", options: 0 },
  { kind: "dropdown", id: "profileDropdown", label: "Toggle profile dropdown", options: 0 },
  { kind: "button", id: "<random-id>", text: "Student Selection" },
  { kind: "button", id: "<random-id>", text: "Summary", disabled: true },
  { kind: "button", id: "<random-id>", build: { classes: ["btn", "btn-link", "textual-stepper-button"], children: ["img"] } },
  { kind: "link", count: 13 },
];
const map = (step: FormMap["step"], controls: MappedControl[], headings: string[] = []): FormMap => ({ mapVersion: 8, step, path: "/x", controls: [...chrome, ...controls], headings: ["Scholarship Portal", ...headings], notices: [] });
const btn = (text: string): MappedControl => ({ kind: "button", id: "<random-id>", text });

const block = "collapseOne____item_1";
const detailsCommon: MappedControl[] = [
  { kind: "date", id: "purchaseDate", label: "Purchase Date*", block, hasValue: true },
  { kind: "text", id: "invoiceNumber", label: "Invoice/Receipt #", block, hasValue: false },
  { kind: "dropdown", id: "category", label: "Category*", block, options: 62 },
  { kind: "text", placeholder: "Enter Quantity", label: "Quantity*", block, hasValue: true },
  { kind: "button", label: "Up", build: { classes: ["rz-numeric-button", "rz-numeric-up"] }, block, count: 3 },
  { kind: "text", placeholder: "Enter Cost per Item", label: "Cost per Item/Service*", block, hasValue: true },
  { kind: "text", placeholder: "Enter Additional Costs", label: "Tax, Shipping, etc", block, hasValue: true },
  { kind: "textarea", id: "educationalBenefit", block, hasValue: false },
  { kind: "text", id: "itemServiceUrl", block, hasValue: false },
  { kind: "button", text: "View Details Hide Details" },
  { kind: "button", id: "<random-id>", text: "Delete", disabled: true, count: 2 },
  btn("Add an Item"),
  btn("Back"),
  btn("Continue Continue to Additional Documents"),
];

describe("recognising the recorded steps", () => {
  it("the student step", () => {
    expect(recognise(map("studentSelection", [{ kind: "dropdown", id: "Student__Select", options: 16 }]))).toMatchObject({ problems: [] });
  });

  it("the upload step, empty and attached", () => {
    const empty = map("upload", [btn("BROWSE"), { kind: "file", id: "inputDrop__", hasValue: false }, btn("BACK"), btn("CONTINUE TO ITEM/SERVICE SELECTION CONTINUE")]);
    expect(recognise(empty).problems).toEqual([]);
    const attached = map("upload", [{ kind: "text", id: "fileName", hasValue: true, disabled: true }, { kind: "button" }, { kind: "button", id: "fileDeleteButton" }, btn("BACK"), btn("CONTINUE TO ITEM/SERVICE SELECTION CONTINUE")]);
    expect(recognise(attached).problems).toEqual([]);
    const reopened = map("upload", [{ kind: "text", id: "fileName", hasValue: true }, btn("Quick View"), { kind: "button", id: "fileDeleteButton", label: "Close" }, btn("BACK"), btn("CONTINUE TO ITEM/SERVICE SELECTION CONTINUE")]);
    expect(recognise(reopened).problems).toEqual([]);
  });

  it("item selection: scanning is busy, and each outcome is its own variant", () => {
    expect(recognise(map("itemSelection", [], ["One moment while we read your document..."]))).toMatchObject({ variant: "scanning", busy: true, problems: [] });
    const none = map("itemSelection", [btn("UPLOAD A DIFFERENT DOCUMENT"), btn("BACK")], ["We were not able to detect items or services on your document"]);
    expect(recognise(none)).toMatchObject({ variant: "notDetected", problems: [] });
    const found = map(
      "itemSelection",
      [
        { kind: "button", text: "zoom_in" },
        { kind: "checkbox", id: "select-all", hasValue: true },
        { kind: "checkbox", id: "item_0", hasValue: true },
        { kind: "text", hasValue: true },
        { kind: "text", placeholder: "$0.00", hasValue: true },
        btn("BACK"),
        btn("CONTINUE TO ITEM/SERVICE DETAILS CONTINUE"),
      ],
      ["Item(s) and/or service(s) detected! Select what you would like to reimburse for <name>"],
    );
    expect(recognise(found)).toMatchObject({ variant: "detected", problems: [] });
  });

  it("item details in the three payee states", () => {
    const vendor = map("itemDetails", [...detailsCommon, { kind: "dropdown", label: "Who did you pay?*", block, options: 116 }, { kind: "text", id: "vendorName", label: "Vendor Name*", block, hasValue: false }]);
    expect(recognise(vendor).problems).toEqual([]);
    const listed = map("itemDetails", [...detailsCommon, { kind: "dropdown", id: "categoryType", block, options: 10 }, { kind: "date", id: "serviceDate", block, hasValue: false }, { kind: "dropdown", id: "provider", label: "Who did you pay?*", block, options: 45 }]);
    expect(recognise(listed).problems).toEqual([]);
    const typed = map("itemDetails", [...detailsCommon, { kind: "dropdown", id: "provider", block, options: 45 }, { kind: "text", id: "otherServiceProviderName", label: "Provider Name*", block, hasValue: false }]);
    expect(recognise(typed).problems).toEqual([]);
  });

  it("item details with the delete question open is its own variant", () => {
    const m = map(
      "itemDetails",
      [...detailsCommon, { kind: "dropdown", label: "Who did you pay?*", block, options: 116 }, { kind: "text", id: "vendorName", block, hasValue: true }, { kind: "link", id: "close_button" }, { kind: "button", id: "deny-button", text: "Cancel" }, { kind: "button", id: "confirm-button", text: "Delete Item" }],
      ["Item 1", "Are you sure you want to delete \"Item 1"],
    );
    expect(recognise(m)).toMatchObject({ variant: "confirmDelete", problems: [] });
  });

  it("additional documents, with documents attached", () => {
    const m = map("additionalDocuments", [
      btn("BROWSE"),
      { kind: "file", id: "inputDrop__", hasValue: true },
      { kind: "link", id: "delete_Document_<id>", text: "Delete", count: 2 },
      { kind: "link", id: "display_Document_<id>", count: 2 },
      btn("BACK"),
      btn("CONTINUE TO SUMMARY CONTINUE"),
    ]);
    expect(recognise(m).problems).toEqual([]);
  });

  it("summary, and its total", () => {
    const m = map("summary", [{ kind: "button", id: "editButton_0", text: "Edit icon" }, { kind: "button", id: "backButton", text: "Back" }, btn("Submit for approval")], ["Review your purchase(s) for <name>", "Total", "$27.78"]);
    expect(recognise(m).problems).toEqual([]);
    expect(summaryTotal(m)).toBe(27.78);
  });
});

describe("saying what is wrong instead of guessing", () => {
  it("flags a control that is not expected, and one that is missing", () => {
    const m = map("itemDetails", [...detailsCommon.filter((c) => c.id !== "purchaseDate"), { kind: "dropdown", label: "Who did you pay?*", block, options: 5 }, { kind: "text", id: "taxExemptNumber", label: "Tax exempt #", block, hasValue: false }]);
    const { problems } = recognise(m);
    expect(problems).toContain("missing: purchase date");
    expect(problems.some((p) => p.startsWith("unexpected: text taxExemptNumber"))).toBe(true);
  });

  it("flags a provider list and a vendor name showing together", () => {
    const m = map("itemDetails", [...detailsCommon, { kind: "dropdown", id: "provider", block, options: 45 }, { kind: "text", id: "vendorName", block, hasValue: false }]);
    expect(recognise(m).problems).toContain("unexpected: a provider list and a vendor name are both showing");
  });

  it("flags attached documents that are not matched by delete links", () => {
    const m = map("additionalDocuments", [btn("BROWSE"), { kind: "file", id: "inputDrop__" }, { kind: "link", id: "display_Document_<id>", count: 2 }, btn("BACK"), btn("CONTINUE TO SUMMARY CONTINUE")]);
    expect(recognise(m).problems.some((p) => p.includes("2 attached document(s)"))).toBe(true);
  });

  it("says nothing is recognised off the wizard or on an unseen page", () => {
    expect(recognise({ mapVersion: 8, path: "/Dashboard", controls: [], headings: [], notices: [] }).problems).toHaveLength(1);
    expect(recognise(map("itemSelection", [], ["Something nobody has seen before"])).problems).toHaveLength(1);
  });

  it("waits while the page says it is loading", () => {
    expect(recognise(map("additionalDocuments", [], ["Loading..."]))).toMatchObject({ busy: true, problems: [] });
  });

  it("knows the words of the final submit button", () => {
    expect(isSubmitWords("Submit for approval")).toBe(true);
    expect(isSubmitWords("SUBMIT")).toBe(true);
    expect(isSubmitWords("Continue")).toBe(false);
  });
});
