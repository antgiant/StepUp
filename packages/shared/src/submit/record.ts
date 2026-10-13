import type { LedgerState } from "../domain/types.js";
import type { Ledger } from "../events/ledger.js";
import { categoryIdForPath } from "../reference/categories.js";
import { hashString } from "../util/hash.js";

/** The hold the automation puts on items it could not file (the old "Unfiled (Missing Things)" status). Cleared by a person once fixed. */
export const AUTOMATION_HOLD = "needs-attention";

const submissionId = (reimbursementId: string) => `sub-${hashString(`stepup:${reimbursementId}`)}`;

/** Records that these items (in line order) became line items 1..n of a StepUp reimbursement. Safe to repeat. */
export function recordSubmitted(ledger: Ledger, itemIds: string[], info: { reimbursementId: string; submittedAt: string; guid?: string }): void {
  const id = submissionId(info.reimbursementId);
  const first = ledger.state.items[itemIds[0] ?? ""];
  ledger.set(
    "submission",
    id,
    { reimbursementId: info.reimbursementId, submittedAt: info.submittedAt, ...(info.guid ? { guid: info.guid } : {}), ...(first?.purchaseId ? { purchaseId: first.purchaseId } : {}), ...(first?.childId ? { childId: first.childId } : {}) },
    { label: "submission.recorded" }
  );
  itemIds.forEach((itemId, n) => ledger.set("item", itemId, { submissionId: id, lineNumber: n + 1, stepUpStatus: "Submitted" }, { label: "item.submitted" }));
}

/** A draft was started: remember its reimbursement number on the items before anything is submitted (so a crash loses nothing). */
export function recordDraftNumber(ledger: Ledger, itemIds: string[], reimbursementId: string, guid?: string): void {
  const id = submissionId(reimbursementId);
  ledger.set("submission", id, { reimbursementId, ...(guid ? { guid } : {}) }, { label: "submission.draft" });
  for (const itemId of itemIds) ledger.set("item", itemId, { submissionId: id }, { label: "item.draftLinked" });
}

/** Stops the items being offered again until a person looks: a hold with the reason, and the reason added to the notes. */
export function recordNeedsAttention(ledger: Ledger, itemIds: string[], note: string, today: string): void {
  for (const itemId of itemIds) {
    const item = ledger.state.items[itemId];
    if (!item) continue;
    const dated = `[${today}] ${note}`;
    ledger.set("item", itemId, { hold: AUTOMATION_HOLD, holdNote: note, notes: item.notes ? `${item.notes} | ${dated}` : dated }, { label: "item.needsAttention" });
  }
}

/** The automation fixed a category name to match StepUp's live list. */
export function recordCategoryFix(ledger: Ledger, itemIds: string[], categoryText: string): void {
  const path = categoryText.split(" - ").map((s) => s.trim()).filter(Boolean);
  for (const itemId of itemIds) ledger.set("item", itemId, { categoryPath: path, categoryId: categoryIdForPath(path) }, { label: "item.categoryFixed" });
}

export interface ApiLineItem {
  LineItemNumber: string;
  ExternalStatus: string;
  Appealed: boolean;
  /** Dollars. */
  ItemAmount: number;
  /** StepUp's id of the reimbursement this line belongs to (the search result's own id), when the caller has it. */
  ReimbursementGuid?: string;
  /** Text StepUp attached to the line (a denial reason, an adjustment note), when it sent any. */
  Message?: string;
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The address of a reimbursement's status page on StepUp's site. */
export const stepUpStatusUrl = (guid: string): string => `https://apply.stepupforstudents.org/Reimbursement/Details/${guid}/Two?BackLink=Reimbursement`;

/**
 * Text fields StepUp's line items might carry a reason in. Not yet confirmed against a real denied item: the CLI keeps
 * every denied line it sees in .cache/denied-line-items.json so the real name can be settled and this list trimmed.
 */
const MESSAGE_FIELDS = ["DenialReason", "DenialReasons", "DenialMessage", "StatusReason", "StatusMessage", "Reason", "Comments", "Comment", "Message", "Notes"];

/** The reason text on a raw search line item, if it has any. */
export function messageOf(lineItem: Record<string, unknown>): string | undefined {
  for (const k of MESSAGE_FIELDS) {
    const v = lineItem[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (Array.isArray(v)) {
      const joined = v.filter((x): x is string => typeof x === "string" && x.trim() !== "").join("\n");
      if (joined) return joined;
    }
  }
  return undefined;
}

/** StepUp's raw status (and whether it was appealed) -> our status vocabulary; anything unrecognised is left alone. */
export function mapStepUpStatus(externalStatus: string, appealed: boolean): string | undefined {
  switch (externalStatus) {
    case "Submitted":
    case "Approved":
    case "Paid":
      return externalStatus;
    case "Denied":
      return appealed ? "Denied (Final)" : "Denied (Initial)";
    default:
      return undefined;
  }
}

/**
 * Brings submitted items up to date from StepUp's reimbursements list: matches `{ReimbursementID}-{LineNumber}`,
 * sets the status, and records the paid/approved amount once it is final. Approved/Paid with an amount that is neither
 * the item's amount nor its requested total is "Adjusted" (an unexplained reduction). Returns how many items changed.
 */
export function applyStepUpStatuses(ledger: Ledger, apiItems: ApiLineItem[]): number {
  const byNumber = new Map(apiItems.filter((a) => a.LineItemNumber).map((a) => [a.LineItemNumber, a]));
  const state: LedgerState = ledger.state;
  let changed = 0;
  for (const item of Object.values(state.items)) {
    const sub = item.submissionId ? state.submissions[item.submissionId] : undefined;
    if (!sub?.reimbursementId || item.lineNumber === undefined) continue;
    const api = byNumber.get(`${sub.reimbursementId}-${item.lineNumber}`);
    if (!api) continue;
    let status = mapStepUpStatus(api.ExternalStatus, api.Appealed);
    if (!status) continue;
    const amountCents = Number.isFinite(api.ItemAmount) ? Math.round(api.ItemAmount * 100) : undefined;
    const requested = (item.amountCents ?? 0) + (item.taxShippingCents ?? 0);
    if ((status === "Approved" || status === "Paid") && amountCents !== undefined && amountCents !== item.amountCents && amountCents !== requested) status = "Adjusted";

    if (api.ReimbursementGuid && GUID.test(api.ReimbursementGuid) && sub.guid?.toLowerCase() !== api.ReimbursementGuid.toLowerCase()) {
      ledger.set("submission", sub.id, { guid: api.ReimbursementGuid.toLowerCase() }, { label: "submission.guidObserved" });
      changed++;
    }
    const fields: Record<string, string | number> = {};
    const message = api.Message?.trim();
    if (message && item.stepUpMessage !== message) fields["stepUpMessage"] = message;
    if (item.stepUpStatus !== status) fields["stepUpStatus"] = status;
    if (amountCents !== undefined && (status === "Approved" || status === "Adjusted") && item.approvedCents !== amountCents) fields["approvedCents"] = amountCents;
    if (amountCents !== undefined && status === "Paid") {
      if (item.paidCents !== amountCents) fields["paidCents"] = amountCents;
      if (item.approvedCents !== amountCents) fields["approvedCents"] = amountCents;
    }
    if (Object.keys(fields).length === 0) continue;
    ledger.set("item", item.id, fields, { label: "item.statusObserved" });
    changed++;
  }
  return changed;
}
