import { isStorageError, type StorageProvider } from "../storage/types.js";
import type { MirrorWorkbook } from "./model.js";
import { renderMirrorXlsx } from "./xlsx.js";

export type PublishResult = { status: "written" | "unchanged" | "locked" };

/**
 * Writes the mirror workbook into the year's reports folder unless the ledger state is unchanged since the last
 * write (tracked in a small sidecar file). A locked file (open in Excel) is reported, never thrown: the mirror is
 * derived data and must not fail the real operation.
 */
export async function publishMirror(storage: StorageProvider, driveId: string, reportsFolderId: string, fileName: string, model: MirrorWorkbook): Promise<PublishResult> {
  const hashName = `${fileName}.state-hash.txt`;
  const sidecar = await storage.find(driveId, reportsFolderId, hashName);
  if (sidecar) {
    const { text } = await storage.readText(driveId, sidecar.id);
    if (text.trim() === model.stateHash && (await storage.find(driveId, reportsFolderId, fileName))) return { status: "unchanged" };
  }
  const bytes = await renderMirrorXlsx(model);
  try {
    await storage.write(driveId, reportsFolderId, fileName, bytes);
  } catch (err) {
    if (isStorageError(err, "locked")) return { status: "locked" };
    throw err;
  }
  await storage.write(driveId, reportsFolderId, hashName, model.stateHash);
  return { status: "written" };
}
