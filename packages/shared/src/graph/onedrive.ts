import { graphFetch, graphJson } from "./client.js";

export interface DriveItemRef {
  driveId: string;
  itemId: string;
  name: string;
  isFolder: boolean;
}

interface DriveItemResponse {
  id: string;
  name: string;
  parentReference: { driveId: string };
  folder?: unknown;
}

/** Encodes a onedrive.com / 1drv.ms sharing URL into the Graph "shares" API token format. */
function encodeShareUrl(shareUrl: string): string {
  const bytes = new TextEncoder().encode(shareUrl);
  const base64 = btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""));
  const unpadded = base64.replace(/=+$/, "").replace(/\//g, "_").replace(/\+/g, "-");
  return `u!${unpadded}`;
}

/** Resolves any onedrive share link (file or folder) to a concrete drive+item id pair. */
export async function resolveShareLink(shareUrl: string): Promise<DriveItemRef> {
  const shareId = encodeShareUrl(shareUrl);
  const item = await graphJson<DriveItemResponse>(
    `/shares/${shareId}/driveItem?$select=id,name,parentReference,folder`
  );
  return {
    driveId: item.parentReference.driveId,
    itemId: item.id,
    name: item.name,
    isFolder: Boolean(item.folder),
  };
}

export interface FolderChild {
  id: string;
  name: string;
  isFolder: boolean;
  size: number;
  webUrl?: string;
}

interface ChildrenResponse {
  value: Array<{ id: string; name: string; size: number; webUrl?: string; folder?: unknown }>;
  "@odata.nextLink"?: string;
}

/**
 * Lists every child of a folder, following Graph's `@odata.nextLink` pagination until exhausted.
 * A folder with more than 200 items (very plausible here, given ~300+ tracked rows each with
 * multiple documents) would otherwise silently truncate at the first page — real files present
 * in the folder would appear "not found" with no error, since nothing beyond page 1 was ever
 * fetched.
 */
export async function listFolderChildren(ref: DriveItemRef): Promise<FolderChild[]> {
  const results: FolderChild[] = [];
  let url: string | undefined = `/drives/${ref.driveId}/items/${ref.itemId}/children?$select=id,name,size,webUrl,folder&$top=200`;
  while (url) {
    const data: ChildrenResponse = await graphJson<ChildrenResponse>(url);
    results.push(...data.value.map((c) => ({ id: c.id, name: c.name, isFolder: Boolean(c.folder), size: c.size, webUrl: c.webUrl })));
    url = data["@odata.nextLink"];
  }
  return results;
}

/** Fetches a file item's raw content; callers stream it to disk (Node) or read it as a Blob (browser). */
export function fetchItemContent(driveId: string, itemId: string, label?: string): Promise<Response> {
  return graphFetch(`/drives/${driveId}/items/${itemId}/content`, { rawBody: true, label });
}

/** Finds the best filename match in a folder for a loose document description (case-insensitive substring match). */
export function findBestMatch(children: FolderChild[], query: string): FolderChild[] {
  const needle = query.toLowerCase();
  return children
    .filter((c) => !c.isFolder)
    .filter((c) => c.name.toLowerCase().includes(needle))
    .sort((a, b) => a.name.length - b.name.length);
}

// ---- Excel workbook helpers -------------------------------------------------

interface WorksheetsResponse {
  value: Array<{ id: string; name: string; position: number }>;
}

export async function listWorksheets(ref: DriveItemRef) {
  const data = await graphJson<WorksheetsResponse>(
    `/drives/${ref.driveId}/items/${ref.itemId}/workbook/worksheets`
  );
  return data.value;
}

interface TablesResponse {
  value: Array<{ id: string; name: string }>;
}

export async function listTables(ref: DriveItemRef) {
  const data = await graphJson<TablesResponse>(`/drives/${ref.driveId}/items/${ref.itemId}/workbook/tables`);
  return data.value;
}

interface RangeResponse {
  values: unknown[][];
  address: string;
}

export async function getTableHeaderRow(ref: DriveItemRef, tableName: string): Promise<string[]> {
  const data = await graphJson<RangeResponse>(
    `/drives/${ref.driveId}/items/${ref.itemId}/workbook/tables/${encodeURIComponent(tableName)}/headerRowRange`
  );
  return data.values[0].map(String);
}

