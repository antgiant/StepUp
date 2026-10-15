import { messageOf } from "../submit/record.js";

/**
 * What StepUp's list means for an Excel year's workbook rows: the command line's status sync, as a pure decision so the
 * command line, the web app and (later) the extension can share it. Rows are found by `Reimbursement ID`-`Line Number`.
 * It plans only; whoever calls it does the writing (and may never write when the layout has no such columns).
 */
export interface WorkbookLineItem {
  LineItemNumber?: string;
  ExternalStatus?: string;
  Appealed?: boolean;
  ItemAmount?: number;
  [key: string]: unknown;
}

/** Maps StepUp's own status (and whether it was appealed) onto the workbook's status words; anything else is left alone. */
export function mapApiStatus(externalStatus: string | undefined, appealed: boolean | undefined): string | undefined {
  switch (externalStatus) {
    case "Submitted":
    case "Approved":
    case "Paid":
    case "Appealed":
      return externalStatus;
    case "Denied":
      return appealed ? "Denied (Final)" : "Denied (Initial)";
    default:
      return undefined;
  }
}

/** Every line item of a StepUp list response, by its `<reimbursement id>-<line number>`. */
export function lineItemsByNumber(results: unknown[]): Map<string, WorkbookLineItem> {
  const out = new Map<string, WorkbookLineItem>();
  for (const r of results) {
    const items = (r as { LineItems?: unknown }).LineItems;
    if (!Array.isArray(items)) continue;
    for (const li of items as WorkbookLineItem[]) if (li?.LineItemNumber) out.set(li.LineItemNumber, li);
  }
  return out;
}

export interface WorkbookStatusPlan {
  /** Table1 rows (by position) and the columns to set. */
  updates: Array<{ rowIndex: number; label: string; changes: Record<string, string | number> }>;
  /** Statuses this app defines that the workbook's list lacks: add them to it before writing. */
  addStatuses: string[];
  /** Statuses the workbook's list lacks that the app does not define: those rows were left alone. */
  unknownStatuses: string[];
}

/** Statuses the app itself defines, which are added to the sheet's list when it lacks them. */
const DEFINED_HERE = new Set(["Appealed", "Paid", "Paid (Adjusted)"]);

export function planWorkbookStatusSync(headers: readonly string[], rows: readonly unknown[][], validStatuses: readonly string[], results: unknown[]): WorkbookStatusPlan {
  const col = (name: string): number => headers.indexOf(name);
  const [reimb, line, status, amount, reim, reimbursed, notes] = ["Reimbursement ID", "Line Number", "Status", "Amount", "Reim. $", "Reimbursed Amount", "Notes"].map(col) as [number, number, number, number, number, number, number];
  if ([reimb, line, status, amount, reim, reimbursed].some((i) => i === -1)) {
    throw new Error("Table1 is missing one of the Reimbursement ID / Line Number / Status / Amount / Reim. $ / Reimbursed Amount columns.");
  }
  const byNumber = lineItemsByNumber(results);
  const valid = new Set(validStatuses.filter(Boolean));
  const plan: WorkbookStatusPlan = { updates: [], addStatuses: [], unknownStatuses: [] };
  rows.forEach((values, rowIndex) => {
    const id = String(values[reimb] ?? "").trim();
    const n = String(values[line] ?? "").trim();
    if (!id || !n) return;
    const item = byNumber.get(`${id}-${n}`);
    if (!item) return;
    let mapped = mapApiStatus(item.ExternalStatus, item.Appealed);
    if (!mapped) return;
    const paidOut = typeof item.ItemAmount === "number" && Number.isFinite(item.ItemAmount);
    if ((mapped === "Approved" || mapped === "Paid") && paidOut) {
      const a = Number.parseFloat(String(values[amount] ?? "NaN"));
      const t = Number.parseFloat(String(values[reim] ?? "NaN"));
      if (Math.abs(item.ItemAmount! - a) >= 0.01 && Math.abs(item.ItemAmount! - t) >= 0.01) mapped = mapped === "Paid" ? "Paid (Adjusted)" : "Adjusted";
    }
    if (!valid.has(mapped) && DEFINED_HERE.has(mapped)) {
      valid.add(mapped);
      plan.addStatuses.push(mapped);
    }
    if (!valid.has(mapped)) {
      if (!plan.unknownStatuses.includes(mapped)) plan.unknownStatuses.push(mapped);
      return;
    }
    const changes: Record<string, string | number> = {};
    if (String(values[status] ?? "").trim() !== mapped) changes["Status"] = mapped;
    // A real reimbursed amount only once the item is paid out: "Submitted" is only the request, "Denied" was never paid.
    if (["Approved", "Paid", "Paid (Adjusted)", "Adjusted"].includes(mapped) && paidOut && String(values[reimbursed] ?? "").trim() !== String(item.ItemAmount)) {
      changes["Reimbursed Amount"] = item.ItemAmount!;
    }
    // What StepUp said (a denial reason) goes on the end of the row's notes, once. A paid item's old comment is history.
    const said = mapped !== "Paid" && notes !== -1 ? messageOf(item as Record<string, unknown>) : undefined;
    if (said) {
      const text = `StepUp: ${said}`;
      const current = String(values[notes] ?? "").trim();
      const norm = (t: string): string => t.toLowerCase().replace(/\s+/g, " ");
      const comment = said.includes(": ") ? said.slice(said.indexOf(": ") + 2) : said;
      if (!current.includes(text) && !norm(current).includes(norm(comment).slice(0, 60))) changes["Notes"] = current ? `${current}\n${text}` : text;
    }
    if (Object.keys(changes).length) plan.updates.push({ rowIndex, label: `${id}-${n}`, changes });
  });
  return plan;
}
