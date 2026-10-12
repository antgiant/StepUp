import { describe, expect, it, vi } from "vitest";

// The web module signs in at import time, which wants a browser; the pivot itself needs none of it.
vi.mock("../../web/src/storage.js", () => ({ storage: {} }));
vi.stubGlobal("localStorage", { getItem: () => null, setItem() {} });
const { pivot, drillInto, getDrill, clearDrill } = await import("../../web/src/legacyYear.js");

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
  it("award mode lists every student with the award, money by stage and what is left", () => {
    const st: any = {
      children: { a: { id: "a", name: "Ann", scholarship: "FES-UA", capCents: 5000 }, b: { id: "b", name: "Bo", capCents: 0 } },
      purchases: {},
      items: {
        1: { childId: "a", amountCents: 1000, stepUpStatus: "Paid", paidCents: 900 },
        2: { childId: "a", amountCents: 500, stepUpStatus: "Approved" },
        3: { childId: "a", amountCents: 200, stepUpStatus: "Submitted" },
        4: { childId: "a", amountCents: 300 },
        5: { childId: "a", amountCents: 700, stepUpStatus: "Denied", submissionId: "s" },
      },
    };
    const r = pivot(st, ctx, { rows: "child", cols: "budget", value: "dollars" });
    expect(r.cols).toEqual(["Award", "Paid", "Approved", "Pending", "Remaining", "Not yet filed"]);
    expect(r.rows).toEqual(["Ann", "Bo"]);
    const c = (row: string, col: string) => r.cell.get(`${row}\u0000${col}`)?.cents;
    expect([c("Ann", "Award"), c("Ann", "Paid"), c("Ann", "Approved"), c("Ann", "Pending"), c("Ann", "Remaining"), c("Ann", "Not yet filed")]).toEqual([5000, 900, 500, 200, 3400, 300]);
    expect(c("Bo", "Award")).toBeUndefined();
    expect(c("Bo", "Paid")).toBe(0);
    expect(r.colTotal.get("Award")?.cents).toBe(5000);
  });
  it("leaves the award empty when grouping by something an award does not belong to", () => {
    const r = pivot(state, ctx, { rows: "vendor", cols: "budget", value: "dollars" });
    expect(r.cell.get("Amazon\u0000Award")).toBeUndefined();
    expect(r.cell.get("Amazon\u0000Paid")?.cents).toBe(1000);
  });
  it("a cell's drill-down is exactly the items that make it up", () => {
    const st: any = {
      children: { a: { id: "a", name: "Ann", capCents: 5000 }, b: { id: "b", name: "Bo" } },
      purchases: {},
      items: {
        i1: { childId: "a", amountCents: 1000, stepUpStatus: "Paid" },
        i2: { childId: "a", amountCents: 500, stepUpStatus: "Approved" },
        i3: { childId: "b", amountCents: 200, stepUpStatus: "Paid" },
        i4: { childId: "a", amountCents: 100, stepUpStatus: "Paid", archived: true },
      },
    };
    // Table 1 defaults to students by award stages.
    drillInto(st, ctx, 0, "Ann", "Paid");
    expect([...getDrill()!.ids]).toEqual(["i1"]);
    drillInto(st, ctx, 0, "Ann", "Remaining");
    expect([...getDrill()!.ids].sort()).toEqual(["i1", "i2"]);
    drillInto(st, ctx, 0, undefined, "Paid");
    expect([...getDrill()!.ids].sort()).toEqual(["i1", "i3"]);
    // Table 2 defaults to status with a single Total column.
    drillInto(st, ctx, 1, "Paid");
    expect(getDrill()!.title).toBe("Status Paid");
    expect([...getDrill()!.ids].sort()).toEqual(["i1", "i3"]);
    clearDrill();
    expect(getDrill()).toBeUndefined();
  });
});
