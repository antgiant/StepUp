import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  getTableHeaderRow,
  getTableRows,
  getUsedRange,
  type DriveItemRef,
} from "./graph/onedrive.js";
import {
  TABLE1,
  CHILDREN_TABLE,
  CATEGORIES_TABLE,
  INCLUDE_PATH_TABLE,
  WORKSHEET,
  STATUS_UNFILED,
  DOC_FILE_COLUMNS,
  parseCategoryLevels,
  scholarshipNamesMatch,
} from "@step-up/shared";

export { parseCategoryLevels };

const RECEIPT_KEYWORDS = ["invoice", "order", "receipt"];
const RECEIPT_CHOICE_CACHE_FILE = path.resolve(process.cwd(), ".cache", "receipt-choice-cache.json");

/** Persisted across process restarts, keyed by the sorted candidate file set — same shape as the
 *  in-memory cache buildGroups() already kept, just backed by disk so a crash/restart mid-run
 *  (which this project has needed a lot of) doesn't force re-answering every prompt from scratch. */
async function loadReceiptChoiceCache(): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(RECEIPT_CHOICE_CACHE_FILE, "utf-8"));
  } catch {
    return {};
  }
}

async function saveReceiptChoiceCache(cache: Record<string, string>): Promise<void> {
  await mkdir(path.dirname(RECEIPT_CHOICE_CACHE_FILE), { recursive: true });
  await writeFile(RECEIPT_CHOICE_CACHE_FILE, JSON.stringify(cache, null, 2), "utf-8");
}

export interface Table1Row {
  /** 0-based index within Table1 — needed for write-back via updateTableRowByIndex. */
  rowIndex: number;
  /** All of Table1's own columns, keyed by header name. */
  data: Record<string, string>;
  /** The row's raw cell values in column order — needed as updateTableRowByIndex's currentValues. */
  rawValues: unknown[];
  /** Non-blank values from Documentation File 1-6 (columns live outside Table1's own range). */
  documentationFiles: string[];
}

/**
 * Everything downstream (findFile() in main.ts, etc.) matches Documentation File 1-6 values
 * against OneDrive folder item names by exact string equality, which only works if those cells
 * hold bare filenames. "Include Path" (Table9) is a legacy flag from a Windows-based tool that,
 * if ever flipped to true, would make Excel populate those cells with full local paths instead
 * — silently breaking every file match. Fail loudly here rather than have that happen quietly.
 */
async function assertIncludePathIsOff(excelRef: DriveItemRef): Promise<void> {
  const rows = await getTableRows(excelRef, INCLUDE_PATH_TABLE);
  const raw = String(rows[0]?.[0] ?? "").trim().toLowerCase();
  if (raw === "true") {
    throw new Error(
      `${INCLUDE_PATH_TABLE} ("Include Path") is set to true. Documentation File columns would contain full paths ` +
        `instead of bare filenames, which breaks file matching against the OneDrive folder — set it back to false before running this.`
    );
  }
}

/** Loads every Table1 row whose Status is "Unfiled (Ready to Submit)", including its documentation filenames. */
export async function loadUnfiledRows(excelRef: DriveItemRef): Promise<Table1Row[]> {
  await assertIncludePathIsOff(excelRef);

  const headers = await getTableHeaderRow(excelRef, TABLE1);
  const rows = await getTableRows(excelRef, TABLE1);
  const { headers: wsHeaders, rows: wsRows } = await getUsedRange(excelRef, WORKSHEET);

  if (rows.length !== wsRows.length) {
    throw new Error(
      `Table1 has ${rows.length} data row(s) but the "${WORKSHEET}" worksheet's used range has ${wsRows.length}. ` +
        `They're expected to be row-aligned (Documentation File columns sit just to the right of Table1) — ` +
        `bail out rather than risk matching a row to the wrong documentation files.`
    );
  }

  const statusIdx = headers.indexOf("Status");
  if (statusIdx === -1) {
    throw new Error(`"Status" column not found in ${TABLE1}. Columns: ${headers.join(", ")}`);
  }

  if (!headers.some((h) => /service/i.test(h) && /date/i.test(h))) {
    console.warn(`Warning: no Service Date column found in ${TABLE1}. Columns: ${headers.join(", ")}`);
  }

  const docFileIndexes = DOC_FILE_COLUMNS.map((name) => wsHeaders.indexOf(name)).filter((i) => i !== -1);
  if (docFileIndexes.length !== DOC_FILE_COLUMNS.length) {
    const missing = DOC_FILE_COLUMNS.filter((name) => !wsHeaders.includes(name));
    console.warn(`Warning: expected columns not found on "${WORKSHEET}": ${missing.join(", ")}`);
  }

  const result: Table1Row[] = [];
  rows.forEach((values, rowIndex) => {
    const status = String(values[statusIdx] ?? "").trim();
    if (status !== STATUS_UNFILED) return;

    const data: Record<string, string> = {};
    headers.forEach((h, i) => {
      data[h] = values[i] === undefined || values[i] === null ? "" : String(values[i]);
    });

    // Tolerate a slightly different header ("Service Date ", "Date of Service", ...) by aliasing it.
    if (!data["Service Date"]?.trim()) {
      const key = headers.find((h) => h !== "Service Date" && /service/i.test(h) && /date/i.test(h) && data[h]?.trim());
      if (key) data["Service Date"] = data[key];
    }

    const wsRow = wsRows[rowIndex];
    const documentationFiles = docFileIndexes
      .map((i) => wsRow[i])
      .filter((v): v is string => typeof v === "string" && v.trim() !== "")
      .map((v) => v.trim());

    result.push({ rowIndex, data, rawValues: values, documentationFiles });
  });

  return result;
}

