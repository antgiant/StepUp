/** One piece of text with its position on the page (PDF coordinates: y grows upward), as pdf.js reports it. */
export interface TextItem {
  str: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
}

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** A rebuilt line of text and the box it occupies on the page (PDF coordinates). */
export interface PositionedLine extends Rect {
  text: string;
}

/**
 * Rebuilds lines of text from positioned pieces: pieces whose baselines are within `tolerance` of each other are one
 * line, read left to right; lines run top to bottom. Pure, so it is tested without a PDF.
 */
export function positionedLines(items: TextItem[], tolerance = 2.5): PositionedLine[] {
  const pieces = items.filter((i) => i.str.trim().length > 0).sort((a, b) => b.y - a.y || a.x - b.x);
  const rows: TextItem[][] = [];
  for (const piece of pieces) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(row[0]!.y - piece.y) <= tolerance) row.push(piece);
    else rows.push([piece]);
  }
  return rows.map((row) => {
    row.sort((a, b) => a.x - b.x);
    let text = "";
    let prevEnd: number | undefined;
    for (const p of row) {
      const touching = prevEnd !== undefined && p.x - prevEnd < 0.5;
      text += (text && !touching ? " " : "") + p.str.trim();
      prevEnd = p.width !== undefined ? p.x + p.width : undefined;
    }
    const height = Math.max(...row.map((p) => p.height ?? 10));
    const baseline = Math.min(...row.map((p) => p.y));
    return {
      text,
      x0: Math.min(...row.map((p) => p.x)),
      x1: Math.max(...row.map((p) => p.x + (p.width ?? p.str.length * 5))),
      y0: baseline - height * 0.3,
      y1: Math.max(...row.map((p) => p.y + (p.height ?? 10))),
    };
  });
}

/** The page's text as lines (top to bottom). Pages are joined by a blank line. */
export function linesFromTextItems(pages: TextItem[][], tolerance = 2.5): string {
  return pages.map((items) => positionedLines(items, tolerance).map((l) => l.text).join("\n")).join("\n\n");
}

/** A recognised piece of text and its box in an image (pixels, y grows downward). */
export interface BoxedText {
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  confidence: number;
}

/**
 * OCR on a screenshot of a table tends to return each column as its own line ("09/18", "AMZN Mktp", "54.28"), so a
 * transaction never shows up as one row. This joins pieces that sit on the same visual row (their vertical extents
 * overlap by at least half of the shorter one) into one left-to-right line, top to bottom. Pure, so it is tested
 * without an image.
 */
export function groupBoxesIntoRows<T extends BoxedText>(pieces: T[]): BoxedText[] {
  const sorted = [...pieces].filter((p) => p.text.trim()).sort((a, b) => a.y0 + a.y1 - (b.y0 + b.y1) || a.x0 - b.x0);
  const rows: T[][] = [];
  const extent: Array<{ y0: number; y1: number }> = [];
  for (const p of sorted) {
    const i = rows.length - 1;
    const e = extent[i];
    const overlap = e ? Math.min(e.y1, p.y1) - Math.max(e.y0, p.y0) : -1;
    const shorter = e ? Math.min(e.y1 - e.y0, p.y1 - p.y0) : 0;
    if (e && overlap >= 0.5 * shorter && overlap > 0) {
      rows[i]!.push(p);
      e.y0 = Math.min(e.y0, p.y0);
      e.y1 = Math.max(e.y1, p.y1);
    } else {
      rows.push([p]);
      extent.push({ y0: p.y0, y1: p.y1 });
    }
  }
  return rows.map((row) => {
    row.sort((a, b) => a.x0 - b.x0);
    return {
      text: row.map((p) => p.text.trim()).join(" "),
      x0: Math.min(...row.map((p) => p.x0)),
      y0: Math.min(...row.map((p) => p.y0)),
      x1: Math.max(...row.map((p) => p.x1)),
      y1: Math.max(...row.map((p) => p.y1)),
      confidence: Math.min(...row.map((p) => p.confidence)),
    };
  });
}
