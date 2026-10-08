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
