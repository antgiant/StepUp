export interface PaymentEvidence {
  /** 0..1. At or above `PAYMENT_EVIDENCE_MIN` it counts as proof of payment; below that a person confirms. */
  confidence: number;
  snippet: string;
}

export interface ReceiptReading {
  vendor?: string;
  date?: string;
  invoiceNo?: string;
  totalCents?: number;
  /** Tax plus shipping/handling found on the receipt. */
  taxShippingCents?: number;
  last4?: string;
  paymentEvidence?: PaymentEvidence;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONEY = /(?:\$\s?)?(\d{1,3}(?:,\d{3})*|\d+)\.(\d{2})\b/g;
const cents = (whole: string, frac: string) => Number(whole.replace(/,/g, "")) * 100 + Number(frac);

function amountsIn(line: string): number[] {
  return [...line.matchAll(MONEY)].map((m) => cents(m[1]!, m[2]!));
}

function isoDate(y: number, m: number, d: number): string | undefined {
  return m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 2000 && y <= 2100 ? `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}` : undefined;
}

/** The first date in a line: 2026-09-17, 09/17/2026, 09/17/26, September 17, 2026, 17 Sep 2026. */
function dateIn(line: string): string | undefined {
  let m = /\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/.exec(line);
  if (m) return isoDate(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /\b(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})\b/.exec(line);
  if (m) return isoDate(m[3]!.length === 2 ? 2000 + Number(m[3]) : Number(m[3]), Number(m[1]), Number(m[2]));
  m = /\b([A-Za-z]{3,9})\.? (\d{1,2})(?:st|nd|rd|th)?,? (20\d{2})\b/.exec(line);
  if (m && MONTHS.includes(m[1]!.slice(0, 3).toLowerCase())) return isoDate(Number(m[3]), MONTHS.indexOf(m[1]!.slice(0, 3).toLowerCase()) + 1, Number(m[2]));
  m = /\b(\d{1,2}) ([A-Za-z]{3,9})\.?,? (20\d{2})\b/.exec(line);
  if (m && MONTHS.includes(m[2]!.slice(0, 3).toLowerCase())) return isoDate(Number(m[3]), MONTHS.indexOf(m[2]!.slice(0, 3).toLowerCase()) + 1, Number(m[1]));
  return undefined;
}

const TOTAL_RANKS: RegExp[] = [/\b(grand|order|invoice) total\b/i, /\b(total (paid|charged|amount)|amount (paid|charged))\b/i, /\btotal\b/i];
const NOT_TOTAL = /sub\s*-?\s*total|total (savings|before|items|qty|quantity)|before tax|tax total|\btotal tax\b/i;

function readTotal(lines: string[]): number | undefined {
  for (const rank of TOTAL_RANKS) {
    const hits = lines.filter((l) => rank.test(l) && !NOT_TOTAL.test(l) && amountsIn(l).length > 0);
    const last = hits[hits.length - 1];
    if (last) return amountsIn(last).at(-1);
  }
  return undefined;
}

/** What the receipt says it was paid with; "balance due 0.00" and card lines are the strong signs. */
function readPayment(lines: string[], text: string): { evidence?: PaymentEvidence; last4?: string } {
  const last4 = /(?:visa|mastercard|master card|mc|amex|american express|discover|debit|credit|card)\D{0,24}?(?:ending(?: in)?|\*{2,}|x{2,}|•{2,}|#)\s*(\d{4})\b/i.exec(text)?.[1] ?? /\bending in (\d{4})\b/i.exec(text)?.[1];
  const hits: PaymentEvidence[] = [];
  const add = (confidence: number, re: RegExp) => {
    const line = lines.find((l) => re.test(l));
    if (line) hits.push({ confidence, snippet: line.slice(0, 80) });
  };
  add(0.95, /\b(amount|balance|total)\s*(due|owed|remaining|outstanding)\W{0,8}\$?\s?0*\.00\b/i);
  add(0.95, /\bpaid in full\b|\bpayment received\b|\bthank you for your payment\b/i);
  add(0.9, /\b(payment|paid)\b.{0,40}\b(visa|mastercard|master card|amex|american express|discover|debit|credit card)\b/i);
  add(0.85, /\b(visa|mastercard|master card|amex|american express|discover|debit|credit)\b.{0,30}(ending|\*{2,}|x{2,}|•{2,}).{0,4}\d{4}/i);
  add(0.6, /\bpayment method\b|\bpaid\b/i);
  const owes = lines.find((l) => /\b(amount|balance|total)\s*(due|owed)\b/i.test(l) && amountsIn(l).some((a) => a > 0));
  let best = hits.sort((a, b) => b.confidence - a.confidence)[0];
  if (owes && (!best || best.confidence < 0.9)) best = { confidence: 0.2, snippet: owes.slice(0, 80) };
  return { ...(best ? { evidence: best } : {}), ...(last4 ? { last4 } : {}) };
}

function readVendor(lines: string[], text: string): string | undefined {
  const domain = /\b(?:www\.)?([a-z0-9][a-z0-9-]{2,})\.(?:com|org|net|edu)\b/i.exec(lines.slice(0, 10).join("\n"));
  if (domain && !/^(www|mail|email|noreply)$/i.test(domain[1]!)) return domain[1]![0]!.toUpperCase() + domain[1]!.slice(1).toLowerCase();
  const candidate = lines.slice(0, 6).find((l) => /^[A-Z][A-Za-z]{2}/.test(l) && l.length <= 40 && !/receipt|invoice|order|page|thank|date|total|tax|details|transaction|statement|summary|confirmation|your |\d{3}|^[^A-Za-z]/i.test(l));
  return candidate && text ? candidate : undefined;
}

/** Reads what a receipt's text says. Everything it returns is a suggestion for a person to confirm. Pure: the text comes from OCR or a PDF. */
export function readReceiptText(text: string): ReceiptReading {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  const out: ReceiptReading = {};

  const vendor = readVendor(lines, text);
  if (vendor) out.vendor = vendor;

  const dated = lines.filter((l) => /order|date|placed|purchased|invoice|ordered/i.test(l)).map(dateIn).find(Boolean) ?? lines.map(dateIn).find(Boolean);
  if (dated) out.date = dated;

  // "Order #112-...", "Invoice #A-10045": the id must contain a digit ("Order Placed" is not an id).
  const invoice = [...text.matchAll(/(?:order|invoice|receipt|confirmation)\s*(?:#|no\.?|number|id)?\s*[:#]?\s*([A-Za-z0-9][A-Za-z0-9-]{3,})/gi)].map((m) => m[1]!).find((id) => /\d/.test(id));
  if (invoice) out.invoiceNo = invoice;

  const total = readTotal(lines);
  if (total !== undefined) out.totalCents = total;

  const extras = lines.filter((l) => /\b(sales tax|tax|vat|shipping|delivery|handling)\b/i.test(l) && !/tax (id|rate|exempt)|before tax|\btotal\b|sub\s*-?\s*total/i.test(l)).map((l) => amountsIn(l).at(-1)).filter((n): n is number => n !== undefined);
  if (extras.length) out.taxShippingCents = extras.reduce((a, b) => a + b, 0);

  const { evidence, last4 } = readPayment(lines, text);
  if (evidence) out.paymentEvidence = evidence;
  if (last4) out.last4 = last4;
  return out;
}
