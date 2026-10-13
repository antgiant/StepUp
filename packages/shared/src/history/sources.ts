import { formatCents } from "../domain/money.js";
import type { StepUpLine, StepUpReimbursement } from "../stepup/archive.js";
import type { HistoryChange, HistoryDetail } from "./types.js";

const dollars = (c: number | undefined) => (c === undefined ? "(none)" : formatCents(c));
const word = (l: StepUpLine) => (l.status === "Denied" ? (l.appealed ? "Denied (final)" : "Denied") : l.status || "(none)");
const short = (s: string | undefined) => (s ? (s.length > 160 ? `${s.slice(0, 157)}...` : s) : "(none)");

/**
 * What changed in StepUp's own list between two readings. `next` is the reimbursements that are new or different
 * (the unchanged ones need not be passed); `prev` is everything kept before. A reimbursement not seen before is "added".
 */
export function diffStepUp(prev: readonly StepUpReimbursement[], next: readonly StepUpReimbursement[], at: string): HistoryChange[] {
  const before = new Map(prev.map((r) => [r.id, r]));
  const out: HistoryChange[] = [];
  for (const r of next) {
    const was = before.get(r.id);
    const total = r.lines.reduce((n, l) => n + l.amountCents, 0);
    const label = `#${r.number}${r.student ? ` for ${r.student}` : ""}`;
    const subject = { kind: "reimbursement", id: String(r.number), label };
    const base = { at, source: "stepup" as const, actor: "StepUp", subject };
    if (!was) {
      out.push({ ...base, id: `stepup:${r.id}:added:${at}`, kind: "added", summary: `StepUp has reimbursement ${label}: ${r.lines.length} item(s), ${formatCents(total)}, ${r.status || "status unknown"}` });
      continue;
    }
    const details: HistoryDetail[] = [];
    if (was.status !== r.status) details.push({ field: "Reimbursement status", from: was.status || "(none)", to: r.status || "(none)" });
    const had = new Map(was.lines.map((l) => [l.number, l]));
    for (const l of r.lines) {
      const o = had.get(l.number);
      const name = l.name ?? l.benefit?.slice(0, 40) ?? l.number;
      if (!o) {
        details.push({ field: `Item ${l.number}`, to: `added: ${name}, ${dollars(l.amountCents)}, ${word(l)}` });
        continue;
      }
      if (word(o) !== word(l)) details.push({ field: `Status of ${l.number}`, from: word(o), to: word(l) });
      if (o.amountCents !== l.amountCents) details.push({ field: `Amount of ${l.number}`, from: dollars(o.amountCents), to: dollars(l.amountCents) });
      if ((o.reason ?? "") !== (l.reason ?? "")) details.push({ field: `Reason for ${l.number}`, from: short(o.reason), to: short(l.reason) });
      if ((o.comment ?? "") !== (l.comment ?? "")) details.push({ field: `StepUp says about ${l.number}`, from: short(o.comment), to: short(l.comment) });
      if ((o.paymentDate ?? "") !== (l.paymentDate ?? "")) details.push({ field: `Payment date of ${l.number}`, from: o.paymentDate ?? "(none)", to: l.paymentDate ?? "(none)" });
    }
    for (const o of was.lines) if (!r.lines.some((l) => l.number === o.number)) details.push({ field: `Item ${o.number}`, from: `${o.name ?? o.benefit?.slice(0, 40) ?? ""} ${dollars(o.amountCents)}`.trim(), to: "no longer listed" });
    if (details.length) out.push({ ...base, id: `stepup:${r.id}:${at}`, kind: "changed", summary: `StepUp changed reimbursement ${label}`, details });
  }
  return out;
}

/** The workbook's columns whose changes are worth listing. Others (formulas, counters, file names) are left out. */
export const EXCEL_TRACKED = [
  "Child", "Item", "Description", "Date", "Service Date", "Invoice #", "Category", "Quantity", "Amount", "Tax, Shipping, etc.", "Reim. $", "Reimbursed Amount",
  "Vendor", "Service Provider", "Payment Method", "Benefit Message", "Status", "Notes", "Submitted", "Reimbursement ID", "Line Number", "Pre-Auth #",
] as const;

/** What was seen of a workbook the last time: each tracked column of each row, by the row's ID. */
export interface ExcelSnapshot {
  v: 1;
  at: string;
  rows: Record<string, Record<string, string>>;
}

const cell = (v: unknown): string => (v === undefined || v === null ? "" : typeof v === "number" ? String(Math.round(v * 100) / 100) : String(v).replace(/\s+/g, " ").trim());

/** A workbook's rows as a snapshot (rows with no ID cannot be followed and are left out). */
export function snapshotExcel(headers: readonly string[], rows: readonly unknown[][], at: string): ExcelSnapshot {
  const idAt = headers.indexOf("ID");
  const cols = EXCEL_TRACKED.map((name) => [name, headers.indexOf(name)] as const).filter(([, i]) => i >= 0);
  const out: ExcelSnapshot["rows"] = {};
  if (idAt < 0) return { v: 1, at, rows: out };
  for (const r of rows) {
    const id = cell(r[idAt]);
    if (!id) continue;
    out[id] = Object.fromEntries(cols.map(([name, i]) => [name, cell(r[i])]));
  }
  return { v: 1, at, rows: out };
}

/**
 * What changed in the workbook between two snapshots: rows added or removed, and each tracked column that differs.
 * With no earlier snapshot there is nothing to compare, so a single note says tracking began.
 */
export function diffExcel(prev: ExcelSnapshot | undefined, next: ExcelSnapshot, actor: string): HistoryChange[] {
  const at = next.at;
  const base = { at, source: "excel" as const, actor };
  const count = Object.keys(next.rows).length;
  if (!prev) {
    return count ? [{ ...base, id: `excel:${at}:baseline`, kind: "note", subject: { kind: "workbook", id: "workbook", label: "Tracking workbook" }, summary: `Started following the workbook: ${count} row(s)` }] : [];
  }
  const out: HistoryChange[] = [];
  const name = (row: Record<string, string>) => row["Item"] || row["Description"] || "row";
  for (const [id, row] of Object.entries(next.rows)) {
    const was = prev.rows[id];
    const subject = { kind: "row", id, label: `${name(row)}${row["Child"] ? ` (${row["Child"]})` : ""}` };
    if (!was) {
      out.push({ ...base, id: `excel:${at}:${id}:added`, kind: "added", subject, summary: `Row ${id} added to the workbook: ${subject.label}` });
      continue;
    }
    const details: HistoryDetail[] = [];
    for (const col of EXCEL_TRACKED) {
      if (row[col] === undefined && was[col] === undefined) continue;
      if ((row[col] ?? "") !== (was[col] ?? "")) details.push({ field: col, from: was[col] || "(blank)", to: row[col] || "(blank)" });
    }
    if (details.length) out.push({ ...base, id: `excel:${at}:${id}`, kind: "changed", subject, summary: `Row ${id} changed in the workbook: ${subject.label}`, details });
  }
  for (const [id, was] of Object.entries(prev.rows)) {
    if (!next.rows[id]) out.push({ ...base, id: `excel:${at}:${id}:removed`, kind: "removed", subject: { kind: "row", id, label: name(was) }, summary: `Row ${id} removed from the workbook: ${name(was)}` });
  }
  return out;
}
