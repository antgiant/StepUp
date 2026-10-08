import type { Ledger } from "../events/ledger.js";
import { GraphError } from "../graph/client.js";
import { writeFile } from "../graph/files.js";
import { documentIdFor, guessContentKind } from "./ingest.js";

export interface UploadInput {
  name: string;
  body: Blob | Uint8Array;
  /** Hex SHA-256 of the bytes; lets the same file be recognised if it is added twice. */
  sha256?: string;
}

export type UploadResult =
  | { status: "uploaded"; documentId: string; name: string }
  | { status: "duplicate"; documentId: string; name: string };

const withSuffix = (name: string, n: number) => {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
};

/**
 * Puts a receipt in the year folder (where people already drop files) and registers it as a document, so it appears
 * in the entry queue. A file whose SHA-256 is already registered is not uploaded again. A name clash never overwrites
 * an existing file: the new one becomes "name (2).ext". The caller flushes the ledger.
 */
export async function uploadReceipt(ledger: Ledger, driveId: string, yearFolderId: string, input: UploadInput): Promise<UploadResult> {
  if (input.sha256) {
    const same = Object.values(ledger.state.documents).find((d) => d.sha256 === input.sha256);
    if (same) return { status: "duplicate", documentId: same.id, name: same.filename ?? input.name };
  }
  for (let n = 1; n <= 50; n++) {
    const name = n === 1 ? input.name : withSuffix(input.name, n);
    try {
      const stored = await writeFile(driveId, yearFolderId, name, input.body, { createOnly: true });
      const documentId = documentIdFor(stored.id);
      ledger.set(
        "document",
        documentId,
        {
          driveItemId: stored.id,
          filename: stored.name,
          sizeBytes: stored.size ?? (input.body instanceof Blob ? input.body.size : input.body.byteLength),
          contentKind: guessContentKind(stored.name),
          source: "upload",
          ...(input.sha256 ? { sha256: input.sha256 } : {}),
          ...(stored.webUrl ? { webUrl: stored.webUrl } : {}),
        },
        { label: "document.uploaded" }
      );
      return { status: "uploaded", documentId, name: stored.name };
    } catch (err) {
      if (err instanceof GraphError && err.status === 409) continue;
      throw err;
    }
  }
  throw new Error(`Could not find a free file name for "${input.name}".`);
}
