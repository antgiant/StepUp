import { describe, expect, it } from "vitest";
import { PAYMENT_EVIDENCE_MIN, parseStatementText, readReceiptText } from "../src/index.js";

// Made-up receipts.
const ONLINE = `
amazon.com
Order Placed: September 17, 2026
Order # 112-0000000-1234567
Item(s) Subtotal: $50.00
Shipping & Handling: $0.00
Estimated tax to be collected: $3.50
Grand Total: $53.50
Paid with Visa ending in 4242
`;

const STORE = `
Star Learning Supply
123 Main St
09/20/26 14:32
Workbook          12.00
Pencils            3.00
SUBTOTAL          15.00
TAX                1.05
TOTAL             16.05
VISA **** 4242     16.05
Thank you!
`;

const INVOICE = `
Acme Tutoring
Invoice #A-10045
Invoice Date: 2026-10-01
Tutoring, 4 sessions   $200.00
Total: $200.00
Amount Due: $200.00
`;

const PAID = `
Acme Tutoring
Invoice #A-10046
Date: 10/01/2026
Total: $200.00
Payment received - thank you
Balance due: $0.00
`;

describe("readReceiptText", () => {
  it("reads an online order", () => {
    const r = readReceiptText(ONLINE);
    expect(r).toMatchObject({ vendor: "Amazon", date: "2026-09-17", invoiceNo: "112-0000000-1234567", totalCents: 5350, taxShippingCents: 350, last4: "4242" });
    expect(r.paymentEvidence!.confidence).toBeGreaterThanOrEqual(PAYMENT_EVIDENCE_MIN);
  });

  it("reads a till receipt: takes TOTAL not SUBTOTAL, and a card line is payment evidence", () => {
    const r = readReceiptText(STORE);
    expect(r).toMatchObject({ vendor: "Star Learning Supply", date: "2026-09-20", totalCents: 1605, taxShippingCents: 105, last4: "4242" });
    expect(r.paymentEvidence!.confidence).toBeGreaterThanOrEqual(PAYMENT_EVIDENCE_MIN);
  });

  it("an unpaid invoice is not proof of payment", () => {
    const r = readReceiptText(INVOICE);
    expect(r).toMatchObject({ vendor: "Acme Tutoring", date: "2026-10-01", invoiceNo: "A-10045", totalCents: 20000 });
    expect(r.paymentEvidence!.confidence).toBeLessThan(PAYMENT_EVIDENCE_MIN);
  });

  it("a zero balance or 'payment received' is strong evidence", () => {
    const r = readReceiptText(PAID);
    expect(r.paymentEvidence!.confidence).toBeGreaterThanOrEqual(PAYMENT_EVIDENCE_MIN);
    expect(r.paymentEvidence!.snippet).toMatch(/Balance due|Payment received/i);
  });

  it("does not take a screen heading for the vendor", () => {
    expect(readReceiptText("Transaction details X\nYouTube Premium\nAug 3, 2025\nTotal $26.12").vendor).toBe("YouTube Premium");
  });

  it("does not take a mail service from a printed email for the vendor", () => {
    const printed = "Gmail - Your order\nhttps://mail.google.com/mail/u/0/\nFrom: Acme Tutoring <billing@acmetutoring.com>\nTo: jane@gmail.com\nTotal $20.00";
    expect(readReceiptText(printed).vendor).not.toMatch(/gmail|google/i);
    expect(readReceiptText("Order confirmation\nsomeone@gmail.com\nStar Learning Supply\nTotal $5.00").vendor).toBe("Star Learning Supply");
  });

  it("prefers the order id over a receipt or confirmation number", () => {
    expect(readReceiptText("Acme Shop\nReceipt #R-99812\nConfirmation: C77410\nOrder ID: 5521-8890\nTotal $9.00").invoiceNo).toBe("5521-8890");
    expect(readReceiptText("Acme Shop\nReceipt #R-99812\nTotal $9.00").invoiceNo).toBe("R-99812");
  });

  it("finds an order id printed under its heading, as Apple's emails and receipts do", () => {
    const email = "Patty Wooley <patty.wooley@gmail.com>\nYour purchases from Apple.\nApple <no_reply@email.apple.com> Mon, Jul 27 at 3:04PM\nAPPLE ACCOUNT DATE ORDER ID\npatty.wooley@gmail.com Jul 27, 2026 MQKXQ1GX5H\nApp Store\nProcreate $12.99\nTOTAL $12.99";
    expect(readReceiptText(email)).toMatchObject({ vendor: "Apple", date: "2026-07-27", invoiceNo: "MQKXQ1GX5H", totalCents: 1299 });
    const receipt = "Receipt\nAPPLE ACCOUNT\nantgiant@example.us BILLED TO\nDATE Travis Wooley\nJan 7, 2026 2311 Jeslan Ct\nORDER ID DOCUMENT NO. USA\nMVWT1MLWMY 744074245753\nApp Store\nSplitly $2.99\nTOTAL $2.99";
    expect(readReceiptText(receipt)).toMatchObject({ invoiceNo: "MVWT1MLWMY", date: "2026-01-07", totalCents: 299 });
    expect(readReceiptText(receipt).vendor).not.toBe("APPLE ACCOUNT");
  });

  it("returns only what it found", () => {
    expect(readReceiptText("hello world")).toEqual({});
  });
});

describe("OCR confidence", () => {
  it("lowers row confidence so uncertain OCR rows are flagged", () => {
    const text = "Statement Period 09/15/2026 - 10/14/2026\n09/18 09/19 SHOP 5.00";
    expect(parseStatementText(text).transactions[0]!.confidence).toBeGreaterThan(0.9);
    expect(parseStatementText(text, { confidencePenalty: 0.2 }).transactions[0]!.confidence).toBeLessThan(0.8);
  });
});
