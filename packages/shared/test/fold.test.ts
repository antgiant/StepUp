import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  FOLD_VERSION,
  Ledger,
  HlcClock,
  MemoryBackend,
  MemoryEventStore,
  SCHEMA_VERSION,
  foldEvents,
  makeSnapshot,
  materialize,
  tailEvents,
  type LedgerEvent,
} from "../src/index.js";

let seq = 0;
function ev(partial: Partial<LedgerEvent> & Pick<LedgerEvent, "op" | "entityId">): LedgerEvent {
  const wall = partial.hlc ? 0 : ++seq;
  const hlc = partial.hlc ?? `${String(wall).padStart(13, "0")}-00000-${partial.clientId ?? "a"}`;
  return { id: hlc, hlc, clientId: partial.clientId ?? "a", schemaVersion: SCHEMA_VERSION, entity: "item", ...partial };
}
const hlcAt = (wall: number, client: string, counter = 0) => `${String(wall).padStart(13, "0")}-${String(counter).padStart(5, "0")}-${client}`;

describe("fold semantics", () => {
  it("merges edits to different fields of the same entity", () => {
    const events = [
      ev({ hlc: hlcAt(1, "a"), clientId: "a", op: "set", entityId: "i1", fields: { description: "pen" } }),
      ev({ hlc: hlcAt(2, "b"), clientId: "b", op: "set", entityId: "i1", fields: { notes: "from phone" } }),
    ];
    const s = materialize(foldEvents(events));
    expect(s.items["i1"]).toMatchObject({ description: "pen", notes: "from phone" });
  });

  it("resolves same-field conflicts by highest hlc, regardless of arrival order", () => {
    const early = ev({ hlc: hlcAt(1, "a"), clientId: "a", op: "set", entityId: "i1", fields: { description: "old" } });
    const late = ev({ hlc: hlcAt(2, "b"), clientId: "b", op: "set", entityId: "i1", fields: { description: "new" } });
    expect(materialize(foldEvents([early, late])).items["i1"]?.description).toBe("new");
    expect(materialize(foldEvents([late, early])).items["i1"]?.description).toBe("new");
  });

  it("delete wins over later field sets until an explicit restore", () => {
    const set = ev({ hlc: hlcAt(1, "a"), clientId: "a", op: "set", entityId: "i1", fields: { description: "x" } });
    const del = ev({ hlc: hlcAt(2, "a"), clientId: "a", op: "delete", entityId: "i1" });
    const lateSet = ev({ hlc: hlcAt(3, "b"), clientId: "b", op: "set", entityId: "i1", fields: { notes: "n" } });
    const restore = ev({ hlc: hlcAt(4, "a"), clientId: "a", op: "restore", entityId: "i1" });
    expect(materialize(foldEvents([set, del, lateSet])).items["i1"]).toBeUndefined();
    const restored = materialize(foldEvents([set, del, lateSet, restore])).items["i1"];
    expect(restored).toMatchObject({ description: "x", notes: "n" });
  });

  it("skips events from a newer schema version instead of misreading them", () => {
    const future = ev({ hlc: hlcAt(1, "a"), op: "set", entityId: "i1", fields: { description: "?" }, schemaVersion: SCHEMA_VERSION + 1 });
    const raw = foldEvents([future]);
    expect(materialize(raw).items["i1"]).toBeUndefined();
    expect(Object.keys(raw.skipped)).toEqual([future.id]);
  });
});

// ---- properties ------------------------------------------------------------

const clients = ["a", "b", "c"];
const arbEvent = fc
  .record({
    wall: fc.integer({ min: 1, max: 40 }),
    counter: fc.integer({ min: 0, max: 3 }),
    client: fc.constantFrom(...clients),
    op: fc.constantFrom("set", "set", "set", "delete", "restore") as fc.Arbitrary<LedgerEvent["op"]>,
    entityId: fc.constantFrom("i1", "i2", "i3"),
    field: fc.constantFrom("description", "notes", "amountCents"),
    value: fc.oneof(fc.string({ maxLength: 4 }), fc.integer({ min: 0, max: 99 })),
  })
  .map(({ wall, counter, client, op, entityId, field, value }) => {
    const hlc = hlcAt(wall, client, counter);
    return ev({ hlc, clientId: client, op, entityId, ...(op === "set" ? { fields: { [field]: value } } : {}) });
  });
// Unique ids: a real clock never issues the same hlc twice for one client.
const arbEvents = fc.array(arbEvent, { maxLength: 40 }).map((list) => [...new Map(list.map((e) => [e.id, e])).values()]);

