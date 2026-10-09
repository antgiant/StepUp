import type { AdditionalDocKind, LedgerState } from "../domain/types.js";
import type { Ledger } from "../events/ledger.js";
import { evaluateItem, type RulesContext } from "../rules/readiness.js";
import { hashString } from "../util/hash.js";
import { createPurchase, type NewPurchaseInput } from "./actions.js";

export type MapTarget = { kind: "purchase"; id: string } | { kind: "item"; id: string };

export interface Suggestion {
  target: MapTarget;
  role: "receipt" | "additional";
  score: number;
  why: string[];
}

const alnum = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const tokens = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3);

/**
 * Where might a file that arrived without data belong? Ranks existing purchases/items: a receipt-like file for a purchase
 * that has no receipt yet, a file whose name mentions the vendor or invoice number, a statement for purchases still
 * awaiting proof of payment. Suggestions only; a person decides.
 */
export function suggestTargets(state: LedgerState, docId: string, ctx: RulesContext, limit = 5): Suggestion[] {
  const doc = state.documents[docId];
  if (!doc) return [];
  const name = doc.filename ?? "";
  const nameTokens = new Set(tokens(name));
  const nameFlat = alnum(name);
  const isStatement = doc.contentKind === "statement";
  const out: Suggestion[] = [];

  for (const purchase of Object.values(state.purchases)) {
    if (purchase.archived) continue;
    const items = Object.values(state.items).filter((i) => i.purchaseId === purchase.id);
    const why: string[] = [];
    let score = 0;
    const hasReceipt = Boolean(purchase.receiptDocumentId && state.documents[purchase.receiptDocumentId]);
    if (purchase.receiptDocumentId === docId || Object.values(state.additionalDocs).some((a) => a.ownerKind === "purchase" && a.ownerId === purchase.id && a.documentId === docId)) continue;

    if (!hasReceipt && !isStatement) {
      score += 3;
      why.push("has no receipt yet");
    }
    if (purchase.vendor && tokens(purchase.vendor).some((t) => nameTokens.has(t))) {
      score += 2;
      why.push("file name mentions the vendor");
    }
    const invoices = [purchase.invoiceNo, ...items.map((i) => i.invoiceNo)].filter((x): x is string => Boolean(x));
    if (invoices.some((inv) => alnum(inv).length >= 4 && nameFlat.includes(alnum(inv)))) {
      score += 3;
      why.push("file name contains the invoice number");
    }
    if (isStatement) {
      const awaiting = items.some((i) => evaluateItem(state, i.id, ctx).reasons.some((r) => r.code === "awaiting-proof"));
      if (awaiting) {
        score += 3;
        why.push("items are waiting for proof of payment");
      }
      const label = state.paymentMethods[purchase.paymentMethodId ?? ""]?.label;
      if (label && tokens(label).some((t) => nameTokens.has(t))) {
        score += 2;
        why.push("file name mentions the payment method");
      }
    }
    if (score === 0) continue;
    out.push({ target: { kind: "purchase", id: purchase.id }, role: !hasReceipt && !isStatement ? "receipt" : "additional", score, why });
  }
  return out.sort((a, b) => b.score - a.score || a.target.id.localeCompare(b.target.id)).slice(0, limit);
}

export type AttachResult = { ok: true } | { ok: false; reason: "purchase-has-receipt" | "is-the-receipt" | "document-missing" | "target-missing" };

/** Makes the document the purchase's receipt. Refuses to replace an existing receipt unless `replace` is set. */
export function attachAsReceipt(ledger: Ledger, purchaseId: string, docId: string, opts: { replace?: boolean } = {}): AttachResult {
  const s = ledger.state;
  if (!s.documents[docId]) return { ok: false, reason: "document-missing" };
  const purchase = s.purchases[purchaseId];
  if (!purchase) return { ok: false, reason: "target-missing" };
  if (purchase.receiptDocumentId && purchase.receiptDocumentId !== docId && !opts.replace) return { ok: false, reason: "purchase-has-receipt" };
  ledger.set("purchase", purchaseId, { receiptDocumentId: docId }, { label: "purchase.receiptSet" });
  return { ok: true };
}

/** Takes the file off the purchase as its receipt. The file itself stays (it goes back to the unattached files). */
export function detachReceipt(ledger: Ledger, purchaseId: string): AttachResult {
  const purchase = ledger.state.purchases[purchaseId];
  if (!purchase) return { ok: false, reason: "target-missing" };
  if (!purchase.receiptDocumentId) return { ok: true };
  ledger.set("purchase", purchaseId, { receiptDocumentId: "" }, { label: "purchase.receiptRemoved" });
  return { ok: true };
}

/** The receipt becomes additional documentation of the same purchase, leaving it with no receipt. */
export function moveReceiptToAdditional(ledger: Ledger, purchaseId: string): AttachResult {
  const docId = ledger.state.purchases[purchaseId]?.receiptDocumentId;
  if (!docId) return { ok: false, reason: "document-missing" };
  detachReceipt(ledger, purchaseId);
  return attachAdditional(ledger, { kind: "purchase", id: purchaseId }, docId);
}

export const additionalDocId = (target: MapTarget, docId: string) => `add-${hashString(`${target.kind}:${target.id}::${docId}`)}`;

/** Attaches the document as additional documentation (statement, explanation, letter...) to a purchase or a single item. */
export function attachAdditional(ledger: Ledger, target: MapTarget, docId: string, kind: AdditionalDocKind = "other"): AttachResult {
  const s = ledger.state;
  if (!s.documents[docId]) return { ok: false, reason: "document-missing" };
  const owner = target.kind === "purchase" ? s.purchases[target.id] : s.items[target.id];
  if (!owner) return { ok: false, reason: "target-missing" };
  const purchase = target.kind === "purchase" ? s.purchases[target.id] : s.purchases[s.items[target.id]?.purchaseId ?? ""];
  if (purchase?.receiptDocumentId === docId) return { ok: false, reason: "is-the-receipt" };
  ledger.set(
    "additionalDoc",
    additionalDocId(target, docId),
    { ownerKind: target.kind, ownerId: target.id, documentId: docId, kind, source: "manual" },
    { label: "document.attached" }
  );
  return { ok: true };
}

/** Undo for a mapping mistake. */
export function detachAdditional(ledger: Ledger, target: MapTarget, docId: string): void {
  ledger.delete("additionalDoc", additionalDocId(target, docId), { label: "document.detached" });
}

/** Turns a file into a brand-new purchase (its receipt) ready for itemizing. Returns the purchase id. */
export function startPurchaseFromDocument(ledger: Ledger, docId: string, defaults: NewPurchaseInput = {}): string {
  return createPurchase(ledger, { ...defaults, receiptDocumentId: docId });
}
