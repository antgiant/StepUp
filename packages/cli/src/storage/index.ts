import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { OneDriveProvider, type StorageProvider } from "@step-up/shared";
import { cliAuth } from "../graph/auth.js";
import "../graph/client.js"; // the Excel-era commands call Graph directly and need the token provider registered too
import { LOCAL_DRIVE, LocalFsProvider } from "./localFs.js";

export { LocalFsProvider, LOCAL_DRIVE } from "./localFs.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name} (see .env.example).`);
  return value;
}

/**
 * Where the command line keeps its files. Set STEPUP_LOCAL_ROOT to a folder on this computer to use that; otherwise it
 * is OneDrive. One instance per process.
 */
let current: StorageProvider | undefined;
export function openStorage(): StorageProvider {
  if (!current) {
    const local = process.env["STEPUP_LOCAL_ROOT"];
    current = local ? new LocalFsProvider(local) : new OneDriveProvider(cliAuth);
  }
  return current;
}

export interface WorkspaceLocation {
  storage: StorageProvider;
  driveId: string;
  /** The folder that holds the year folders. */
  rootId: string;
}

/**
 * The workspace root. On this computer it is STEPUP_LOCAL_ROOT itself; on OneDrive it is the parent of the receipts
 * folder named by ONEDRIVE_FILES_FOLDER_URL.
 */
export async function locateWorkspace(): Promise<WorkspaceLocation> {
  const storage = openStorage();
  if (storage.kind === "local-folder") return { storage, driveId: LOCAL_DRIVE, rootId: "" };
  const folder = await storage.folderFromLink!(requireEnv("ONEDRIVE_FILES_FOLDER_URL"));
  return { storage, driveId: folder.driveId, rootId: await storage.parentOf(folder.driveId, folder.itemId) };
}

/** Saves a stored file to a path on this computer, creating folders as needed. */
export async function downloadTo(storage: StorageProvider, driveId: string, itemId: string, destPath: string): Promise<void> {
  await mkdir(path.dirname(destPath), { recursive: true });
  await writeFile(destPath, new Uint8Array(await (await storage.download(driveId, itemId)).arrayBuffer()));
}
