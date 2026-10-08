import { linesFromTextItems, type TextItem } from "@step-up/shared/web";

/**
 * Reads the text layer of a PDF in the browser (nothing is uploaded anywhere) and returns it as lines.
 * pdf.js is large, so it is loaded only when a statement is read. A scanned PDF has no text layer and yields "".
 */
export async function pdfToText(file: Blob): Promise<string> {
  const pdfjs = await import("pdfjs-dist");
  const worker = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
  pdfjs.GlobalWorkerOptions.workerSrc = worker;
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  const doc = await task.promise;
  const pages: TextItem[][] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const content = await (await doc.getPage(n)).getTextContent();
    pages.push(
      content.items.flatMap((i) => ("str" in i ? [{ str: i.str, x: i.transform[4] as number, y: i.transform[5] as number, width: i.width }] : []))
    );
  }
  await task.destroy();
  return linesFromTextItems(pages);
}
