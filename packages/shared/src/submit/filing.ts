import type { DocumentRec, LedgerState, LineItem } from "../domain/types.js";
import { effectiveDate, effectiveInvoice, effectiveVendor, requestedCents, type RulesContext } from "../rules/readiness.js";
import { planSubmissions, type BlockedItem } from "./plan.js";

/** The status text the StepUp automation looks for; the ledger derives readiness, so this is only the label handed to it. */
export const READY_LABEL = "Unfiled (Ready to Submit)";

/** One item shaped the way the StepUp form-filling code reads it (the old Table1 column names). */
export interface FilingRow {
  itemId: string;
  data: Record<string, string>;
}

export interface FilingGroup {
  purchaseId: string;
  childId: string;
  child: string;
  program: string;
  receipt: DocumentRec;
  additionalDocs: DocumentRec[];
  /** Statements that would be sent un-redacted (file names). */
  unredactedStatements: string[];
  rows: FilingRow[];
}

const dollars = (cents: number | undefined): string => (cents === undefined ? "" : (cents / 100).toFixed(2));

/** An item as the automation expects to read it. Dates are ISO (the automation accepts those as well as Excel serials). */
export function filingRow(state: LedgerState, item: LineItem, ctx: RulesContext): FilingRow {
  const purchase = state.purchases[item.purchaseId ?? ""];
  const child = state.children[item.childId ?? ""];
  const submission = state.submissions[item.submissionId ?? ""];
  const path = (item.categoryId ? ctx.category(item.categoryId)?.path : undefined) ?? item.categoryPath;
  const data: Record<string, string> = {
    ID: item.id,
    Child: child?.name ?? "",
    Program: child?.scholarship ?? "",
    Item: item.description ?? "",
    Description: item.description ?? "",
    Date: effectiveDate(item, purchase) ?? "",
    "Service Date": item.serviceDate ?? "",
    "Invoice #": effectiveInvoice(item, purchase) ?? "",
    Category: path?.join(" - ") ?? "",
    Quantity: item.quantity === undefined ? "" : String(item.quantity),
    Amount: dollars(item.amountCents),
    "Tax, Shipping, etc.": dollars(item.taxShippingCents),
    "Reim. $": dollars(requestedCents(item)),
    Vendor: effectiveVendor(item, purchase) ?? "",
    "Service Provider": item.serviceProvider ?? "",
    "Payment Method": state.paymentMethods[purchase?.paymentMethodId ?? ""]?.label ?? "",
    "Benefit Message": item.benefitMessage ?? "",
    "Item/Service URL": item.itemUrl ?? "",
    "Pre-Auth #": item.preAuthId ?? "",
    Status: READY_LABEL,
    Notes: item.notes ?? "",
    "Reimbursement ID": submission?.reimbursementId ?? "",
    "Line Number": item.lineNumber === undefined ? "" : String(item.lineNumber),
  };
  return { itemId: item.id, data };
}

/** What can be filed now, one group per StepUp submission (a purchase x a child), shaped for the automation. */
export function filingGroups(state: LedgerState, ctx: RulesContext): { groups: FilingGroup[]; blocked: BlockedItem[] } {
  const plan = planSubmissions(state, ctx);
  return {
    blocked: plan.blocked,
    groups: plan.groups.map((g) => ({
      purchaseId: g.purchaseId,
      childId: g.childId,
      child: g.childName,
      program: state.children[g.childId]?.scholarship ?? "",
      receipt: g.receipt,
      additionalDocs: g.additionalDocs,
      unredactedStatements: g.unredactedStatements,
      rows: g.items.map((i) => filingRow(state, i, ctx)),
    })),
  };
}