/**
 * Called when a row has multiple documentation files and none/more-than-one look like the main
 * receipt. Returns one of `candidates`, or `null` if none of them are actually right (e.g. the
 * documentation itself is wrong) — the resolver is expected to have already recorded that
 * (a Notes/Status update) before returning null; the row is then excluded from grouping entirely.
 */
export type ResolveAmbiguousMainReceipt = (row: Table1Row, candidates: string[]) => Promise<string | null>;

/**
 * Picks the file that should be uploaded first (triggers StepUp's OCR item-detection) for a row:
 * the only file if there's just one, or the one whose name contains "invoice"/"order"/"receipt"
 * if that's unambiguous. Otherwise defers to `resolveAmbiguous` (interactive prompt).
 */
export async function determineMainReceipt(
  row: Table1Row,
  resolveAmbiguous: ResolveAmbiguousMainReceipt
): Promise<string | null> {
  const files = row.documentationFiles;
  if (files.length === 0) {
    throw new Error(`Row ID ${row.data["ID"]} (${row.data["Item"]}) has no documentation files listed.`);
  }
  if (files.length === 1) return files[0];

  const keywordMatches = files.filter((f) => RECEIPT_KEYWORDS.some((k) => f.toLowerCase().includes(k)));
  if (keywordMatches.length === 1) return keywordMatches[0];

  return resolveAmbiguous(row, files);
}

export interface ReimbursementGroup {
  child: string;
  mainReceiptFile: string;
  rows: Table1Row[];
  /** Every other documentation file + resolved payment-proof file across all rows in the group, deduplicated. */
  additionalFiles: string[];
}

/**
 * Groups unfiled rows into one-per-StepUp-submission units: rows sharing the same child, vendor and
 * main receipt file get submitted together (matching how one uploaded receipt can cover several
 * line items). Rows from different vendors are never grouped.
 */
