import { buildImagePdf, isBlurry, sharpness, toGray, type ImagePage } from "@step-up/shared/web";

export type Rotation = 0 | 90 | 180 | 270;

export interface ScanPage {
  id: number;
  blob: Blob;
  /** Object URL for the thumbnail; revoked when the page is dropped. */
  url: string;
  rotation: Rotation;
  blurry: boolean;
}

let nextId = 1;

/** Photographed page, with a quick sharpness check on a shrunken copy (so a soft photo can be retaken on the spot). */
export async function addScanPage(file: Blob): Promise<ScanPage> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 800 / bitmap.width);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(3, Math.round(bitmap.width * scale));
  canvas.height = Math.max(3, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const score = sharpness(toGray(ctx.getImageData(0, 0, canvas.width, canvas.height).data), canvas.width, canvas.height);
  return { id: nextId++, blob: file, url: URL.createObjectURL(file), rotation: 0, blurry: isBlurry(score) };
}

async function pageToJpeg(page: ScanPage, maxEdge: number, quality: number): Promise<ImagePage> {
  const bitmap = await createImageBitmap(page.blob);
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const sideways = page.rotation === 90 || page.rotation === 270;
  const canvas = document.createElement("canvas");
  canvas.width = sideways ? h : w;
  canvas.height = sideways ? w : h;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((page.rotation * Math.PI) / 180);
  ctx.drawImage(bitmap, -w / 2, -h / 2, w, h);
  const jpeg = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
  if (!jpeg) throw new Error("Could not encode a page.");
  // 200 dpi: a phone photo becomes a page of a sensible size.
  return { jpeg: new Uint8Array(await jpeg.arrayBuffer()), pxWidth: canvas.width, pxHeight: canvas.height, widthPt: (canvas.width * 72) / 200, heightPt: (canvas.height * 72) / 200 };
}

const STEPS: Array<[edge: number, quality: number]> = [[2400, 0.8], [2000, 0.7], [1600, 0.6], [1300, 0.5], [1000, 0.45]];

/** The pages, in order and rotated as shown, as one PDF that fits under the limit (the first setting that fits wins). */
export async function buildScanPdf(pages: ScanPage[], limitBytes: number): Promise<Uint8Array> {
  for (const [edge, quality] of STEPS) {
    const bytes = buildImagePdf(await Promise.all(pages.map((p) => pageToJpeg(p, edge, quality))));
    if (bytes.byteLength <= limitBytes * 0.95) return bytes;
  }
  throw new Error("These pages are too large to fit under StepUp's 5 MB limit even at low quality; scan fewer pages per file.");
}
