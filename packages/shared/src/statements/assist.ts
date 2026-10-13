import type { LedgerState } from "../domain/types.js";
import { statementCard } from "./edit.js";
import { days, purchaseDate, purchaseTotalCents, words } from "./match.js";

/** How the list is ordered: the best overall fit, the nearest date, or the nearest dollar amount. */
export type AssistSort = "best" | "date" | "amount";

interface Fit {
  /** What the charge cost, less what the purchase came to, in cents (absent when the purchase has no total). */
  amountDiffCents?: number;
  /** Days from the receipt date to the charge: positive when the charge came after the receipt (absent when the purchase has no date). */
  dayDiff?: number;
  /** The charge is dated before the receipt, which a payment should never be. Kept in the list, but last. */
  beforeReceipt: boolean;
  /** 0 to 1, from the amount and the date only. */
  closeness: number;
  /** The charge's description looks like the purchase's vendor (shown as a hint, not used to rank). */
  vendorHit: boolean;
}

/** A charge on a statement that could be the payment for a purchase. */
export interface ChargeCandidate extends Fit {
  documentId: string;
  transactionId: string;
  date: string;
  descriptor: string;
  amountCents: number;
  statementName: string;
  cardKey: string;
  cardLabel: string;
}

/** A purchase that could be what a charge paid for. */
export interface PurchaseCandidate extends Fit {
  purchaseId: string;
  vendor: string;
  date?: string;
  totalCents?: number;
  childIds: string[];
  /** The card or account the purchase says it was paid with, when set. */
  methodId?: string;
  /** Another charge is already linked as its proof of payment. */
  hasProof: boolean;
}

function fit(state: LedgerState, purchaseId: string, charge: { date: string; postDate?: string; amountCents: number; descriptor: string }): Fit {
  const p = state.purchases[purchaseId]!;
  const total = purchaseTotalCents(state, p);
  const pd = purchaseDate(state, p);
  const amountDiffCents = total === undefined ? undefined : charge.amountCents - total;
  const dayDiff = pd ? days(charge.postDate ?? charge.date) - days(pd) : undefined;
  const ratio = amountDiffCents === undefined ? 1 : Math.abs(amountDiffCents) / Math.max(Math.abs(total!), Math.abs(charge.amountCents), 1);
  const amountScore = amountDiffCents === undefined ? 0.2 : Math.max(0, 1 - ratio * 4);
  const dateScore = dayDiff === undefined ? 0.3 : Math.max(0, 1 - Math.abs(dayDiff) / 45);
  const vendor = words(p.vendor ?? "");
  const aliases = state.settings["year"]?.vendorAliases;
  const vendorHit = words(charge.descriptor).some((w) => vendor.some((v) => v === w || v.startsWith(w) || w.startsWith(v)) || aliases?.[w]?.some((a) => vendor.includes(a)));
  return {
    ...(amountDiffCents !== undefined ? { amountDiffCents } : {}),
    ...(dayDiff !== undefined ? { dayDiff } : {}),
    beforeReceipt: dayDiff !== undefined && dayDiff < 0,
    closeness: Math.round((amountScore * 0.6 + dateScore * 0.4) * 100) / 100,
    vendorHit,
  };
}

/** Orders candidates. A charge before the receipt date is always last; ties fall back to the other measure, then to the amount. */
export function sortCandidates<T extends Fit>(list: T[], sort: AssistSort): T[] {
  const amount = (c: Fit) => (c.amountDiffCents === undefined ? Infinity : Math.abs(c.amountDiffCents));
  const date = (c: Fit) => (c.dayDiff === undefined ? Infinity : Math.abs(c.dayDiff));
  const by = (a: T, b: T): number =>
    Number(a.beforeReceipt) - Number(b.beforeReceipt) ||
    (sort === "amount" ? amount(a) - amount(b) || date(a) - date(b) : sort === "date" ? date(a) - date(b) || amount(a) - amount(b) : b.closeness - a.closeness || amount(a) - amount(b));
  return [...list].sort((a, b) => by(a, b) || 0);
}

/** Charges already used as payment proof (for any purchase). */
function claimed(state: LedgerState): Set<string> {
  return new Set(Object.values(state.additionalDocs).filter((a) => a.kind === "payment-proof" && a.transactionId).map((a) => `${a.documentId}:${a.transactionId}`));
}

/** Every unlinked purchase charge on every statement, as a candidate payment for this purchase. */
export function chargesForPurchase(state: LedgerState, purchaseId: string): ChargeCandidate[] {
  if (!state.purchases[purchaseId]) return [];
  const used = claimed(state);
  const out: ChargeCandidate[] = [];
  for (const doc of Object.values(state.documents)) {
    if (!doc.statement || doc.archived || doc.contentKind !== "statement") continue;
    const card = statementCard(doc.statement);
    for (const t of doc.statement.transactions) {
      if (t.kind !== "purchase" || used.has(`${doc.id}:${t.id}`)) continue;
      out.push({
        documentId: doc.id, transactionId: t.id, date: t.date, descriptor: t.descriptor, amountCents: t.amountCents,
        statementName: doc.filename ?? doc.id, cardKey: card.key, cardLabel: card.label,
        ...fit(state, purchaseId, t),
      });
    }
  }
  return out;
}

/** Every purchase that could be what one charge paid for. */
export function purchasesForCharge(state: LedgerState, documentId: string, transactionId: string): PurchaseCandidate[] {
  const t = state.documents[documentId]?.statement?.transactions.find((x) => x.id === transactionId);
  if (!t) return [];
  const proven = new Set(Object.values(state.additionalDocs).filter((a) => a.kind === "payment-proof" && a.ownerKind === "purchase" && a.transactionId).map((a) => a.ownerId!));
  return Object.values(state.purchases)
    .filter((p) => !p.archived)
    .map((p) => {
      const total = purchaseTotalCents(state, p);
      const pd = purchaseDate(state, p);
      const childIds = [...new Set(Object.values(state.items).filter((i) => i.purchaseId === p.id && !i.archived && i.childId).map((i) => i.childId!))];
      return {
        purchaseId: p.id, vendor: p.vendor ?? "", ...(pd ? { date: pd } : {}), ...(total !== undefined ? { totalCents: total } : {}),
        childIds, ...(p.paymentMethodId ? { methodId: p.paymentMethodId } : {}), hasProof: proven.has(p.id),
        ...fit(state, p.id, t),
      };
    });
}
