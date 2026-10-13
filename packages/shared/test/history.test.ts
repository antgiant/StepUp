import { describe, expect, it } from "vitest";
import { HlcClock, Ledger, diffExcel, diffStepUp, ledgerHistory, projectReimbursement, snapshotExcel, type EventStore, type LedgerEvent } from "../src/index.js";

class MemoryStore implements EventStore {
  readonly clientId = "me";
  events: LedgerEvent[] = [];
  async readAll() { return this.events; }
  async appendOwn(e: LedgerEvent[]) { this.events.push(...e); }
}

describe("ledger history", () => {
  it("lists an entity's first appearance as added and later field changes with what they were", async () => {
    let t = 1_700_000_000_000;
    const store = new MemoryStore();
    const l = new Ledger(store, new HlcClock("me", { now: () => (t += 1000) }), "alice");
    l.set("item", "i1", { description: "Hub", amountCents: 1000, categoryId: "c", submissionId: "s" }, { label: "item.created" });
    l.set("item", "i1", { amountCents: 1250, notes: "bigger" });
    l.set("item", "i1", { amountCents: 1250 }); // nothing changed
    l.delete("item", "i1");
    await l.flush();
    const h = ledgerHistory(store.events, l.state);
    expect(h.map((c) => c.kind)).toEqual(["added", "changed", "removed"]);
    expect(h[0]!.details).toEqual([{ field: "Description", to: "Hub" }, { field: "Amount", to: "$10.00" }]);
    expect(h[1]!.details).toEqual([{ field: "Amount", from: "$10.00", to: "$12.50" }, { field: "Notes", to: "bigger" }]);
    expect(h[0]!.actor).toBe("alice");
  });

  it("leaves out the one-time import and the app's working state", () => {
    const l = new Ledger(new MemoryStore(), new HlcClock("legacy-import", { now: () => 1_600_000_000_000 }), "legacy-import");
    l.set("item", "i1", { description: "Old" }, { label: "legacy.item" });
    l.set("claim", "c1", { actor: "x" });
    expect(ledgerHistory([...(l as unknown as { pending: LedgerEvent[] }).pending], l.state)).toEqual([]);
  });
});

describe("StepUp and Excel history", () => {
  const r = (status: string, amount: number, extra: Record<string, unknown> = {}) => projectReimbursement({
    Id: "g1", SequenceNumber: 55, SchoolYear: "2025-2026", ExternalStatus: "Submitted", StudentName: "Kid",
    LineItems: [{ LineItemNumber: "55-1", ExternalStatus: status, Appealed: false, ItemAmount: amount, ...extra }],
  })!;

  it("reports a reimbursement StepUp has not shown before, and what changed on one it has", () => {
    expect(diffStepUp([], [r("Submitted", 10)], "2026-10-13T10:00:00Z")[0]).toMatchObject({ kind: "added", source: "stepup" });
    const c = diffStepUp([r("Submitted", 10)], [r("Denied", 10, { ReasonDescription: "Not an approved expense" })], "2026-10-14T10:00:00Z");
    expect(c).toHaveLength(1);
    expect(c[0]!.details).toEqual([
      { field: "Status of 55-1", from: "Submitted", to: "Denied" },
      { field: "Reason for 55-1", from: "(none)", to: "Not an approved expense" },
    ]);
    expect(diffStepUp([r("Paid", 10)], [r("Paid", 10)], "x")).toEqual([]);
  });

  it("follows the workbook row by row", () => {
    const headers = ["ID", "Child", "Item", "Amount", "Status", "Formula"];
    const a = snapshotExcel(headers, [[1, "Kid", "Hub", 10, "Submitted", "=1"], [2, "Kid", "Pen", 2, "Submitted", "=2"]], "2026-10-13T10:00:00.000Z");
    const b = snapshotExcel(headers, [[1, "Kid", "Hub", 10, "Paid", "=9"], [3, "Kid", "Book", 7, "Unfiled", "=3"]], "2026-10-14T10:00:00.000Z");
    expect(diffExcel(undefined, a, "x")[0]).toMatchObject({ kind: "note" });
    const c = diffExcel(a, b, "edited in Excel");
    expect(c.map((x) => x.kind).sort()).toEqual(["added", "changed", "removed"]);
    expect(c.find((x) => x.kind === "changed")!.details).toEqual([{ field: "Status", from: "Submitted", to: "Paid" }]);
  });
});
