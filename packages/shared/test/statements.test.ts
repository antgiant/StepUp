import { describe, expect, it } from "vitest";
import {
  HlcClock,
  Ledger,
  MemoryBackend,
  MemoryEventStore,
  addItem,
  createPurchase,
  evaluateItem,
  linkConfidentMatches,
  matchStatement,
  parseAmount,
  parseStatementText,
  relinkAllStatements,
  saveStatement,
  unlinkTransaction,
  type RulesContext,
} from "../src/index.js";

// Entirely made-up statement text (no real account data).
const STATEMENT = `
EXAMPLE BANK VISA SIGNATURE
Account ending in 4242
Statement Period: 09/15/2026 - 10/14/2026
Payment Due Date 11/08/2026   Minimum Payment Due $25.00
Previous Balance $1,200.00

Trans Date  Post Date  Description  Amount
09/18 09/19 AMZN Mktp US*2K4 Amzn.com/bill WA 54.28
09/20 09/21 CENTRAL FL ZOO TICKETS ORLANDO FL 86.40
09/25 09/25 PAYMENT THANK YOU -1,200.00
10/02 10/03 STAR LEARNING CO 12.00
10/05 10/06 AMZN Mktp US*9X1 Amzn.com/bill WA 20.00
10/05 10/06 AMZN Mktp US*9X1 Amzn.com/bill WA 20.00
10/09 10/10 REFUND ACME BOOKS (15.00)
10/12 10/12 INTEREST CHARGE ON PURCHASES 18.77
10/13 SOMETHING WEIRD 4.5
`;

describe("parseAmount", () => {
  it("reads the ways issuers write credits", () => {
    expect(parseAmount("$1,234.56")).toBe(123456);
    expect(parseAmount("-12.00")).toBe(-1200);
    expect(parseAmount("(12.00)")).toBe(-1200);
    expect(parseAmount("12.00-")).toBe(-1200);
    expect(parseAmount("12.00 CR")).toBe(-1200);
    expect(parseAmount("12")).toBeUndefined();
  });
});

describe("parseStatementText", () => {
  const parsed = parseStatementText(STATEMENT);

  it("finds the card, period and issuer words", () => {
    expect(parsed.last4).toBe("4242");
    expect(parsed.periodStart).toBe("2026-09-15");
    expect(parsed.periodEnd).toBe("2026-10-14");
  });

  it("reads rows with one or two dates, classifies them and keeps repeated rows distinct", () => {
    const t = parsed.transactions;
    expect(t).toHaveLength(8);
    expect(t[0]).toMatchObject({ date: "2026-09-18", postDate: "2026-09-19", amountCents: 5428, kind: "purchase" });
    expect(t.find((x) => /PAYMENT/.test(x.descriptor))).toMatchObject({ amountCents: -120000, kind: "payment" });
    expect(t.find((x) => /REFUND/.test(x.descriptor))).toMatchObject({ amountCents: -1500, kind: "credit" });
    expect(t.find((x) => /INTEREST/.test(x.descriptor))?.kind).toBe("fee");
    const twins = t.filter((x) => x.amountCents === 2000);
    expect(twins).toHaveLength(2);
    expect(twins[0]!.id).not.toBe(twins[1]!.id);
  });

  it("does not mistake header lines for transactions, and reports dated lines it could not read", () => {
    expect(parsed.transactions.some((x) => /Minimum|Previous|Due/i.test(x.descriptor))).toBe(false);
    expect(parsed.unparsedLines).toEqual([]); // "4.5" is not a money amount, so that line is not a candidate row
    expect(parseStatementText("Statement Period 09/15/2026 - 10/14/2026\n13/45 BAD DATE 5.00").unparsedLines).toEqual(["13/45 BAD DATE 5.00"]);
  });

  it("puts a December charge on a January statement in the previous year", () => {
    const p = parseStatementText("Statement Period 12/16/2026 - 01/15/2027\n12/28 12/29 SHOP 10.00\n01/03 01/04 SHOP 5.00");
    expect(p.transactions.map((x) => x.date)).toEqual(["2026-12-28", "2027-01-03"]);
  });

  it("warns when there is nothing to read", () => {
    const p = parseStatementText("hello");
    expect(p.transactions).toEqual([]);
    expect(p.warnings.join()).toMatch(/No transactions/);
  });
});

