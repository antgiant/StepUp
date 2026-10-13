import { describe, expect, it } from "vitest";
import { HlcClock, Ledger, MemoryBackend, MemoryEventStore, addItem, createPurchase, updateItem, remainingToItemize } from "../src/index.js";

const ledger = () => new Ledger(new MemoryEventStore(new MemoryBackend(), "dev"), new HlcClock("dev"), "t");

describe("estimated tax", () => {
  it("is never more than what is left on the receipt", () => {
    const l = ledger();
    const p = createPurchase(l, { vendor: "Acme", date: "2026-10-01", orderTotalCents: 10000 });
    const whole = addItem(l, p, { childId: "kid", description: "Everything", amountCents: 10000 });
    expect(l.state.items[whole]!.taxShippingCents).toBe(0);
    expect(remainingToItemize(l.state, p)).toBe(0);
  });

  it("still estimates when there is room, and trims to the room", () => {
    const l = ledger();
    const p = createPurchase(l, { orderTotalCents: 10000 });
    const a = addItem(l, p, { childId: "kid", description: "A", amountCents: 5000 });
    expect(l.state.items[a]!.taxShippingCents).toBeGreaterThan(0);
    const b = addItem(l, p, { childId: "kid", description: "B", amountCents: 4900 });
    const total = [a, b].reduce((s, id) => s + l.state.items[id]!.amountCents! + l.state.items[id]!.taxShippingCents!, 0);
    expect(l.state.items[b]!.taxShippingCents).toBeLessThanOrEqual(100);
    expect(total).toBeLessThanOrEqual(10000 + (l.state.items[a]!.taxShippingCents ?? 0));
  });

  it("is trimmed when the amount is edited up to the whole receipt", () => {
    const l = ledger();
    const p = createPurchase(l, { orderTotalCents: 10000 });
    const a = addItem(l, p, { childId: "kid", description: "A", amountCents: 5000 });
    updateItem(l, a, { amountCents: 10000 });
    expect(l.state.items[a]!.taxShippingCents).toBe(0);
  });

  it("without a receipt total is the plain estimate", () => {
    const l = ledger();
    const p = createPurchase(l, {});
    const a = addItem(l, p, { childId: "kid", description: "A", amountCents: 10000 });
    expect(l.state.items[a]!.taxShippingCents).toBeGreaterThan(0);
  });
});
