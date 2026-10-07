import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { getTableHeaderRow, getTableRows, updateTableRowByIndex, type DriveItemRef } from "./graph/onedrive.js";

const TABLE1 = "Table1";
const URL_PATTERN = /reimbursementapi-prod\.stepupforstudents\.org\/api\/preauthorization\/search/i;
const THROTTLE_MS = 2 * 60 * 60 * 1000;
const STATE_FILE = path.resolve(process.cwd(), ".cache", "last-preauth-sync.json");

interface PreauthResult {
  SequenceNumber: number;
  ExternalStatus: string;
  IsReimbursement: boolean;
}

interface ApiResponse {
  Results: PreauthResult[];
}

/**
 * Maps StepUp's Pre-Auth API status onto Table7's "Pre-Auth Status" list (Not Required,
 * Unsubmitted, Submitted, Approved, Denied). Only "Complete" (confirmed via real data, always
 * paired with IsReimbursement: true — i.e. it went all the way through) is mapped so far; we
 * have no real examples of OnHold/Denied/etc. to confirm those, so anything else is left
 * unmapped (logged, not guessed) rather than risk a wrong status.
 */
function mapApiStatus(externalStatus: string): string | undefined {
  switch (externalStatus) {
    case "Complete":
      return "Approved";
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
 * Matches every Table1 row that has a "Pre-Auth #" (matched against the API's SequenceNumber)
 * and updates the "Pre-Auth" column where the mapped status differs from what's stored.
 * Currently a no-op for everyone until Pre-Auth # gets populated somewhere (no current rows
 * have one) — built now so it's ready the moment that changes.
 */
export async function syncPreauthFromApiResponse(excelRef: DriveItemRef, body: ApiResponse): Promise<number> {
  const byNumber = new Map<string, PreauthResult>();
  for (const r of body.Results ?? []) {
    if (r.SequenceNumber) byNumber.set(String(r.SequenceNumber), r);
  }
  if (byNumber.size === 0) return 0;

  const headers = await getTableHeaderRow(excelRef, TABLE1);
  const rows = await getTableRows(excelRef, TABLE1);
  const numIdx = headers.indexOf("Pre-Auth #");
  const statusIdx = headers.indexOf("Pre-Auth");
  if (numIdx === -1 || statusIdx === -1) {
    throw new Error('Table1 is missing "Pre-Auth #" or "Pre-Auth" columns.');
  }

  let updated = 0;
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const values = rows[rowIndex];
    const preAuthNumber = String(values[numIdx] ?? "").trim();
    if (!preAuthNumber) continue;

    const apiResult = byNumber.get(preAuthNumber);
    if (!apiResult) continue;

    const mappedStatus = mapApiStatus(apiResult.ExternalStatus);
    if (!mappedStatus) {
      console.log(`[pre-auth sync] Unrecognized status "${apiResult.ExternalStatus}" for Pre-Auth #${preAuthNumber} — skipping, not guessing the mapping.`);
      continue;
    }

    const currentStatus = String(values[statusIdx] ?? "").trim();
    if (currentStatus === mappedStatus) continue;

    await updateTableRowByIndex(excelRef, TABLE1, rowIndex, values, headers, { "Pre-Auth": mappedStatus });
    console.log(`[pre-auth sync] Pre-Auth #${preAuthNumber}: "${currentStatus}" -> "${mappedStatus}"`);
    updated++;
  }
  return updated;
}

/**
 * Passively watches for StepUp's Pre-Authorization search API, which we've seen load
 * automatically on the home page (no special navigation needed), and syncs the Pre-Auth column
 * from it — throttled to once per 2 hours, same as statusSync.
 *
 * The home page's call often returns an empty result set (distinct from the real
 * Pre-Authorizations list page) — an empty response must NOT start the throttle window, or it
 * silently blocks the next, actually-populated response for 2 hours.
 */
export function attachPreauthSyncListener(page: Page, excelRef: DriveItemRef): void {
  page.on("response", async (response) => {
    if (!URL_PATTERN.test(response.url())) return;
    if (Date.now() - (await getLastSyncAt()) < THROTTLE_MS) return;

    try {
      const body = (await response.json()) as ApiResponse;
      if (!body.Results || body.Results.length === 0) return;
      const updated = await syncPreauthFromApiResponse(excelRef, body);
      await setLastSyncAt(Date.now());
      console.log(`\n[pre-auth sync] Updated ${updated} row(s) from the Pre-Authorization list.`);
    } catch (err) {
      console.log(`\n[pre-auth sync] Failed: ${(err as Error).message}`);
    }
  });
}
