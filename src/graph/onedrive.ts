import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
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
  const base64 = Buffer.from(shareUrl, "utf-8").toString("base64");
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
}

interface ChildrenResponse {
  value: Array<{ id: string; name: string; size: number; folder?: unknown }>;
}

export async function listFolderChildren(ref: DriveItemRef): Promise<FolderChild[]> {
  const data = await graphJson<ChildrenResponse>(
    `/drives/${ref.driveId}/items/${ref.itemId}/children?$select=id,name,size,folder&$top=200`
  );
  return data.value.map((c) => ({ id: c.id, name: c.name, isFolder: Boolean(c.folder), size: c.size }));
}

/** Downloads a file item's content to destPath, creating parent directories as needed. */
export async function downloadItem(driveId: string, itemId: string, destPath: string): Promise<void> {
  await mkdir(path.dirname(destPath), { recursive: true });
  const response = await graphFetch(`/drives/${driveId}/items/${itemId}/content`, { rawBody: true });
  if (!response.body) throw new Error(`No response body when downloading item ${itemId}`);
  await pipeline(Readable.fromWeb(response.body as any), createWriteStream(destPath));
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
    )}/rows/${rowIndex}`,
    { method: "PATCH", body: JSON.stringify({ values: [next] }) }
  );
}
