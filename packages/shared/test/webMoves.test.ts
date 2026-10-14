import { describe, expect, it } from "vitest";
import {
  HlcClock,
  Ledger,
  MemoryBackend,
  MemoryEventStore,
  MemoryProvider,
  archiveStepUpList,
  crc32,
  ensureLedgerFolders,
  listYears,
  readStepUpIndex,
  readStepUpYear,
  resultsFromSavedList,
  verifyFiles,
  zipBackup,
  zipStore,
  type StepUpTarget,
} from "../src/index.js";

const raw = (number: number, year = "2025-2026", status = "Submitted") => ({
  Id: `guid-${number}`,
  SequenceNumber: number,
  SchoolYear: year,
  ExternalStatus: "Complete",
  StudentName: "Child A",
  LineItems: [{ LineItemNumber: `${number}-1`, ExternalStatus: status, Appealed: false, ItemAmount: 12.5 }],
});

/** Reads the end-of-central-directory record: how many entries and where the directory starts. */
function zipEntries(bytes: Uint8Array): Array<{ name: string; data: Uint8Array }> {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.length - 22;
  expect(v.getUint32(end, true)).toBe(0x06054b50);
  const count = v.getUint16(end + 10, true);
  let p = v.getUint32(end + 16, true);
  const out: Array<{ name: string; data: Uint8Array }> = [];
  for (let i = 0; i < count; i++) {
    expect(v.getUint32(p, true)).toBe(0x02014b50);
    const crc = v.getUint32(p + 16, true);
    const size = v.getUint32(p + 24, true);
    const nameLen = v.getUint16(p + 28, true);
    const local = v.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    const dataAt = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    const data = bytes.subarray(dataAt, dataAt + size);
    expect(crc32(data)).toBe(crc);
    out.push({ name, data });
    p += 46 + nameLen;
  }
  return out;
}

describe("zipStore", () => {
  it("writes an archive that reads back, with names and bytes intact", async () => {
    const blob = await zipStore([
      { name: "a.txt", data: new TextEncoder().encode("hello") },
      { name: "events/ünï.jsonl", data: new Blob(["line1\nline2\n"]) },
      { name: "empty", data: new Uint8Array() },
    ]);
    const entries = zipEntries(new Uint8Array(await blob.arrayBuffer()));
    expect(entries.map((e) => e.name)).toEqual(["a.txt", "events/ünï.jsonl", "empty"]);
    expect(new TextDecoder().decode(entries[0]!.data)).toBe("hello");
    expect(new TextDecoder().decode(entries[1]!.data)).toBe("line1\nline2\n");
  });

  it("has the standard CRC-32 of '123456789'", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });
});

describe("resultsFromSavedList", () => {
  it("accepts StepUp's response, a bare array, the CLI capture file and a single saved reimbursement", () => {
    expect(resultsFromSavedList(JSON.stringify({ Results: [raw(1), raw(2)] }))).toHaveLength(2);
    expect(resultsFromSavedList(JSON.stringify([raw(1)]))).toHaveLength(1);
    expect(resultsFromSavedList(JSON.stringify({ a: { capturedAt: "x", result: raw(1) }, b: { capturedAt: "x", result: raw(2) } }))).toHaveLength(2);
    expect(resultsFromSavedList(JSON.stringify({ seenAt: "x", result: raw(1) }))).toHaveLength(1);
  });
  it("says so when there is nothing in the file", () => {
    expect(() => resultsFromSavedList("not json")).toThrow(/not JSON/);
    expect(() => resultsFromSavedList("{}")).toThrow(/No StepUp reimbursements/);
  });
});

describe("archiveStepUpList", () => {
  const setup = async () => {
    const storage = new MemoryProvider();
    const driveId = "memory";
    const rootId = storage.rootId;
    const target: StepUpTarget = { storage, driveId, rootId };
    return { storage, driveId, rootId, target };
  };

  it("writes each reimbursement to its own year (creating the folder) and skips what has not changed", async () => {
    const { storage, driveId, rootId, target } = await setup();
    const first = await archiveStepUpList(target, [raw(1), raw(2), raw(3, "2024-2025")]);
    expect(first.listed).toBe(3);
    expect(first.changed).toBe(3);
    expect(first.years.map((y) => [y.label, y.created])).toEqual([["2024-2025", true], ["2025-2026", true]]);

    const years = await listYears(storage, driveId, rootId);
    const y = years.find((x) => x.label === "2025-2026")!;
    const kept = await readStepUpYear(storage, driveId, y.folderId);
    expect(kept.reimbursements.map((r) => r.number)).toEqual([1, 2]);

    // The same list again changes nothing; one changed status rewrites just that file.
    const again = await archiveStepUpList({ storage, driveId, rootId }, [raw(1), raw(2), raw(3, "2024-2025")]);
    expect(again.changed).toBe(0);
    const edit = await archiveStepUpList({ storage, driveId, rootId }, [raw(1), raw(2, "2025-2026", "Paid"), raw(3, "2024-2025")]);
    expect(edit.changed).toBe(1);
    const index = await readStepUpIndex(storage, driveId, (await storage.find(driveId, y.folderId, "_stepup"))!.id);
    expect(index?.index.reimbursements.find((r) => r.number === 2)?.lines[0]?.status).toBe("Paid");
  });

  it("does nothing for an empty list", async () => {
    const { target } = await setup();
    expect(await archiveStepUpList(target, [])).toEqual({ listed: 0, changed: 0, years: [] });
  });
});

describe("zipBackup and verifyFiles", () => {
  it("backs up a ledger year's logs and documents with a manifest, and checks the files", async () => {
    const storage = new MemoryProvider();
    const driveId = "memory";
    const yearId = await storage.ensureFolder(driveId, storage.rootId, "2026-2027");
    const folders = await ensureLedgerFolders(storage, driveId, yearId);
    await storage.write(driveId, folders.eventsId, "dev.jsonl", '{"id":"e1"}\n');
    const doc = await storage.write(driveId, folders.documentsId, "receipt.pdf", new Uint8Array([1, 2, 3]));

    const ledger = new Ledger(new MemoryEventStore(new MemoryBackend(), "dev"), new HlcClock("dev"), "t");
    ledger.set("document", "d1", { filename: "receipt.pdf", driveItemId: doc.id, sizeBytes: 3, sha256: "00" });

    const plain = await zipBackup(storage, driveId, yearId, "2026-2027", ledger.state);
    expect(plain.manifest.files.map((f) => f.path)).toEqual(["events/dev.jsonl"]);
    const withDocs = await zipBackup(storage, driveId, yearId, "2026-2027", ledger.state, { documents: true });
    const names = zipEntries(new Uint8Array(await withDocs.blob.arrayBuffer())).map((e) => e.name);
    expect(names).toEqual(["events/dev.jsonl", "documents/receipt.pdf", "manifest.json"]);

    // Present and the right size passes; a wrong recorded hash is an error; a missing file is an error.
    expect(await verifyFiles(storage, driveId, ledger.state)).toEqual([]);
    expect((await verifyFiles(storage, driveId, ledger.state, { hash: true })).map((f) => f.code)).toEqual(["file-contents-changed"]);
    ledger.set("document", "d2", { filename: "gone.pdf", driveItemId: "nope" });
    expect((await verifyFiles(storage, driveId, ledger.state)).map((f) => f.code)).toContain("file-missing-in-onedrive");
  });
});
