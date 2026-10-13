import { describe, expect, it } from "vitest";
import { HlcClock, Ledger, MemoryBackend, MemoryEventStore, addItem, clearTaxTotal, createPurchase, reallocateTax, updateItem, remainingToItemize } from "../src/index.js";

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

  describe("include tax", () => {
    const setup = () => {
      const l = ledger();
      const p = createPurchase(l, { orderTotalCents: 11000, taxShippingTotalCents: 1000 });
      const a = addItem(l, p, { childId: "kid", description: "A", amountCents: 6000 });
      const b = addItem(l, p, { childId: "kid", description: "B", amountCents: 4000, includeTax: false });
      const c = addItem(l, p, { childId: "kid", description: "C", amountCents: 0 });
      return { l, p, a, b, c };
    };

    it("spreads the receipt tax only over the items that include it", () => {
      const { l, p, a, b } = setup();
      reallocateTax(l, p);
      expect(l.state.items[b]!.taxShippingCents).toBe(0);
      expect(l.state.items[a]!.taxShippingCents).toBe(1000);
      expect(l.state.items[a]!.taxShippingEstimated).toBe(false);
    });

    it("moves the tax when an item is switched off and on", () => {
      const { l, p, a, b } = setup();
      reallocateTax(l, p);
      updateItem(l, b, { includeTax: true });
      reallocateTax(l, p);
      expect(l.state.items[a]!.taxShippingCents! + l.state.items[b]!.taxShippingCents!).toBe(1000);
      expect(l.state.items[b]!.taxShippingCents).toBe(400);
      updateItem(l, a, { includeTax: false });
      reallocateTax(l, p);
      expect(l.state.items[a]!.taxShippingCents).toBe(0);
      expect(l.state.items[b]!.taxShippingCents).toBe(1000);
    });

    it("a receipt tax of zero gives every item zero, and a blank one goes back to estimates", () => {
      const l = ledger();
      const p = createPurchase(l, { orderTotalCents: 20000, taxShippingTotalCents: 0 });
      const a = addItem(l, p, { childId: "kid", description: "A", amountCents: 5000 });
      const b = addItem(l, p, { childId: "kid", description: "B", amountCents: 5000, includeTax: false });
      reallocateTax(l, p);
      expect(l.state.items[a]!.taxShippingCents).toBe(0);
      expect(l.state.items[a]!.taxShippingEstimated).toBe(false);
      clearTaxTotal(l, p);
      expect(l.state.purchases[p]!.taxShippingTotalCents).toBeUndefined();
      expect(l.state.items[a]!.taxShippingCents).toBeGreaterThan(0);
      expect(l.state.items[a]!.taxShippingEstimated).toBe(true);
      expect(l.state.items[b]!.taxShippingCents).toBe(0);
    });

    it("does not divide by nothing when no item includes tax", () => {
      const l = ledger();
      const p = createPurchase(l, { orderTotalCents: 5000, taxShippingTotalCents: 500 });
      const a = addItem(l, p, { childId: "kid", description: "A", amountCents: 5000, includeTax: false });
      reallocateTax(l, p);
      expect(l.state.items[a]!.taxShippingCents).toBe(0);
    });
  });
});
