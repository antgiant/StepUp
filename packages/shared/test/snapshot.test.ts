import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configureGraph, diffReference, ensureFolder, mergeReference, readYearSnapshot, referenceHash, resolveReference, setTokenProvider, validateCategoryReference, writeYearSnapshot, type CategoryReference, type ReferenceNode } from "../src/index.js";
import { FakeGraph } from "./fakeGraph.js";

const node = (id: string, name: string, extra: Partial<ReferenceNode> = {}): ReferenceNode => ({ id, name, isActive: true, eligibleScholarships: [], requiresServiceDate: false, ...extra });
const file = (version: number, categories: ReferenceNode[]): CategoryReference => ({ schemaVersion: 1, version, hash: referenceHash(categories), categories });

describe("reference snapshot", () => {
  const snap = file(1, [node("c1", "Curriculum"), node("c2", "Old thing"), node("t1", "Books", { parentId: "c1" })]);
  const latest = file(2, [node("c1", "Curriculum", { eligibleScholarships: ["FES-UA"] }), node("t1", "Books and Workbooks", { parentId: "c1" }), node("c3", "Software")]);

  it("describes what changed upstream", () => {
    const d = diffReference(snap, latest);
    expect(d.newer).toBe(true);
    expect(d.added.map((n) => n.id)).toEqual(["c3"]);
    expect(d.removed.map((n) => n.id)).toEqual(["c2"]);
    expect(d.changed).toEqual([{ id: "c1", name: "Curriculum", what: ["eligibility"] }, { id: "t1", name: "Books and Workbooks", what: ["name"] }]);
    expect(diffReference(latest, latest)).toMatchObject({ added: [], changed: [], removed: [], newer: false });
  });

  it("merging keeps what the year already uses: removed entries stay (inactive), nothing is lost, the result is valid", () => {
    const merged = mergeReference(snap, latest);
    expect(validateCategoryReference(merged)).toEqual([]);
    expect(merged.version).toBe(2);
    const r = resolveReference(merged);
    expect(r.category("c2")).toMatchObject({ isActive: false, path: ["Old thing"] });
    expect(r.category("t1")?.path).toEqual(["Curriculum", "Books and Workbooks"]);
    expect(r.category("c3")?.isActive).toBe(true);
    expect(r.choices.map((c) => c.label)).not.toContain("Old thing");
  });
});

describe("year snapshot file", () => {
  let g: FakeGraph;
  beforeEach(() => {
    g = new FakeGraph();
    setTokenProvider(async () => "t");
    configureGraph({ fetch: g.fetch as typeof fetch, sleep: async () => undefined, maxRetries: 0 });
  });
  afterEach(() => configureGraph());

  it("is written once (create-only) and read back; a second device's write does not overwrite it", async () => {
    const dir = await ensureFolder("d", g.rootId, "_ledger");
    expect(await readYearSnapshot("d", dir)).toBeUndefined();
    const a = file(1, [node("c1", "Curriculum")]);
    await writeYearSnapshot("d", dir, a);
    await writeYearSnapshot("d", dir, file(5, [node("x", "Other")])); // loses quietly
    expect((await readYearSnapshot("d", dir))?.version).toBe(1);
    await writeYearSnapshot("d", dir, file(2, [node("c1", "Curriculum")]), true); // an explicit update replaces
    expect((await readYearSnapshot("d", dir))?.version).toBe(2);
  });

  it("an invalid file is ignored rather than trusted", async () => {
    const dir = await ensureFolder("d", g.rootId, "_ledger");
    g.add(dir, "reference.snapshot.json", false, new TextEncoder().encode('{"nope":1}'));
    expect(await readYearSnapshot("d", dir)).toBeUndefined();
  });
});