export async function getTableRows(ref: DriveItemRef, tableName: string): Promise<unknown[][]> {
  const data = await graphJson<{ value: Array<{ index: number; values: unknown[][] }> }>(
    `/drives/${ref.driveId}/items/${ref.itemId}/workbook/tables/${encodeURIComponent(tableName)}/rows`
  );
  return data.value.map((r) => r.values[0]);
}

/** Appends new rows to the end of a Table. Each entry in `rows` is one row's values in column order. */
export async function appendTableRows(ref: DriveItemRef, tableName: string, rows: unknown[][]): Promise<void> {
  if (rows.length === 0) return;
  await graphFetch(
    `/drives/${ref.driveId}/items/${ref.itemId}/workbook/tables/${encodeURIComponent(tableName)}/rows/add`,
    { method: "POST", body: JSON.stringify({ values: rows }) }
  );
}

/** Reads the header row + all data rows from the sheet's used range, for workbooks without a formal Table object. */
export async function getUsedRange(
  ref: DriveItemRef,
  worksheetName: string
): Promise<{ headers: string[]; rows: unknown[][] }> {
  const data = await graphJson<RangeResponse>(
    `/drives/${ref.driveId}/items/${ref.itemId}/workbook/worksheets/${encodeURIComponent(
      worksheetName
    )}/usedRange`
  );
  const [headers, ...rows] = data.values;
  return { headers: headers.map(String), rows };
}

/**
 * Finds a single row in a Table by exact match on one column's value, keyed by header name.
 * Returns the row's 0-based index within the table (needed for updateTableRowByIndex) plus the row values.
 */
export async function findTableRow(
  ref: DriveItemRef,
  tableName: string,
  matchColumn: string,
  matchValue: string
): Promise<{ rowIndex: number; values: unknown[]; headers: string[] } | undefined> {
  const headers = await getTableHeaderRow(ref, tableName);
  const colIndex = headers.indexOf(matchColumn);
  if (colIndex === -1) {
    throw new Error(`Column "${matchColumn}" not found. Available columns: ${headers.join(", ")}`);
  }
  const rows = await getTableRows(ref, tableName);
  const rowIndex = rows.findIndex((r) => String(r[colIndex] ?? "").trim() === matchValue.trim());
  if (rowIndex === -1) return undefined;
  return { rowIndex, values: rows[rowIndex], headers };
}

/**
 * Inserts a blank column at the given worksheet column letter (e.g. "C"), shifting that column
 * and everything after it one column to the right. Unlike a Table's own `columns/add`, this is a
 * plain worksheet-level operation, so it's allowed to displace *other* Tables that happen to sit
 * in the way — which is exactly the situation on sheets like "Validation Criteria" where several
 * small reference Tables are packed into adjacent columns with no gap between them. Use this to
 * clear space before growing a Table that has another Table immediately to its right.
 */
export async function insertWorksheetColumn(
  ref: DriveItemRef,
  worksheetName: string,
  columnLetter: string
): Promise<void> {
  await graphFetch(
    `/drives/${ref.driveId}/items/${ref.itemId}/workbook/worksheets/${encodeURIComponent(
      worksheetName
    )}/range(address='${columnLetter}:${columnLetter}')/insert`,
    { method: "POST", body: JSON.stringify({ shift: "Right" }) }
  );
}

/**
 * Deletes the given worksheet column letter (e.g. "D"), shifting everything after it one column
 * to the left. Symmetric counterpart to `insertWorksheetColumn` — use to close a gap.
 */
export async function deleteWorksheetColumn(
  ref: DriveItemRef,
  worksheetName: string,
  columnLetter: string
): Promise<void> {
  await graphFetch(
    `/drives/${ref.driveId}/items/${ref.itemId}/workbook/worksheets/${encodeURIComponent(
      worksheetName
    )}/range(address='${columnLetter}:${columnLetter}')/delete`,
    { method: "POST", body: JSON.stringify({ shift: "Left" }) }
  );
}

