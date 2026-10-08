import { buildImagePdf } from "@step-up/shared/web";
import { renderPdfPagesJpeg } from "./pdfText.js";

export interface Shrunk {
  bytes: Uint8Array;
  mime: "application/pdf" | "image/jpeg";
  ext: "pdf" | "jpg";
  /** What was done, for the person ("scanned pages at 1.3x, quality 0.5"). */
  how: string;
}

// Steps from gentle to harsh; the first that fits wins, so a document loses as little as possible.
const PDF_STEPS: Array<[scale: number, quality: number]> = [[2, 0.8], [1.6, 0.7], [1.3, 0.6], [1.1, 0.5], [0.9, 0.45], [0.75, 0.4]];
const IMAGE_STEPS: Array<[edge: number, quality: number]> = [[3200, 0.85], [2600, 0.8], [2000, 0.7], [1600, 0.6], [1200, 0.5]];

/**
 * Makes a document fit under a size limit (StepUp rejects receipts over 5 MB). A PDF becomes an image-only PDF (its text
 * layer is lost, which StepUp does not need: it reads receipts by OCR); an image is re-encoded smaller. Throws if even the
 * harshest step is too big.
 */
export async function shrinkToLimit(blob: Blob, kind: "pdf" | "image", limitBytes: number): Promise<Shrunk> {
  const target = limitBytes * 0.95;
  if (kind === "pdf") {
    for (const [scale, quality] of PDF_STEPS) {
      const bytes = buildImagePdf(await renderPdfPagesJpeg(blob, scale, quality));
      if (bytes.byteLength <= target) return { bytes, mime: "application/pdf", ext: "pdf", how: `re-drew the pages at ${Math.round(scale * 72)} dpi, quality ${quality}` };
    }
    throw new Error("This PDF is too large to shrink under the limit; split it into parts or scan it at a lower resolution.");
  }
  const bitmap = await createImageBitmap(blob);
  const long = Math.max(bitmap.width, bitmap.height);
  for (const [edge, quality] of IMAGE_STEPS) {
    const scale = Math.min(1, edge / long);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const out = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    if (out && out.size <= target) return { bytes: new Uint8Array(await out.arrayBuffer()), mime: "image/jpeg", ext: "jpg", how: `resized to ${canvas.width}x${canvas.height}, quality ${quality}` };
  }
  throw new Error("This image is too large to shrink under the limit.");
}
