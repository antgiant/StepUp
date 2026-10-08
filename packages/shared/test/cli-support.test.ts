import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  HlcClock,
  Ledger,
  LockHeldError,
  LockLostError,
  MemoryBackend,
  MemoryEventStore,
  OneDriveEventStore,
  SessionLock,
  applyObservedCategories,
  categorySyncEdits,
  configureGraph,
  ensureFolder,
  publishYearMirror,
  referenceHash,
  resolveReference,
  setTokenProvider,
  type CategoryReference,
  type ReferenceNode,
  type RulesContext,
} from "../src/index.js";
import { FakeGraph } from "./fakeGraph.js";

let g: FakeGraph;
beforeEach(() => {
  g = new FakeGraph();
  setTokenProvider(async () => "token");
  configureGraph({ fetch: g.fetch as typeof fetch, sleep: async () => undefined, maxRetries: 0 });
});
afterEach(() => configureGraph());

const alice = { actor: "alice@example.com", clientId: "cli-a", machine: "ALICE-MAC" };
const bob = { actor: "bob@example.com", clientId: "cli-b", machine: "BOB-PC" };

describe("SessionLock", () => {
  it("lets one person in and tells the other who is using StepUp", async () => {
    const root = g.rootId;
    const lockA = await SessionLock.acquire("d", root, alice);
    const err = await SessionLock.acquire("d", root, bob).catch((e) => e);
    expect(err).toBeInstanceOf(LockHeldError);
    expect(err.message).toMatch(/alice@example.com is using StepUp from ALICE-MAC/);
    await lockA.release();
    const lockB = await SessionLock.acquire("d", root, bob); // free again
    await lockB.release();
  });

  it("an abandoned lock (no heartbeat past its time-out) can be taken over, and the old holder finds out", async () => {
    let t = 1_000_000;
    const now = () => t;
    const a = await SessionLock.acquire("d", g.rootId, alice, { ttlMs: 60_000, now });
    t += 30_000;
    await a.heartbeat(); // still alive
    await expect(SessionLock.acquire("d", g.rootId, bob, { ttlMs: 60_000, now })).rejects.toBeInstanceOf(LockHeldError);
    t += 61_000; // alice's laptop slept
    const b = await SessionLock.acquire("d", g.rootId, bob, { ttlMs: 60_000, now });
    await expect(a.heartbeat()).rejects.toBeInstanceOf(LockLostError);
    await a.release(); // does not remove bob's lock
    await expect(SessionLock.acquire("d", g.rootId, alice, { now })).rejects.toBeInstanceOf(LockHeldError);
    await b.release();
  });

  it("--force-unlock takes a live lock; your own leftover lock needs no force", async () => {
    const a = await SessionLock.acquire("d", g.rootId, alice);
    const forced = await SessionLock.acquire("d", g.rootId, bob, { force: true });
    await expect(a.heartbeat()).rejects.toBeInstanceOf(LockLostError);
    await forced.release();

    await SessionLock.acquire("d", g.rootId, alice); // crashed without releasing
    const again = await SessionLock.acquire("d", g.rootId, alice); // same install restarts
    await again.release();
  });
});

describe("category sync into the ledger", () => {
  const node = (id: string, name: string, extra: Partial<ReferenceNode> = {}): ReferenceNode => ({ id, name, isActive: true, eligibleScholarships: [], requiresServiceDate: false, ...extra });
  const base = (categories: ReferenceNode[]): CategoryReference => ({ schemaVersion: 1, version: 1, hash: referenceHash(categories), categories });
  const ledger = () => new Ledger(new MemoryEventStore(new MemoryBackend(), "dev"), new HlcClock("dev"), "t");

  it("adds new entries, updates what changed, and leaves the rest (and Service Date flags) alone", () => {
    const b = base([node("c1", "Curriculum", { requiresServiceDate: true, eligibleScholarships: ["FES-UA"] }), node("t1", "Books", { parentId: "c1" })]);
    const l = ledger();
    const observed = [
      node("c1", "Curriculum", { eligibleScholarships: ["FES-UA"] }), // same (their requiresServiceDate=false must not override ours)
      node("t1", "Books and Workbooks", { parentId: "c1", eligibleScholarships: ["FES-UA", "FTC"] }), // renamed + eligibility now known
      node("t2", "Software", { parentId: "c1", eligibleScholarships: ["FES-UA"] }), // new
    ];
    expect(applyObservedCategories(l, b, observed)).toEqual({ added: 1, updated: 1 });
    const r = resolveReference(b, l.state.categories);
    expect(r.category("t1")).toMatchObject({ path: ["Curriculum", "Books and Workbooks"], eligibleScholarships: ["FES-UA", "FTC"] });
    expect(r.category("t2")?.path).toEqual(["Curriculum", "Software"]);
    expect(r.category("c1")?.requiresServiceDate).toBe(true);
    expect(applyObservedCategories(l, b, observed)).toEqual({ added: 0, updated: 0 }); // idempotent
  });

  it("an observation with no eligibility list never wipes a known one, and a deactivated entry is recorded", () => {
    const b = base([node("c1", "Curriculum", { eligibleScholarships: ["FES-UA"] })]);
    expect(categorySyncEdits(b.categories, {}, [node("c1", "Curriculum")])).toEqual([]);
    expect(categorySyncEdits(b.categories, {}, [node("c1", "Curriculum", { isActive: false })])).toEqual([{ id: "c1", isActive: false }]);
  });
});

describe("publishYearMirror", () => {
  const ctx: RulesContext = { today: "2026-10-20", category: () => undefined };
  it("writes the same file name the web uses, skips when unchanged, and respects the off switch", async () => {
    const year = await ensureFolder("d", g.rootId, "2026-2027");
    const ledger_ = await ensureFolder("d", year, "_ledger");
    const events = await ensureFolder("d", ledger_, "events");
    const reports = await ensureFolder("d", ledger_, "reports");
    await ensureFolder("d", ledger_, "documents");
    await ensureFolder("d", ledger_, "inbox");
    const l = new Ledger(new OneDriveEventStore("d", events, "dev"), new HlcClock("dev"), "t");
    l.set("child", "kid", { name: "Kid" });
    const opts = { ledger: l, ctx, driveId: "d", yearFolderId: year, yearLabel: "2026-2027", appVersion: "test" };

    const first = await publishYearMirror(opts);
    expect(first.status).toBe("written");
    expect(g.child(reports, "2026-2027 FES UA Tracking (mirror).xlsx")).toBeDefined();
    expect((await publishYearMirror({ ...opts, reportsId: first.reportsId })).status).toBe("unchanged");
    l.set("setting", "year", { mirror: false });
    expect((await publishYearMirror(opts)).status).toBe("off");
  });
});
