import type { LedgerState } from "../domain/types.js";
import { parseHlc } from "../events/hlc.js";
import type { Json, LedgerEvent } from "../events/types.js";
import { formatCents } from "../domain/money.js";
import type { HistoryChange, HistoryDetail } from "./types.js";

/** Fields people see, by the name they know them by. Anything not listed (and not in IGNORED) shows under its own name. */
const FIELD_NAMES: Record<string, string> = {
  stepUpStatus: "Status",
  statusOverride: "Status (Excel)",
  stepUpAmountCents: "Amount at StepUp",
  stepUpMessage: "StepUp says",
  amountCents: "Amount",
  taxShippingCents: "Tax/shipping",
  approvedCents: "Approved",
  paidCents: "Paid",
  description: "Description",
  categoryPath: "Category",
  vendor: "Vendor",
  date: "Date",
  serviceDate: "Service date",
  serviceProvider: "Service provider",
  invoiceNo: "Invoice #",
  quantity: "Quantity",
  benefitMessage: "Benefit message",
  itemUrl: "Item URL",
  hold: "Hold",
  holdNote: "Hold note",
  readyToSubmit: "Ready to submit",
  notes: "Notes",
  name: "Name",
  receiptDocumentId: "Receipt",
  orderTotalCents: "Receipt total",
  taxShippingTotalCents: "Tax/shipping total",
  paymentMethodId: "Paid with",
  childId: "Student",
  scholarship: "Program",
  capCents: "Award",
  requiresServiceDate: "Needs a service date",
  includeTax: "Include tax",
  archived: "Archived",
  filename: "File name",
  submittedAt: "Submitted",
  reimbursementId: "Reimbursement #",
  guid: "StepUp id",
  label: "Name",
  submissionDeadline: "Submission deadline",
  defaultTaxRate: "Tax rate",
};

/** Bookkeeping that is not a change a person made, or is shown under another name. */
const IGNORED = new Set(["categoryId", "submissionId", "lineNumber", "purchaseId", "driveItemId", "webUrl", "sha256", "sizeBytes", "pages", "statement", "reading", "taxShippingEstimated", "source", "contentKind", "derivedFrom", "redactedKeeps", "mirror", "year", "ownerKind", "ownerId", "documentId", "transactionId", "confidence"]);

const text = (v: unknown, state: LedgerState, field: string): string => {
  if (v === undefined || v === null || v === "") return "(blank)";
  if (field.endsWith("Cents") && typeof v === "number") return formatCents(v);
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (Array.isArray(v)) return v.join(" - ");
  if (field === "childId" && typeof v === "string") return state.children[v]?.name ?? v;
  if (field === "receiptDocumentId" && typeof v === "string") return state.documents[v]?.filename ?? v;
  if (field === "paymentMethodId" && typeof v === "string") return state.paymentMethods[v]?.label ?? v;
  const s = String(v).replace(/\s+/g, " ").trim();
  return s.length > 140 ? `${s.slice(0, 137)}...` : s;
};

/** What to call an entity today. */
function subjectOf(entity: string, id: string, state: LedgerState): HistoryChange["subject"] {
  switch (entity) {
    case "item": {
      const i = state.items[id];
      return { kind: "item", id, label: i?.description || "Item", ...(i?.purchaseId ? { purchaseId: i.purchaseId } : {}) };
    }
    case "purchase": {
      const p = state.purchases[id];
      const auto = [p?.vendor, p?.date].filter(Boolean).join(", ");
      return { kind: "purchase", id, label: p?.name?.trim() || auto || state.documents[p?.receiptDocumentId ?? ""]?.filename || "Purchase", purchaseId: id };
    }
    case "child":
      return { kind: "student", id, label: state.children[id]?.name ?? "Student" };
    case "document":
      return { kind: "file", id, label: state.documents[id]?.filename ?? "File" };
    case "submission": {
      const s = state.submissions[id];
      return { kind: "submission", id, label: s?.reimbursementId ? `Reimbursement #${s.reimbursementId}` : "Submission", ...(s?.purchaseId ? { purchaseId: s.purchaseId } : {}) };
    }
    case "setting":
      return { kind: "year", id, label: "Year settings" };
    case "paymentMethod":
      return { kind: "payment method", id, label: state.paymentMethods[id]?.label ?? "Payment method" };
    case "additionalDoc": {
      const a = state.additionalDocs[id];
      return { kind: "file", id, label: state.documents[a?.documentId ?? ""]?.filename ?? "Additional documentation", ...(a?.ownerKind === "purchase" && a.ownerId ? { purchaseId: a.ownerId } : {}) };
    }
    default:
      return { kind: entity, id, label: entity };
  }
}

/** Entities nobody needs listed: working state of the app rather than the person's record. */
const QUIET = new Set(["claim", "draft", "category"]);

const same = (a: Json | undefined, b: Json | undefined) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * The ledger's own history: every change in the event log, newest information first not required (sorted by the caller).
 * Pure. One entry per event and entity: an entity's first appearance is "added", later field changes list what each
 * field was and became. The one-time import from Excel and the app's working state (claims, drafts) are left out.
 */
export function ledgerHistory(events: readonly LedgerEvent[], state: LedgerState): HistoryChange[] {
  const ordered = [...events].sort((a, b) => (a.hlc < b.hlc ? -1 : a.hlc > b.hlc ? 1 : 0));
  const seen = new Map<string, Record<string, Json>>();
  const out: HistoryChange[] = [];
  for (const e of ordered) {
    if (e.clientId === "legacy-import" || (e.label ?? "").startsWith("legacy.") || QUIET.has(e.entity)) continue;
    let at: string;
    try {
      at = new Date(parseHlc(e.hlc).wall).toISOString();
    } catch {
      continue;
    }
    const key = `${e.entity}:${e.entityId}`;
    const subject = subjectOf(e.entity, e.entityId, state);
    const base = { id: `ledger:${e.id}`, at, source: "ledger" as const, ...(e.actor ? { actor: e.actor } : {}), subject };
    if (e.op === "delete" || e.op === "restore") {
      const verb = e.op === "delete" ? "removed" : "restored";
      out.push({ ...base, kind: verb, summary: `${e.op === "delete" ? "Archived" : "Restored"} ${subject.kind} ${subject.label ?? ""}`.trim() });
      continue;
    }
    const prev = seen.get(key);
    const fields = seen.get(key) ?? {};
    const details: HistoryDetail[] = [];
    for (const [f, v] of Object.entries(e.fields ?? {})) {
      if (IGNORED.has(f)) continue;
      if (!prev || !same(fields[f], v)) details.push({ field: FIELD_NAMES[f] ?? f, ...(prev && fields[f] !== undefined ? { from: text(fields[f], state, f) } : {}), to: text(v, state, f) });
    }
    seen.set(key, { ...fields, ...(e.fields ?? {}) });
    if (!prev) {
      out.push({ ...base, kind: "added", summary: `Added ${subject.kind} ${subject.label ?? ""}`.trim(), ...(details.length ? { details } : {}) });
    } else if (details.length) {
      out.push({ ...base, kind: "changed", summary: `Changed ${subject.kind} ${subject.label ?? ""}`.trim(), details });
    }
  }
  return out;
}
