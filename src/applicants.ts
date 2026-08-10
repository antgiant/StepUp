import { findTableRow, updateTableRowByIndex, type DriveItemRef } from "./graph/onedrive.js";

/**
 * Loads one applicant's row from the Excel table, keyed by header name (e.g. row["Student First Name"]).
 * Uses the Graph Excel Tables API, which is safe to read/write alongside other people editing the
 * same workbook (no download/re-upload of the whole file, no risk of clobbering their changes).
 */
export async function loadApplicant(
  excelRef: DriveItemRef,
  tableName: string,
  matchColumn: string,
  matchValue: string
): Promise<{ data: Record<string, string>; rowIndex: number; headers: string[]; rawValues: unknown[] }> {
  const found = await findTableRow(excelRef, tableName, matchColumn, matchValue);
  if (!found) {
    throw new Error(`No row found where "${matchColumn}" = "${matchValue}" in table "${tableName}".`);
  }
  const data: Record<string, string> = {};
  found.headers.forEach((header, i) => {
    data[header] = found.values[i] === undefined || found.values[i] === null ? "" : String(found.values[i]);
  });
  return { data, rowIndex: found.rowIndex, headers: found.headers, rawValues: found.values };
}

/** Writes a status/progress update back to the applicant's row without touching any other cell. */
export async function markApplicantStatus(
  excelRef: DriveItemRef,
  tableName: string,
  rowIndex: number,
  headers: string[],
  rawValues: unknown[],
  statusColumn: string,
  status: string
): Promise<void> {
  await updateTableRowByIndex(excelRef, tableName, rowIndex, rawValues, headers, { [statusColumn]: status });
}
