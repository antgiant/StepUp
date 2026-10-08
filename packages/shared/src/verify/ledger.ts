import type { LedgerState } from "../domain/types.js";
import { parseHlc } from "../events/hlc.js";
import { SCHEMA_VERSION, type LedgerEvent } from "../events/types.js";

export interface Finding {
  severity: "error" | "warn" | "info";
  code: string;
  message: string;
  /** Ids involved, for looking them up. */
  ids?: string[];
}

const add = (out: Finding[], severity: Finding["severity"], code: string, message: string, ids?: string[]) => out.push({ severity, code, message, ...(ids?.length ? { ids } : {}) });

/**
 * Integrity check of a year's ledger: the folded state must make sense (nothing points at something that is not there),
 * the logs must be clean (no clashing duplicates, nothing from the far future), and files must not be duplicated or
 * orphaned. Pure: it reads state and events, never the network. Errors are real inconsistencies; warnings are worth a look.
 */
export function verifyLedger(state: LedgerState, events: LedgerEvent[], now = Date.now()): Finding[] {
  const out: Finding[] = [];

  // ---- the logs
  const byId = new Map<string, LedgerEvent>();
  const clashes: string[] = [];
  for (const e of events) {
    const seen = byId.get(e.id);
    if (!seen) byId.set(e.id, e);
    else if (JSON.stringify(seen) !== JSON.stringify(e)) clashes.push(e.id);
  }
  if (clashes.length) add(out, "error", "event-id-clash", `${clashes.length} event id(s) appear twice with different contents (two installs sharing a client id?).`, clashes.slice(0, 10));
  const newer = events.filter((e) => e.schemaVersion > SCHEMA_VERSION);
  if (newer.length) add(out, "warn", "newer-events", `${newer.length} event(s) were written by a newer version of the app and are not understood by this one.`);
  const wall = (hlc: string) => {
    try {
      return parseHlc(hlc).wall;
    } catch {
      return 0;
    }
  };
  const future = events.filter((e) => wall(e.hlc) > now + 24 * 3_600_000);
  if (future.length) add(out, "warn", "clock-ahead", `${future.length} event(s) are stamped more than a day in the future: a device clock is wrong (they would win every conflict).`, future.slice(0, 5).map((e) => e.id));

  // ---- the state
  const has = {
    child: (id?: string) => Boolean(id && state.children[id]),
    purchase: (id?: string) => Boolean(id && state.purchases[id]),
    item: (id?: string) => Boolean(id && state.items[id]),
    doc: (id?: string) => Boolean(id && state.documents[id]),
  };
  const items = Object.values(state.items);
  const noPurchase = items.filter((i) => !has.purchase(i.purchaseId)).map((i) => i.id);
  if (noPurchase.length) add(out, "error", "item-without-purchase", `${noPurchase.length} item(s) point at a purchase that does not exist.`, noPurchase.slice(0, 10));
  const noChild = items.filter((i) => i.childId && !has.child(i.childId)).map((i) => i.id);
  if (noChild.length) add(out, "error", "item-without-child", `${noChild.length} item(s) point at a student that does not exist.`, noChild.slice(0, 10));
  const noSub = items.filter((i) => i.submissionId && !state.submissions[i.submissionId]).map((i) => i.id);
  if (noSub.length) add(out, "error", "item-without-submission", `${noSub.length} item(s) point at a StepUp submission that is not recorded.`, noSub.slice(0, 10));
  const lineClash = new Map<string, string[]>();
  for (const i of items) if (i.submissionId && i.lineNumber !== undefined) lineClash.set(`${i.submissionId}-${i.lineNumber}`, [...(lineClash.get(`${i.submissionId}-${i.lineNumber}`) ?? []), i.id]);
  const dupLines = [...lineClash.entries()].filter(([, ids]) => ids.length > 1);
  if (dupLines.length) add(out, "error", "duplicate-line-number", `${dupLines.length} StepUp line number(s) are used by more than one item.`, dupLines.flatMap(([, ids]) => ids).slice(0, 10));

  const badReceipt = Object.values(state.purchases).filter((p) => p.receiptDocumentId && !has.doc(p.receiptDocumentId)).map((p) => p.id);
  if (badReceipt.length) add(out, "error", "receipt-missing", `${badReceipt.length} purchase(s) point at a receipt file that is not registered.`, badReceipt.slice(0, 10));
  const emptyPurchases = Object.values(state.purchases).filter((p) => !p.archived && !items.some((i) => i.purchaseId === p.id)).map((p) => p.id);
  if (emptyPurchases.length) add(out, "info", "purchase-without-items", `${emptyPurchases.length} purchase(s) have no items yet.`, emptyPurchases.slice(0, 10));

  const badLinks = Object.values(state.additionalDocs).filter((a) => !has.doc(a.documentId) || !(a.ownerKind === "purchase" ? has.purchase(a.ownerId) : has.item(a.ownerId))).map((a) => a.id);
  if (badLinks.length) add(out, "error", "broken-attachment", `${badLinks.length} attached document link(s) point at something that does not exist.`, badLinks.slice(0, 10));
  const badTxn = Object.values(state.additionalDocs).filter((a) => a.transactionId && has.doc(a.documentId) && !state.documents[a.documentId!]!.statement?.transactions.some((t) => t.id === a.transactionId)).map((a) => a.id);
  if (badTxn.length) add(out, "warn", "charge-not-on-statement", `${badTxn.length} payment link(s) name a charge that is not on the statement as it is stored now (the statement was read again?).`, badTxn.slice(0, 10));

  const docs = Object.values(state.documents);
  const bySha = new Map<string, string[]>();
  for (const d of docs) if (d.sha256) bySha.set(d.sha256, [...(bySha.get(d.sha256) ?? []), d.id]);
  const dupFiles = [...bySha.values()].filter((ids) => ids.length > 1);
  if (dupFiles.length) add(out, "warn", "duplicate-files", `${dupFiles.length} file(s) are registered more than once (identical contents).`, dupFiles.flat().slice(0, 10));
  const used = new Set<string>([...Object.values(state.purchases).map((p) => p.receiptDocumentId ?? ""), ...Object.values(state.additionalDocs).map((a) => a.documentId ?? ""), ...docs.map((d) => d.derivedFrom ?? "")]);
  const orphans = docs.filter((d) => !used.has(d.id) && !d.derivedFrom).map((d) => d.id);
  if (orphans.length) add(out, "info", "unattached-files", `${orphans.length} file(s) are not attached to anything yet.`, orphans.slice(0, 10));
  const noFile = docs.filter((d) => !d.driveItemId).map((d) => d.id);
  if (noFile.length) add(out, "warn", "document-without-file", `${noFile.length} document(s) have no OneDrive file id.`, noFile.slice(0, 10));
  const brokenCopy = docs.filter((d) => d.derivedFrom && !has.doc(d.derivedFrom)).map((d) => d.id);
  if (brokenCopy.length) add(out, "error", "copy-without-original", `${brokenCopy.length} redacted/smaller copy(ies) point at an original that is not registered.`, brokenCopy.slice(0, 10));

  const lonelyDrafts = Object.values(state.drafts).filter((d) => d.itemIds?.some((id) => !has.item(id))).map((d) => d.id);
  if (lonelyDrafts.length) add(out, "warn", "draft-for-missing-items", `${lonelyDrafts.length} saved StepUp draft(s) refer to items that no longer exist.`, lonelyDrafts.slice(0, 10));

  if (out.length === 0) add(out, "info", "all-good", "No inconsistencies found.");
  return out;
}

export const hasErrors = (findings: Finding[]): boolean => findings.some((f) => f.severity === "error");
