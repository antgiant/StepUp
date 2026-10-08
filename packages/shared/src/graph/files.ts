import { GraphError, graphFetch, graphJson, trackActivity } from "./client.js";
import { sendUploadChunk } from "./uploadTransport.js";

/** Simple PUT upload is limited to ~4 MB by Graph; anything larger needs an upload session. */
export const SIMPLE_UPLOAD_LIMIT = 4 * 1024 * 1024;
/** Upload-session chunks must be a multiple of 320 KiB. */
export const UPLOAD_CHUNK = 320 * 1024 * 10;

export type FileBody = string | Uint8Array | Blob;

export interface StoredFile {
  id: string;
  name: string;
  eTag?: string;
  size?: number;
  webUrl?: string;
}

interface DriveItemJson {
  id: string;
  name: string;
  eTag?: string;
  size?: number;
  webUrl?: string;
  folder?: unknown;
}

const encodeName = (name: string) => encodeURIComponent(name);

function sizeOf(body: FileBody): number {
  if (typeof body === "string") return new TextEncoder().encode(body).byteLength;
  return body instanceof Blob ? body.size : body.byteLength;
}

/** Finds a direct child by name; undefined when it does not exist. */
export async function findChild(driveId: string, parentId: string, name: string): Promise<(StoredFile & { isFolder: boolean }) | undefined> {
  try {
    const item = await graphJson<DriveItemJson>(
      `/drives/${driveId}/items/${parentId}:/${encodeName(name)}?$select=id,name,eTag,size,webUrl,folder`
    );
    return { id: item.id, name: item.name, eTag: item.eTag, size: item.size, webUrl: item.webUrl, isFolder: Boolean(item.folder) };
  } catch (err) {
    if (err instanceof GraphError && err.status === 404) return undefined;
    throw err;
  }
}

/** Returns the id of the named child folder, creating it if needed (safe if two clients race to create it). */
export async function ensureFolder(driveId: string, parentId: string, name: string): Promise<string> {
  const existing = await findChild(driveId, parentId, name);
  if (existing) {
    if (!existing.isFolder) throw new Error(`"${name}" exists but is not a folder`);
    return existing.id;
  }
  try {
    const created = await graphJson<DriveItemJson>(`/drives/${driveId}/items/${parentId}/children`, {
      method: "POST",
      body: JSON.stringify({ name, folder: {}, "@microsoft.graph.conflictBehavior": "fail" }),
    });
    return created.id;
  } catch (err) {
    if (err instanceof GraphError && err.status === 409) {
      const raced = await findChild(driveId, parentId, name);
      if (raced?.isFolder) return raced.id;
    }
    throw err;
  }
}

/** Reads a small text file together with its ETag. */
export async function readTextFile(driveId: string, itemId: string): Promise<{ text: string; eTag?: string }> {
  const meta = await graphJson<DriveItemJson>(`/drives/${driveId}/items/${itemId}?$select=eTag`);
  const response = await graphFetch(`/drives/${driveId}/items/${itemId}/content`, { rawBody: true });
  return { text: await response.text(), eTag: meta.eTag };
}

export interface FileWriteOptions {
  /** Replace only if the file's current ETag matches (optimistic concurrency); a mismatch throws GraphError 412. */
  ifMatch?: string;
  /** Fail instead of overwriting when a file with this name already exists. */
  createOnly?: boolean;
}

/**
 * Creates or replaces `name` inside the folder. Up to ~4 MB uses one PUT; larger bodies use an upload session
 * with sequential chunks.
 */
export async function writeFile(driveId: string, parentId: string, name: string, body: FileBody, opts: FileWriteOptions = {}): Promise<StoredFile> {
  const conflict = opts.createOnly ? "fail" : "replace";
  const base = `/drives/${driveId}/items/${parentId}:/${encodeName(name)}`;
  const headers: Record<string, string> = {};
  if (opts.ifMatch) headers["If-Match"] = opts.ifMatch;

  if (sizeOf(body) <= SIMPLE_UPLOAD_LIMIT) {
    const item = await graphJson<DriveItemJson>(`${base}:/content?@microsoft.graph.conflictBehavior=${conflict}`, {
      method: "PUT",
      headers,
      body: body as BodyInit,
      rawBody: true,
    });
    return { id: item.id, name: item.name, eTag: item.eTag, size: item.size, webUrl: item.webUrl };
  }

  const session = await graphJson<{ uploadUrl: string }>(`${base}:/createUploadSession`, {
    method: "POST",
    headers,
    body: JSON.stringify({ item: { "@microsoft.graph.conflictBehavior": conflict } }),
  });
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body instanceof Blob ? new Uint8Array(await body.arrayBuffer()) : body;
  let last: DriveItemJson | undefined;
  await trackActivity(`Uploading ${name}…`, async (update) => {
    for (let start = 0; start < bytes.byteLength; start += UPLOAD_CHUNK) {
      const end = Math.min(start + UPLOAD_CHUNK, bytes.byteLength);
      update(`Uploading ${name} — ${Math.round((start / bytes.byteLength) * 100)}%`);
      // The upload URL is pre-authorized; sending our bearer token to it is rejected, so use the raw transport.
      const res = await uploadChunk(session.uploadUrl, bytes.subarray(start, end), start, end - 1, bytes.byteLength);
      if (res) last = res;
    }
  });
  if (!last) throw new Error(`Upload session for "${name}" finished without returning the file`);
  return { id: last.id, name: last.name, eTag: last.eTag, size: last.size, webUrl: last.webUrl };
}

async function uploadChunk(url: string, chunk: Uint8Array, first: number, last: number, total: number): Promise<DriveItemJson | undefined> {
  return (await sendUploadChunk(url, chunk, first, last, total)) as DriveItemJson | undefined;
}
