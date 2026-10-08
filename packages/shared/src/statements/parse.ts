import type { StatementData, StatementTransaction } from "../domain/types.js";
import { hashString } from "../util/hash.js";

export interface ParsedStatement extends StatementData {
  /** Lines that end in an amount but could not be read as a transaction: shown for a person to check, never silently dropped. */
  unparsedLines: string[];
  warnings: string[];
}

export interface ParseOptions {
  /** Year to assume for dates that carry none when the statement has no readable period (default: this year). */
  defaultYear?: number;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
// "09/15", "09/15/25", "09/15/2025", "Sep 15", "Sep 15, 2025"
const DATE = String.raw`(?:\d{1,2}/\d{1,2}(?:/\d{2,4})?|[A-Za-z]{3,9}\.? \d{1,2}(?:, ?\d{4})?)`;
const AMOUNT = String.raw`[-(]?\$?\s?\d{1,3}(?:,\d{3})*\.\d{2}\)?-?(?:\s?CR)?`;
const ROW = new RegExp(String.raw`^\s*(${DATE})(?:\s+(${DATE}))?\s+(.+?)\s+(${AMOUNT})\s*$`, "i");
const ENDS_IN_AMOUNT = new RegExp(String.raw`${AMOUNT}\s*$`, "i");
const PERIOD = new RegExp(String.raw`(?:period|closing|billing|statement)[^\n]{0,40}?(${DATE})\s*(?:-|–|to|through)\s*(${DATE})`, "i");

const ISSUERS: Array<[RegExp, string]> = [
  [/american express|amex/i, "American Express"],
  [/capital one/i, "Capital One"],
  [/bank of america/i, "Bank of America"],
  [/wells fargo/i, "Wells Fargo"],
  [/chase/i, "Chase"],
  [/citi(?:bank|corp|\b)/i, "Citi"],
  [/discover/i, "Discover"],
  [/barclays/i, "Barclays"],
  [/u\.?s\.? bank/i, "U.S. Bank"],
  [/apple card|goldman/i, "Apple Card"],
  [/synchrony/i, "Synchrony"],
];

/** Pure text -> transactions. The text comes from pdf.js / OCR in the browser (or Node); nothing here touches a file or the network. */
export function parseStatementText(text: string, opts: ParseOptions = {}): ParsedStatement {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  const warnings: string[] = [];

  const period = PERIOD.exec(text.replace(/\s+/g, " "));
  const fallbackYear = opts.defaultYear ?? new Date().getFullYear();
  let periodEnd = period ? toIso(period[2]!, fallbackYear) : undefined;
  let periodStart = period ? toIso(period[1]!, yearOf(periodEnd) ?? fallbackYear) : undefined;
  if (periodStart && periodEnd && periodStart > periodEnd) periodStart = toIso(period![1]!, (yearOf(periodEnd) ?? fallbackYear) - 1);
  if (!period) warnings.push("Could not find the statement period; dates without a year are assumed to be in " + fallbackYear + ".");
  const refYear = yearOf(periodEnd) ?? fallbackYear;
  const refMonth = periodEnd ? Number(periodEnd.slice(5, 7)) : 12;

  const issuer = ISSUERS.find(([re]) => re.test(lines.slice(0, 40).join("\n")))?.[1];
  const last4 = /(?:ending in|ending|account number|account #|acct\.?|card number|xxxx[- ]?|x{4}[- ]?|\*{4}[- ]?|•{4}[- ]?)\D{0,12}?(\d{4})\b/i.exec(text)?.[1];

  const transactions: StatementTransaction[] = [];
  const unparsedLines: string[] = [];
  const seen = new Map<string, number>();
  for (const line of lines) {
    const m = ROW.exec(line);
    if (!m) {
      if (/^\s*\d{1,2}\/\d{1,2}|^[A-Za-z]{3}\.? \d{1,2}\b/.test(line) && ENDS_IN_AMOUNT.test(line)) unparsedLines.push(line);
      continue;
    }
    const amountCents = parseAmount(m[4]!);
    const date = toIso(m[1]!, refYear, refMonth);
    if (amountCents === undefined || !date) {
      unparsedLines.push(line);
      continue;
    }
    const postDate = m[2] ? toIso(m[2], refYear, refMonth) : undefined;
    const descriptor = m[3]!.replace(/\s+/g, " ").trim();
    const hasYear = /\d\/\d{1,2}\/\d|\b\d{4}\b/.test(m[1]!);
    let confidence = 0.95;
    if (!hasYear && !period) confidence -= 0.2;
    if (descriptor.length < 3) confidence -= 0.3;
    const key = `${date}|${amountCents}|${descriptor.toLowerCase()}`;
    const nth = (seen.get(key) ?? 0) + 1;
    seen.set(key, nth);
    transactions.push({
      id: `txn-${hashString(`${key}#${nth}`)}`,
      date,
      ...(postDate ? { postDate } : {}),
      descriptor,
      amountCents,
      kind: classify(descriptor, amountCents),
      confidence: Math.round(confidence * 100) / 100,
    });
  }
  if (transactions.length === 0) warnings.push("No transactions were found. The statement can still be attached by hand.");
  return {
    ...(issuer ? { issuer } : {}),
    ...(last4 ? { last4 } : {}),
    ...(periodStart ? { periodStart } : {}),
    ...(periodEnd ? { periodEnd } : {}),
    transactions,
    unparsedLines,
    warnings,
  };
}

/** Positive = charge. Credits are written -12.00, (12.00), 12.00- or 12.00 CR depending on the issuer. */
export function parseAmount(raw: string): number | undefined {
  const s = raw.trim();
  const negative = /^-|^\(|\)$|-$|CR$/i.test(s);
  const digits = s.replace(/[^0-9.]/g, "");
  if (!/^\d+\.\d{2}$/.test(digits)) return undefined;
  const cents = Math.round(Number(digits) * 100);
  return negative ? -cents : cents;
}

function classify(descriptor: string, cents: number): StatementTransaction["kind"] {
  if (cents < 0) return /payment|thank you|autopay|auto pay/i.test(descriptor) ? "payment" : "credit";
  return /interest charge|finance charge|late fee|annual (?:membership )?fee|foreign transaction fee/i.test(descriptor) ? "fee" : "purchase";
}

function yearOf(iso: string | undefined): number | undefined {
  return iso ? Number(iso.slice(0, 4)) : undefined;
}

/** "09/15/25", "09/15", "Sep 15, 2025" -> "2025-09-15". A date with no year takes `refYear`, or the year before it when its month is later than `refMonth` (a December charge on a January statement). */
function toIso(raw: string, refYear: number, refMonth = 12): string | undefined {
  let month: number;
  let day: number;
  let year: number | undefined;
  const num = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/.exec(raw.trim());
  if (num) {
    month = Number(num[1]);
    day = Number(num[2]);
    year = num[3] ? (num[3].length === 2 ? 2000 + Number(num[3]) : Number(num[3])) : undefined;
  } else {
    const named = /^([A-Za-z]{3,9})\.? (\d{1,2})(?:, ?(\d{4}))?$/.exec(raw.trim());
    if (!named) return undefined;
    month = MONTHS.indexOf(named[1]!.slice(0, 3).toLowerCase()) + 1;
    day = Number(named[2]);
    year = named[3] ? Number(named[3]) : undefined;
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const y = year ?? (month > refMonth ? refYear - 1 : refYear);
  return `${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
