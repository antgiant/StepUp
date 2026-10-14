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

  it("lets a person leave an Excel year and use the StepUp bookmarklet from it", () => {
    // These controls are drawn outside <header>, so the guard would otherwise disable or remove them.
    const keep = guard.slice(guard.indexOf("READ_ONLY_KEEP = ["), guard.indexOf('].join(",")'));
    for (const id of ["year-pick", "dismiss-status", "reload-app", "show-bookmarklet", "copy-bookmarklet", "close-bookmarklet", "stepup-apply", "stepup-ignore", "stepup-result-close"]) {
      expect(keep, `#${id} must stay usable in the Excel view`).toContain(`#${id}`);
    }
    // ...and each of them is allowed through the Excel view's click filter.
    for (const id of ["show-bookmarklet", "close-bookmarklet", "copy-bookmarklet", "stepup-apply", "stepup-ignore", "stepup-result-close"]) {
      expect(main, `#${id} must be reachable from the Excel view`).toContain(`t.id === "${id}"`);
    }
    expect(keep).toContain("[data-stepup-year]");
    // The Excel view's Advanced menu offers the bookmarklet.
    expect(main).toMatch(/legacy-download">Download as a spreadsheet<\/button><button id="show-bookmarklet"/);
  });

  it("keeps only viewing controls", () => {
    const keep = guard.slice(guard.indexOf("READ_ONLY_KEEP = ["), guard.indexOf('].join(",")'));
    for (const action of ["archive", "unarchive", "ready", "link", "upload", "rename", "dup", "edit", "remove", "read", "attach", "start", "use", "replace"]) {
      expect(keep, `a control for "${action}" must not be allowed through`).not.toMatch(new RegExp(`data-${action}[\\]-]`));
    }
  });
});