describe("fold properties", () => {
  it("is independent of event order", () => {
    fc.assert(
      fc.property(arbEvents, fc.infiniteStream(fc.nat()), (events, rnd) => {
        const shuffled = [...events].sort(() => (rnd.next().value % 3) - 1);
        expect(foldEvents(shuffled)).toEqual(foldEvents(events));
      })
    );
  });

  it("is idempotent: replaying events changes nothing", () => {
    fc.assert(
      fc.property(arbEvents, (events) => {
        const once = foldEvents(events);
        expect(foldEvents([...events, ...events])).toEqual(once);
        expect(foldEvents(events, once)).toEqual(once);
      })
    );
  });

  it("snapshot + tail equals the full fold, wherever the snapshot was taken", () => {
    fc.assert(
      fc.property(arbEvents, fc.nat(), (events, cut) => {
        const k = events.length === 0 ? 0 : cut % (events.length + 1);
        // Per-client logs are monotonic in hlc, so take the snapshot over a per-client prefix.
        const sorted = [...events].sort((x, y) => (x.hlc < y.hlc ? -1 : 1));
        const head = sorted.slice(0, k);
        const snap = makeSnapshot(head);
        const tail = tailEvents(sorted, snap);
        expect(foldEvents(tail, snap.raw)).toEqual(foldEvents(sorted));
        expect(snap.foldVersion).toBe(FOLD_VERSION);
      })
    );
  });
});

describe("Ledger across clients", () => {
  it("two devices editing offline converge after exchanging logs", async () => {
    const backend = new MemoryBackend();
    let tA = 1000;
    let tB = 1000;
    const a = new Ledger(new MemoryEventStore(backend, "dev-a"), new HlcClock("dev-a", { now: () => tA }), "alice");
    const b = new Ledger(new MemoryEventStore(backend, "dev-b"), new HlcClock("dev-b", { now: () => tB }), "bob");

    a.set("item", "i1", { description: "pencils", amountCents: 500 });
    await a.flush();
    await b.refresh();
    expect(b.state.items["i1"]?.description).toBe("pencils");

    // Concurrent offline edits: different fields on one item, same field on another.
    tA = 2000;
    tB = 2001;
    a.set("item", "i1", { notes: "from alice" });
    b.set("item", "i1", { amountCents: 650 });
    a.set("item", "i2", { description: "alice version" });
    b.set("item", "i2", { description: "bob version" });
    await Promise.all([a.flush(), b.flush()]);
    await Promise.all([a.refresh(), b.refresh()]);

    expect(a.state).toEqual(b.state);
    expect(a.state.items["i1"]).toMatchObject({ description: "pencils", notes: "from alice", amountCents: 650 });
    expect(a.state.items["i2"]?.description).toBe("bob version");
  });

  it("keeps unflushed local edits through a refresh and flush is idempotent", async () => {
    const backend = new MemoryBackend();
    const store = new MemoryEventStore(backend, "dev-a");
    const l = new Ledger(store, new HlcClock("dev-a", { now: () => 1000 }));
    l.set("item", "i1", { description: "x" });
    await l.refresh();
    expect(l.state.items["i1"]?.description).toBe("x");
    expect(l.unflushedCount).toBe(1);
    await l.flush();
    await l.flush();
    expect((await store.readAll()).length).toBe(1);
  });
});

import { upcastEvent, SCHEMA_VERSION as CURRENT, type LedgerEvent as Ev } from "../src/index.js";

describe("schema upcasting", () => {
  const old = (v: number, fields: Record<string, unknown>): Ev => ({ id: "h1", hlc: "h1", clientId: "c", schemaVersion: v, op: "set", entity: "item", entityId: "i", fields: fields as never });

  it("walks an old event up through the registered steps, one version at a time", () => {
    const migrations = {
      1: (e: Ev) => ({ ...e, fields: { ...e.fields, description: (e.fields as Record<string, unknown>)["name"] } as never }),
      2: (e: Ev) => ({ ...e, fields: { ...e.fields, amountCents: Math.round(Number((e.fields as Record<string, unknown>)["amount"]) * 100) } as never }),
    };
    const up = upcastEvent(old(1, { name: "Book", amount: 12.5 }), migrations, 3);
    expect(up.schemaVersion).toBe(3);
    expect(up.fields).toMatchObject({ description: "Book", amountCents: 1250 });
  });

  it("a version with no step registered is treated as compatible, and current events are untouched", () => {
    expect(upcastEvent(old(1, { a: 1 }), {}, 3).schemaVersion).toBe(3);
    const now = old(CURRENT, { a: 1 });
    expect(upcastEvent(now)).toBe(now);
  });
});
