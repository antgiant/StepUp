import type { Ledger } from "../events/ledger.js";
import type { StatementData, StatementTransaction } from "../domain/types.js";
import { hashString } from "../util/hash.js";

/** What a person may correct about a statement's header. A blank string clears the field. */
export interface StatementDetails {
  issuer?: string;
  last4?: string;
  periodStart?: string;
  periodEnd?: string;
}

export interface TransactionEdit {
  date: string;
  descriptor: string;
  amountCents: number;
  kind: StatementTransaction["kind"];
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
export const isIsoDate = (s: string) => ISO.test(s) && !Number.isNaN(Date.parse(s));

function write(ledger: Ledger, docId: string, data: StatementData, label: string): void {
  ledger.set("document", docId, { statement: data as never }, { label });
}

/** Corrects the issuer, last four digits or period. A person's period replaces a worked-out one and is no longer flagged as a guess. */
export function editStatementDetails(ledger: Ledger, docId: string, details: StatementDetails): void {
  const current = ledger.state.documents[docId]?.statement;
  if (!current) return;
  const next: StatementData = { transactions: current.transactions };
  const pick = (key: keyof StatementDetails) => {
    const v = (key in details ? details[key] : current[key])?.trim();
    if (v) next[key] = v;
  };
  (["issuer", "last4", "periodStart", "periodEnd"] as const).forEach(pick);
  if (next.periodStart && !isIsoDate(next.periodStart)) delete next.periodStart;
  if (next.periodEnd && !isIsoDate(next.periodEnd)) delete next.periodEnd;
  if (next.last4 && !/^\d{4}$/.test(next.last4)) next.last4 = current.last4 as string;
  const periodTouched = "periodStart" in details || "periodEnd" in details;
  if (current.periodInferred && !periodTouched) next.periodInferred = true;
  write(ledger, docId, next, "statement.detailsEdited");
}

/** Fixes a misread row. The row keeps its id, so a link to a purchase survives the correction. */
export function editTransaction(ledger: Ledger, docId: string, txnId: string, edit: TransactionEdit): boolean {
  const current = ledger.state.documents[docId]?.statement;
  if (!current || !isIsoDate(edit.date) || !edit.descriptor.trim() || !Number.isFinite(edit.amountCents)) return false;
  let found = false;
  const transactions = current.transactions.map((t) => {
    if (t.id !== txnId) return t;
    found = true;
    return { ...t, date: edit.date, descriptor: edit.descriptor.trim(), amountCents: edit.amountCents, kind: edit.kind, confidence: 1, edited: true };
  });
  if (found) write(ledger, docId, { ...current, transactions }, "statement.rowEdited");
  return found;
}

/** Adds a row the reader missed. Its id cannot collide with a read row (it is derived from the content and the time of day-independent count). */
export function addTransaction(ledger: Ledger, docId: string, edit: TransactionEdit): string | undefined {
  const current = ledger.state.documents[docId]?.statement;
  if (!current || !isIsoDate(edit.date) || !edit.descriptor.trim() || !Number.isFinite(edit.amountCents)) return undefined;
  const base = `manual|${edit.date}|${edit.amountCents}|${edit.descriptor.trim().toLowerCase()}`;
  let n = 1;
  let id = `txn-${hashString(`${base}#${n}`)}`;
  while (current.transactions.some((t) => t.id === id)) id = `txn-${hashString(`${base}#${++n}`)}`;
  const row: StatementTransaction = { id, date: edit.date, descriptor: edit.descriptor.trim(), amountCents: edit.amountCents, kind: edit.kind, confidence: 1, edited: true };
  write(ledger, docId, { ...current, transactions: [...current.transactions, row].sort((a, b) => a.date.localeCompare(b.date)) }, "statement.rowAdded");
  return id;
}

/** Drops a row that is not a charge at all (a page header read as a transaction). */
export function removeTransaction(ledger: Ledger, docId: string, txnId: string): void {
  const current = ledger.state.documents[docId]?.statement;
  if (!current) return;
  write(ledger, docId, { ...current, transactions: current.transactions.filter((t) => t.id !== txnId) }, "statement.rowRemoved");
}

/**
 * When a statement is read again, keeps what a person already fixed: edited and added rows stay, and a read row is
 * dropped when an edited row covers the same charge. A person's period and card details win over the newly read ones.
 */
export function mergeReread(previous: StatementData | undefined, fresh: StatementData): StatementData {
  if (!previous) return fresh;
  const edited = previous.transactions.filter((t) => t.edited);
  const ids = new Set(edited.map((t) => t.id));
  const keep = fresh.transactions.filter((t) => !ids.has(t.id) && !edited.some((e) => e.date === t.date && e.amountCents === t.amountCents));
  const periodKept = previous.periodStart && !previous.periodInferred;
  return {
    ...fresh,
    ...(previous.issuer && !fresh.issuer ? { issuer: previous.issuer } : {}),
    ...(previous.last4 && !fresh.last4 ? { last4: previous.last4 } : {}),
    ...(periodKept ? { periodStart: previous.periodStart, periodEnd: previous.periodEnd, periodInferred: undefined } : {}),
    transactions: [...keep, ...edited].sort((a, b) => a.date.localeCompare(b.date)),
  };
}

export interface StatementGroup<T> {
  /** "Chase 4242", or "Card not identified" when neither issuer nor last four was read. */
  label: string;
  key: string;
  items: T[];
}

interface Clusterable {
  filename?: string;
  id: string;
  statement?: StatementData;
}

/** Groups statements by issuer and last four digits, each group oldest first. Statements not read yet are last. */
export function clusterStatements<T extends Clusterable>(docs: T[]): StatementGroup<T>[] {
  const groups = new Map<string, StatementGroup<T>>();
  for (const d of docs) {
    const s = d.statement;
    const issuer = s?.issuer?.trim();
    const last4 = s?.last4?.trim();
    const key = !s ? "~unread" : issuer || last4 ? `${(issuer ?? "").toLowerCase()}|${last4 ?? ""}` : "~unknown";
    const label = !s ? "Not read yet" : issuer || last4 ? [issuer ?? "Card", last4 ? `ending ${last4}` : ""].filter(Boolean).join(" ") : "Card not identified";
    const g = groups.get(key) ?? { label, key, items: [] };
    g.items.push(d);
    groups.set(key, g);
  }
  const when = (d: Clusterable) => d.statement?.periodStart ?? d.statement?.periodEnd ?? d.statement?.transactions[0]?.date ?? "9999";
  for (const g of groups.values()) g.items.sort((a, b) => when(a).localeCompare(when(b)) || (a.filename ?? a.id).localeCompare(b.filename ?? b.id));
  const rank = (g: StatementGroup<T>) => (g.key === "~unread" ? 2 : g.key === "~unknown" ? 1 : 0);
  return [...groups.values()].sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));
}
