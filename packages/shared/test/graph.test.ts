import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GraphError,
  HlcClock,
  Ledger,
  OneDriveEventStore,
  SCHEMA_VERSION,
  SIMPLE_UPLOAD_LIMIT,
  configureGraph,
  ensureFolder,
  graphJson,
  readTextFile,
  setTokenProvider,
  uploadReceipt,
  writeFile,
  type LedgerEvent,
} from "../src/index.js";
import { FakeGraph } from "./fakeGraph.js";

let g: FakeGraph;
const sleeps: number[] = [];

beforeEach(() => {
  g = new FakeGraph();
  sleeps.length = 0;
  setTokenProvider(async () => "token");
  configureGraph({ fetch: g.fetch as typeof fetch, sleep: async (ms) => void sleeps.push(ms), maxRetries: 3 });
});
afterEach(() => configureGraph());

describe("graphFetch resilience", () => {
  it("retries 429 honouring Retry-After and then succeeds", async () => {
    g.failNext = [{ status: 429, retryAfter: 2 }];
    const out = await graphJson<{ id: string }>(`/drives/d/items/${g.rootId}`);
    expect(out.id).toBe(g.rootId);
    expect(sleeps).toEqual([2000]);
  });

  it("gives up after maxRetries and reports a GraphError", async () => {
    g.failNext = [503, 503, 503, 503].map((status) => ({ status }));
    await expect(graphJson(`/drives/d/items/${g.rootId}`)).rejects.toBeInstanceOf(GraphError);
    expect(sleeps.length).toBe(3);
  });

  it("does not retry client errors", async () => {
    await expect(graphJson(`/drives/d/items/nope`)).rejects.toMatchObject({ status: 404 });
    expect(sleeps).toEqual([]);
  });

  it("refreshes the token once on 401", async () => {
    let calls = 0;
    setTokenProvider(async () => `t${++calls}`);
    g.failNext = [{ status: 401 }];
    await graphJson(`/drives/d/items/${g.rootId}`);
    expect(calls).toBe(2);
  });
});

describe("file helpers", () => {
  it("creates folders idempotently, even when asked twice", async () => {
    const a = await ensureFolder("d", g.rootId, "events");
    const b = await ensureFolder("d", g.rootId, "events");
    expect(a).toBe(b);
  });

  it("writes with optimistic concurrency", async () => {
    const first = await writeFile("d", g.rootId, "a.json", "one", { createOnly: true });
    await expect(writeFile("d", g.rootId, "a.json", "x", { createOnly: true })).rejects.toMatchObject({ status: 409 });
    const second = await writeFile("d", g.rootId, "a.json", "two", { ifMatch: first.eTag });
    await expect(writeFile("d", g.rootId, "a.json", "three", { ifMatch: first.eTag })).rejects.toMatchObject({ status: 412 });
    expect((await readTextFile("d", second.id)).text).toBe("two");
  });

  it("uses an upload session for bodies over the simple-upload limit", async () => {
    const big = new Uint8Array(SIMPLE_UPLOAD_LIMIT + 1000).fill(7);
    // The fake learns the total size from this header on session creation.
    const original = g.fetch;
    configureGraph({
      fetch: ((u: RequestInfo | URL, i: RequestInit = {}) =>
        original(u, String(u).endsWith("createUploadSession") ? { ...i, headers: { ...(i.headers as object), "x-total": String(big.byteLength) } } : i)) as typeof fetch,
      sleep: async () => {},
    });
    const stored = await writeFile("d", g.rootId, "big.pdf", big);
    expect(g.nodes.get(stored.id)!.content.byteLength).toBe(big.byteLength);
    expect(g.requests.some((r) => r.url.endsWith("createUploadSession"))).toBe(true);
  });
});

