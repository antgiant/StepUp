import type { LedgerState, LineItem } from "../domain/types.js";
import { formatHlc } from "../events/hlc.js";
import { SCHEMA_VERSION, type Json, type LedgerEvent } from "../events/types.js";
import { requestedCents } from "../rules/readiness.js";
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

/** What StepUp's line says about an item: status (Adjusted when it paid something other than what was asked), amounts, message. */
export function stepUpItemFields(line: StepUpLine, item?: Pick<LineItem, "amountCents" | "taxShippingCents">): Record<string, Json> {
  let status = stepUpStatusOf(line);
  const out: Record<string, Json> = {};
  if (status && (status === "Approved" || status === "Paid") && item && item.amountCents !== undefined) {
    const requested = (item.amountCents ?? 0) + (item.taxShippingCents ?? 0);
    if (line.amountCents !== item.amountCents && line.amountCents !== requested) status = "Adjusted";
  }
  if (status) out["stepUpStatus"] = status;
  if (status === "Approved" || status === "Adjusted") out["approvedCents"] = line.amountCents;
  if (status === "Paid") out["paidCents"] = line.amountCents;
  const said = [line.reason, line.comment && line.comment !== line.reason ? line.comment : ""].filter(Boolean).join(": ");
  if (said) out["stepUpMessage"] = said;
  return out;
}

/**
 * Events that lay StepUp's list over a ledger year: for every filed item StepUp knows (matched by reimbursement number
 * and line), its status, amounts and message, and the reimbursement's id on the submission. `readAt` is when StepUp's
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
  for (const r of reimbursements) {
    let submissionId: string | undefined;
    for (const line of r.lines) {
      const item = byLine.get(line.number);
      if (!item) continue;
      submissionId ??= item.submissionId;
      emit("item", item.id, stepUpItemFields(line, item));
    }
    if (submissionId) emit("submission", submissionId, { guid: r.id });
  }
  return events;
}
