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
  ItemAmount: number;
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
 *
 * Also records the actual reimbursed dollar amount in "Reimbursed Amount", and — when the
 * status would otherwise be Approved/Paid — uses "Adjusted" instead if that amount matches
 * *neither* Amount nor Reim. $ (both are normal, StepUp reports the item amount with or without
 * tax folded in depending on the case; only matching neither means an unexplained reduction,
 * calibrated against 59 real historical rows: 45 matched Amount, 13 matched Reim. $, 1 matched
 * neither). A genuinely denied item still maps to Denied (Initial)/(Final) regardless of amount.
 *
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
  const amountIdx = headers.indexOf("Amount");
  const reimTotalIdx = headers.indexOf("Reim. $");
  const reimbursedAmountIdx = headers.indexOf("Reimbursed Amount");
  if (reimbIdx === -1 || lineNumIdx === -1 || statusIdx === -1 || amountIdx === -1 || reimTotalIdx === -1 || reimbursedAmountIdx === -1) {
    throw new Error(
      "Table1 is missing one of Reimbursement ID / Line Number / Status / Amount / Reim. $ / Reimbursed Amount columns."
    );
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

    let mappedStatus = mapApiStatus(apiItem.ExternalStatus, apiItem.Appealed);
    if (!mappedStatus) continue;

    if ((mappedStatus === "Approved" || mappedStatus === "Paid") && Number.isFinite(apiItem.ItemAmount)) {
      const amount = Number.parseFloat(String(values[amountIdx] ?? "NaN"));
      const total = Number.parseFloat(String(values[reimTotalIdx] ?? "NaN"));
      const matchesAmount = Math.abs(apiItem.ItemAmount - amount) < 0.01;
      const matchesTotal = Math.abs(apiItem.ItemAmount - total) < 0.01;
      if (!matchesAmount && !matchesTotal) mappedStatus = "Adjusted";
    }

    if (!validStatuses.has(mappedStatus)) {
      if (!warnedInvalidStatuses.has(mappedStatus)) {
        console.log(
          `[status sync] "${mappedStatus}" isn't in ${STATUSES_TABLE} yet — add it to the spreadsheet's Statuses list. Skipping affected row(s) for now.`
        );
        warnedInvalidStatuses.add(mappedStatus);
      }
      continue;
    }

    const changes: Record<string, unknown> = {};
    const currentStatus = String(values[statusIdx] ?? "").trim();
    if (currentStatus !== mappedStatus) changes.Status = mappedStatus;

    // Only record an actual reimbursed amount once the item is in a finalized, paid-out state —
    // for "Submitted" (still pending) the API's ItemAmount just reflects the request, not a
    // real disbursement, and "Denied" items were never paid at all.
    const isFinalizedAmount = mappedStatus === "Approved" || mappedStatus === "Paid" || mappedStatus === "Adjusted";
    if (isFinalizedAmount && Number.isFinite(apiItem.ItemAmount)) {
      const currentReimbursedAmount = String(values[reimbursedAmountIdx] ?? "").trim();
      if (currentReimbursedAmount !== String(apiItem.ItemAmount)) changes["Reimbursed Amount"] = apiItem.ItemAmount;
    }

    if (Object.keys(changes).length === 0) continue;

    await updateTableRowByIndex(excelRef, TABLE1, rowIndex, values, headers, changes);
    console.log(
      `[status sync] Row ${reimbursementId}-${lineNumber}: ${Object.entries(changes)
        .map(([k, v]) => `${k}="${v}"`)
        .join(", ")}`
    );
    updated++;
  }
  return updated;
}

/**
 * Passively watches for StepUp's reimbursements-list API response, which loads automatically
 * during normal navigation, and syncs Status from it — throttled to once per 2 hours so normal
 * page reloads don't hammer the spreadsheet with redundant writes.
 *
 * This same endpoint also fires on the home page with an empty/near-empty result set (some
 * "recent activity" widget, distinct from the real Reimbursements list page) — an empty response
 * must NOT start the throttle window, or it silently blocks the next, actually-populated response
 * for 2 hours. Only a response with real data to sync counts as a sync.
 */
export function attachStatusSyncListener(page: Page, excelRef: DriveItemRef): void {
  page.on("response", async (response) => {
    if (!API_URL_PATTERN.test(response.url())) return;
    if (Date.now() - (await getLastSyncAt()) < THROTTLE_MS) return;

    try {
      const body = (await response.json()) as ApiResponse;
      if (!body.Results || body.Results.length === 0) return;
      const updated = await syncStatusesFromApiResponse(excelRef, body);
      await setLastSyncAt(Date.now());
      console.log(`\n[status sync] Updated ${updated} row(s) from the reimbursements list.`);
    } catch (err) {
      console.log(`\n[status sync] Failed: ${(err as Error).message}`);
    }
  });
}
