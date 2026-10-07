/** Workbook layout and parsing rules shared by the CLI automator and the web entry portal. */

export const TABLE1 = "Table1";
export const CHILDREN_TABLE = "Table2";
export const CATEGORIES_TABLE = "Table5";
export const INCLUDE_PATH_TABLE = "Table9";
export const WORKSHEET = "FES UA Tracking Spreadsheet";
export const STATUS_UNFILED = "Unfiled (Ready to Submit)";
export const DOC_FILE_COLUMNS = [1, 2, 3, 4, 5, 6].map((n) => `Documentation File ${n}`);

/**
 * Excel's "Category" column stores a cascading dropdown selection as one string, e.g.
 * "Bob - Smith" means: pick "Bob" in the first dropdown, then "Smith" in the second
 * dropdown that appears once "Bob" is selected (StepUp's category picker can be
 * more than two levels deep, so this splits on every " - " occurrence).
 */
export function parseCategoryLevels(category: string): string[] {
  return category
    .split(" - ")
    .map((level) => level.trim())
    .filter((level) => level.length > 0);
}

/** Loosely compares a Table2-style label ("FES-UA") against a resolved display name, ignoring punctuation/case. */
export function scholarshipNamesMatch(a: string, b: string): boolean {
  const normalize = (s: string) => s.replace(/[^a-z0-9]/gi, "").toUpperCase();
  return normalize(a) === normalize(b);
}
