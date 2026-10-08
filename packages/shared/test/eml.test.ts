import { describe, expect, it } from "vitest";
import { emlToText, parseEml, readReceiptText, receiptAttachments } from "../src/index.js";

const PDF_B64 = btoa("%PDF-1.4 fake receipt");

const EML = [
  "From: Amazon Orders <auto-confirm@amazon.com>",
  "Subject: =?UTF-8?B?WW91ciBBbWF6b24gb3JkZXI=?=",
  "Date: Thu, 17 Sep 2026 10:15:00 -0400",
  "MIME-Version: 1.0",
  'Content-Type: multipart/mixed; boundary="BOUND"',
  "",
  "--BOUND",
  'Content-Type: multipart/alternative; boundary="ALT"',
  "",
  "--ALT",
  "Content-Type: text/plain; charset=utf-8",
  "Content-Transfer-Encoding: quoted-printable",
  "",
  "Order Placed: September 17, 2026",
  "Order # 112-0000000-1234567",
  "Grand Total: =2453.50",
  "Paid with Visa ending in 4242",
  "--ALT",
  "Content-Type: text/html; charset=utf-8",
  "",
  "<p>Order Placed</p>",
  "--ALT--",
  "--BOUND",
  'Content-Type: application/pdf; name="invoice.pdf"',
  'Content-Disposition: attachment; filename="invoice.pdf"',
  "Content-Transfer-Encoding: base64",
  "",
  PDF_B64,
  "--BOUND--",
  "",
].join("\r\n");

describe("eml", () => {
  it("reads headers (including encoded words), the plain-text body and attachments", () => {
    const m = parseEml(EML);
    expect(m.headers["subject"]).toBe("Your Amazon order");
    expect(m.text).toContain("Order # 112-0000000-1234567");
    expect(m.text).toContain("Grand Total: $53.50"); // =24 is a quoted-printable "$"
    expect(m.attachments).toHaveLength(1);
    expect(m.attachments[0]).toMatchObject({ filename: "invoice.pdf", contentType: "application/pdf" });
    expect(new TextDecoder().decode(m.attachments[0]!.bytes)).toBe("%PDF-1.4 fake receipt");
    expect(receiptAttachments(m)).toHaveLength(1);
  });

  it("falls back to the HTML part with tags stripped", () => {
    const html = ["Subject: Receipt", "Content-Type: text/html; charset=utf-8", "", "<html><body><p>Total: <b>$12.00</b></p><script>x()</script></body></html>"].join("\n");
    expect(parseEml(html).text).toBe("Total: $12.00");
  });

  it("feeds the receipt reader: vendor from the sender, date, order number, total and payment", () => {
    const r = readReceiptText(emlToText(EML));
    expect(r).toMatchObject({ vendor: "Amazon", date: "2026-09-17", invoiceNo: "112-0000000-1234567", totalCents: 5350, last4: "4242" });
    expect(r.paymentEvidence!.confidence).toBeGreaterThanOrEqual(0.8);
  });
});