/** Writes literal values directly into a worksheet range (e.g. "C1:C5"), bypassing any Table object. */
export async function setRangeValues(
  ref: DriveItemRef,
  worksheetName: string,
  address: string,
  values: unknown[][]
): Promise<void> {
  await graphFetch(
    `/drives/${ref.driveId}/items/${ref.itemId}/workbook/worksheets/${encodeURIComponent(
      worksheetName
    )}/range(address='${address}')`,
    { method: "PATCH", body: JSON.stringify({ values }) }
  );
}

/** Converts a Table back to a plain range, keeping its data but dropping Table-ness (filters, banding, etc). */
export async function convertTableToRange(ref: DriveItemRef, tableName: string): Promise<void> {
  await graphFetch(
    `/drives/${ref.driveId}/items/${ref.itemId}/workbook/tables/${encodeURIComponent(tableName)}/convertToRange`,
    { method: "POST" }
  );
}

/** Creates a new Table over an existing range (e.g. "B1:C5") and returns its auto-generated name. */
export async function createTable(
  ref: DriveItemRef,
  worksheetName: string,
  address: string,
  hasHeaders: boolean
): Promise<string> {
  const data = await graphJson<{ name: string }>(
    `/drives/${ref.driveId}/items/${ref.itemId}/workbook/worksheets/${encodeURIComponent(worksheetName)}/tables/add`,
    { method: "POST", body: JSON.stringify({ address: `'${worksheetName}'!${address}`, hasHeaders }) }
  );
  return data.name;
}

/** Renames an existing Table (e.g. after `createTable` returns an auto-generated name like "Table10"). */
export async function renameTable(ref: DriveItemRef, currentName: string, newName: string): Promise<void> {
  await graphFetch(`/drives/${ref.driveId}/items/${ref.itemId}/workbook/tables/${encodeURIComponent(currentName)}`, {
    method: "PATCH",
    body: JSON.stringify({ name: newName }),
  });
}

/**
 * Inserts a new blank column into a Table at 0-based `index`, with the given header name.
 * Requires the table's *current* headers (before this insert) as `currentHeaders` — the new
 * header row is computed in-memory by splicing into that array, rather than by re-fetching
 * headers from the API right after the insert, because that read can come back stale (missing
 * the just-added column) and produce a PATCH whose dimensions don't match the table anymore.
 * Naming is done via a single whole-header-row PATCH rather than addressing the new column
 * individually by index — that per-column addressing does not reliably refer to the same
 * position used by the `columns/add` index parameter and can silently rename a different,
 * pre-existing column instead.
 */
export async function insertTableColumn(
  ref: DriveItemRef,
  tableName: string,
  index: number,
  headerName: string,
  currentHeaders: string[]
): Promise<void> {
  await graphFetch(
    `/drives/${ref.driveId}/items/${ref.itemId}/workbook/tables/${encodeURIComponent(tableName)}/columns/add`,
    { method: "POST", body: JSON.stringify({ index }) }
  );
  const newHeaders = [...currentHeaders];
  newHeaders.splice(index, 0, headerName);
  await graphFetch(
    `/drives/${ref.driveId}/items/${ref.itemId}/workbook/tables/${encodeURIComponent(tableName)}/headerRowRange`,
    { method: "PATCH", body: JSON.stringify({ values: [newHeaders] }) }
  );
}

/**
 * Updates specific columns (by header name) on one existing table row, leaving all other cells untouched.
 * Uses the Graph Excel session-safe row PATCH, which is co-authoring compatible.
 */
export async function updateTableRowByIndex(
  ref: DriveItemRef,
  tableName: string,
  rowIndex: number,
  currentValues: unknown[],
  headers: string[],
  changes: Record<string, unknown>
): Promise<void> {
  const next = [...currentValues];
  for (const [column, value] of Object.entries(changes)) {
    const idx = headers.indexOf(column);
    if (idx === -1) throw new Error(`Column "${column}" not found. Available columns: ${headers.join(", ")}`);
    next[idx] = value;
  }
  await graphFetch(
    `/drives/${ref.driveId}/items/${ref.itemId}/workbook/tables/${encodeURIComponent(
      tableName
    )}/rows/itemAt(index=${rowIndex})`,
    { method: "PATCH", body: JSON.stringify({ values: [next] }) }
  );
}
