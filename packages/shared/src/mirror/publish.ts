import { GraphError } from "../graph/client.js";
import { findChild, readTextFile, writeFile } from "../graph/files.js";
import type { MirrorWorkbook } from "./model.js";
import { renderMirrorXlsx } from "./xlsx.js";

export type PublishResult = { status: "written" | "unchanged" | "locked" };

/**
 * Writes the mirror workbook into the year's reports folder unless the ledger state is unchanged since the last
 * write (tracked in a small sidecar file). A locked file (open in Excel) is reported, never thrown: the mirror is
 * derived data and must not fail the real operation.
 */
export async function publishMirror(driveId: string, reportsFolderId: string, fileName: string, model: MirrorWorkbook): Promise<PublishResult> {
  const hashName = `${fileName}.state-hash.txt`;
  const sidecar = await findChild(driveId, reportsFolderId, hashName);
  if (sidecar) {
    const { text } = await readTextFile(driveId, sidecar.id);
    if (text.trim() === model.stateHash && (await findChild(driveId, reportsFolderId, fileName))) return { status: "unchanged" };
  }
  const bytes = await renderMirrorXlsx(model);
  try {
    await writeFile(driveId, reportsFolderId, fileName, bytes);
  } catch (err) {
    if (err instanceof GraphError && err.status === 423) return { status: "locked" };
    throw err;
  }
  await writeFile(driveId, reportsFolderId, hashName, model.stateHash);
  return { status: "written" };
}
