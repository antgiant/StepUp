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
const HEADER_BAND = 0.35;
const MONEY = /\d[\d,]*\.\d{2}\b/;
const BALANCE_WORDS = /balance|payment due|due date|credit limit|credit line|available|minimum|new charges|previous|rewards|points|late fee|interest/i;
const COLUMN_HEADER = /date.*(description|merchant|details|transaction).*amount/i;

/** The statement period, as printed on one line. */
function periodOf(text: string): boolean {
  return readStatementHeader([text], text).periodStart !== undefined;
}

/** First-page lines that mark the end of the heading: the issuer's name, the statement period, and the card's last digits. */
function isFirstPageAnchor(text: string): boolean {
  const h = readStatementHeader([text], text);
  return Boolean(h.issuer) || h.periodStart !== undefined || h.last4 !== undefined;
}

const FAR = 100000;

/** The full-width strips from the top of the page down to `bottom`, leaving out the given lines (and what is level with them). */
function regionRects(bottom: number, hidden: Rect[], pad: number): Rect[] {
  const cuts = hidden.map((r) => ({ x0: r.x0 - pad, x1: r.x1 + pad, y0: Math.max(bottom, r.y0 - pad), y1: r.y1 + pad })).filter((r) => r.y1 > bottom);
  const ys = [...new Set([bottom, FAR, ...cuts.flatMap((c) => [c.y0, c.y1].filter((y) => y > bottom && y < FAR))])].sort((a, b) => a - b);
  const out: Rect[] = [];
  for (let i = 0; i + 1 < ys.length; i++) {
    const [y0, y1] = [ys[i]!, ys[i + 1]!];
    const mid = (y0 + y1) / 2;
    const spans = cuts.filter((c) => c.y0 <= mid && mid <= c.y1).sort((a, b) => a.x0 - b.x0);
    let x = -FAR;
    for (const c of spans) {
      if (c.x0 > x) out.push({ x0: x, y0, x1: c.x0, y1 });
      x = Math.max(x, c.x1);
    }
    out.push({ x0: x, y0, x1: FAR, y1 });
  }
  return out;
}

/** A heading line's identity across pages: its words with digits folded, so "Page 2 of 5" matches "Page 3 of 5". */
function headingKey(text: string): string | undefined {
  const key = text.toLowerCase().replace(/\d+/g, "#").replace(/[^a-z#]+/g, " ").trim();
  return /[a-z]{3}/.test(key) ? key : undefined;
}

/** Per page, the line numbers in its top band above the first column heading or charge: where a heading can be. */
function pageBands(flat: Array<{ page: number; line: PositionedLine }>, texts: string[], rowLines: Set<number>, pageCount: number): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (let page = 0; page < pageCount; page++) {
    const ns = flat.map((f, n) => ({ f, n })).filter((x) => x.f.page === page);
    if (!ns.length) continue;
    const topY = Math.max(...ns.map((x) => x.f.line.y1));
    const bottomY = Math.min(...ns.map((x) => x.f.line.y0));
    const floor = topY - HEADER_BAND * (topY - bottomY);
    const stop = ns.find((x) => rowLines.has(x.n) || COLUMN_HEADER.test(texts[x.n]!));
    out.set(page, ns.filter((x) => (!stop || x.n < stop.n) && x.f.line.y0 >= floor).map((x) => x.n));
  }
  return out;
}

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

  // The statement's heading is kept as a whole region, logo and card art included, not as separate lines of text: from the
  // top of the page down to its last anchor. Anchors are the issuer's name, the statement period and the card line on the
  // first page, and on every page a line that repeats on other pages (the same words, page numbers aside), whatever it
  // says. Inside the region, a line of balances, rewards or other amounts is blacked out unless it is itself a repeating
  // heading line; nothing below the last anchor is part of the heading.
  const rowLines = new Set(rows.map((r) => r.index));
  const band = pageBands(flat, texts, rowLines, pages.length);
  const seenOn = new Map<string, Set<number>>();
  for (const [page, ns] of band) for (const n of ns) {
    const key = headingKey(texts[n]!);
    if (key) (seenOn.get(key) ?? seenOn.set(key, new Set()).get(key)!).add(page);
  }
  const repeats = (n: number) => {
    const key = headingKey(texts[n]!);
    return key !== undefined && (seenOn.get(key)?.size ?? 0) > 1;
  };
  const regionIdx = new Set<number>();
  const regionKeeps: Array<{ page: number; rects: Rect[] }> = [];
  let hasPeriodLine = false;
  for (const [page, ns] of band) {
    const anchors = ns.filter((n) => repeats(n) || (page === 0 && isFirstPageAnchor(texts[n]!)));
    if (page === 0 && ns.some((n) => periodOf(texts[n]!))) hasPeriodLine = true;
    if (!anchors.length) continue;
    const last = Math.min(...anchors.map((n) => flat[n]!.line.y0));
    const bottom = last - pad;
    const inRegion = flat.map((f, n) => n).filter((n) => flat[n]!.page === page && flat[n]!.line.y1 > last && !rowLines.has(n));
    const hidden = inRegion.filter((n) => !repeats(n) && !(page === 0 && isFirstPageAnchor(texts[n]!)) && (MONEY.test(texts[n]!) || BALANCE_WORDS.test(texts[n]!)));
    for (const n of inRegion) if (!hidden.includes(n)) { keepIdx.add(n); regionIdx.add(n); }
    regionKeeps.push({ page, rects: regionRects(bottom, hidden.map((n) => flat[n]!.line), pad) });
  }
  const headerKept = regionKeeps.length > 0;

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
  for (const r of regionKeeps) out[r.page]!.keep.push(...r.rects);
  for (const n of [...keepIdx].sort((a, b) => a - b)) {
    const { page, line } = flat[n]!;
    if (!regionIdx.has(n)) out[page]!.keep.push({ x0: line.x0 - pad, y0: line.y0 - pad, x1: line.x1 + pad, y1: line.y1 + pad });
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
  if (!hasPeriodLine) warnings.push("The statement period was not found; the copy will not show which period it covers.");
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
  const money = (cents: number) => (Math.abs(cents) / 100).toFixed(2);
  const expected = new Set(kept.map((k) => money(k.amountCents)));
  const amounts = (t: string) => [...t.matchAll(/\d{1,3}(?:,\d{3})*\.\d{2}|\d+\.\d{2}/g)].map((m) => m[0].replace(/,/g, ""));
  // Lines that are meant to be readable are not leaks: the heading on every page (card digits and all) and the kept
  // charges' own lines (with whatever else is printed on them, such as the points or cash back earned by that charge).
  const outside: string[] = [];
  const found = new Set<string>();
  for (const page of pageTexts) {
    const lines = page.split("\n");
    let from = 0;
    if (opts.headerKept) {
      const stop = lines.findIndex((l) => COLUMN_HEADER.test(l) || amounts(l).some((a) => expected.has(a)));
      from = stop < 0 ? lines.length : stop;
    }
    lines.forEach((line, i) => {
      const here = amounts(line);
      here.forEach((a) => found.add(a));
      if (i < from || here.some((a) => expected.has(a))) return;
      outside.push(line);
    });
  }
  const unreadable = kept.filter((k) => !found.has(money(k.amountCents))).map((k) => k.descriptor);
  const leaks = [...new Set(outside.flatMap(amounts))].filter((f) => !expected.has(f)).map((f) => `an amount (${f}) that is not a kept charge`);
  if (SENSITIVE.test(outside.join("\n").replace(/\b(19|20)\d{2}\b/g, ""))) leaks.push("something shaped like an account number");
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
