import { describe, expect, it } from "vitest";
import {
  categorySyncEdits,
  emptyCategoryCache,
  matchStudentsToChildren,
  mergeCategorySearch,
  mergeDetails,
  mergeTypes,
  mergeVendors,
  nodesFromCategoryCache,
  parseBalances,
  parseStudents,
  sanitizeBalances,
  sanitizeStudents,
  stepUpDrafts,
  studentNameCandidates,
  type ReferenceNode,
  type StepUpReimbursement,
} from "../src/index.js";

const search = {
  Results: [
    { Id: "c-test", Name: "Testing", Types: ["t1"], IsActive: true, IsDeleted: false, RequiresServiceDate: true, RequiresVendor: false, IsTaxable: true, ApprovedPrograms: [{ PartnerId: "24" }] },
    { Id: "c-book", Name: "Books", Types: [], IsActive: true, IsDeleted: false, RequiresServiceDate: false },
  ],
};

describe("category rules StepUp reports", () => {
  it("keeps the flags on categories, types and details, in either spelling", () => {
    const c = emptyCategoryCache();
    mergeCategorySearch(c, search);
    mergeTypes(c, [{ id: "t1", name: "Type", isActive: true, isDeleted: false, details: ["d1"], requiresServiceDate: null, requiresVendor: true }]);
    mergeDetails(c, [{ id: "d1", name: "Detail", isActive: true, isDeleted: false, requiresServiceDate: true }]);
    expect(c.categories["c-test"]).toMatchObject({ requiresServiceDate: true, requiresVendor: false, isTaxable: true });
    expect(c.types["t1"]).toMatchObject({ requiresServiceDate: null, requiresVendor: true });
    expect(c.details["d1"]!.requiresServiceDate).toBe(true);
  });

  it("only ever raises a service-date requirement, and only when StepUp says it is required", () => {
    const c = emptyCategoryCache();
    mergeCategorySearch(c, search);
    mergeTypes(c, [{ id: "t1", name: "Type", isActive: true, isDeleted: false, requiresServiceDate: null }]);
    const observed = nodesFromCategoryCache(c);
    const base: ReferenceNode[] = [
      { id: "c-test", name: "Testing", isActive: true, eligibleScholarships: [], requiresServiceDate: false },
      // ours is stricter than StepUp's `false`: it must stay as the maintainers set it
      { id: "c-book", name: "Books", isActive: true, eligibleScholarships: [], requiresServiceDate: true },
      { id: "t1", parentId: "c-test", name: "Type", isActive: true, eligibleScholarships: [], requiresServiceDate: false },
    ];
    const edits = categorySyncEdits(base, {}, observed);
    expect(edits.find((e) => e.id === "c-test")).toMatchObject({ requiresServiceDate: true });
    expect(edits.find((e) => e.id === "c-book")).toBeUndefined();
    expect(edits.find((e) => e.id === "t1")).toBeUndefined();
    // Once recorded, a repeat finds nothing to do.
    const again = categorySyncEdits(base, { "c-test": { id: "c-test", requiresServiceDate: true } }, observed);
    expect(again.find((e) => e.id === "c-test")?.requiresServiceDate).toBeUndefined();
  });
});

