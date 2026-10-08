/**
 * Receipts and statements never change once registered, so a downloaded copy is kept on this device (Cache Storage) and
 * previews, OCR and statement reading do not have to wait on OneDrive again. It holds private files, so it is emptied on
 * Sign out and Disconnect. Everything here is best effort: a failure just means downloading again.
 */
const NAME = "stepup-docs";
const MAX_CACHED_BYTES = 25 * 1024 * 1024;
const keyFor = (workspaceKey: string, docId: string) => `https://docs.local/${encodeURIComponent(workspaceKey)}/${encodeURIComponent(docId)}`;

export async function getCachedDocument(workspaceKey: string, docId: string, expectedSize?: number): Promise<Blob | undefined> {
  try {
    const hit = await (await caches.open(NAME)).match(keyFor(workspaceKey, docId));
    if (!hit) return undefined;
    const blob = await hit.blob();
    return expectedSize !== undefined && blob.size !== expectedSize ? undefined : blob;
  } catch {
    return undefined;
  }
}

export async function cacheDocument(workspaceKey: string, docId: string, blob: Blob): Promise<void> {
  if (blob.size > MAX_CACHED_BYTES) return;
  try {
    await (await caches.open(NAME)).put(keyFor(workspaceKey, docId), new Response(blob, { headers: { "Content-Type": blob.type || "application/octet-stream" } }));
  } catch {
    /* storage full or blocked */
  }
}

export async function clearCachedDocuments(): Promise<void> {
  try {
    await caches.delete(NAME);
  } catch {
    /* nothing to clear */
  }
}
