import type { LedgerState } from "../domain/types.js";
import { evaluateItem, isFiled, type RulesContext } from "../rules/readiness.js";
import { fileNameHints, type FileNameHints } from "../workspace/ingest.js";
import { suggestTargets, type Suggestion } from "./mapping.js";

export type QueueKind = "unattached-document" | "purchase-needs-items" | "item-blocked";

export interface QueueEntry {
  kind: QueueKind;
  /** Document, purchase or item id, depending on `kind`. */
  id: string;
  title: string;
  reasons: string[];
  purchaseId?: string;
  /** For unattached documents: the two things a person can do — start a purchase, or map it to something already entered. */
  actions?: Array<"start-purchase" | "attach-receipt" | "attach-additional">;
  suggestions?: Suggestion[];
  /** Vendor/date read from the file name, to prefill a new purchase. */
  hints?: FileNameHints;
}

/**
 * The single "needs your attention" list for entry: files that arrived but have no data yet, receipts with no
 * items, and unfiled items that cannot be submitted yet (with why). Filed items never appear.
 */
export function buildQueue(state: LedgerState, ctx: RulesContext): QueueEntry[] {
  const used = new Set<string>();
  for (const p of Object.values(state.purchases)) if (p.receiptDocumentId) used.add(p.receiptDocumentId);
  for (const a of Object.values(state.additionalDocs)) if (a.documentId) used.add(a.documentId);

  // A file that has been replaced by a smaller or redacted copy is no longer something to deal with.
  const hasCopy = new Set(Object.values(state.documents).flatMap((d) => (d.derivedFrom ? [d.derivedFrom] : [])));
  const entries: QueueEntry[] = [];
  const docs = Object.values(state.documents).filter((d) => !used.has(d.id) && !d.derivedFrom && !hasCopy.has(d.id)).sort((a, b) => (a.filename ?? a.id).localeCompare(b.filename ?? b.id));
  for (const d of docs) {
    entries.push({
      kind: "unattached-document",
      id: d.id,
      title: d.filename ?? d.id,
      reasons: [d.contentKind === "statement" ? "Statement: attach it as proof of payment" : "Needs data (start a purchase) or belongs to something already entered"],
      actions: d.contentKind === "statement" ? ["attach-additional", "start-purchase"] : ["start-purchase", "attach-receipt", "attach-additional"],
      suggestions: suggestTargets(state, d.id, ctx, 3),
      hints: fileNameHints(d.filename ?? ""),
    });
  }

  const withItems = new Set(Object.values(state.items).filter((i) => !i.archived).map((i) => i.purchaseId));
  for (const p of Object.values(state.purchases).sort((a, b) => a.id.localeCompare(b.id))) {
    if (!p.archived && !withItems.has(p.id)) {
      entries.push({ kind: "purchase-needs-items", id: p.id, purchaseId: p.id, title: p.vendor || (state.documents[p.receiptDocumentId ?? ""]?.filename ?? p.id), reasons: ["Add the items on this receipt"] });
    }
  }

  const blocked = Object.values(state.items)
    .filter((i) => !i.archived && !isFiled(i) && !i.statusOverride)
    .sort((a, b) => (a.purchaseId ?? "").localeCompare(b.purchaseId ?? "") || a.id.localeCompare(b.id));
  for (const item of blocked) {
    const ev = evaluateItem(state, item.id, ctx);
    if (ev.readiness === "blocked") {
      entries.push({ kind: "item-blocked", id: item.id, purchaseId: item.purchaseId, title: item.description ?? item.id, reasons: ev.reasons.map((r) => r.message) });
    }
  }
  return entries;
}
