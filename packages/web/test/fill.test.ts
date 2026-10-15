import { describe, expect, it } from "vitest";
import { boxesToCheck, categoryLevels, chooseEntry, expectedTotal, isoDate, linesMatch, matchBlock, moneyText, sameNumber, type FilingRow } from "../src/agent/fill.js";

const row = (id: string, data: Record<string, string>): FilingRow => ({ id, data });

describe("choosing an entry of a list", () => {
  const list = ["Apple Store", "Wal-mart", "Books-A-Million", "Books Inc", "Provider not Listed"];
  it("takes an exact entry, then the same ignoring case and punctuation, then a single partial hit", () => {
    expect(chooseEntry(list, "Wal-mart")).toEqual({ how: "exact", text: "Wal-mart" });
    expect(chooseEntry(list, "walmart")).toEqual({ how: "normalized", text: "Wal-mart" });
    expect(chooseEntry(list, "Apple")).toEqual({ how: "partial", text: "Apple Store" });
  });
  it("does not choose between two partial hits, and never offers the not-listed entry as a match", () => {
    expect(chooseEntry(list, "Books")).toEqual({ how: "ambiguous", count: 2 });
    expect(chooseEntry(list, "Provider not", ["Provider not Listed"])).toEqual({ how: "none" });
    expect(chooseEntry(list, "")).toEqual({ how: "none" });
  });
});

describe("values", () => {
  it("writes money to two places and compares numbers, not words", () => {
    expect(moneyText("12.345")).toBe("12.35");
    expect(moneyText("")).toBeUndefined();
    expect(sameNumber("$12.50", "12.5")).toBe(true);
    expect(sameNumber("12.50", "12.51")).toBe(false);
  });
  it("reads ISO dates and Excel serials", () => {
    expect(isoDate("2026-03-04")).toBe("2026-03-04");
    expect(isoDate("46085")).toBe("2026-03-04");
    expect(isoDate("")).toBeUndefined();
  });
  it("splits a category into its levels", () => {
    expect(categoryLevels("Books - Print - Textbooks")).toEqual(["Books", "Print", "Textbooks"]);
  });
});

describe("totals", () => {
  const rows = [row("a", { Amount: "5.00", Quantity: "3", "Tax, Shipping, etc.": "0.50" }), row("b", { Amount: "10.00", Quantity: "", "Tax, Shipping, etc.": "" })];
  it("is amount x quantity (blank is 1) plus tax", () => {
    expect(expectedTotal(rows)).toBe(25.5);
  });
  it("checks the Summary's lines against the rows in any order", () => {
    expect(linesMatch([{ quantity: 1, cost: 10, tax: 0 }, { quantity: 3, cost: 5, tax: 0.5 }], rows)).toBe(true);
    expect(linesMatch([{ quantity: 2, cost: 5, tax: 0.5 }, { quantity: 1, cost: 10, tax: 0 }], rows)).toBe(false);
    expect(linesMatch([{ quantity: 1, cost: 10, tax: 0 }], rows)).toBe(false);
  });
});

describe("pairing blocks with rows", () => {
  const a = row("a", { Item: "Math book", Amount: "12.98" });
  const b = row("b", { Item: "Pencils", Amount: "3.00" });
  it("by the amount the scan read, then the name, then the only one left", () => {
    expect(matchBlock([a, b], "$3.00", undefined, false)).toMatchObject({ how: "amount", row: b });
    expect(matchBlock([a, b], "$0.00", "Math Book", false)).toMatchObject({ how: "name", row: a });
    expect(matchBlock([a], "", "", false)).toMatchObject({ how: "only", row: a });
  });
  it("by order only when the scan read nothing at all, and otherwise stops", () => {
    expect(matchBlock([a, b], "", "", true)).toMatchObject({ how: "order", row: a });
    expect(matchBlock([a, b], "$0.00", "", false)).toEqual({ how: "ambiguous" });
    expect(matchBlock([], "", "", false)).toEqual({ how: "none" });
  });
});

describe("which detected items to tick", () => {
  const rows = [row("a", { Item: "Math book" }), row("b", { Item: "Pencils" })];
  it("all of them when the counts agree; matches by name otherwise; stops when unsure", () => {
    expect(boxesToCheck(["x", "y"], rows)).toEqual([0, 1]);
    expect(boxesToCheck(["Math book", "Receipt total", "Pencils"], rows)).toBeUndefined();
    expect(boxesToCheck(["Pencils", "Math book", "Math book"], rows)).toBeUndefined();
    expect(boxesToCheck(["Pencils", "Math book", "zzz"], [rows[0]!, rows[1]!, row("c", { Item: "zzz" })])).toEqual([0, 1, 2]);
  });
});
