import { GraphError, graphJson } from "../graph/client.js";
import { findChild, readTextFile, writeFile } from "../graph/files.js";

/** Which folder a person uses. Stored in their own OneDrive app folder so every device finds it after sign-in. */
export interface Pointer {
  driveId: string;
  rootId: string;
  year?: string;
}

export const POINTER_FILE = "pointer.json";

async function approot(): Promise<{ driveId: string; id: string } | undefined> {
  try {
    const item = await graphJson<{ id: string; parentReference?: { driveId?: string } }>("/me/drive/special/approot?$select=id,parentReference");
    return item.parentReference?.driveId ? { driveId: item.parentReference.driveId, id: item.id } : undefined;
  } catch (err) {
    if (err instanceof GraphError && (err.status === 404 || err.status === 403)) return undefined;
    throw err;
  }
}

function parse(text: string): Pointer | undefined {
  try {
    const v = JSON.parse(text) as Partial<Pointer>;
    return typeof v.driveId === "string" && typeof v.rootId === "string" ? { driveId: v.driveId, rootId: v.rootId, ...(typeof v.year === "string" ? { year: v.year } : {}) } : undefined;
  } catch {
    return undefined;
  }
}

/** The pointer saved in this account's app folder, or undefined when none (or the app folder is not available). */
export async function loadRemotePointer(): Promise<Pointer | undefined> {
  const root = await approot();
  if (!root) return undefined;
  const file = await findChild(root.driveId, root.id, POINTER_FILE);
  if (!file || file.isFolder) return undefined;
  return parse((await readTextFile(root.driveId, file.id)).text);
}

/** Saves the pointer; `undefined` clears it. Returns false when the app folder is not available. */
export async function saveRemotePointer(pointer: Pointer | undefined): Promise<boolean> {
  const root = await approot();
  if (!root) return false;
  await writeFile(root.driveId, root.id, POINTER_FILE, JSON.stringify(pointer ?? {}));
  return true;
}
