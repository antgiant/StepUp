import { describe, expect, it } from "vitest";
import {
  HlcClock,
  Ledger,
  MemoryBackend,
  MemoryEventStore,
  buildImagePdf,
  createPurchase,
  parseStatementText,
  planRedaction,
  positionedLines,
  type PositionedLine,
  type RulesContext,
} from "../src/index.js";
import { planSubmissions, redactedCopyOf } from "../src/index.js";

// Entirely made-up page content, top to bottom.
const PAGE1 = [
  "CHASE FREEDOM UNLIMITED VISA",
  "Account ending in 4242",
  "Statement Period: 09/15/2026 - 10/14/2026",
  "New Balance $1,812.44   Minimum Payment Due $35.00",
  "Rewards points earned this period 1,204",
  "Trans Date Post Date Description Amount",
  "09/18 09/19 AMZN Mktp US*2K4 Amzn.com/bill WA 54.28",
  "09/20 09/21 SOME PRIVATE PHARMACY 33.10",
  "09/25 09/25 PAYMENT THANK YOU -1,200.00",
  "10/02 10/03 STAR LEARNING CO 12.00",
  "10/12 10/12 INTEREST CHARGE ON PURCHASES 18.77",
];
const PAGE2 = ["Page 2 of 2   Account 1234 5678 9012 3456", "Fees and interest summary   Total interest charged 18.77"];

function layout(pages: string[][]): PositionedLine[][] {
  return pages.map((lines) => positionedLines(lines.map((text, i) => ({ str: text, x: 40, y: 760 - i * 14, width: text.length * 5, height: 10 }))));
}

describe("issuer detection", () => {
  it("matches whole words only (\"PURCHASES\" is not Chase)", () => {
    expect(parseStatementText("Statement Period 09/15/2026 - 10/14/2026\n10/12 10/12 INTEREST CHARGE ON PURCHASES 18.77").issuer).toBeUndefined();
    expect(parseStatementText("Chase Freedom\nStatement Period 09/15/2026 - 10/14/2026").issuer).toBe("Chase");
  });
});

describe("planRedaction", () => {
  const text = [...PAGE1, ...PAGE2].join("\n");
  const parsed = parseStatementText(text);
  const id = (re: RegExp) => parsed.transactions.find((t) => re.test(t.descriptor))!.id;

  it("keeps only the issuer, the period, the headings and the chosen charges", () => {
    const plan = planRedaction(layout([PAGE1, PAGE2]), { keepTransactionIds: new Set([id(/AMZN/), id(/STAR LEARNING/)]) });
    expect(plan.pages[0]!.keptText).toEqual([
      "CHASE FREEDOM UNLIMITED VISA",
      "Statement Period: 09/15/2026 - 10/14/2026",
      "Trans Date Post Date Description Amount",
      "09/18 09/19 AMZN Mktp US*2K4 Amzn.com/bill WA 54.28",
      "10/02 10/03 STAR LEARNING CO 12.00",
    ]);
    expect(plan.pages[1]!.keep).toEqual([]);
    expect(plan.keptTransactions).toBe(2);
    expect(plan.missing).toEqual([]);
  });

  it("never keeps an account number, balances, rewards, payments, interest or unrelated charges", () => {
    const plan = planRedaction(layout([PAGE1, PAGE2]), { keepTransactionIds: new Set([id(/AMZN/), id(/PAYMENT/), id(/INTEREST/)]) });
    const kept = plan.pages.flatMap((p) => p.keptText).join("\n");
    for (const secret of ["4242", "Balance", "Rewards", "PAYMENT THANK YOU", "INTEREST", "PHARMACY", "3456"]) expect(kept).not.toContain(secret);
    expect(plan.keptTransactions).toBe(1); // payments and fees can't be kept even when asked
  });

  it("reports charges it could not find and warns when nothing would be visible", () => {
    const plan = planRedaction(layout([PAGE1, PAGE2]), { keepTransactionIds: new Set(["txn-nope"]) });
    expect(plan.missing).toEqual(["txn-nope"]);
    expect(plan.warnings.join()).toMatch(/blacked out/);
  });

  it("puts each kept box around its line, padded, in PDF coordinates", () => {
    const plan = planRedaction(layout([PAGE1, PAGE2]), { keepTransactionIds: new Set([id(/AMZN/)]), pad: 2 });
    const lines = layout([PAGE1])[0]!;
    const row = lines.find((l) => /AMZN/.test(l.text))!;
    const box = plan.pages[0]!.keep.find((r) => r.y0 === row.y0 - 2)!;
    expect(box).toEqual({ x0: row.x0 - 2, y0: row.y0 - 2, x1: row.x1 + 2, y1: row.y1 + 2 });
    expect(box.y1).toBeGreaterThan(box.y0);
  });
});

