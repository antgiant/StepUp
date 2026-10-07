import { DEFAULT_TAX_RATE } from "../domain/money.js";
import type { AdditionalDoc, LedgerState, LineItem, Purchase } from "../domain/types.js";

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
/** A receipt whose payment-evidence confidence is at least this counts as proof of payment on its own. */
export const PAYMENT_EVIDENCE_MIN = 0.8;

export interface CategoryInfo {
  id: string;
  path: string[];
  requiresServiceDate: boolean;
  /** Scholarship labels the category is eligible for (e.g. "FES-UA"). */
  eligibleScholarships: string[];
  isActive: boolean;
}

export interface RulesContext {
  category(id: string): CategoryInfo | undefined;
  /** Today's date (ISO), injected so rules stay pure and testable. */
  today: string;
}

export type ReasonCode =
  | "missing-child"
  | "missing-description"
  | "missing-amount"
  | "missing-benefit-message"
  | "missing-category"
  | "unknown-category"
  | "category-ineligible"
  | "missing-service-date"
  | "missing-purchase"
  | "missing-vendor"
  | "missing-purchase-date"
  | "missing-receipt"
  | "receipt-document-missing"
  | "receipt-also-additional"
  | "receipt-too-large"
  | "awaiting-proof"
  | "items-exceed-receipt-total"
  | "on-hold";

export interface Reason {
  code: ReasonCode;
  message: string;
}

export type Readiness = "ready" | "blocked";

export interface Evaluation {
  readiness: Readiness;
  reasons: Reason[];
}

export const effectiveDate = (item: LineItem, purchase?: Purchase) => item.date ?? purchase?.date;
export const effectiveInvoice = (item: LineItem, purchase?: Purchase) => item.invoiceNo ?? purchase?.invoiceNo;
export const effectiveVendor = (item: LineItem, purchase?: Purchase) => item.vendor ?? purchase?.vendor;

export function requestedCents(item: LineItem): number {
  return (item.amountCents ?? 0) + (item.taxShippingCents ?? 0);
}

export function additionalDocsFor(state: LedgerState, item: LineItem, purchase: Purchase | undefined): AdditionalDoc[] {
  return Object.values(state.additionalDocs).filter(
    (a) => (a.ownerKind === "item" && a.ownerId === item.id) || (a.ownerKind === "purchase" && purchase && a.ownerId === purchase.id)
  );
}

function hasPaymentProof(state: LedgerState, purchase: Purchase, additional: AdditionalDoc[]): boolean {
  const receipt = purchase.receiptDocumentId ? state.documents[purchase.receiptDocumentId] : undefined;
  if ((receipt?.paymentEvidenceConfidence ?? 0) >= PAYMENT_EVIDENCE_MIN) return true;
  return additional.some((a) => a.kind === "payment-proof" && a.documentId && state.documents[a.documentId]);
}