function event(client: string, wall: number, entityId: string, fields: Record<string, string>): LedgerEvent {
  const hlc = `${String(wall).padStart(13, "0")}-00000-${client}`;
  return { id: hlc, hlc, clientId: client, schemaVersion: SCHEMA_VERSION, op: "set", entity: "item", entityId, fields };
}

describe("OneDriveEventStore", () => {
  it("two clients append only to their own logs and see each other's events", async () => {
    const folder = await ensureFolder("d", g.rootId, "events");
    const a = new OneDriveEventStore("d", folder, "dev-a");
    const b = new OneDriveEventStore("d", folder, "dev-b");
    await a.appendOwn([event("dev-a", 1, "i1", { description: "x" })]);
    await b.appendOwn([event("dev-b", 2, "i1", { notes: "y" })]);
    await a.appendOwn([event("dev-a", 3, "i2", { description: "z" })]);

    expect(g.child(folder, "dev-a.jsonl")).toBeDefined();
    expect(g.child(folder, "dev-b.jsonl")).toBeDefined();
    expect((await b.readAll()).map((e) => e.id).sort()).toHaveLength(3);
    expect(g.text(g.child(folder, "dev-a.jsonl")!.id).trim().split("\n")).toHaveLength(2);
  });

  it("is idempotent, resumes its own log after a restart, and rolls segments when large", async () => {
    const folder = await ensureFolder("d", g.rootId, "events");
    const first = new OneDriveEventStore("d", folder, "dev-a", { segmentBytes: 300 });
    const e1 = event("dev-a", 1, "i1", { description: "a".repeat(50) });
    await first.appendOwn([e1]);
    await first.appendOwn([e1]);
    expect(g.text(g.child(folder, "dev-a.jsonl")!.id).trim().split("\n")).toHaveLength(1);

    const restarted = new OneDriveEventStore("d", folder, "dev-a", { segmentBytes: 300 });
    await restarted.appendOwn([event("dev-a", 2, "i2", { description: "b".repeat(300) })]);
    await restarted.appendOwn([event("dev-a", 3, "i3", { description: "c" })]);
    expect(g.child(folder, "dev-a.1.jsonl")).toBeDefined();
    const all = await restarted.readAll();
    expect(all.map((e) => e.entityId).sort()).toEqual(["i1", "i2", "i3"]);
  });

  it("fails loudly when another writer used the same clientId", async () => {
    const folder = await ensureFolder("d", g.rootId, "events");
    const one = new OneDriveEventStore("d", folder, "dev-a");
    const clone = new OneDriveEventStore("d", folder, "dev-a");
    await one.appendOwn([event("dev-a", 1, "i1", { description: "x" })]);
    await clone.appendOwn([event("dev-a", 2, "i1", { notes: "from the clone" })]);
    await expect(one.appendOwn([event("dev-a", 3, "i1", { notes: "stale" })])).rejects.toThrow(/clientId/);
  });

  it("ignores a torn trailing line instead of failing the read", async () => {
    const folder = await ensureFolder("d", g.rootId, "events");
    const store = new OneDriveEventStore("d", folder, "dev-b");
    await store.appendOwn([event("dev-b", 1, "i1", { description: "ok" })]);
    const node = g.child(folder, "dev-b.jsonl")!;
    node.content = new TextEncoder().encode(g.text(node.id) + '{"id":"broken');
    node.version += 1;
    expect(await store.readAll()).toHaveLength(1);
  });

  it("drives a Ledger end to end across two clients", async () => {
    const folder = await ensureFolder("d", g.rootId, "events");
    const la = new Ledger(new OneDriveEventStore("d", folder, "dev-a"), new HlcClock("dev-a", { now: () => 1000 }), "alice");
    const lb = new Ledger(new OneDriveEventStore("d", folder, "dev-b"), new HlcClock("dev-b", { now: () => 1001 }), "bob");
    la.set("item", "i1", { description: "pencils" });
    await la.flush();
    await lb.refresh();
    lb.set("item", "i1", { notes: "bob was here" });
    await lb.flush();
    await la.refresh();
    expect(la.state.items["i1"]).toMatchObject({ description: "pencils", notes: "bob was here" });
    expect(la.state).toEqual((await (async () => (await lb.refresh(), lb.state))()));
  });
});

