import type { StorageProvider } from "../storage/types.js";

/** Which folder a person uses. Stored in their own app folder in their storage so every device finds it after sign-in. */
export interface Pointer {
  driveId: string;
  rootId: string;
  year?: string;
}

export const POINTER_FILE = "pointer.json";

function parse(text: string): Pointer | undefined {
  try {
    const v = JSON.parse(text) as Partial<Pointer>;
    return typeof v.driveId === "string" && typeof v.rootId === "string" ? { driveId: v.driveId, rootId: v.rootId, ...(typeof v.year === "string" ? { year: v.year } : {}) } : undefined;
  } catch {
    return undefined;
  }
}

/** The pointer saved in this account's app folder, or undefined when none (or the app folder is not available). */
export async function loadRemotePointer(storage: StorageProvider): Promise<Pointer | undefined> {
  const root = await storage.appFolder();
  if (!root) return undefined;
  const file = await storage.find(root.driveId, root.id, POINTER_FILE);
  if (!file || file.isFolder) return undefined;
  return parse((await storage.readText(root.driveId, file.id)).text);
}

/** Saves the pointer; `undefined` clears it. Returns false when the app folder is not available. */
export async function saveRemotePointer(storage: StorageProvider, pointer: Pointer | undefined): Promise<boolean> {
  const root = await storage.appFolder();
  if (!root) return false;
  await storage.write(root.driveId, root.id, POINTER_FILE, JSON.stringify(pointer ?? {}));
  return true;
}
