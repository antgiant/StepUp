import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";

// Confirmed live: StepUp creates the draft (POST /api/reimbursements/v2) the moment the student is
// confirmed, identified by a GUID that sits in the wizard URL from the upload step on. GET
// /api/reimbursements/v2/{guid} returns its numeric `sequenceNumber` (the "Reimbursement #" used in
// the spreadsheet), `externalStatus`, `submitDate` and `lineItems`.
const API_HOST_PATTERN = /reimbursementapi-prod\.stepupforstudents\.org/i;
const DRAFT_GET_PATTERN = /reimbursementapi-prod\.stepupforstudents\.org\/api\/reimbursements\/v2\/([0-9a-f-]{36})(?:[?#]|$)/i;
const API_ORIGIN = "https://reimbursementapi-prod.stepupforstudents.org";
const GUID_IN_URL = /\/SubmitReimbursement\/(?:Confirmation\/)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const CACHE_FILE = path.resolve(process.cwd(), ".cache", "drafts.json");

export interface DraftSnapshot {
  guid: string;
  sequenceNumber?: string;
  externalStatus?: string;
  submitDate?: string;
  lineItemCount: number;
  hasAdditionalDocuments: boolean;
}

/** What we remember on disk about the draft started for one group of Table1 rows. */
export interface DraftRecord {
  guid: string;
  rowIds: string[];
  /** Row IDs in the order they became line items 1..n (known once item details were filled). */
  rowOrder?: string[];
  sequenceNumber?: string;
}

const snapshots = new Map<string, DraftSnapshot>();
let authHeader: string | undefined;

function toSnapshot(guid: string, body: Record<string, unknown>): DraftSnapshot {
  const lineItems = Array.isArray(body.lineItems) ? body.lineItems : [];
  const additional = Array.isArray(body.additionalDocuments) ? body.additionalDocuments : [];
  return {
    guid,
    sequenceNumber: body.sequenceNumber != null ? String(body.sequenceNumber) : undefined,
    externalStatus: typeof body.externalStatus === "string" ? body.externalStatus : undefined,
    submitDate: typeof body.submitDate === "string" ? body.submitDate : undefined,
    lineItemCount: lineItems.length,
    hasAdditionalDocuments: additional.length > 0,
  };
}

/** Passively remembers the Authorization header and every draft GET response StepUp's own page makes. */
export function attachDraftTracker(page: Page): void {
  page.on("request", async (request) => {
    if (!API_HOST_PATTERN.test(request.url())) return;
    const headers = await request.allHeaders().catch(() => ({}) as Record<string, string>);
    if (headers["authorization"]) authHeader = headers["authorization"];
  });
  page.on("response", async (response) => {
    const match = DRAFT_GET_PATTERN.exec(response.url());
    if (!match || response.request().method() !== "GET") return;
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (body) snapshots.set(match[1].toLowerCase(), toSnapshot(match[1].toLowerCase(), body));
  });
}

export function guidFromUrl(url: string): string | undefined {
  return GUID_IN_URL.exec(url)?.[1].toLowerCase();
}

export function latestSnapshot(guid: string): DraftSnapshot | undefined {
  return snapshots.get(guid.toLowerCase());
}

/**
 * The Authorization header is only learned from StepUp's own API traffic, so a run that starts on
 * an already-loaded page may not have seen any yet — wait briefly, then reload once to make the
 * page fire its own API calls (the Dashboard/list pages do on load).
 */
async function ensureAuthHeader(page: Page): Promise<boolean> {
  for (let attempt = 0; attempt < 2 && !authHeader; attempt++) {
    for (let i = 0; i < 16 && !authHeader; i++) await page.waitForTimeout(500);
    if (!authHeader && attempt === 0) await page.reload().catch(() => {});
  }
  return Boolean(authHeader);
}

/** Fetches a draft's current state directly (reusing the page's own auth); null if that isn't possible. */
export async function fetchDraftSnapshot(page: Page, guid: string): Promise<DraftSnapshot | null> {
  if (!(await ensureAuthHeader(page)) || !authHeader) return null;
  const auth = authHeader;
  try {
    const res = await page.request.get(`${API_ORIGIN}/api/reimbursements/v2/${guid}`, { headers: { authorization: auth } });
    if (!res.ok()) return null;
    const snapshot = toSnapshot(guid.toLowerCase(), (await res.json()) as Record<string, unknown>);
    snapshots.set(snapshot.guid, snapshot);
    return snapshot;
  } catch {
    return null;
  }
}

/**
 * Confirmed live: an unsubmitted request reports externalStatus "Draft" with the placeholder
 * submitDate "0001-01-01T00:00:00" (truthy, so it can't be used as a bare existence check), while
 * a submitted one has a real submit date and status "Submitted" (or a later status).
 */
export function isSubmitted(snapshot: DraftSnapshot): boolean {
  if (/draft|incomplete|unsubmitted/i.test(snapshot.externalStatus ?? "")) return false;
  const submitted = snapshot.submitDate ? new Date(snapshot.submitDate) : undefined;
  return Boolean(submitted && submitted.getUTCFullYear() > 1900);
}

export function groupKey(rowIds: string[]): string {
  return [...rowIds].sort().join(",");
}

async function loadAll(): Promise<Record<string, DraftRecord>> {
  try {
    return JSON.parse(await readFile(CACHE_FILE, "utf-8"));
  } catch {
    return {};
  }
}

export async function loadDraftRecord(rowIds: string[]): Promise<DraftRecord | undefined> {
  return (await loadAll())[groupKey(rowIds)];
}

export async function saveDraftRecord(record: DraftRecord): Promise<void> {
  const all = await loadAll();
  all[groupKey(record.rowIds)] = record;
  await mkdir(path.dirname(CACHE_FILE), { recursive: true });
  await writeFile(CACHE_FILE, JSON.stringify(all, null, 2), "utf-8");
}

export async function deleteDraftRecord(rowIds: string[]): Promise<void> {
  const all = await loadAll();
  delete all[groupKey(rowIds)];
  await mkdir(path.dirname(CACHE_FILE), { recursive: true });
  await writeFile(CACHE_FILE, JSON.stringify(all, null, 2), "utf-8");
}
