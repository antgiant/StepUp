import type { PositionedLine, Rect } from "./lines.js";
import type { LedgerState, StatementTransaction } from "../domain/types.js";
import { readRows, readStatementHeader } from "./parse.js";

export interface RedactionOptions {
  /** Charges that stay visible: by default every charge linked to a purchase this year (`program-rows`). */
  keepTransactionIds: ReadonlySet<string>;
  /** Extra room around each kept line, in PDF points. */
  pad?: number;
  /** `all` keeps every page that shows anything; `matched` also leaves out pages with no kept charge (the first page is always kept). A page that would be entirely black is always left out. */
  pages?: "all" | "matched";
}

export interface PageRedaction {
  /** The only parts of this page that stay visible. Everything else is blacked out. */
  keep: Rect[];
  keptText: string[];
  /** True when this page is left out of the copy altogether (`pages: "matched"`). */
  omit?: boolean;
}

export interface RedactionPlan {
  pages: PageRedaction[];
  keptTransactions: number;
  /** True when the top of the first page (issuer, card, period, who it is for) is left visible. */
  headerKept: boolean;
  /** Charges that were meant to stay but were not found on any page (so they would be blacked out). */
  missing: string[];
  warnings: string[];
}

// Account-number shapes: long digit groups, or "ending/account/card ... 1234".
export const SENSITIVE = /\d{4}[- ]?\d{4}|(?:ending|account|acct|card)\D{0,15}\d{4}|x{3,}[- ]?\d{4}|\*{3,}[- ]?\d{4}/i;
/** How much of the first page, from the top, can count as its header. */
const HEADER_BAND = 0.3;
const MONEY = /\d[\d,]*\.\d{2}\b/;
const BALANCE_WORDS = /balance|payment due|due date|credit limit|credit line|available|minimum|new charges|previous|rewards|points|late fee|interest/i;
const COLUMN_HEADER = /date.*(description|merchant|details|transaction).*amount/i;

/**
 * Decides what may stay visible on a statement sent to StepUp (plan §3.10a). It fails closed: only the allow-list below
 * is kept, and anything the parser does not recognise is blacked out.
 *   kept: the issuer's name line, the statement-period line, the column headings, and the rows of the charges to keep.
 *   never kept: account numbers, balances, interest, rewards, payments to the card, and every other charge.
 * Pure geometry: the renderer copies only these rectangles from the page image, so nothing else can survive.
 */
export function planRedaction(pages: PositionedLine[][], opts: RedactionOptions): RedactionPlan {
  const pad = opts.pad ?? 2;
  const flat = pages.flatMap((lines, page) => lines.map((line, i) => ({ page, i, line })));
  const texts = flat.map((f) => f.line.text.replace(/\s+/g, " ").trim());
  const header = readStatementHeader(texts, texts.join("\n"));
  const { rows } = readRows(texts, header);

  const keepIdx = new Set<number>();
  const keptIds = new Set<string>();
  for (const { index, txn } of rows) {
    if (txn.kind === "purchase" && opts.keepTransactionIds.has(txn.id)) {
      keepIdx.add(index);
      keptIds.add(txn.id);
    }
  }

  // Header lines (first page only): the issuer name and the statement period, unless they also carry an account number.
  const firstPage = flat.map((f, n) => ({ ...f, n })).filter((f) => f.page === 0).slice(0, 15);
  const rowLines = new Set(rows.map((r) => r.index));
  const issuerLine = firstPage.find((f) => !rowLines.has(f.n) && readStatementHeader([texts[f.n]!], texts[f.n]!).issuer && !SENSITIVE.test(texts[f.n]!));
  if (issuerLine) keepIdx.add(issuerLine.n);
  const periodLine = flat.findIndex((_, n) => !rowLines.has(n) && readStatementHeader([texts[n]!], texts[n]!).periodStart !== undefined && !SENSITIVE.test(texts[n]!));
  if (periodLine >= 0) keepIdx.add(periodLine);

  // The statement's header: everything at the top of the first page above the first column heading or charge, which is
  // where the issuer, the card, the period and the cardholder are. Lines with an amount or a balance are never part of it.
  const page0 = firstPage.length ? flat.map((f, n) => ({ ...f, n })).filter((f) => f.page === 0) : [];
  let headerKept = false;
  if (page0.length) {
    const topY = Math.max(...page0.map((f) => f.line.y1));
    const bottomY = Math.min(...page0.map((f) => f.line.y0));
    const floor = topY - HEADER_BAND * (topY - bottomY);
    const stop = page0.find((f) => rowLines.has(f.n) || COLUMN_HEADER.test(texts[f.n]!));
    for (const f of page0) {
      if (stop && f.n >= stop.n) break;
      if (f.line.y0 < floor) continue;
      if (MONEY.test(texts[f.n]!) || BALANCE_WORDS.test(texts[f.n]!)) continue;
      keepIdx.add(f.n);
      headerKept = true;
    }
  }

  // The column headings directly above the first kept row on each page, so the rows can be read.
  for (const n of [...keepIdx]) {
    for (let k = n - 1; k >= Math.max(0, n - 6) && flat[k]!.page === flat[n]!.page; k--) {
      if (COLUMN_HEADER.test(texts[k]!) && !SENSITIVE.test(texts[k]!)) {
        keepIdx.add(k);
        break;
      }
    }
  }

  const out: PageRedaction[] = pages.map(() => ({ keep: [], keptText: [] }));
  for (const n of [...keepIdx].sort((a, b) => a - b)) {
    const { page, line } = flat[n]!;
    out[page]!.keep.push({ x0: line.x0 - pad, y0: line.y0 - pad, x1: line.x1 + pad, y1: line.y1 + pad });
    out[page]!.keptText.push(texts[n]!);
  }

  // A page with nothing kept is solid black: never worth sending. `matched` also drops pages that only repeat a heading.
  const hasCharge = out.map(() => false);
  for (const n of keepIdx) if (rows.some((r) => r.index === n)) hasCharge[flat[n]!.page] = true;
  out.forEach((p, i) => {
    if (p.keep.length === 0 || (opts.pages === "matched" && i > 0 && !hasCharge[i])) p.omit = true;
  });
  if (out.length && out.every((p) => p.omit)) out[0]!.omit = false; // nothing found: keep one page so the failure is visible

  const missing = [...opts.keepTransactionIds].filter((id) => !keptIds.has(id));
  const warnings: string[] = [];
  if (keptIds.size === 0) warnings.push("None of the linked charges were found in this PDF, so every line would be blacked out.");
  if (periodLine < 0) warnings.push("The statement period was not found; the copy will not show which period it covers.");
  return { pages: out, keptTransactions: keptIds.size, headerKept, missing, warnings };
}

