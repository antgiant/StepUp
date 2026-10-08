import type { DocumentRec, LedgerState, LineItem } from "../domain/types.js";
import { additionalDocsFor, displayStatus, evaluateItem, isFiled, type Reason, type RulesContext } from "../rules/readiness.js";

/** One StepUp submission: a purchase x a child. Replaces the old Table1 `buildGroups` (child + main receipt). */
export interface SubmissionGroup {
  purchaseId: string;
  childId: string;
  childName: string;
  receipt: DocumentRec;
  /** Every non-receipt document across the group's items and its purchase, deduplicated. */
  additionalDocs: DocumentRec[];
  /** Statements sent as they are because no redacted copy exists yet (file names): a person should look before filing. */
  unredactedStatements: string[];
  items: LineItem[];
}

export interface BlockedItem {
  item: LineItem;
  status: string;
  reasons: Reason[];
}

export interface SubmissionPlan {
  groups: SubmissionGroup[];
  blocked: BlockedItem[];
  /** Items already filed (or forfeited / overridden) and therefore not part of the plan. */
  skipped: number;
}

const byLine = (a: LineItem, b: LineItem) => (a.lineNumber ?? Infinity) - (b.lineNumber ?? Infinity) || a.id.localeCompare(b.id);

/**
 * Pure planning pass: which items can be filed now, grouped one per StepUp submission, and which are
 * blocked and why. Reads only; never changes the ledger.
 */
export function planSubmissions(state: LedgerState, ctx: RulesContext): SubmissionPlan {
  const groups = new Map<string, SubmissionGroup>();
  const blocked: BlockedItem[] = [];
  let skipped = 0;
  const deadline = Object.values(state.settings)[0]?.submissionDeadline;

  for (const item of Object.values(state.items).sort(byLine)) {
    if (item.archived) continue;
    if (isFiled(item) || item.statusOverride) {
      skipped++;
      continue;
    }
    const evaluation = evaluateItem(state, item.id, ctx);
    const status = displayStatus(item, evaluation, ctx, deadline);
    if (status === "Forfeited") {
      skipped++;
      continue;
    }
    // Ready implies purchase, child and receipt all resolve; the checks only narrow the types.
    const purchase = item.purchaseId ? state.purchases[item.purchaseId] : undefined;
    const child = item.childId ? state.children[item.childId] : undefined;
    const receipt = purchase?.receiptDocumentId ? state.documents[purchase.receiptDocumentId] : undefined;
    if (evaluation.readiness !== "ready" || !purchase || !child || !receipt) {
      blocked.push({ item, status, reasons: evaluation.reasons });
      continue;
    }
    const key = `${purchase.id}|${child.id}`;
    let group = groups.get(key);
    if (!group) {
      group = { purchaseId: purchase.id, childId: child.id, childName: child.name ?? child.id, receipt, additionalDocs: [], unredactedStatements: [], items: [] };
      groups.set(key, group);
    }
    group.items.push(item);
    for (const a of additionalDocsFor(state, item, purchase)) {
      const original = a.documentId ? state.documents[a.documentId] : undefined;
      const doc = original ? redactedCopyOf(state, original) ?? original : undefined;
      if (original && doc && doc.id !== receipt.id && !group.additionalDocs.some((d) => d.id === doc.id)) {
        group.additionalDocs.push(doc);
        if (original.contentKind === "statement" && !doc.redacted && !group.unredactedStatements.includes(original.filename ?? original.id)) group.unredactedStatements.push(original.filename ?? original.id);
      }
    }
  }

  return {
    groups: [...groups.values()].sort((a, b) => a.childName.localeCompare(b.childName) || (a.items[0]!.lineNumber ?? 0) - (b.items[0]!.lineNumber ?? 0)),
    blocked,
    skipped,
  };
}

/** The redacted copy made from a statement, if there is one. That copy, never the original, is what StepUp should receive. */
export function redactedCopyOf(state: LedgerState, doc: DocumentRec): DocumentRec | undefined {
  return Object.values(state.documents).find((d) => d.redacted && d.derivedFrom === doc.id);
}
