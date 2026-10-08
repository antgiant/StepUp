import { buildImagePdf, positionedLines, type ImagePage, type PositionedLine, type RedactionPlan, type TextItem } from "@step-up/shared/web";

/** pdf.js is large, so it is loaded only when a PDF is read. Nothing is uploaded: everything happens on this device. */
async function openPdf(file: Blob) {
  const pdfjs = await import("pdfjs-dist");
  const worker = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
  pdfjs.GlobalWorkerOptions.workerSrc = worker;
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  return { task, doc: await task.promise };
}

/** The PDF's text layer as positioned lines, one list per page. A scanned PDF has no text layer and yields empty pages. */
export async function pdfLines(file: Blob): Promise<PositionedLine[][]> {
  const { task, doc } = await openPdf(file);
  try {
    const pages: PositionedLine[][] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const content = await (await doc.getPage(n)).getTextContent();
      const items: TextItem[] = content.items.flatMap((i) => ("str" in i ? [{ str: i.str, x: i.transform[4] as number, y: i.transform[5] as number, width: i.width, height: i.height }] : []));
      pages.push(positionedLines(items));
    }
    return pages;
  } finally {
    await task.destroy();
  }
}

/** The PDF's text, line by line (pages separated by a blank line). */
export async function pdfToText(file: Blob): Promise<string> {
  return (await pdfLines(file)).map((lines) => lines.map((l) => l.text).join("\n")).join("\n\n");
}

/**
 * Renders each page, paints the whole page black, and copies back only the rectangles the plan keeps. The black is
 * never "covered" content: pixels outside the kept boxes are never copied, so they cannot be recovered from the result.
 * The output is an image-only PDF (no text layer).
 */
export async function renderRedactedPdf(file: Blob, plan: RedactionPlan, scale = 2): Promise<Uint8Array> {
  const { task, doc } = await openPdf(file);
  try {
    const out: ImagePage[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
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
      const jpeg = await new Promise<Blob | null>((resolve) => result.toBlob(resolve, "image/jpeg", 0.8));
      if (!jpeg) throw new Error("Could not encode the redacted page.");
      const base = page.getViewport({ scale: 1 });
      out.push({ jpeg: new Uint8Array(await jpeg.arrayBuffer()), pxWidth: result.width, pxHeight: result.height, widthPt: base.width, heightPt: base.height });
    }
    return buildImagePdf(out);
  } finally {
    await task.destroy();
  }
}
