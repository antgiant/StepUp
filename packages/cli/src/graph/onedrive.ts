import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fetchItemContent } from "@step-up/shared";
import "./client.js"; // registers the Node token provider before any Graph call

export * from "@step-up/shared/graph/onedrive";

/** Downloads a file item's content to destPath, creating parent directories as needed. */
export async function downloadItem(driveId: string, itemId: string, destPath: string): Promise<void> {
  await mkdir(path.dirname(destPath), { recursive: true });
  const response = await fetchItemContent(driveId, itemId);
  if (!response.body) throw new Error(`No response body when downloading item ${itemId}`);
  await pipeline(Readable.fromWeb(response.body as any), createWriteStream(destPath));
}