describe("students and balances", () => {
  const raw = [
    { sequenceNumber: 1001, id: "s-1", firstName: "Alex", lastName: "Sample", middleName: "Q", dob: "2012-01-01", isActive: true, scholarships: [{ name: "FES-UA" }, { nothing: 1 }], renewalPrograms: [{ programName: "FTC" }] },
    { sequenceNumber: 1002, id: "s-2", firstName: "Bo", lastName: "Sample", isActive: false, scholarships: [] },
    { id: "no-seq", firstName: "X", lastName: "Y" },
  ];

  it("keeps only the fields the app needs: no birth date, no school", () => {
    const s = parseStudents(raw);
    expect(s).toHaveLength(2);
    expect(s[0]).toEqual({ sequenceNumber: 1001, id: "s-1", firstName: "Alex", lastName: "Sample", middleName: "Q", isActive: true, programs: ["FES-UA", "FTC"], scholarships: [{ program: "FES-UA" }] });
    expect(JSON.stringify(s)).not.toContain("2012");
  });

  it("reads each scholarship's program, year, status and award and funded amounts", () => {
    const [st] = parseStudents([{ sequenceNumber: 1, id: "s", firstName: "A", lastName: "B", scholarships: [
      { programName: "FES-UA", programYear: "2026-2027", status: "Funded", awardAmount: 7000.5, fundedAmount: 7000.5, studentId: "x" },
      { programName: "FTC", programYear: "2025-2026", status: "Renewed", awardAmount: 5000 },
      { nothing: true },
    ] }]);
    expect(st!.scholarships).toEqual([
      { program: "FES-UA", year: "2026-2027", status: "Funded", awardCents: 700050, fundedCents: 700050 },
      { program: "FTC", year: "2025-2026", status: "Renewed", awardCents: 500000 },
    ]);
    expect(sanitizeStudents([st])[0]!.scholarships).toEqual(st!.scholarships);
  });

  it("reads balances keyed by student, in cents", () => {
    const b = parseBalances({ "1001": [{ ProgramAlias: "FES-UA", ProgramType: 2, Funding: 1000.5, Spending: 200, Reserved: 50.25, Available: 750.25, Adjustments: -10 }, { nope: 1 }], notANumber: [], "1002": "x" });
    expect(Object.keys(b)).toEqual(["1001"]);
    expect(b["1001"]).toEqual([{ program: "FES-UA", programType: 2, fundingCents: 100050, spendingCents: 20000, reservedCents: 5025, availableCents: 75025, adjustmentsCents: -1000 }]);
  });

  it("sanitises what the page sends the app", () => {
    expect(sanitizeStudents([{ sequenceNumber: 1, id: "a", firstName: "A", lastName: "B", programs: ["x", 5] }, "junk", { sequenceNumber: "1" }])).toEqual([
      { sequenceNumber: 1, id: "a", firstName: "A", lastName: "B", programs: ["x"] },
    ]);
    expect(sanitizeBalances({ "1": [{ program: "P", fundingCents: 5.4, spendingCents: "x" }], bad: [] })).toEqual({
      "1": [{ program: "P", fundingCents: 5, spendingCents: 0, reservedCents: 0, availableCents: 0, adjustmentsCents: 0 }],
    });
  });

  it("matches students to the ledger's children by name, however the child was named", () => {
    const students = parseStudents(raw);
    const m = matchStudentsToChildren(students, [{ id: "child-alex-sample", name: "alex  SAMPLE" }, { id: "child-bo", name: "Bo" }, { id: "other", name: "Someone" }]);
    expect(m.get(1001)).toBe("child-alex-sample");
    expect(m.get(1002)).toBe("child-bo");
    expect(studentNameCandidates({ firstName: "Alex", lastName: "Sample", middleName: "Q" })[0]).toBe("alex q sample");
  });
});

describe("providers from either endpoint", () => {
  it("uses the DBA name when there is one, else the name, and reports only what is new", () => {
    const cache: Record<string, import("../src/index.js").VendorEntry> = {};
    const body = { Results: [{ Id: "1", Name: "Legal One", DBAName: null }, { Id: "2", Name: "Legal Two", DBAName: "Shop Two" }, { Id: "3", BusinessProfileId: "bp", DBAName: "Old Style" }, { Id: "4" }] };
    expect(mergeVendors(cache, body, []).map((v) => v.name)).toEqual(["Legal One", "Shop Two", "Old Style"]);
    expect(mergeVendors(cache, body, [])).toEqual([]);
    expect(cache["3"]!.businessProfileId).toBe("bp");
  });
});

describe("unfinished drafts", () => {
  const r = (number: number, over: Partial<StepUpReimbursement>): StepUpReimbursement => ({ id: `g${number}`, number, schoolYear: "2026-2027", status: "Submitted", submittedAt: "2026-09-01", receipts: [], lines: [], ...over });
  it("lists what was started and never submitted, newest first, and not what was cancelled", () => {
    const list = [r(1, {}), r(2, { status: "Draft", submittedAt: undefined }), r(3, { status: "Incomplete" }), r(4, { status: "Canceled", submittedAt: undefined }), r(5, { submittedAt: undefined })];
    expect(stepUpDrafts(list).map((x) => x.number)).toEqual([5, 3, 2]);
  });
});
