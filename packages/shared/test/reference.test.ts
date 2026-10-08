import { describe, expect, it } from "vitest";
import committed from "../../web/public/reference/categories.json";
import { categoryIdForPath, referenceHash, resolveReference, validateCategoryReference, type CategoryReference, type ReferenceNode } from "../src/index.js";

const node = (id: string, name: string, extra: Partial<ReferenceNode> = {}): ReferenceNode => ({ id, name, isActive: true, eligibleScholarships: [], requiresServiceDate: false, ...extra });
const file = (categories: ReferenceNode[]): CategoryReference => ({ schemaVersion: 1, version: 1, hash: referenceHash(categories), categories });

const tree = [
  node("c1", "Curriculum", { eligibleScholarships: ["FES-UA"] }),
  node("t1", "Books", { parentId: "c1" }),
  node("t2", "Old", { parentId: "c1", isActive: false }),
  node("c2", "Services", { requiresServiceDate: true }),
];

describe("category reference", () => {
  it("the committed file is valid", () => {
    expect(validateCategoryReference(committed)).toEqual([]);
  });

  it("rejects unknown fields, bad parents, loops and a stale hash", () => {
    expect(validateCategoryReference(file(tree))).toEqual([]);
    expect(validateCategoryReference({ ...file(tree), extra: 1 })).toEqual(['Unknown field "extra"']);
    const withSecret = file([{ ...node("c1", "A"), cardNumber: "1234" } as ReferenceNode]);
    expect(validateCategoryReference(withSecret).join()).toContain('unknown field "cardNumber"');
    expect(validateCategoryReference(file([node("a", "A", { parentId: "zzz" })])).join()).toContain("does not exist");
    expect(validateCategoryReference(file([node("a", "A", { parentId: "b" }), node("b", "B", { parentId: "a" })])).join()).toContain("loop");
    expect(validateCategoryReference({ ...file(tree), hash: "nope" }).join()).toContain("hash");
  });

  it("resolves paths, inherited eligibility, activity and picker choices", () => {
    const r = resolveReference(file(tree));
    expect(r.category("t1")).toMatchObject({ path: ["Curriculum", "Books"], eligibleScholarships: ["FES-UA"], isActive: true, requiresServiceDate: false });
    expect(r.category("t2")?.isActive).toBe(false);
    expect(r.category("c2")?.requiresServiceDate).toBe(true);
    expect(r.category("nope")).toBeUndefined();
    expect(r.choices.map((c) => c.label)).toEqual(["Curriculum - Books", "Services"]); // c1 has an active child; t2 is inactive
    expect(r.idForLabel("curriculum - books")).toBe("t1");
    expect(r.idForLabel("Curriculum")).toBe("c1");
  });

  it("still resolves the ids older imports gave to a path", () => {
    const r = resolveReference(file(tree));
    expect(categoryIdForPath(["Curriculum", "Books"])).toBe("legacy-cat-curriculum-books");
    expect(r.category("legacy-cat-curriculum-books")?.id).toBe("t1");
  });
});