const ctx: RulesContext = { today: "2026-10-20", category: () => undefined };
const newLedger = () => new Ledger(new MemoryEventStore(new MemoryBackend(), "dev"), new HlcClock("dev"), "t");

function setup() {
  const l = newLedger();
  l.set("child", "kid", { name: "Kid" });
  l.set("paymentMethod", "visa", { label: "Visa", kind: "card", last4: ["4242"] });
  l.set("document", "stmt", { filename: "Statement Oct.pdf", contentKind: "statement" });
  const amazon = createPurchase(l, { vendor: "Amazon", date: "2026-09-17", orderTotalCents: 5428, paymentMethodId: "visa" });
  const zoo = createPurchase(l, { vendor: "Central Florida Zoo", date: "2026-09-20", orderTotalCents: 8640 });
  const odd = createPurchase(l, { vendor: "Mystery", date: "2026-10-02", orderTotalCents: 1200 });
  return { l, amazon, zoo, odd };
}

describe("matchStatement", () => {
  it("links confident matches, leaves weaker ones as suggestions, and ignores payments and fees", () => {
    const { l, amazon, zoo, odd } = setup();
    const data = parseStatementText(STATEMENT);
    const matches = matchStatement(l.state, "stmt", data);
    const byAmount = (cents: number) => matches.find((m) => data.transactions.find((t) => t.id === m.transactionId)!.amountCents === cents);

    expect(byAmount(5428)).toMatchObject({ auto: true, best: { purchaseId: amazon } }); // amount + date + vendor ("amzn" ~ "amazon") + same card
    expect(byAmount(8640)).toMatchObject({ auto: true, best: { purchaseId: zoo } });
    expect(byAmount(1200)).toMatchObject({ auto: false, best: { purchaseId: odd } }); // amount + date only: ask first
    expect(matches.some((m) => data.transactions.find((t) => t.id === m.transactionId)!.kind !== "purchase")).toBe(false);
  });

  it("uses learned aliases for vendor names that do not look alike", () => {
    const l = newLedger();
    l.set("document", "stmt", { contentKind: "statement" });
    const p = createPurchase(l, { vendor: "Amazon", date: "2026-09-18", orderTotalCents: 999 });
    const data = parseStatementText("Statement Period 09/15/2026 - 10/14/2026\n09/18 09/19 ZZQ*8812 9.99");
    expect(matchStatement(l.state, "stmt", data)[0]).toMatchObject({ best: { purchaseId: p }, auto: false });
    expect(matchStatement(l.state, "stmt", data, { aliases: { zzq: ["amazon"] } })[0]).toMatchObject({ best: { purchaseId: p }, auto: true });
  });

  it("does not match across a different card, or a charge before the purchase", () => {
    const { l, amazon } = setup();
    l.set("paymentMethod", "visa", { last4: ["9999"] });
    const data = parseStatementText(STATEMENT);
    const m = matchStatement(l.state, "stmt", data).find((x) => x.best?.purchaseId === amazon);
    expect(m?.auto).toBe(false);
    const early = parseStatementText("Statement Period 09/01/2026 - 09/30/2026\n09/01 09/01 AMAZON 54.28");
    expect(matchStatement(l.state, "stmt", early).find((x) => x.best?.purchaseId === amazon)).toBeUndefined();
  });

  it("gives a purchase to only one automatic match, and does not stay ambiguous", () => {
    const l = newLedger();
    l.set("document", "stmt", { contentKind: "statement" });
    createPurchase(l, { vendor: "Star Learning", date: "2026-10-02", orderTotalCents: 1200 });
    const data = parseStatementText("Statement Period 10/01/2026 - 10/31/2026\n10/03 10/04 STAR LEARNING 12.00\n10/05 10/06 STAR LEARNING 12.00");
    const autos = matchStatement(l.state, "stmt", data).filter((m) => m.auto);
    expect(autos.length).toBeLessThanOrEqual(1);
  });
});