describe("OneDriveEventStore cache", () => {
  const contentGets = () => g.requests.filter((r) => r.method === "GET" && r.url.includes("/content")).length;

  it("downloads only logs whose ETag changed, and never re-downloads its own log", async () => {
    const folder = await ensureFolder("d", g.rootId, "events");
    const a = new OneDriveEventStore("d", folder, "dev-a");
    const b = new OneDriveEventStore("d", folder, "dev-b");
    await a.appendOwn([event("dev-a", 1, "i1", { description: "x" })]);
    await b.appendOwn([event("dev-b", 2, "i2", { description: "y" })]);

    // A later visit, seeded from what was persisted.
    const saved = JSON.parse(JSON.stringify(a.exportCache()));
    const later = new OneDriveEventStore("d", folder, "dev-a");
    later.seedCache(saved);
    expect(later.cachedEvents().map((e) => e.entityId)).toEqual(["i1"]);

    g.requests.length = 0;
    expect((await later.readAll()).map((e) => e.entityId).sort()).toEqual(["i1", "i2"]);
    expect(contentGets()).toBe(1); // only dev-b's log; dev-a's own was cached

    g.requests.length = 0;
    await later.readAll();
    expect(contentGets()).toBe(0); // nothing changed

    await later.appendOwn([event("dev-a", 3, "i3", { description: "z" })]);
    g.requests.length = 0;
    await later.readAll();
    expect(contentGets()).toBe(0); // our own write is already known
  });

  it("appends without re-reading its log when the cache matches the folder", async () => {
    const folder = await ensureFolder("d", g.rootId, "events");
    const first = new OneDriveEventStore("d", folder, "dev-a");
    await first.appendOwn([event("dev-a", 1, "i1", { description: "x" })]);
    const again = new OneDriveEventStore("d", folder, "dev-a");
    again.seedCache(first.exportCache());
    g.requests.length = 0;
    await again.appendOwn([event("dev-a", 2, "i2", { description: "y" })]);
    expect(contentGets()).toBe(0);
    expect(g.text(g.child(folder, "dev-a.jsonl")!.id).trim().split("\n")).toHaveLength(2);
  });
});

describe("uploadReceipt", () => {
  it("uploads and registers, renames on a name clash, and skips an identical file", async () => {
    const year = await ensureFolder("d", g.rootId, "2026-2027");
    const ledger = new Ledger(new OneDriveEventStore("d", await ensureFolder("d", year, "events"), "dev-a"), new HlcClock("dev-a"), "t");
    const bytes = (s: string) => new TextEncoder().encode(s);

    const first = await uploadReceipt(ledger, "d", year, { name: "Acme 07 28 2026 Books.pdf", body: bytes("one"), sha256: "aa" });
    expect(first.status).toBe("uploaded");
    expect(ledger.state.documents[first.documentId]).toMatchObject({ filename: "Acme 07 28 2026 Books.pdf", source: "upload", contentKind: "receipt-like", sha256: "aa" });

    const clash = await uploadReceipt(ledger, "d", year, { name: "Acme 07 28 2026 Books.pdf", body: bytes("two"), sha256: "bb" });
    expect(clash).toMatchObject({ status: "uploaded", name: "Acme 07 28 2026 Books (2).pdf" });
    expect(g.text(g.child(year, "Acme 07 28 2026 Books.pdf")!.id)).toBe("one");

    const again = await uploadReceipt(ledger, "d", year, { name: "other.pdf", body: bytes("one"), sha256: "aa" });
    expect(again).toMatchObject({ status: "duplicate", documentId: first.documentId });
    expect(g.child(year, "other.pdf")).toBeUndefined();
  });
});
