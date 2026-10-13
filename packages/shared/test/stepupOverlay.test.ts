import { describe, expect, it } from "vitest";
import { HlcClock, Ledger, projectReimbursement, stepUpOverlayEvents, type EventStore, type LedgerEvent } from "../src/index.js";

class MemoryStore implements EventStore {
  readonly clientId = "me";
  events: LedgerEvent[] = [];
  async readAll() { return this.events; }
  async appendOwn(e: LedgerEvent[]) { this.events.push(...e); }
}

const reimb = (status: string) => projectReimbursement({
  Id: "guid-7", SequenceNumber: 7, SchoolYear: "2026-2027", ExternalStatus: "Submitted",
  LineItems: [{ LineItemNumber: "7-1", ExternalStatus: status, Appealed: false, ItemAmount: 10, ReasonDescription: status === "Denied" ? "Not an approved expense" : null }],
})!;

function ledgerWithSubmittedItem(now: number) {
  const clock = new HlcClock("me", { now: () => now });
  const l = new Ledger(new MemoryStore(), clock, "test");
  l.set("submission", "sub-7", { reimbursementId: "7" });
  l.set("item", "i1", { submissionId: "sub-7", lineNumber: 1, amountCents: 1000, stepUpStatus: "Submitted" });
  return l;
}

describe("StepUp's list laid over a ledger year", () => {
  it("outranks what the ledger holds, by the time StepUp was last read", () => {
    const l = ledgerWithSubmittedItem(1_000_000);
    l.setOverlay((state) => stepUpOverlayEvents(state, [reimb("Denied")], 2_000_000));
    l.loadKnown([]);
    expect(l.state.items["i1"]).toMatchObject({ stepUpStatus: "Denied (Initial)", stepUpMessage: "Not an approved expense" });
    expect(l.state.submissions["sub-7"]?.guid).toBe("guid-7");
  });

  it("yields to something done here after StepUp was read: its copy has not caught up yet", () => {
    const l = ledgerWithSubmittedItem(3_000_000); // submitted at 3,000,000, StepUp last read at 2,000,000 (still a draft there)
    l.setOverlay((state) => stepUpOverlayEvents(state, [reimb("Denied")], 2_000_000));
    l.loadKnown([]);
    expect(l.state.items["i1"]?.stepUpStatus).toBe("Submitted");
  });

  it("calls a payment of another amount Adjusted, and nothing is flushed for StepUp's events", async () => {
    const l = ledgerWithSubmittedItem(1_000_000);
    const r = projectReimbursement({ Id: "g", SequenceNumber: 7, SchoolYear: "2026-2027", LineItems: [{ LineItemNumber: "7-1", ExternalStatus: "Paid", ItemAmount: 8.5 }] })!;
    l.setOverlay((state) => stepUpOverlayEvents(state, [r], 2_000_000));
    l.loadKnown([]);
    expect(l.state.items["i1"]).toMatchObject({ stepUpStatus: "Adjusted", approvedCents: 850 });
    expect(l.unflushedCount).toBe(2); // only the ledger's own
  });

  it("flags an item whose amount differs from StepUp's as adjusted at any stage, but leaves a denial a denial", () => {
    const l = ledgerWithSubmittedItem(1_000_000);
    const r = projectReimbursement({ Id: "g", SequenceNumber: 7, SchoolYear: "2026-2027", LineItems: [{ LineItemNumber: "7-1", ExternalStatus: "Submitted", ItemAmount: 8.5 }] })!;
    l.setOverlay((state) => stepUpOverlayEvents(state, [r], 2_000_000));
    l.loadKnown([]);
    expect(l.state.items["i1"]).toMatchObject({ stepUpStatus: "Adjusted", stepUpAmountCents: 850 });
    const denied = projectReimbursement({ Id: "g", SequenceNumber: 7, SchoolYear: "2026-2027", LineItems: [{ LineItemNumber: "7-1", ExternalStatus: "Denied", ItemAmount: 8.5 }] })!;
    l.setOverlay((state) => stepUpOverlayEvents(state, [denied], 2_000_000));
    l.loadKnown([]);
    expect(l.state.items["i1"]?.stepUpStatus).toBe("Denied (Initial)");
  });

  it("shows what StepUp has that the ledger has never heard of, except drafts", () => {
    const l = ledgerWithSubmittedItem(1_000_000);
    l.set("child", "child-kid", { name: "Kid" });
    const r = projectReimbursement({
      Id: "g9", SequenceNumber: 9, SchoolYear: "2026-2027", StudentName: "Kid", SubmitDate: "2026-03-01T00:00:00Z", ProviderName: "Amazon",
      Receipts: [{ Id: "r", SourceFileName: "216 - amazon.pdf" }],
      LineItems: [
        { LineItemNumber: "9-1", ExternalStatus: "Paid", ItemAmount: 20, MatchedItemName: "Hub", CategoryName: "Instructional Material" },
        { LineItemNumber: "9-2", ExternalStatus: "Draft", ItemAmount: 5 },
      ],
    })!;
    l.setOverlay((state) => stepUpOverlayEvents(state, [r], 2_000_000));
    l.loadKnown([]);
    expect(l.state.items["stepup-9-1"]).toMatchObject({ description: "Hub", childId: "child-kid", stepUpStatus: "Paid", paidCents: 2000, amountCents: 2000 });
    expect(l.state.items["stepup-9-2"]).toBeUndefined();
    expect(l.state.purchases["purchase-stepup-9"]).toMatchObject({ vendor: "Amazon" });
    expect(Object.values(l.state.submissions).find((s) => s.reimbursementId === "9")?.guid).toBe("g9");
    expect(l.unflushedCount).toBe(3);
  });
});
