import { describe, expect, it } from "vitest";
import {
  HlcClock,
  Ledger,
  MemoryBackend,
  MemoryEventStore,
  addTransaction,
  clusterStatements,
  editStatementDetails,
  editTransaction,
  groupBoxesIntoRows,
  mergeReread,
  parseStatementText,
  removeTransaction,
  saveStatement,
} from "../src/index.js";

const newLedger = () => new Ledger(new MemoryEventStore(new MemoryBackend(), "dev"), new HlcClock("dev"), "t");
const NO_PERIOD = "ACME BANK\nAccount ending in 1111\n09/18/2026 AMZN 54.28\n10/02/2026 ZOO 12.00\n";

describe("period detection", () => {
  it("uses the first and last charge when the statement prints no period, and says so", () => {
    const p = parseStatementText(NO_PERIOD);
    expect(p.periodStart).toBe("2026-09-18");
    expect(p.periodEnd).toBe("2026-10-02");
    expect(p.periodInferred).toBe(true);
  });
  it("prefers a printed period", () => {
    const p = parseStatementText("Statement Period: 09/15/2026 - 10/14/2026\n09/18 AMZN 54.28");
    expect(p.periodStart).toBe("2026-09-15");
    expect(p.periodInferred).toBeUndefined();
  });
});

describe("editing a statement", () => {
  const setup = () => {
    const ledger = newLedger();
    ledger.set("document", "d1", { filename: "a.pdf" }, { label: "document.registered" });
    saveStatement(ledger, "d1", parseStatementText(NO_PERIOD));
    return ledger;
  };
  it("corrects a row in place, keeping its id, and flags it as edited", () => {
    const ledger = setup();
    const t = ledger.state.documents["d1"]!.statement!.transactions[0]!;
    expect(editTransaction(ledger, "d1", t.id, { date: "2026-09-19", descriptor: "AMAZON", amountCents: 5500, kind: "purchase" })).toBe(true);
    const after = ledger.state.documents["d1"]!.statement!.transactions.find((x) => x.id === t.id)!;
    expect(after).toMatchObject({ descriptor: "AMAZON", amountCents: 5500, edited: true, confidence: 1 });
  });
  it("rejects an impossible date", () => {
    const ledger = setup();
    const t = ledger.state.documents["d1"]!.statement!.transactions[0]!;
    expect(editTransaction(ledger, "d1", t.id, { date: "2026-13-40", descriptor: "X", amountCents: 1, kind: "purchase" })).toBe(false);
  });
  it("adds and removes rows", () => {
    const ledger = setup();
    const id = addTransaction(ledger, "d1", { date: "2026-09-25", descriptor: "MISSED", amountCents: 900, kind: "purchase" })!;
    expect(ledger.state.documents["d1"]!.statement!.transactions).toHaveLength(3);
    removeTransaction(ledger, "d1", id);
    expect(ledger.state.documents["d1"]!.statement!.transactions).toHaveLength(2);
  });
  it("a person's period replaces the estimate and drops the estimate flag", () => {
    const ledger = setup();
    editStatementDetails(ledger, "d1", { periodStart: "2026-09-01", periodEnd: "2026-09-30" });
    expect(ledger.state.documents["d1"]!.statement).toMatchObject({ periodStart: "2026-09-01", periodEnd: "2026-09-30" });
    expect(ledger.state.documents["d1"]!.statement!.periodInferred).toBeUndefined();
  });
  it("keeps corrected rows and the person's period when read again", () => {
    const ledger = setup();
    const t = ledger.state.documents["d1"]!.statement!.transactions[0]!;
    editTransaction(ledger, "d1", t.id, { date: "2026-09-18", descriptor: "AMAZON", amountCents: 5428, kind: "purchase" });
    editStatementDetails(ledger, "d1", { periodStart: "2026-09-01", periodEnd: "2026-09-30" });
    const merged = mergeReread(ledger.state.documents["d1"]!.statement, parseStatementText(NO_PERIOD));
    expect(merged.transactions).toHaveLength(2);
    expect(merged.transactions.find((x) => x.id === t.id)?.descriptor).toBe("AMAZON");
    expect(merged.periodStart).toBe("2026-09-01");
  });
});

describe("clusterStatements", () => {
  const mk = (id: string, issuer: string | undefined, last4: string | undefined, start: string | undefined) => ({
    id,
    filename: id,
    statement: issuer || last4 || start ? { issuer, last4, periodStart: start, transactions: [] } : undefined,
  });
  it("groups by card, orders each group by date, and puts unread files last", () => {
    const groups = clusterStatements([
      mk("c", "Chase", "4242", "2026-10-01"),
      mk("a", "Chase", "4242", "2026-08-01"),
      mk("u", undefined, undefined, undefined),
      mk("b", "Amex", "9999", "2026-09-01"),
    ]);
    expect(groups.map((g) => g.label)).toEqual(["Amex ending 9999", "Chase ending 4242", "Not read yet"]);
    expect(groups[1]!.items.map((i) => i.id)).toEqual(["a", "c"]);
  });
});

describe("groupBoxesIntoRows (OCR of a screenshot of a table)", () => {
  const box = (text: string, x0: number, y0: number, x1: number, y1: number) => ({ text, x0, y0, x1, y1, confidence: 0.9 });
  it("puts date, description and amount columns back on one row, top to bottom", () => {
    const rows = groupBoxesIntoRows([
      box("54.28", 800, 102, 880, 128),
      box("09/18", 20, 100, 90, 126),
      box("AMZN Mktp US", 140, 101, 520, 127),
      box("12.00", 800, 172, 880, 198),
      box("10/02", 20, 170, 90, 196),
      box("STAR LEARNING", 140, 171, 520, 197),
    ]);
    expect(rows.map((r) => r.text)).toEqual(["09/18 AMZN Mktp US 54.28", "10/02 STAR LEARNING 12.00"]);
    expect(parseStatementText(rows.map((r) => r.text).join("\n"), { defaultYear: 2026 }).transactions).toHaveLength(2);
  });
  it("keeps separate rows apart", () => {
    expect(groupBoxesIntoRows([box("a", 0, 0, 10, 20), box("b", 0, 25, 10, 45)])).toHaveLength(2);
  });
});