describe("linking proof", () => {
  it("a matched charge satisfies the proof requirement, and re-running adds nothing new", () => {
    const { l, amazon } = setup();
    l.set("document", "rcpt", { filename: "Amazon 09 17 2026.pdf", contentKind: "receipt-like", sizeBytes: 1000 });
    l.set("purchase", amazon, { receiptDocumentId: "rcpt" });
    const item = addItem(l, amazon, { childId: "kid", description: "Book", amountCents: 5000, taxShippingCents: 428, categoryId: "c", benefitMessage: "learning" });
    expect(evaluateItem(l.state, item, ctx).reasons.map((r) => r.code)).toContain("awaiting-proof");

    saveStatement(l, "stmt", parseStatementText(STATEMENT));
    expect(l.state.documents["stmt"]!.statement?.transactions.length).toBe(8);
    expect(relinkAllStatements(l)).toBeGreaterThanOrEqual(1);
    expect(evaluateItem(l.state, item, ctx).reasons.map((r) => r.code)).not.toContain("awaiting-proof");

    const links = Object.values(l.state.additionalDocs);
    expect(links.find((a) => a.ownerId === amazon)).toMatchObject({ kind: "payment-proof", documentId: "stmt", source: "auto" });
    expect(relinkAllStatements(l)).toBe(0); // already linked charges are skipped
  });

  it("can be undone, and the charge becomes matchable again", () => {
    const { l, amazon } = setup();
    const data = parseStatementText(STATEMENT);
    const matches = matchStatement(l.state, "stmt", data);
    linkConfidentMatches(l, "stmt", matches);
    const link = Object.values(l.state.additionalDocs).find((a) => a.ownerId === amazon)!;
    unlinkTransaction(l, amazon, "stmt", link.transactionId!);
    expect(Object.values(l.state.additionalDocs).some((a) => a.ownerId === amazon)).toBe(false);
  });
});

import { learnAlias, linesFromTextItems, linkTransaction } from "../src/index.js";

describe("linesFromTextItems", () => {
  it("rebuilds rows from positioned pieces, top to bottom and left to right", () => {
    const text = linesFromTextItems([
      [
        { str: "54.28", x: 400, y: 700 },
        { str: "09/18", x: 20, y: 700.4 },
        { str: "AMZN Mktp", x: 90, y: 699.8 },
        { str: "Description", x: 90, y: 720 },
        { str: "Amount", x: 400, y: 720 },
        { str: "   ", x: 1, y: 1 },
      ],
      [{ str: "next", x: 0, y: 10 }],
    ]);
    expect(text).toBe("Description Amount\n09/18 AMZN Mktp 54.28\n\nnext");
    expect(parseStatementText("Statement Period 09/15/2026 - 10/14/2026\n" + text).transactions[0]).toMatchObject({ amountCents: 5428, descriptor: "AMZN Mktp" });
  });
});

describe("learnAlias", () => {
  it("remembers a descriptor word for a vendor once, and uses it next time", () => {
    const l = newLedger();
    l.set("document", "stmt", { contentKind: "statement" });
    const p = createPurchase(l, { vendor: "Amazon", date: "2026-09-18", orderTotalCents: 999 });
    const data = parseStatementText("Statement Period 09/15/2026 - 10/14/2026\n09/18 09/19 ZZQ*8812 9.99");
    const m = matchStatement(l.state, "stmt", data)[0]!;
    expect(m.auto).toBe(false);
    linkTransaction(l, p, "stmt", m.transactionId, "manual");
    expect(learnAlias(l, data.transactions[0]!.descriptor, "Amazon")).toBe(true);
    expect(learnAlias(l, data.transactions[0]!.descriptor, "Amazon")).toBe(false); // nothing new
    expect(l.state.settings["year"]?.vendorAliases).toEqual({ zzq: ["amazon"] });
    expect(learnAlias(l, "AMAZON PRIME", "Amazon")).toBe(false); // already matches by name

    const next = parseStatementText("Statement Period 10/15/2026 - 11/14/2026\n10/20 10/21 ZZQ*0001 9.99");
    const q = createPurchase(l, { vendor: "Amazon", date: "2026-10-19", orderTotalCents: 999 });
    expect(matchStatement(l.state, "stmt", next)[0]).toMatchObject({ best: { purchaseId: q }, auto: true });
  });
});

import { evaluateItem as evalItem, linkRefund, matchRefunds, matchSplitCharges, unlinkRefund } from "../src/index.js";

