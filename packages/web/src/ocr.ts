import type { Worker } from "tesseract.js";

/** One recognised line of text and its box in the image, in pixels (y grows downward). */
export interface OcrLine {
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  confidence: number;
}

export interface OcrProgress {
  status: string;
  progress: number;
}

let progressHandler: ((p: OcrProgress) => void) | undefined;
/** Lets the page show what the engine is doing ("Loading language data…", "Reading text… 40%"). */
export function onOcrProgress(fn: ((p: OcrProgress) => void) | undefined): void {
  progressHandler = fn;
}

let worker: Promise<Worker> | undefined;

/**
 * The OCR engine runs entirely on this device. Its worker, WebAssembly core and English data are served from this site
 * (see ocrAssets.js), never from a CDN, and are loaded only the first time text has to be read from an image.
 */
function engine(): Promise<Worker> {
  worker ??= (async () => {
    const { createWorker } = await import("tesseract.js");
    const abs = (p: string) => new URL(`${import.meta.env.BASE_URL}${p}`, document.baseURI).href;
    return createWorker("eng", 1, {
      workerPath: abs("ocr/worker.min.js"),
      corePath: abs("ocr/core"),
      langPath: abs("ocr/lang"),
      workerBlobURL: false,
      logger: (m) => progressHandler?.({ status: m.status, progress: m.progress }),
    });
  })();
  worker.catch(() => (worker = undefined)); // a failed start can be retried
  return worker;
}

export async function ocrCanvas(canvas: HTMLCanvasElement): Promise<OcrLine[]> {
  const { data } = await (await engine()).recognize(canvas, {}, { blocks: true });
  const lines = (data.blocks ?? []).flatMap((b) => b.paragraphs.flatMap((p) => p.lines));
  return lines
    .map((l) => ({ text: l.text.replace(/\s+/g, " ").trim(), x0: l.bbox.x0, y0: l.bbox.y0, x1: l.bbox.x1, y1: l.bbox.y1, confidence: l.confidence / 100 }))
    .filter((l) => l.text.length > 0);
}

const MAX_EDGE = 3200;
const MIN_EDGE = 1600;

/** Reads the text of a photo or scan, top to bottom. Small images are enlarged and huge ones shrunk, which helps accuracy. */
export async function ocrImage(blob: Blob): Promise<{ text: string; lines: OcrLine[] }> {
  const bitmap = await createImageBitmap(blob);
  const long = Math.max(bitmap.width, bitmap.height);
  const scale = long > MAX_EDGE ? MAX_EDGE / long : long < MIN_EDGE ? MIN_EDGE / long : 1;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const lines = (await ocrCanvas(canvas)).sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  return { text: lines.map((l) => l.text).join("\n"), lines };
}
