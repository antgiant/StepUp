import type { LedgerState, LineItem } from "../domain/types.js";
import { formatHlc } from "../events/hlc.js";
import { SCHEMA_VERSION, type Json, type LedgerEvent } from "../events/types.js";
import { childIdForName } from "../entry/actions.js";
import { categoryIdForPath } from "../reference/categories.js";
import { submissionIdFor } from "../submit/record.js";
import type { StepUpLine, StepUpReimbursement } from "./archive.js";

/**
 * StepUp is the most accurate record of what happened to a filed item, so what it says about an item's status, amounts
 * and message outranks the ledger, and the ledger outranks Excel. The one exception is something this app (or the
 * command line) did after StepUp was last read: that is newer than StepUp's copy, which has simply not caught up.
 *
 * That rule is the ledger's own rule (the latest change to a field wins), so StepUp's data is folded in as events
 * stamped with the time StepUp was last read. Anything done since sorts after them and wins, until the next read.
 */
export const STEPUP_CLIENT = "stepup";

/** StepUp's status word for a line as ours: undefined for what the app has no word for yet (a draft). */
export function stepUpStatusOf(line: Pick<StepUpLine, "status" | "appealed">): string | undefined {
  if (line.status === "Denied") return line.appealed ? "Denied (Final)" : "Denied (Initial)";
  return ["Submitted", "Approved", "Paid", "Appealed"].includes(line.status) ? line.status : undefined;
}

/**
 * What StepUp's line says about an item: status, amounts, message. An item StepUp holds at an amount that is neither the
 * item's amount nor its amount with tax and shipping is Adjusted ("Paid (Adjusted)" once paid), at whatever stage it is
 * (denied items keep their status).
 */
export function stepUpItemFields(line: StepUpLine, item?: Pick<LineItem, "amountCents" | "taxShippingCents">): Record<string, Json> {
  let status = stepUpStatusOf(line);
  const out: Record<string, Json> = {};
  if (status && status !== "Denied (Initial)" && status !== "Denied (Final)" && item && item.amountCents !== undefined) {
    const requested = (item.amountCents ?? 0) + (item.taxShippingCents ?? 0);
    if (line.amountCents !== item.amountCents && line.amountCents !== requested) status = status === "Paid" ? "Paid (Adjusted)" : "Adjusted";
  }
  out["stepUpAmountCents"] = line.amountCents;
  if (status) out["stepUpStatus"] = status;
  if (status === "Approved" || status === "Adjusted") out["approvedCents"] = line.amountCents;
  if (status === "Paid" || status === "Paid (Adjusted)") out["paidCents"] = line.amountCents;
  const said = [line.reason, line.comment && line.comment !== line.reason ? line.comment : ""].filter(Boolean).join(": ");
  if (said) out["stepUpMessage"] = said;
  return out;
}

/**
 * Events that lay StepUp's list over a ledger year: for every filed item StepUp knows (matched by reimbursement number
 * and line), its status, amounts and message, and the reimbursement's id on the submission; and the items StepUp has that
 * the ledger has not, as purchases and items of their own. `readAt` is when StepUp's
 * list was last read (ms), which is what puts later local changes ahead of it.
 */
