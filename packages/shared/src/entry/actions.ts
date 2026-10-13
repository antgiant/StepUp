import type { LedgerState, LineItem, Purchase } from "../domain/types.js";
import { estimateTaxCents } from "../domain/money.js";
import type { Ledger } from "../events/ledger.js";
import type { Json } from "../events/types.js";
import { defaultTaxRate, requestedCents } from "../rules/readiness.js";
import { newId } from "../util/ids.js";
import { allocateProportionally } from "./allocate.js";

type Fields = Record<string, Json | undefined>;

function clean(fields: Fields): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== "") out[k] = v;
  return out;
}

export interface NewPurchaseInput {
  receiptDocumentId?: string;
  vendor?: string;
  date?: string;
  invoiceNo?: string;
  paymentMethodId?: string;
  orderTotalCents?: number;
  taxShippingTotalCents?: number;
  notes?: string;
}

/** Starts a purchase (one receipt, one payment) that any number of items can then hang off. Returns its id. */
export function createPurchase(ledger: Ledger, input: NewPurchaseInput = {}): string {
  const id = newId("purchase");
  ledger.set("purchase", id, clean({ ...input }), { label: "purchase.created" });
  return id;
}

export interface NewItemInput {
  childId?: string;
  description?: string;
  amountCents?: number;
  categoryId?: string;
  categoryPath?: string[];
  benefitMessage?: string;
  serviceDate?: string;
  serviceProvider?: string;
  quantity?: number;
  itemUrl?: string;
  notes?: string;
  taxShippingCents?: number;
  /** False when none of the receipt's tax/shipping belongs to this item (e.g. it was bought tax-free). Default true. */
  includeTax?: boolean;
  /** Per-item overrides of what the purchase supplies (StepUp takes these per item). */
  date?: string;
  invoiceNo?: string;
  vendor?: string;
}

/**
 * Adds an item to a purchase. Vendor, date, invoice # and payment method come from the purchase, so itemizing a
 * receipt never repeats them. Tax/shipping is estimated at the year's default rate unless given; once the purchase's
 * real tax total is known, call `reallocateTax` to replace the estimates.
 */
export function addItem(ledger: Ledger, purchaseId: string, input: NewItemInput): string {
  const id = newId("item");
  const noTax = input.includeTax === false;
  const estimated = !noTax && input.taxShippingCents === undefined && input.amountCents !== undefined;
  const taxShippingCents = noTax ? 0 : input.taxShippingCents ?? (input.amountCents !== undefined ? estimatedTax(ledger.state, purchaseId, input.amountCents) : undefined);
  ledger.set("item", id, clean({ ...input, includeTax: noTax ? false : undefined, purchaseId, taxShippingCents, taxShippingEstimated: estimated || undefined }), { label: "item.created" });
  return id;
}

/**
 * The tax/shipping to assume for an item whose real figure is not known yet: the year's default rate, but never so much
 * that the purchase's items add up to more than its receipt total (the amount is often the whole receipt, tax and all).
 */
function estimatedTax(state: LedgerState, purchaseId: string, amountCents: number, exceptItemId?: string): number {
  const estimate = estimateTaxCents(amountCents, defaultTaxRate(state));
  const total = state.purchases[purchaseId]?.orderTotalCents;
  if (total === undefined) return estimate;
  const others = itemsOf(state, purchaseId).filter((i) => i.id !== exceptItemId).reduce((sum, i) => sum + requestedCents(i), 0);
  return Math.max(0, Math.min(estimate, total - others - amountCents));
}

/**
 * Changes an item's details. Only the fields given are touched; an empty text clears the field. When the amount changes
 * and the tax/shipping is still an estimate, the estimate follows the new amount.
 */
