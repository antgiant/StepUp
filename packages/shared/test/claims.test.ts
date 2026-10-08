import { describe, expect, it } from "vitest";
import {
  CLAIM_TTL_MS,
  HlcClock,
  Ledger,
  MemoryBackend,
  MemoryEventStore,
  claimItems,
  claimedByOthers,
  deleteDraft,
  findDraft,
  releaseItems,
  saveDraft,
  winningClaim,
} from "../src/index.js";

const alice = { actor: "alice@example.com", clientId: "cli-a" };
const bob = { actor: "bob@example.com", clientId: "cli-b" };

function pair() {
  const backend = new MemoryBackend();
  const mk = (id: string) => new Ledger(new MemoryEventStore(backend, id), new HlcClock(id), id);
  return { a: mk("cli-a"), b: mk("cli-b") };
}

describe("claims", () => {
  it("one person's claim keeps the other out, and releasing frees the items", async () => {
    const { a, b } = pair();
    expect(await claimItems(a, ["i1", "i2"], alice)).toEqual({ ok: true });
    await b.refresh();
    const res = await claimItems(b, ["i2", "i3"], bob);
    expect(res.ok).toBe(false);
    expect(!res.ok && res.conflicts).toEqual([expect.objectContaining({ itemId: "i2", actor: "alice@example.com" })]);
    expect(winningClaim(b.state, "i3", Date.now())).toBeUndefined(); // bob's failed attempt left nothing behind

    await releaseItems(a, ["i1", "i2"], alice);
    expect(await claimItems(b, ["i2", "i3"], bob)).toEqual({ ok: true });
  });

  it("two people claiming at the same moment: only the earliest goes ahead", async () => {
    const { a, b } = pair();
    const t = 1_700_000_000_000;
    // Neither has seen the other's claim when writing (the race the re-read exists for); alice's is earlier.
    const [ra, rb] = await Promise.all([claimItems(a, ["i1"], alice, () => t), claimItems(b, ["i1"], bob, () => t + 5)]);
    expect([ra.ok, rb.ok].filter(Boolean)).toHaveLength(1);
    expect(ra.ok).toBe(true);
    expect(rb.ok).toBe(false);
  });

  it("your own earlier claim (a crashed run) is resumed, and old claims expire", async () => {
    const { a, b } = pair();
    const t0 = 1_700_000_000_000;
    await claimItems(a, ["i1"], alice, () => t0);
    expect(await claimItems(a, ["i1"], alice, () => t0 + 1000)).toEqual({ ok: true }); // same install
    await b.refresh();
    expect(claimedByOthers(b.state, ["i1"], bob, t0 + 1000)).toHaveLength(1);
    expect(claimedByOthers(b.state, ["i1"], bob, t0 + 1000 + CLAIM_TTL_MS + 1)).toEqual([]); // abandoned (the resume renewed the claim at t0+1000)
    expect(await claimItems(b, ["i1"], bob, () => t0 + 1000 + CLAIM_TTL_MS + 2)).toEqual({ ok: true });
  });
});

describe("drafts in the ledger", () => {
  const record = { guid: "11111111-2222-3333-4444-555555555555", rowIds: ["i2", "i1"], lastStep: "itemDetails", scanOutcome: "detected", attachedFiles: ["a.pdf"] };

  it("saves resume state, finds it by its items on another machine, and updates it in place", async () => {
    const { a, b } = pair();
    saveDraft(a, record, "alice@example.com", new Date("2026-10-20T10:00:00Z"));
    await a.flush();
    await b.refresh();
    expect(findDraft(b.state, ["i1", "i2"])).toMatchObject({ guid: record.guid, rowIds: ["i2", "i1"], lastStep: "itemDetails", attachedFiles: ["a.pdf"], scanOutcome: "detected" });
    expect(findDraft(b.state, ["i1"])).toBeUndefined();

    saveDraft(a, { ...record, lastStep: "summary", sequenceNumber: "4521", skipped: true }, "alice@example.com", new Date("2026-10-20T10:05:00Z"));
    expect(findDraft(a.state, ["i1", "i2"])).toMatchObject({ lastStep: "summary", sequenceNumber: "4521", skipped: true });
    expect(Object.keys(a.state.drafts)).toHaveLength(1);
  });

  it("deleting a draft does not block a later draft for the same items (new guid)", async () => {
    const { a } = pair();
    saveDraft(a, record, "alice", new Date("2026-10-20T10:00:00Z"));
    deleteDraft(a, ["i1", "i2"]);
    expect(findDraft(a.state, ["i1", "i2"])).toBeUndefined();
    saveDraft(a, { ...record, guid: "99999999-2222-3333-4444-555555555555" }, "alice", new Date("2026-10-21T10:00:00Z"));
    expect(findDraft(a.state, ["i1", "i2"])?.guid).toBe("99999999-2222-3333-4444-555555555555");
  });
});
