import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { GoogleDriveProvider, OneDriveProvider, type StorageProvider } from "@step-up/shared";
import { cliAuth } from "../graph/auth.js";
import "../graph/client.js"; // the Excel-era commands call Graph directly and need the token provider registered too
import { GoogleCliAuth } from "./googleAuth.js";
import { LOCAL_DRIVE, LocalFsProvider } from "./localFs.js";

export { LocalFsProvider, LOCAL_DRIVE } from "./localFs.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name} (see .env.example).`);
  return value;
}

/**
 * Where the command line keeps its files: STEPUP_STORAGE is "onedrive" (the default), "google" or "local" (a folder on
 * this computer, named by STEPUP_LOCAL_ROOT, which on its own also selects it). One instance per process.
 */
let current: StorageProvider | undefined;
export function openStorage(): StorageProvider {
  if (current) return current;
  const choice = (process.env["STEPUP_STORAGE"] ?? (process.env["STEPUP_LOCAL_ROOT"] ? "local" : "onedrive")).toLowerCase();
  if (choice === "local") current = new LocalFsProvider(requireEnv("STEPUP_LOCAL_ROOT"));
  else if (choice === "google") {
    current = new GoogleDriveProvider(
      new GoogleCliAuth({ clientId: requireEnv("GOOGLE_CLIENT_ID"), clientSecret: requireEnv("GOOGLE_CLIENT_SECRET"), cacheFile: path.resolve(process.cwd(), ".cache", "google-token.json") })
    );
  } else if (choice === "onedrive") current = new OneDriveProvider(cliAuth);
  else throw new Error(`STEPUP_STORAGE must be onedrive, google or local (got "${choice}").`);
  return current;
}

export interface WorkspaceLocation {
  storage: StorageProvider;
  driveId: string;
  /** The folder that holds the year folders. */
  rootId: string;
}

/**
 * The workspace root. On this computer it is STEPUP_LOCAL_ROOT itself; on OneDrive or Google Drive it is the parent of
 * the receipts folder named by ONEDRIVE_FILES_FOLDER_URL or GOOGLE_FILES_FOLDER_URL.
 */
export async function locateWorkspace(): Promise<WorkspaceLocation> {
  const storage = openStorage();
  if (storage.kind === "local-folder") return { storage, driveId: LOCAL_DRIVE, rootId: "" };
  const folder = await storage.folderFromLink!(requireEnv(storage.kind === "google" ? "GOOGLE_FILES_FOLDER_URL" : "ONEDRIVE_FILES_FOLDER_URL"));
  return { storage, driveId: folder.driveId, rootId: await storage.parentOf(folder.driveId, folder.itemId) };
}

/** Saves a stored file to a path on this computer, creating folders as needed. */
export async function downloadTo(storage: StorageProvider, driveId: string, itemId: string, destPath: string): Promise<void> {
  await mkdir(path.dirname(destPath), { recursive: true });
  await writeFile(destPath, new Uint8Array(await (await storage.download(driveId, itemId)).arrayBuffer()));
}
