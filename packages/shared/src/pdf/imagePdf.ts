export interface ImagePage {
  /** A complete JPEG file. */
  jpeg: Uint8Array;
  pxWidth: number;
  pxHeight: number;
  /** Page size in PDF points (1/72 inch). */
  widthPt: number;
  heightPt: number;
}

const enc = new TextEncoder();

/**
 * Builds a PDF whose pages are nothing but one JPEG each. There is no text layer and no hidden content, which is the
 * point: a redacted page is just the pixels that were kept. Written by hand so no PDF library has to ship.
 */
export function buildImagePdf(pages: ImagePage[]): Uint8Array {
  if (pages.length === 0) throw new Error("A PDF needs at least one page");
  const parts: Uint8Array[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (b: Uint8Array | string) => {
    const bytes = typeof b === "string" ? enc.encode(b) : b;
    parts.push(bytes);
    length += bytes.byteLength;
  };
  const object = (n: number, body: string | Array<Uint8Array | string>) => {
    offsets[n] = length;
    push(`${n} 0 obj\n`);
    for (const piece of Array.isArray(body) ? body : [body]) push(piece);
    push("\nendobj\n");
  };

  push("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
  const pageObj = (i: number) => 3 + i * 3;
  object(1, "<< /Type /Catalog /Pages 2 0 R >>");
  object(2, `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, i) => `${pageObj(i)} 0 R`).join(" ")}] >>`);
  pages.forEach((p, i) => {
    const n = pageObj(i);
    const w = p.widthPt.toFixed(2);
    const h = p.heightPt.toFixed(2);
    object(n, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 ${n + 2} 0 R >> >> /Contents ${n + 1} 0 R >>`);
    const content = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;
    object(n + 1, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    object(n + 2, [
      `<< /Type /XObject /Subtype /Image /Width ${p.pxWidth} /Height ${p.pxHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.byteLength} >>\nstream\n`,
      p.jpeg,
      "\nendstream",
    ]);
  });

  const count = 3 + pages.length * 3;
  const xref = length;
  let table = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let n = 1; n < count; n++) table += `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
  push(table + `trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  const out = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}