export function updateItem(ledger: Ledger, itemId: string, input: NewItemInput): void {
  const item = ledger.state.items[itemId];
  if (!item) return;
  const fields: Record<string, Json> = {};
  for (const [k, v] of Object.entries(input)) if (v !== undefined) fields[k] = v as Json;
  const wasIncluded = item.includeTax !== false;
  if (input.includeTax !== undefined) fields["includeTax"] = input.includeTax;
  if (input.includeTax === false && wasIncluded) {
    fields["taxShippingCents"] = 0;
    fields["taxShippingEstimated"] = false;
  } else if (input.includeTax === true && !wasIncluded) {
    fields["taxShippingCents"] = estimatedTax(ledger.state, item.purchaseId ?? "", input.amountCents ?? item.amountCents ?? 0, itemId);
    fields["taxShippingEstimated"] = true;
  } else if (input.amountCents !== undefined && input.amountCents !== item.amountCents && wasIncluded && item.taxShippingEstimated !== false && input.taxShippingCents === undefined) {
    fields["taxShippingCents"] = estimatedTax(ledger.state, item.purchaseId ?? "", input.amountCents, itemId);
    fields["taxShippingEstimated"] = true;
  }
  if (Object.keys(fields).length) ledger.set("item", itemId, fields, { label: "item.edited" });
}

/** A person's decision that an item is ready to submit (or, with `ready = false`, that it is not). Never set by the app on its own. */
export function setReadyToSubmit(ledger: Ledger, itemId: string, ready = true): void {
  if (!ledger.state.items[itemId]) return;
  ledger.set("item", itemId, { readyToSubmit: ready }, { label: ready ? "item.markedReady" : "item.unmarkedReady" });
}

/** Puts a file away (added by mistake) without deleting it from storage; `archived = false` brings it back. */
export function setDocumentArchived(ledger: Ledger, documentId: string, archived = true): void {
  if (!ledger.state.documents[documentId]) return;
  ledger.set("document", documentId, { archived }, { label: archived ? "document.archived" : "document.unarchived" });
}

/** Hides a purchase and its items everywhere (queue, plan, budget) without losing anything; `archived = false` brings it back. */
export function setPurchaseArchived(ledger: Ledger, purchaseId: string, archived = true): void {
  const label = archived ? "purchase.archived" : "purchase.unarchived";
  ledger.set("purchase", purchaseId, { archived }, { label });
  for (const item of itemsOf(ledger.state, purchaseId)) ledger.set("item", item.id, { archived }, { label });
}