/** Pure readiness check for one line item. Replaces the hand-set "Unfiled (Missing Things)" / "(Ready to Submit)" status. */
export function evaluateItem(state: LedgerState, itemId: string, ctx: RulesContext): Evaluation {
  const item = state.items[itemId];
  const reasons: Reason[] = [];
  const add = (code: ReasonCode, message: string) => reasons.push({ code, message });
  if (!item) return { readiness: "blocked", reasons: [{ code: "missing-purchase", message: "Item not found" }] };

  if (!item.childId || !state.children[item.childId]) add("missing-child", "Choose which child this is for");
  if (!item.description?.trim()) add("missing-description", "Add a description");
  if (!item.amountCents || item.amountCents <= 0) add("missing-amount", "Enter the amount");
  if (!item.benefitMessage?.trim()) add("missing-benefit-message", "Add the benefit message");

  if (!item.categoryId) {
    add("missing-category", "Choose a category");
  } else {
    const cat = ctx.category(item.categoryId);
    if (!cat || !cat.isActive) {
      add("unknown-category", "Category is unknown or no longer active");
    } else {
      const scholarship = item.childId ? state.children[item.childId]?.scholarship : undefined;
      // An empty eligibility list means "not known yet" (it fills in gradually from StepUp), so it is never flagged.
      if (scholarship && cat.eligibleScholarships.length > 0 && !cat.eligibleScholarships.some((s) => norm(s) === norm(scholarship))) {
        add("category-ineligible", `Category is not eligible for ${scholarship}`);
      }
      if (cat.requiresServiceDate && !item.serviceDate) add("missing-service-date", "This category needs a Service Date");
    }
  }

  // A "missing Service Date" hold clears itself once the date is filled in; other holds stay until removed.
  if (item.hold && !(item.hold === "missing-service-date" && item.serviceDate)) {
    add("on-hold", item.holdNote?.trim() || `On hold: ${item.hold}`);
  }

  const purchase = item.purchaseId ? state.purchases[item.purchaseId] : undefined;
  if (!purchase) {
    add("missing-purchase", "Attach this item to a purchase");
  } else {
    // StepUp wants a vendor or a provider for an item, never both: either one satisfies this.
    if (!effectiveVendor(item, purchase)?.trim() && !item.serviceProvider?.trim()) add("missing-vendor", "Add the vendor or service provider");
    if (!effectiveDate(item, purchase)) add("missing-purchase-date", "Add the purchase date");

    const receiptId = purchase.receiptDocumentId;
    const receipt = receiptId ? state.documents[receiptId] : undefined;
    const additional = additionalDocsFor(state, item, purchase);
    if (!receiptId) {
      add("missing-receipt", "Attach the receipt");
    } else if (!receipt) {
      add("receipt-document-missing", "The receipt file is missing");
    } else {
      if ((receipt.sizeBytes ?? 0) > MAX_UPLOAD_BYTES) add("receipt-too-large", "Receipt is over StepUp's 5 MB limit");
      if (additional.some((a) => a.documentId === receiptId)) add("receipt-also-additional", "The receipt is also listed as additional documentation");
    }
    if (receipt && !hasPaymentProof(state, purchase, additional)) {
      add("awaiting-proof", "Needs proof of payment: a receipt that shows payment, or a statement");
    }

    if (purchase.orderTotalCents !== undefined) {
      const sibling = Object.values(state.items).filter((i) => i.purchaseId === purchase.id);
      const total = sibling.reduce((sum, i) => sum + requestedCents(i), 0);
      if (total > purchase.orderTotalCents) add("items-exceed-receipt-total", "Items add up to more than the receipt total");
    }
  }

  return { readiness: reasons.length === 0 ? "ready" : "blocked", reasons };
}

function norm(s: string): string {
  return s.replace(/[^a-z0-9]/gi, "").toUpperCase();
}

const SUBMITTED_LIKE = new Set(["Submitted", "Re-Submitted", "Approved", "Adjusted", "Paid", "Denied (Initial)", "Denied (Final)"]);

export function isFiled(item: LineItem): boolean {
  return Boolean(item.submissionId) || SUBMITTED_LIKE.has(item.stepUpStatus ?? "");
}

/** Status label in the old workbook's vocabulary (used by the mirror spreadsheet and the CLI). */
export function displayStatus(item: LineItem, evaluation: Evaluation, ctx: RulesContext, submissionDeadline?: string): string {
  if (item.statusOverride) return item.statusOverride;
  if (item.stepUpStatus) return item.stepUpStatus;
  if (item.submissionId) return "Submitted";
  if (submissionDeadline && ctx.today > submissionDeadline) return "Forfeited";
  return evaluation.readiness === "ready" ? "Unfiled (Ready to Submit)" : "Unfiled (Missing Things)";
}

/** Tax/shipping estimate: used only while no receipt value is known. */
export function defaultTaxRate(state: LedgerState): number {
  return state.settings["year"]?.defaultTaxRate ?? DEFAULT_TAX_RATE;
}
