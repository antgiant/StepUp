import { currentGraphConfig } from "./client.js";

/** PUTs one chunk to a pre-authorized upload-session URL (no bearer header), retrying transient failures. */
export async function sendUploadChunk(url: string, chunk: Uint8Array, first: number, last: number, total: number): Promise<unknown | undefined> {
  const cfg = currentGraphConfig();
  for (let attempt = 0; ; attempt++) {
    let res: Response | undefined;
    try {
      res = await cfg.fetch(url, {
        method: "PUT",
        headers: { "Content-Range": `bytes ${first}-${last}/${total}`, "Content-Length": String(chunk.byteLength) },
        body: chunk as BodyInit,
      });
    } catch (err) {
      if (attempt >= cfg.maxRetries) throw err;
      await cfg.sleep(Math.min(cfg.baseDelayMs * 2 ** attempt, cfg.maxDelayMs));
      continue;
    }
    if (res.status === 202) return undefined; // chunk accepted, more expected
    if (res.ok) return res.json();
    if ((res.status === 429 || res.status >= 500) && attempt < cfg.maxRetries) {
      await cfg.sleep(Math.min(cfg.baseDelayMs * 2 ** attempt, cfg.maxDelayMs));
      continue;
    }
    throw new Error(`Upload chunk failed with ${res.status}: ${await res.text().catch(() => "")}`);
  }
}