export async function buildGroups(
  rows: Table1Row[],
  resolveAmbiguous: ResolveAmbiguousMainReceipt
): Promise<ReimbursementGroup[]> {
  const groups = new Map<string, ReimbursementGroup>();
  const ambiguousAnswerCache = await loadReceiptChoiceCache();
  const cachedResolveAmbiguous: ResolveAmbiguousMainReceipt = async (row, candidates) => {
    const cacheKey = [...candidates].sort().join(" ");
    const cached = ambiguousAnswerCache[cacheKey];
    if (cached) return cached;
    const answer = await resolveAmbiguous(row, candidates);
    // Never cache a "none of these are right" (null) answer — each row with an identical
    // candidate set still needs its own Notes/Status update from the resolver, not just the
    // first one to hit this candidate set. Persisted to disk (not just in-memory) so a crash or
    // restart mid-run doesn't force re-answering every prompt already resolved this session.
    if (answer) {
      ambiguousAnswerCache[cacheKey] = answer;
      await saveReceiptChoiceCache(ambiguousAnswerCache);
    }
    return answer;
  };

  for (const row of rows) {
    if (row.documentationFiles.length === 0) {
      console.warn(`Skipping row ID ${row.data["ID"]} (${row.data["Item"]}): no documentation files listed.`);
      continue;
    }
    const mainReceipt = await determineMainReceipt(row, cachedResolveAmbiguous);
    if (mainReceipt === null) continue; // flagged as unresolvable; already recorded in the spreadsheet
    const child = row.data["Child"] ?? "";
    // Transactions from different vendors must never share a submission, even with the same
    // child and receipt file.
    const vendor = (row.data["Service Provider"] || row.data["Vendor"] || "").trim().toLowerCase();
    const key = `${child}::${mainReceipt}::${vendor}`;

    let group = groups.get(key);
    if (!group) {
      group = { child, mainReceiptFile: mainReceipt, rows: [], additionalFiles: [] };
      groups.set(key, group);
    }
    group.rows.push(row);

    for (const f of row.documentationFiles) {
      if (f !== mainReceipt && !group.additionalFiles.includes(f)) group.additionalFiles.push(f);
    }

    const paymentFile = (row.data["Payment File"] ?? "").trim();
    if (paymentFile && !group.additionalFiles.includes(paymentFile)) {
      group.additionalFiles.push(paymentFile);
    }
  }

  // A receipt belongs to one vendor; the same main receipt under several vendors means a data
  // entry mistake (wrong vendor or wrong file), and each vendor ends up in its own group.
  const vendorsByReceipt = new Map<string, Set<string>>();
  for (const g of groups.values()) {
    for (const r of g.rows) {
      const v = (r.data["Service Provider"] || r.data["Vendor"] || "").trim();
      const set = vendorsByReceipt.get(g.mainReceiptFile) ?? new Set<string>();
      set.add(v || "(blank)");
      vendorsByReceipt.set(g.mainReceiptFile, set);
    }
  }
  for (const [file, vendors] of vendorsByReceipt) {
    if (vendors.size > 1) {
      console.warn(
        `Warning: receipt "${file}" is used by multiple vendors (${[...vendors].join(", ")}). ` +
          `Receipt files should be unique to a vendor — check the spreadsheet.`
      );
    }
  }

  return Array.from(groups.values());
}

export interface ScholarshipMismatch {
  row: Table1Row;
  child: string;
  category: string;
  childScholarship: string;
  eligibleScholarships: string[];
}

/**
 * Cross-checks each row's chosen Category against its child's Scholarship (Table2), using
 * eligibility data Table5's "Eligible Scholarships" column has accumulated via categorySync.ts.
 * Only flags a real mismatch — rows where either side's data isn't known yet are skipped
 * silently, since Table5 fills in gradually as categories get touched by real submissions.
 * Advisory only: never blocks or mutates anything, just surfaces what StepUp itself would
 * otherwise reject only after the form is already filled out.
 */
export async function checkScholarshipEligibility(
  excelRef: DriveItemRef,
  rows: Table1Row[]
): Promise<ScholarshipMismatch[]> {
  const childRows = await getTableRows(excelRef, CHILDREN_TABLE);
  const scholarshipByChild = new Map<string, string>();
  for (const r of childRows) {
    const name = String(r[0] ?? "").trim();
    const scholarship = String(r[1] ?? "").trim();
    if (name && scholarship) scholarshipByChild.set(name, scholarship);
  }

  const categoryRows = await getTableRows(excelRef, CATEGORIES_TABLE);
  const eligibleByCategory = new Map<string, string[]>();
  for (const r of categoryRows) {
    const categoryPath = String(r[0] ?? "").trim();
    const eligible = String(r[1] ?? "").trim();
    if (categoryPath && eligible) {
      eligibleByCategory.set(
        categoryPath,
        eligible.split(",").map((s) => s.trim()).filter(Boolean)
      );
    }
  }

  const mismatches: ScholarshipMismatch[] = [];
  for (const row of rows) {
    const child = row.data["Child"]?.trim();
    const category = row.data["Category"]?.trim();
    if (!child || !category) continue;

    const childScholarship = scholarshipByChild.get(child);
    const eligibleScholarships = eligibleByCategory.get(category);
    if (!childScholarship || !eligibleScholarships || eligibleScholarships.length === 0) continue;

    const matches = eligibleScholarships.some((s) => scholarshipNamesMatch(s, childScholarship));
    if (!matches) {
      mismatches.push({ row, child, category, childScholarship, eligibleScholarships });
    }
  }
  return mismatches;
}
