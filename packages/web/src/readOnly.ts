/**
 * The read-only guarantee for a year viewed from Excel. The Excel year is drawn by the same screens as a ledger year, so
 * it looks the same; this is what makes it read-only. Whatever a screen draws, only looking around is kept: moving
 * between screens, previewing a file, filtering and pivoting, and refreshing or downloading what was read. Every other
 * button, file chooser and form field is removed or disabled, so a control added to a ledger screen later is read-only in
 * the Excel view without anyone having to remember. To let a new viewing control through, add it to READ_ONLY_KEEP.
 */
export const READ_ONLY_KEEP = [
  "[data-go]", "[data-open]", "[data-statement]", "[data-preview]", "[data-preview-proof]", "[data-pcell]", "[data-pivot-reset]", "[data-drill-clear]",
  "[data-clear='legacy-search']", "#legacy-refresh", "#legacy-download", "#close-preview", "[data-pivot]", "[id^='legacy-']", ".preview a", "header *",
].join(",");

export function enforceReadOnly(scope: ParentNode): void {
  for (const el of scope.querySelectorAll("button, label.btn, input[type=file], .danger-zone")) if (!el.matches(READ_ONLY_KEEP)) el.remove();
  for (const el of scope.querySelectorAll<HTMLInputElement>("input, select, textarea")) {
    if (el.matches(READ_ONLY_KEEP) || el.closest(".preview, header")) continue;
    el.disabled = true;
  }
  // Wrappers that held only controls would otherwise be left as empty boxes and orphaned headings.
  for (let pass = 0; pass < 3; pass++) {
    for (const el of scope.querySelectorAll("p, div.actions, span.actions, div.assist, details:not(.panel)")) {
      const rest = [...el.childNodes].filter((n) => !(n instanceof HTMLElement && n.tagName === "SUMMARY"));
      if (!rest.some((n) => (n.textContent ?? "").trim() || (n instanceof HTMLElement && n.matches("img, input, select, ul, table")))) el.remove();
    }
  }
}
