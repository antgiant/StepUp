import type { Worker } from "tesseract.js";
import { groupBoxesIntoRows } from "@step-up/shared/web";

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

const LANG_KEY = "stepup.ocrLang";
const NAMES: Record<string, string> = { eng: "English", spa: "Spanish", fra: "French", deu: "German", por: "Portuguese", ita: "Italian", hat: "Haitian Creole" };
export const ocrLanguageName = (code: string) => NAMES[code] ?? code;

/** Languages built into this site, and which are in use (a saved choice, else all of them). More languages read slower. */
export function ocrLanguages(): { available: string[]; current: string[] } {
  const available: string[] = typeof __OCR_LANGS__ === "undefined" ? ["eng"] : __OCR_LANGS__;
  let saved: string[] = [];
  try {
    saved = (localStorage.getItem(LANG_KEY) ?? "").split("+").filter((l) => available.includes(l));
  } catch {
    /* storage blocked */
  }
  return { available, current: saved.length ? saved : available };
}

export function setOcrLanguages(langs: string[]): void {
  try {
    localStorage.setItem(LANG_KEY, langs.join("+"));
  } catch {
    /* storage blocked: applies for this visit only */
  }
  const old = worker;
  worker = undefined; // the next read starts an engine for the new languages
  void old?.then((w) => w.terminate()).catch(() => undefined);
}

/**
 * The OCR engine runs entirely on this device. Its worker, WebAssembly core and English data are served from this site
 * (see ocrAssets.js), never from a CDN, and are loaded only the first time text has to be read from an image.
 */
function engine(): Promise<Worker> {
  worker ??= (async () => {
    const { createWorker } = await import("tesseract.js");
    const abs = (p: string) => new URL(`${import.meta.env.BASE_URL}${p}`, document.baseURI).href;
    return createWorker(ocrLanguages().current.join("+"), 1, {
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
  const pieces = lines
    .map((l) => ({ text: l.text.replace(/\s+/g, " ").trim(), x0: l.bbox.x0, y0: l.bbox.y0, x1: l.bbox.x1, y1: l.bbox.y1, confidence: l.confidence / 100 }))
    .filter((l) => l.text.length > 0);
  // Columns of a table come back as separate lines; put each visual row back together.
  return groupBoxesIntoRows(pieces);
}

const MAX_EDGE = 3200;
const MIN_EDGE = 1600;
const TALL_WIDTH_MIN = 1600;
const TALL_WIDTH_MAX = 2400;
const STRIP_OVERLAP = 120;

/** Light text on a dark background (dark mode) reads badly; the page is inverted when its average brightness is low. */
function invertIfDark(canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext("2d")!;
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let sum = 0;
  let n = 0;
  for (let i = 0; i < img.data.length; i += 64) {
    sum += img.data[i]! * 0.3 + img.data[i + 1]! * 0.59 + img.data[i + 2]! * 0.11;
    n++;
  }
  if (n === 0 || sum / n >= 100) return;
  for (let i = 0; i < img.data.length; i += 4) {
    img.data[i] = 255 - img.data[i]!;
    img.data[i + 1] = 255 - img.data[i + 1]!;
    img.data[i + 2] = 255 - img.data[i + 2]!;
  }
  ctx.putImageData(img, 0, 0);
}

function drawStrip(bitmap: ImageBitmap, sy: number, sh: number, scale: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.max(1, Math.round(sh * scale));
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, sy, bitmap.width, sh, 0, 0, canvas.width, canvas.height);
  invertIfDark(canvas);
  return canvas;
}

/**
 * Reads the text of a photo, screenshot or scan, top to bottom. Small images are enlarged and huge ones shrunk, which
 * helps accuracy. A long screenshot (a scrolled statement) is read in overlapping strips at a readable size instead of
 * being shrunk until its text is too small to recognise.
 */
export async function ocrImage(blob: Blob): Promise<{ text: string; lines: OcrLine[] }> {
  const bitmap = await createImageBitmap(blob);
  const tall = bitmap.height > bitmap.width * 2;
  let lines: OcrLine[] = [];
  if (!tall) {
    const long = Math.max(bitmap.width, bitmap.height);
    const scale = long > MAX_EDGE ? MAX_EDGE / long : long < MIN_EDGE ? MIN_EDGE / long : 1;
    lines = await ocrCanvas(drawStrip(bitmap, 0, bitmap.height, scale));
  } else {
    const scale = bitmap.width < TALL_WIDTH_MIN ? TALL_WIDTH_MIN / bitmap.width : bitmap.width > TALL_WIDTH_MAX ? TALL_WIDTH_MAX / bitmap.width : 1;
    const strip = Math.floor(MAX_EDGE / scale);
    const overlap = Math.ceil(STRIP_OVERLAP / scale);
    for (let top = 0; top < bitmap.height; top += strip - overlap) {
      const height = Math.min(strip, bitmap.height - top);
      const last = top + height >= bitmap.height;
      // Keep a line only from the strip that has it away from the cut, so the overlap does not read twice.
      const from = top === 0 ? -Infinity : top + overlap / 2;
      const to = last ? Infinity : top + height - overlap / 2;
      for (const l of await ocrCanvas(drawStrip(bitmap, top, height, scale))) {
        const centre = top + (l.y0 + l.y1) / 2 / scale;
        if (centre < from || centre >= to) continue;
        lines.push({ ...l, x0: l.x0 / scale, x1: l.x1 / scale, y0: top + l.y0 / scale, y1: top + l.y1 / scale });
      }
      if (last) break;
    }
  }
  lines.sort((a, b) => (a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2 || a.x0 - b.x0);
  return { text: lines.map((l) => l.text).join("\n"), lines };
}