/** Items on a purchase, oldest first. */
export function itemsOf(state: LedgerState, purchaseId: string): LineItem[] {
  return Object.values(state.items)
    .filter((i) => i.purchaseId === purchaseId)
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Money on the receipt not yet covered by an item (what the next item can default to). Undefined without a receipt total. */
export function remainingToItemize(state: LedgerState, purchaseId: string): number | undefined {
  const total = state.purchases[purchaseId]?.orderTotalCents;
  if (total === undefined) return undefined;
  return total - itemsOf(state, purchaseId).reduce((sum, i) => sum + requestedCents(i), 0);
}

/**
 * Defaults for the next item on a purchase so a second, third... line needs only what actually changes:
 * the child and service provider carry over from the previous item (the usual case is one child, several items),
 * and the amount defaults to whatever is left on the receipt. Description, category and benefit message are never
 * guessed.
 */
export function suggestNextItem(state: LedgerState, purchaseId: string): Pick<NewItemInput, "childId" | "serviceProvider" | "amountCents"> {
  const items = itemsOf(state, purchaseId);
  const last = items[items.length - 1];
  const remaining = remainingToItemize(state, purchaseId);
  return {
    ...(last?.childId ? { childId: last.childId } : {}),
    ...(last?.serviceProvider ? { serviceProvider: last.serviceProvider } : {}),
    ...(remaining !== undefined && remaining > 0 ? { amountCents: remaining } : {}),
  };
}

/** Copies an item within the same purchase (change the description/amount/child and save). Does not copy hold or StepUp state. */
export function duplicateItem(ledger: Ledger, itemId: string): string | undefined {
  const src = ledger.state.items[itemId];
  if (!src?.purchaseId) return undefined;
  const { id: _id, submissionId: _s, lineNumber: _l, stepUpStatus: _st, approvedCents: _a, paidCents: _p, hold: _h, holdNote: _hn, statusOverride: _so, readyToSubmit: _r, ...rest } = src;
  const copy = newId("item");
  ledger.set("item", copy, clean(rest as Fields), { label: "item.duplicated" });
  return copy;
}

/**
 * When the purchase has a real tax/shipping total, spread it across its items in proportion to their amounts
 * (exactly, to the cent) and clear the "estimated" flag. No-op without a total.
 */
export function reallocateTax(ledger: Ledger, purchaseId: string): void {
  const purchase: Purchase | undefined = ledger.state.purchases[purchaseId];
  if (purchase?.taxShippingTotalCents === undefined) return;
  const items = itemsOf(ledger.state, purchaseId);
  // Only the items that include tax share it; the rest carry none. A receipt tax of 0 simply gives every item 0.
  const taxed = items.filter((i) => i.includeTax !== false);
  const parts = allocateProportionally(purchase.taxShippingTotalCents, taxed.map((i) => i.amountCents ?? 0));
  let n = 0;
  for (const item of items) {
    const cents = item.includeTax === false ? 0 : parts[n++]!;
    ledger.set("item", item.id, { taxShippingCents: cents, taxShippingEstimated: false }, { label: "item.taxAllocated" });
  }
}

/**
 * The receipt's tax/shipping total was blanked: it is unknown again, so each item that includes tax goes back to an
 * estimate (kept within the receipt total) and the ones that do not include it stay at none.
 */
export function clearTaxTotal(ledger: Ledger, purchaseId: string): void {
  if (ledger.state.purchases[purchaseId]?.taxShippingTotalCents === undefined) return;
  ledger.set("purchase", purchaseId, { taxShippingTotalCents: null }, { label: "purchase.edited" });
  for (const item of itemsOf(ledger.state, purchaseId)) {
    const none = item.includeTax === false;
    ledger.set("item", item.id, { taxShippingCents: none ? 0 : estimatedTax(ledger.state, purchaseId, item.amountCents ?? 0, item.id), taxShippingEstimated: !none }, { label: "item.taxEstimated" });
  }
}

/**
 * Carries the students over from an earlier year's ledger into this one, keeping their ids so the same child is the
 * same child in every year (and two devices doing this at once write identical events). Per-year money (cap,
 * rollover) is not copied. Returns how many were added; existing children are never overwritten.
 */
export function copyChildren(ledger: Ledger, from: LedgerState): number {
  let added = 0;
  for (const c of Object.values(from.children)) {
    if (ledger.state.children[c.id]) continue;
    ledger.set("child", c.id, clean({ name: c.name, scholarship: c.scholarship }), { label: "child.carriedOver" });
    added++;
  }
  return added;
}

/** The id a student gets when they come from an old workbook; the same name always gives the same id, on every device and in the legacy import. */
export const childIdForName = (name: string): string => `child-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;

/** Adds students read from an old Excel year (name and program only). Existing ones are left alone. Returns how many were added. */
export function copyLegacyChildren(ledger: Ledger, children: Array<{ name: string; scholarship?: string }>): number {
  let added = 0;
  for (const c of children) {
    const id = childIdForName(c.name);
    if (ledger.state.children[id]) continue;
    ledger.set("child", id, clean({ name: c.name, scholarship: c.scholarship }), { label: "child.carriedOver" });
    added++;
  }
  return added;
}

/**
 * Sets up a new year from an earlier one: the students (see `copyChildren`), the payment methods (cards and the like
 * carry over; their statements do not), and the tax-estimate rate. Nothing existing is overwritten.
 */
export function copyYearSetup(ledger: Ledger, from: LedgerState): { children: number; paymentMethods: number } {
  const children = copyChildren(ledger, from);
  let paymentMethods = 0;
  for (const pm of Object.values(from.paymentMethods)) {
    if (ledger.state.paymentMethods[pm.id]) continue;
    const { id: _id, ...rest } = pm;
    ledger.set("paymentMethod", pm.id, clean(rest as Fields), { label: "paymentMethod.carriedOver" });
    paymentMethods++;
  }
  const rate = from.settings["year"]?.defaultTaxRate;
  if (rate !== undefined && ledger.state.settings["year"]?.defaultTaxRate === undefined) ledger.set("setting", "year", { defaultTaxRate: rate }, { label: "setting.carriedOver" });
  return { children, paymentMethods };
}
