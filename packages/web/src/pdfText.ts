import "./streamPolyfill.js";
import { ocrCanvas } from "./ocr.js";
import { buildImagePdf, positionedLines, type ImagePage, type PositionedLine, type RedactionPlan, type TextItem } from "@step-up/shared/web";

/** pdf.js is large, so it is loaded only when a PDF is read. Nothing is uploaded: everything happens on this device. */
async function openPdf(file: Blob) {
  const pdfjs = await import("pdfjs-dist");
  const worker = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
  pdfjs.GlobalWorkerOptions.workerSrc = worker;
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  return { task, doc: await task.promise };
}

/** Pages with fewer characters than this have no real text layer (a scan or a photo saved as PDF) and are read with OCR. */
const MIN_TEXT_CHARS = 20;
const OCR_SCALE = 2.5;

/**
 * The PDF's text as positioned lines, one list per page. Pages without a text layer are rendered and read with OCR;
 * `ocr` says whether that happened, because OCR text is less reliable and callers should flag it for checking.
 */
export async function pdfLines(file: Blob): Promise<{ pages: PositionedLine[][]; ocr: boolean }> {
  const { task, doc } = await openPdf(file);
  try {
    const pages: PositionedLine[][] = [];
    let ocr = false;
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const items: TextItem[] = content.items.flatMap((i) => ("str" in i ? [{ str: i.str, x: i.transform[4] as number, y: i.transform[5] as number, width: i.width, height: i.height }] : []));
      if (items.reduce((sum, i) => sum + i.str.trim().length, 0) >= MIN_TEXT_CHARS) {
        pages.push(positionedLines(items));
        continue;
      }
      ocr = true;
      const viewport = page.getViewport({ scale: OCR_SCALE });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      await page.render({ canvas, canvasContext: canvas.getContext("2d")!, viewport }).promise;
      pages.push(
        (await ocrCanvas(canvas)).map((l) => {
          // Image pixels (y down) back to PDF points (y up), so redaction boxes line up with the page.
          const [ax, ay] = viewport.convertToPdfPoint(l.x0, l.y1) as [number, number];
          const [bx, by] = viewport.convertToPdfPoint(l.x1, l.y0) as [number, number];
          return { text: l.text, x0: Math.min(ax, bx), x1: Math.max(ax, bx), y0: Math.min(ay, by), y1: Math.max(ay, by) };
        })
      );
    }
    return { pages, ocr };
  } finally {
    await task.destroy();
  }
}

/** The PDF's text, line by line (pages separated by a blank line). */
export async function pdfToText(file: Blob): Promise<{ text: string; ocr: boolean }> {
  const { pages, ocr } = await pdfLines(file);
  return { text: pages.map((lines) => lines.map((l) => l.text).join("\n")).join("\n\n"), ocr };
}

/**
 * Renders each page, paints the whole page black, and copies back only the rectangles the plan keeps. The black is
 * never "covered" content: pixels outside the kept boxes are never copied, so they cannot be recovered from the result.
 * The output is an image-only PDF (no text layer).
 */
export async function renderRedactedPdf(file: Blob, plan: RedactionPlan, scale = 2): Promise<{ bytes: Uint8Array; ocrTexts: string[] }> {
  const { task, doc } = await openPdf(file);
  try {
    const out: ImagePage[] = [];
    const ocrTexts: string[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      if (plan.pages[n - 1]?.omit) continue; // left out of the copy altogether
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale });
      const source = document.createElement("canvas");
      source.width = Math.ceil(viewport.width);
      source.height = Math.ceil(viewport.height);
      await page.render({ canvas: source, canvasContext: source.getContext("2d")!, viewport }).promise;

      const result = document.createElement("canvas");
      result.width = source.width;
      result.height = source.height;
      const ctx = result.getContext("2d")!;
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, result.width, result.height);
      for (const r of plan.pages[n - 1]?.keep ?? []) {
        const [ax, ay] = viewport.convertToViewportPoint(r.x0, r.y0) as [number, number];
        const [bx, by] = viewport.convertToViewportPoint(r.x1, r.y1) as [number, number];
        const x = Math.max(0, Math.floor(Math.min(ax, bx)));
        const y = Math.max(0, Math.floor(Math.min(ay, by)));
        const w = Math.min(result.width - x, Math.ceil(Math.abs(bx - ax)));
        const h = Math.min(result.height - y, Math.ceil(Math.abs(by - ay)));
        if (w > 0 && h > 0) ctx.drawImage(source, x, y, w, h, x, y, w, h);
      }
      // Read the finished page again, exactly as it will be sent: what OCR can read here is what anyone can read.
      ocrTexts.push((await ocrCanvas(result)).map((l) => l.text).join("\n"));
      const jpeg = await new Promise<Blob | null>((resolve) => result.toBlob(resolve, "image/jpeg", 0.8));
      if (!jpeg) throw new Error("Could not encode the redacted page.");
      const base = page.getViewport({ scale: 1 });
      out.push({ jpeg: new Uint8Array(await jpeg.arrayBuffer()), pxWidth: result.width, pxHeight: result.height, widthPt: base.width, heightPt: base.height });
    }
    return { bytes: buildImagePdf(out), ocrTexts };
  } finally {
    await task.destroy();
  }
}

/** Renders every page of a PDF to a JPEG at the given scale (1 = 72 dpi) and quality, as an image-only PDF page list. */
export async function renderPdfPagesJpeg(file: Blob, scale: number, quality: number): Promise<ImagePage[]> {
  const { task, doc } = await openPdf(file);
  try {
    const out: ImagePage[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, canvasContext: ctx, viewport }).promise;
      const jpeg = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
      if (!jpeg) throw new Error("Could not encode a page.");
      const base = page.getViewport({ scale: 1 });
      out.push({ jpeg: new Uint8Array(await jpeg.arrayBuffer()), pxWidth: canvas.width, pxHeight: canvas.height, widthPt: base.width, heightPt: base.height });
    }
    return out;
  } finally {
    await task.destroy();
  }
}