describe("buildImagePdf", () => {
  const jpeg = (n: number) => new Uint8Array([0xff, 0xd8, n, n, n, 0xff, 0xd9]);
  const pdf = buildImagePdf([
    { jpeg: jpeg(1), pxWidth: 100, pxHeight: 200, widthPt: 612, heightPt: 792 },
    { jpeg: jpeg(2), pxWidth: 100, pxHeight: 200, widthPt: 612, heightPt: 792 },
  ]);
  const text = new TextDecoder("latin1").decode(pdf);

  it("is a structurally sound PDF: every cross-reference offset points at its object", () => {
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
    const xrefAt = Number(/startxref\n(\d+)/.exec(text)![1]);
    expect(text.slice(xrefAt, xrefAt + 4)).toBe("xref");
    const entries = [...text.slice(xrefAt).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    expect(entries).toHaveLength(8);
    entries.forEach((offset, i) => expect(text.slice(offset, offset + 8)).toBe(`${i + 1} 0 obj\n`));
    expect(text).toContain("/Count 2");
  });

  it("contains the images and nothing that is text", () => {
    expect(text).toContain("/Filter /DCTDecode");
    expect(text).not.toMatch(/\/Font|BT\b|\/Type \/Annot/);
    expect(() => buildImagePdf([])).toThrow();
  });
});

describe("redacted copies in the submission plan", () => {
  const ctx: RulesContext = { today: "2026-10-20", category: (id) => ({ id, path: [id], requiresServiceDate: false, eligibleScholarships: [], isActive: true }) };
  it("sends the redacted copy instead of the statement, and flags statements that have none", () => {
    const l = new Ledger(new MemoryEventStore(new MemoryBackend(), "dev"), new HlcClock("dev"), "t");
    l.set("child", "kid", { name: "Kid" });
    l.set("document", "rcpt", { filename: "Acme.pdf", contentKind: "receipt-like", sizeBytes: 10 });
    l.set("document", "stmt", { filename: "Statement.pdf", contentKind: "statement", sizeBytes: 10 });
    const p = createPurchase(l, { vendor: "Acme", date: "2026-10-01", receiptDocumentId: "rcpt", orderTotalCents: 1000 });
    l.set("item", "i1", { purchaseId: p, childId: "kid", description: "Book", amountCents: 1000, taxShippingCents: 0, categoryId: "c", benefitMessage: "x", readyToSubmit: true });
    l.set("additionalDoc", "proof", { ownerKind: "purchase", ownerId: p, documentId: "stmt", kind: "payment-proof", transactionId: "t" });

    let group = planSubmissions(l.state, ctx).groups[0]!;
    expect(group.additionalDocs.map((d) => d.id)).toEqual(["stmt"]);
    expect(group.unredactedStatements).toEqual(["Statement.pdf"]);

    l.set("document", "stmt-r", { filename: "Statement (redacted).pdf", contentKind: "statement", derivedFrom: "stmt", redacted: true });
    expect(redactedCopyOf(l.state, l.state.documents["stmt"]!)?.id).toBe("stmt-r");
    group = planSubmissions(l.state, ctx).groups[0]!;
    expect(group.additionalDocs.map((d) => d.id)).toEqual(["stmt-r"]);
    expect(group.unredactedStatements).toEqual([]);
  });
});

import { checkRedactionOutput } from "../src/index.js";

describe("redaction modes and output check", () => {
  const text = [...PAGE1, ...PAGE2].join("\n");
  const parsed = parseStatementText(text);
  const id = (re: RegExp) => parsed.transactions.find((t) => re.test(t.descriptor))!.id;
  const three: string[] = ["PAGE 1 line", "PAGE 2 line", "PAGE 3"];

  it("can leave out pages that have no kept charge, but always keeps the first", () => {
    const pagesText = [PAGE1, PAGE2, ["Nothing here", "09/30 09/30 SOME ROW 1.00"]];
    const all = planRedaction(layout(pagesText), { keepTransactionIds: new Set([id(/AMZN/)]) });
    expect(all.pages.map((p) => p.omit)).toEqual([undefined, undefined, undefined]);
    const matched = planRedaction(layout(pagesText), { keepTransactionIds: new Set([id(/AMZN/)]), pages: "matched" });
    expect(matched.pages.map((p) => p.omit)).toEqual([undefined, true, true]);
    void three;
  });

  it("the finished copy passes when kept charges are legible and nothing else is", () => {
    const kept = [{ descriptor: "AMZN", amountCents: 5428 }, { descriptor: "STAR", amountCents: 1200 }];
    expect(checkRedactionOutput(["CHASE\nStatement Period: 09/15/2026 - 10/14/2026\n09/18 AMZN Mktp 54.28\n10/02 STAR LEARNING CO 12.00"], kept)).toEqual({ legible: 2, unreadable: [], leaks: [] });
  });

  it("flags a charge it cannot read, an extra amount and an account number", () => {
    const kept = [{ descriptor: "AMZN", amountCents: 5428 }, { descriptor: "STAR", amountCents: 1200 }];
    const bad = checkRedactionOutput(["09/18 AMZN Mktp 54.28\nNew Balance $1,812.44\nAccount 1234 5678 9012 3456"], kept);
    expect(bad.unreadable).toEqual(["STAR"]);
    expect(bad.leaks.join()).toMatch(/1812\.44/);
    expect(bad.leaks.join()).toMatch(/account number/);
  });
});