export function stepUpOverlayEvents(state: LedgerState, reimbursements: readonly StepUpReimbursement[], readAt: number): LedgerEvent[] {
  const byLine = new Map<string, LineItem>();
  for (const item of Object.values(state.items)) {
    const number = item.submissionId ? state.submissions[item.submissionId]?.reimbursementId : undefined;
    if (number && item.lineNumber !== undefined) byLine.set(`${number}-${item.lineNumber}`, item);
  }
  const events: LedgerEvent[] = [];
  const emit = (entity: LedgerEvent["entity"], entityId: string, fields: Record<string, Json>) => {
    if (Object.keys(fields).length === 0) return;
    const hlc = formatHlc({ wall: readAt, counter: events.length, clientId: STEPUP_CLIENT });
    events.push({ id: hlc, hlc, clientId: STEPUP_CLIENT, actor: STEPUP_CLIENT, schemaVersion: SCHEMA_VERSION, op: "set", entity, entityId, fields, label: "stepup.overlay" });
  };
  const childByName = new Map(Object.values(state.children).map((c) => [(c.name ?? "").trim().toLowerCase(), c.id]));
  const docByName = new Map(Object.values(state.documents).filter((d) => d.filename).map((d) => [d.filename!.toLowerCase(), d.id]));
  const submissionByNumber = new Map(Object.values(state.submissions).filter((s) => s.reimbursementId).map((s) => [s.reimbursementId!, s]));
  for (const r of reimbursements) {
    let submissionId: string | undefined = submissionByNumber.get(String(r.number))?.id;
    const missing: StepUpLine[] = [];
    for (const line of r.lines) {
      const item = byLine.get(line.number);
      if (!item) {
        // A draft is not filed yet, so it is not shown as an item; everything StepUp has actually received is.
        if (stepUpStatusOf(line)) missing.push(line);
        continue;
      }
      submissionId ??= item.submissionId;
      emit("item", item.id, stepUpItemFields(line, item));
    }
    if (submissionId && r.lines.some((l) => byLine.has(l.number))) emit("submission", submissionId, { guid: r.id });
    if (missing.length === 0) continue;

    // Items StepUp has that the ledger has never heard of: shown as a purchase of their own (or under the reimbursement's
    // submission when the ledger knows it), so the year is the whole of what StepUp holds.
    let childId = r.student ? childByName.get(r.student.trim().toLowerCase()) : undefined;
    if (!childId && r.student) {
      childId = childIdForName(r.student);
      childByName.set(r.student.trim().toLowerCase(), childId);
      emit("child", childId, { name: r.student });
    }
    const known = submissionByNumber.get(String(r.number));
    const purchaseId = known?.purchaseId ?? `purchase-stepup-${r.number}`;
    const sid = known?.id ?? submissionIdFor(String(r.number));
    if (!known?.purchaseId) {
      const first = missing[0]!;
      const receipt = r.receipts[0]?.fileName;
      const fields: Record<string, Json> = {};
      const vendor = first.vendor ?? first.provider ?? r.provider;
      if (vendor) fields["vendor"] = vendor;
      if (first.purchaseDate) fields["date"] = first.purchaseDate;
      if (first.invoiceNo) fields["invoiceNo"] = first.invoiceNo;
      const doc = receipt ? docByName.get(receipt.toLowerCase()) : undefined;
      if (doc) fields["receiptDocumentId"] = doc;
      emit("purchase", purchaseId, fields);
    }
    if (!known) emit("submission", sid, { reimbursementId: String(r.number), purchaseId, ...(childId ? { childId } : {}), ...(r.submittedAt ? { submittedAt: r.submittedAt } : {}), guid: r.id });
    else emit("submission", sid, { guid: r.id });
    for (const line of missing) {
      const path = line.category;
      const lineNo = Number(line.number.split("-").pop());
      const tax = line.additionalCostsCents ?? 0;
      const fields: Record<string, Json> = {
        purchaseId,
        submissionId: sid,
        description: line.name ?? (line.benefit ? line.benefit.slice(0, 80) : path[path.length - 1] ?? "Item"),
        amountCents: Math.max(0, line.amountCents - tax),
        ...stepUpItemFields(line),
      };
      if (childId) fields["childId"] = childId;
      if (Number.isFinite(lineNo)) fields["lineNumber"] = lineNo;
      if (tax) fields["taxShippingCents"] = tax;
      if (line.serviceDate) fields["serviceDate"] = line.serviceDate;
      if (line.provider) fields["serviceProvider"] = line.provider;
      if (line.vendor) fields["vendor"] = line.vendor;
      if (line.purchaseDate) fields["date"] = line.purchaseDate;
      if (line.invoiceNo) fields["invoiceNo"] = line.invoiceNo;
      if (path.length) {
        fields["categoryPath"] = path;
        fields["categoryId"] = categoryIdForPath(path);
      }
      if (line.quantity !== undefined) fields["quantity"] = line.quantity;
      if (line.benefit) fields["benefitMessage"] = line.benefit;
      if (line.itemUrl) fields["itemUrl"] = line.itemUrl;
      emit("item", `stepup-${line.number}`, fields);
    }
  }
  return events;
}
