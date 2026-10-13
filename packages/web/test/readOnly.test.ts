import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const guard = readFileSync(new URL("../src/readOnly.ts", import.meta.url), "utf8");

/** The year Excel owns must be drawn by the ledger's own screens and then made read-only; see packages/web/src/readOnly.ts. */
describe("the Excel year mirrors the ledger view, read-only", () => {
  const branch = main.slice(main.indexOf("const l = workspace?.legacy;"), main.indexOf("const body = onboarding ?"));

  it("draws the ledger's own screens and then strips every action control", () => {
    expect(branch).toContain("purchaseView(");
    expect(branch).toContain("queueView()");
    expect(branch).toContain("summaryView()");
    expect(branch).toContain("statementsView()");
    expect(branch).toMatch(/innerHTML = [^;]+;\s*enforceReadOnly\(root\)/);
  });

  it("has no separate Excel-only screens to drift from the ledger's", () => {
    expect(main).not.toMatch(/legacy(Queue|Purchase|Statements|Summary)View|legacyTabs/);
  });

  it("keeps only viewing controls", () => {
    const keep = guard.slice(guard.indexOf("READ_ONLY_KEEP = ["), guard.indexOf('].join(",")'));
    for (const action of ["archive", "unarchive", "ready", "link", "upload", "rename", "dup", "edit", "remove", "read", "attach", "start", "use", "replace"]) {
      expect(keep, `a control for "${action}" must not be allowed through`).not.toMatch(new RegExp(`data-${action}[\\]-]`));
    }
  });
});
