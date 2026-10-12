import { describe, expect, it, vi } from "vitest";

// The web module signs in at import time, which wants a browser; the pivot itself needs none of it.
vi.mock("../../web/src/storage.js", () => ({ storage: {} }));
vi.stubGlobal("localStorage", { getItem: () => null, setItem() {} });
const { pivot } = await import("../../web/src/legacyYear.js");

const state: any = {
  children: { a: { name: "Ann" }, b: { name: "Bo" } },
  purchases: { p1: { vendor: "Amazon" }, p2: { vendor: "amazon" } },
  items: {
    1: { childId: "a", purchaseId: "p1", amountCents: 1000, stepUpStatus: "Paid" },
    2: { childId: "b", purchaseId: "p2", amountCents: 500, stepUpStatus: "Pending" },
    3: { childId: "a", purchaseId: "p2", amountCents: 200, archived: true },
  },
};
const ctx: any = { category: () => undefined };

describe("summary pivot", () => {
  it("merges vendor spellings, skips archived items and totals rows and columns", () => {
    const r = pivot(state, ctx, { rows: "vendor", cols: "child", value: "both" });
    expect(r.rows).toEqual(["Amazon"]);
    expect(r.cols).toEqual(["Ann", "Bo"]);
    expect(r.cell.get("Amazon\u0000Ann")).toEqual({ count: 1, cents: 1000 });
    expect(r.total).toEqual({ count: 2, cents: 1500 });
  });
  it("has a single Total column when nothing is spread across", () => {
    const r = pivot(state, ctx, { rows: "status", cols: "", value: "count" });
    expect(r.cols).toEqual(["Total"]);
    expect(r.rows).toEqual(["Paid", "Pending"]);
  });
});