describe("refunds", () => {
  const STMT = `Statement Period 10/01/2026 - 10/31/2026
10/02 10/03 AMZN Mktp US*AA1 54.28
10/20 10/21 AMZN Mktp US*RETURN (54.28)
10/22 10/22 SOME OTHER SHOP (54.28)`;

  it("suggests the purchase a refund belongs to, and a full refund stops the purchase being filed", () => {
    const l = newLedger();
    l.set("child", "kid", { name: "Kid" });
    l.set("document", "stmt", { contentKind: "statement" });
    l.set("document", "rcpt", { filename: "r.pdf", contentKind: "receipt-like", sizeBytes: 10, paymentEvidenceConfidence: 0.9 });
    const p = createPurchase(l, { vendor: "Amazon", date: "2026-10-01", orderTotalCents: 5428, receiptDocumentId: "rcpt" });
    const item = addItem(l, p, { childId: "kid", description: "Book", amountCents: 5000, taxShippingCents: 428, categoryId: "c", benefitMessage: "m" });
    const data = parseStatementText(STMT);

    const refunds = matchRefunds(l.state, "stmt", data, { aliases: { amzn: ["amazon"] } });
    expect(refunds).toHaveLength(1); // the other shop's refund has no matching purchase
    expect(refunds[0]).toMatchObject({ purchaseId: p, amountCents: 5428 });
    expect(refunds[0]!.reasons).toContain("whole purchase");

    const ctx2: RulesContext = { today: "2026-11-01", category: (id) => ({ id, path: [id], requiresServiceDate: false, eligibleScholarships: [], isActive: true }) };
    expect(evalItem(l.state, item, ctx2).reasons.map((r) => r.code)).not.toContain("refunded");
    linkRefund(l, p, "stmt", refunds[0]!.transactionId, refunds[0]!.amountCents);
    expect(evalItem(l.state, item, ctx2).reasons.map((r) => r.code)).toContain("refunded");
    expect(matchRefunds(l.state, "stmt", data, { aliases: { amzn: ["amazon"] } })).toEqual([]); // already linked
    unlinkRefund(l, p, "stmt", refunds[0]!.transactionId);
    expect(evalItem(l.state, item, ctx2).reasons.map((r) => r.code)).not.toContain("refunded");
  });

  it("a partial refund is a suggestion but does not block the purchase", () => {
    const l = newLedger();
    l.set("document", "stmt", { contentKind: "statement" });
    const p = createPurchase(l, { vendor: "Acme", date: "2026-10-01", orderTotalCents: 5000 });
    const data = parseStatementText("Statement Period 10/01/2026 - 10/31/2026\n10/15 10/15 ACME STORE (12.00)");
    const [m] = matchRefunds(l.state, "stmt", data);
    expect(m).toMatchObject({ purchaseId: p, amountCents: 1200 });
  });
});

describe("one order, several charges", () => {
  it("finds charges that add up to a purchase no single charge fits", () => {
    const l = newLedger();
    l.set("document", "stmt", { contentKind: "statement" });
    const p = createPurchase(l, { vendor: "Star Learning", date: "2026-10-02", orderTotalCents: 6000 });
    const data = parseStatementText(`Statement Period 10/01/2026 - 10/31/2026
10/03 10/04 STAR LEARNING 20.00
10/09 10/10 STAR LEARNING 40.00
10/10 10/10 STAR LEARNING 15.00
10/11 10/11 UNRELATED SHOP 40.00`);
    const [m] = matchSplitCharges(l.state, "stmt", data);
    expect(m!.purchaseId).toBe(p);
    expect(m!.transactionIds.map((id) => data.transactions.find((t) => t.id === id)!.amountCents).sort()).toEqual([2000, 4000]);
    expect(matchSplitCharges(l.state, "stmt", parseStatementText("Statement Period 10/01/2026 - 10/31/2026\n10/03 10/04 STAR LEARNING 20.00\n10/09 10/10 STAR LEARNING 15.00"))).toEqual([]);
  });

  it("does not offer a purchase that already has proof of payment", () => {
    const l = newLedger();
    l.set("document", "stmt", { contentKind: "statement" });
    const p = createPurchase(l, { vendor: "Star Learning", date: "2026-10-02", orderTotalCents: 6000 });
    l.set("additionalDoc", "x", { ownerKind: "purchase", ownerId: p, documentId: "stmt", kind: "payment-proof", transactionId: "t" });
    const data = parseStatementText("Statement Period 10/01/2026 - 10/31/2026\n10/03 10/04 STAR LEARNING 20.00\n10/09 10/10 STAR LEARNING 40.00");
    expect(matchSplitCharges(l.state, "stmt", data)).toEqual([]);
  });
});
