import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { getTableHeaderRow, getTableRows, updateTableRowByIndex, type DriveItemRef } from "./graph/onedrive.js";

const TABLE1 = "Table1";
const STATUSES_TABLE = "Table3";
const API_URL_PATTERN = /reimbursementapi-prod\.stepupforstudents\.org\/api\/reimbursements\/V2\/search/i;
const THROTTLE_MS = 2 * 60 * 60 * 1000;
const STATE_FILE = path.resolve(process.cwd(), ".cache", "last-status-sync.json");

interface ApiLineItem {
  LineItemNumber: string;
  ExternalStatus: string;
  Appealed: boolean;
}

interface ApiResponse {
  Results: Array<{ LineItems: ApiLineItem[] }>;
}

/**
 * Maps StepUp's API status (+ whether it's been appealed) onto the spreadsheet's Table3
 * status list. Only the 4 raw values StepUp's API actually reports are handled; anything
 * else is left alone (returns undefined) rather than guessing.
 */
export function mapApiStatus(externalStatus: string, appealed: boolean): string | undefined {
  switch (externalStatus) {
    case "Submitted":
      return "Submitted";
    case "Approved":
      return "Approved";
    case "Paid":
      return "Paid";
    case "Denied":
      return appealed ? "Denied (Final)" : "Denied (Initial)";
    default:
      return undefined;
  }
}

async function getLastSyncAt(): Promise<number> {
  try {
    const raw = await readFile(STATE_FILE, "utf-8");
    return (JSON.parse(raw) as { lastSyncAt?: number }).lastSyncAt ?? 0;
  } catch {
    return 0;
  }
}

async function setLastSyncAt(timestamp: number): Promise<void> {
  await mkdir(path.dirname(STATE_FILE), { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify({ lastSyncAt: timestamp }), "utf-8");
}

/**
 * Matches every Table1 row that has both a Reimbursement ID and Line Number (i.e. was already
 * submitted) against the API response by exact `{ReimbursementID}-{LineNumber}` match, and
 * updates Status where StepUp's current status maps to something different than what's stored.
 * Returns the number of rows updated.
 */
export async function syncStatusesFromApiResponse(excelRef: DriveItemRef, body: ApiResponse): Promise<number> {
  const lineItemsByNumber = new Map<string, ApiLineItem>();
  for (const result of body.Results ?? []) {
    for (const li of result.LineItems ?? []) {
      if (li.LineItemNumber) lineItemsByNumber.set(li.LineItemNumber, li);
    }
  }

  const headers = await getTableHeaderRow(excelRef, TABLE1);
  const rows = await getTableRows(excelRef, TABLE1);
  const reimbIdx = headers.indexOf("Reimbursement ID");
  const lineNumIdx = headers.indexOf("Line Number");
  const statusIdx = headers.indexOf("Status");
  if (reimbIdx === -1 || lineNumIdx === -1 || statusIdx === -1) {
    throw new Error("Table1 is missing one of Reimbursement ID / Line Number / Status columns.");
  }

  const validStatuses = new Set(
    (await getTableRows(excelRef, STATUSES_TABLE)).map((r) => String(r[0] ?? "")).filter(Boolean)
  );
  const warnedInvalidStatuses = new Set<string>();

  let updated = 0;
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const values = rows[rowIndex];
    const reimbursementId = String(values[reimbIdx] ?? "").trim();
    const lineNumber = String(values[lineNumIdx] ?? "").trim();
    if (!reimbursementId || !lineNumber) continue;

    const apiItem = lineItemsByNumber.get(`${reimbursementId}-${lineNumber}`);
    if (!apiItem) continue;

    const mappedStatus = mapApiStatus(apiItem.ExternalStatus, apiItem.Appealed);
    if (!mappedStatus) continue;

    if (!validStatuses.has(mappedStatus)) {
      if (!warnedInvalidStatuses.has(mappedStatus)) {
        console.log(
          `[status sync] "${mappedStatus}" isn't in ${STATUSES_TABLE} yet — add it to the spreadsheet's Statuses list. Skipping affected row(s) for now.`
        );
        warnedInvalidStatuses.add(mappedStatus);
      }
      continue;
    }

    const currentStatus = String(values[statusIdx] ?? "").trim();
    if (currentStatus === mappedStatus) continue;

    await updateTableRowByIndex(excelRef, TABLE1, rowIndex, values, headers, { Status: mappedStatus });
    console.log(`[status sync] Row ${reimbursementId}-${lineNumber}: "${currentStatus}" -> "${mappedStatus}"`);
    updated++;
  }
  return updated;
}

/**
 * Passively watches for StepUp's reimbursements-list API response, which loads automatically
 * during normal navigation, and syncs Status from it — throttled to once per 2 hours so normal
 * page reloads don't hammer the spreadsheet with redundant writes.
 */
export function attachStatusSyncListener(page: Page, excelRef: DriveItemRef): void {
  page.on("response", async (response) => {
    if (!API_URL_PATTERN.test(response.url())) return;
    if (Date.now() - (await getLastSyncAt()) < THROTTLE_MS) return;

    try {
      const body = (await response.json()) as ApiResponse;
      const updated = await syncStatusesFromApiResponse(excelRef, body);
      await setLastSyncAt(Date.now());
      console.log(`\n[status sync] Updated ${updated} row(s) from the reimbursements list.`);
    } catch (err) {
      console.log(`\n[status sync] Failed: ${(err as Error).message}`);
    }
  });
}