export interface RedactionCheck {
  /** Kept charges whose amount can be read in the finished copy. */
  legible: number;
  /** Kept charges whose amount could not be found in it. */
  unreadable: string[];
  /** Things that should not be there: an amount that is not one of the kept charges, or an account-number shape. */
  leaks: string[];
}

/**
 * Checks the finished copy by reading it again (OCR of the output pages): every kept charge must be legible, and nothing
 * else that looks like money or an account number may be. A regression guard, not a replacement for looking at the pages.
 */
export function checkRedactionOutput(pageTexts: string[], kept: Pick<StatementTransaction, "descriptor" | "amountCents">[], opts: { headerKept?: boolean } = {}): RedactionCheck {
  let texts = pageTexts;
  if (opts.headerKept && texts.length) {
    // The header is meant to be readable (card digits and all): leave out the lines above the first column heading or kept amount on page one.
    const expectedAmounts = kept.map((k) => (Math.abs(k.amountCents) / 100).toFixed(2));
    const lines = texts[0]!.split("\n");
    const stop = lines.findIndex((l) => COLUMN_HEADER.test(l) || expectedAmounts.some((a) => l.includes(a)));
    texts = [lines.slice(stop < 0 ? lines.length : stop).join("\n"), ...texts.slice(1)];
  }
  const text = texts.join("\n");
  const money = (cents: number) => (Math.abs(cents) / 100).toFixed(2);
  const found = new Set([...text.matchAll(/\d{1,3}(?:,\d{3})*\.\d{2}|\d+\.\d{2}/g)].map((m) => m[0].replace(/,/g, "")));
  const expected = new Set(kept.map((k) => money(k.amountCents)));
  const unreadable = kept.filter((k) => !found.has(money(k.amountCents))).map((k) => k.descriptor);
  const leaks = [...found].filter((f) => !expected.has(f)).map((f) => `an amount (${f}) that is not a kept charge`);
  if (SENSITIVE.test(text.replace(/\b(19|20)\d{2}\b/g, ""))) leaks.push("something shaped like an account number");
  return { legible: kept.length - unreadable.length, unreadable, leaks };
}

export interface LocatedCharge {
  transactionId: string;
  page: number;
  /** In PDF points (origin bottom left), the whole line of the charge. */
  rect: Rect;
}

/** Where each of the given charges sits in the PDF, so a preview can mark and scroll to it. Pure geometry, like planRedaction. */
export function locateCharges(pages: PositionedLine[][], transactionIds: ReadonlySet<string>): LocatedCharge[] {
  const flat = pages.flatMap((lines, page) => lines.map((line) => ({ page, line })));
  const texts = flat.map((f) => f.line.text.replace(/\s+/g, " ").trim());
  const header = readStatementHeader(texts, texts.join("\n"));
  const { rows } = readRows(texts, header);
  return rows
    .filter((r) => transactionIds.has(r.txn.id))
    .map((r) => {
      const { page, line } = flat[r.index]!;
      return { transactionId: r.txn.id, page, rect: { x0: line.x0, y0: line.y0, x1: line.x1, y1: line.y1 } };
    });
}

/**
 * Statements whose saved redacted copy no longer matches the charges linked to purchases: charges linked after the copy
 * was made (or unlinked since) change what it should show. A copy made before this was recorded is left alone.
 * Returns each statement with the charges its copy should show. Pure.
 */
export function staleRedactions(state: LedgerState): Array<{ documentId: string; keep: string[] }> {
  const out: Array<{ documentId: string; keep: string[] }> = [];
  for (const doc of Object.values(state.documents)) {
    if (!doc.statement || doc.archived || doc.redacted || doc.derivedFrom) continue;
    const keep = [...new Set(Object.values(state.additionalDocs).filter((a) => a.documentId === doc.id && a.kind === "payment-proof" && a.ownerId && a.transactionId).map((a) => a.transactionId!))].sort();
    if (keep.length === 0) continue;
    const copy = Object.values(state.documents).find((d) => d.redacted && d.derivedFrom === doc.id);
    if (copy && !copy.redactedKeeps) continue;
    if (!copy || copy.redactedKeeps!.join("|") !== keep.join("|")) out.push({ documentId: doc.id, keep });
  }
  return out;
}
