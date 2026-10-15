/**
 * The decisions the filing engine makes, as plain functions: how an entry in one of StepUp's lists is chosen for a
 * spreadsheet's words, how amounts and dates are written, and how the item blocks on StepUp's page are paired with the
 * rows being filed. Ported from the command line's flow (reimbursementFlow.ts), which learned each rule the hard way.
 * Nothing here touches the page, and nothing guesses: where two answers are possible the result says so.
 */

/** One item being filed, with the columns the command line read (`Item`, `Amount`, `Quantity`, …). */
export interface FilingRow {
  id: string;
  data: Record<string, string>;
}

export const PROVIDER_NOT_LISTED = "Provider not Listed";

const norm = (v: string): string => v.toLowerCase().replace(/[^a-z0-9]/g, "");

/** "Bob - Smith - Widget" to its levels (Category, then Type, then Description). */
export const categoryLevels = (category: string): string[] =>
  category
    .split(" - ")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

export type EntryChoice = { how: "exact" | "normalized" | "partial"; text: string } | { how: "none" } | { how: "ambiguous"; count: number };

/**
 * Which entry of an open list to click for the words the spreadsheet has. Exact first; then the same ignoring case and
 * punctuation ("Walmart" for "Wal-mart"); then a single partial hit ("Apple" for "Apple Store"). Two or more partial
 * hits are not a match: that is `ambiguous`, and the caller stops.
 */
export function chooseEntry(entries: string[], wanted: string, skip: string[] = []): EntryChoice {
  const pool = entries.filter((e) => !skip.includes(e));
  const w = wanted.trim();
  if (!w) return { how: "none" };
  if (pool.includes(w)) return { how: "exact", text: w };
  const normalized = pool.filter((e) => norm(e) === norm(w));
  if (normalized.length === 1) return { how: "normalized", text: normalized[0]! };
  const partial = pool.filter((e) => e.toLowerCase().includes(w.toLowerCase()));
  if (partial.length === 1) return { how: "partial", text: partial[0]! };
  return partial.length > 1 ? { how: "ambiguous", count: partial.length } : { how: "none" };
}

/** A number from a money or count cell ("$1,234.50", "3"); undefined when there is none. */
export function numberOf(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number.parseFloat(String(v).replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/** Two decimals, as the money fields are written; blanks are left blank. */
export function moneyText(v: string | undefined): string | undefined {
  const n = numberOf(v);
  return n === undefined ? undefined : round2(n).toFixed(2);
}

/** Whether two money or count values are the same number (12.5 and "$12.50" are). */
export const sameNumber = (a: string | undefined, b: string | undefined): boolean => {
  const x = numberOf(a);
  const y = numberOf(b);
  return x !== undefined && y !== undefined && Math.abs(x - y) < 0.005;
};

/** A date cell as `YYYY-MM-DD`: an ISO date, an Excel serial (days since 1899-12-30), or anything Date can read. */
export function isoDate(v: string | undefined): string | undefined {
  const t = (v ?? "").trim();
  if (!t) return undefined;
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);
  const d = /^\d+$/.test(t) ? new Date(Date.UTC(1899, 11, 30) + Number(t) * 86_400_000) : new Date(t);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10);
}

/** What the Summary's total should read for these rows: each amount x its quantity (blank is 1), plus tax and shipping. */
export function expectedTotal(rows: FilingRow[]): number {
  const total = rows.reduce((sum, r) => {
    const qty = numberOf(r.data["Quantity"]);
    const q = qty === undefined || qty === 0 ? 1 : qty;
    return sum + round2(numberOf(r.data["Amount"]) ?? 0) * q + round2(numberOf(r.data["Tax, Shipping, etc."]) ?? 0);
  }, 0);
  return round2(total);
}

/** The Summary's per-item arithmetic for a row, to compare with what StepUp shows. */
export const expectedLine = (r: FilingRow): { quantity: number; cost: number; tax: number } => ({
  quantity: numberOf(r.data["Quantity"]) || 1,
  cost: round2(numberOf(r.data["Amount"]) ?? 0),
  tax: round2(numberOf(r.data["Tax, Shipping, etc."]) ?? 0),
});

/** Whether the Summary's item lines are the rows' lines, in any order (each used once). */
export function linesMatch(shown: Array<{ quantity: number; cost: number; tax: number }>, rows: FilingRow[]): boolean {
  if (shown.length !== rows.length) return false;
  const left = rows.map(expectedLine);
  for (const s of shown) {
    const i = left.findIndex((e) => e.quantity === s.quantity && Math.abs(e.cost - s.cost) < 0.005 && Math.abs(e.tax - s.tax) < 0.005);
    if (i === -1) return false;
    left.splice(i, 1);
  }
  return true;
}

export type BlockMatch = { how: "amount" | "name" | "only" | "order"; row: FilingRow } | { how: "ambiguous" } | { how: "none" };

/**
 * Pairs one item block on StepUp's page with one of the rows not yet used, the way the command line did: by the amount
 * StepUp's scan read, else by the name it read (only when exactly one row has it), else the last row left, else (when the
 * scan read nothing at all) by order. Anything else is `ambiguous`: the command line asked a person; the engine stops.
 */
export function matchBlock(remaining: FilingRow[], scanCost: string | undefined, scanName: string | undefined, scanFailed: boolean): BlockMatch {
  if (remaining.length === 0) return { how: "none" };
  const cost = numberOf(scanCost);
  if (cost !== undefined && cost > 0) {
    const hit = remaining.find((r) => {
      const a = numberOf(r.data["Amount"]);
      return a !== undefined && Math.abs(a - cost) < 0.01;
    });
    if (hit) return { how: "amount", row: hit };
  }
  const name = (scanName ?? "").trim().toLowerCase();
  if (name) {
    const named = remaining.filter((r) => (r.data["Item"] ?? "").trim().toLowerCase() === name);
    if (named.length === 1) return { how: "name", row: named[0]! };
  }
  if (remaining.length === 1) return { how: "only", row: remaining[0]! };
  if (scanFailed) return { how: "order", row: remaining[0]! };
  return { how: "ambiguous" };
}

/**
 * Which checkboxes of the detected items to tick: all of them when there are as many as rows; else each one whose label
 * is exactly one row's item name. Undefined when it cannot be settled without a person.
 */
export function boxesToCheck(labels: string[], rows: FilingRow[]): number[] | undefined {
  if (labels.length === rows.length) return labels.map((_, i) => i);
  const remaining = [...rows];
  const picked: number[] = [];
  for (let i = 0; i < labels.length; i++) {
    const l = (labels[i] ?? "").trim().toLowerCase();
    const hits = l ? remaining.filter((r) => (r.data["Item"] ?? "").trim().toLowerCase() === l) : [];
    if (hits.length !== 1) return undefined;
    picked.push(i);
    remaining.splice(remaining.indexOf(hits[0]!), 1);
  }
  return remaining.length === 0 ? picked : undefined;
}
