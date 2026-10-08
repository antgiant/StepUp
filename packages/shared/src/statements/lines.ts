/** One piece of text with its position on the page (PDF coordinates: y grows upward), as pdf.js reports it. */
export interface TextItem {
  str: string;
  x: number;
  y: number;
  width?: number;
}

/**
 * Rebuilds lines of text from positioned pieces: pieces whose baselines are within `tolerance` of each other are one
 * line, read left to right; lines run top to bottom. Pure, so it is tested without a PDF. Pages are joined by a blank line.
 */
export function linesFromTextItems(pages: TextItem[][], tolerance = 2.5): string {
  return pages.map((items) => pageLines(items, tolerance).join("\n")).join("\n\n");
}

function pageLines(items: TextItem[], tolerance: number): string[] {
  const pieces = items.filter((i) => i.str.trim().length > 0).sort((a, b) => b.y - a.y || a.x - b.x);
  const rows: TextItem[][] = [];
  for (const piece of pieces) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(row[0]!.y - piece.y) <= tolerance) row.push(piece);
    else rows.push([piece]);
  }
  return rows.map((row) => {
    row.sort((a, b) => a.x - b.x);
    let line = "";
    let prevEnd: number | undefined;
    for (const p of row) {
      const touching = prevEnd !== undefined && p.x - prevEnd < 0.5;
      line += (line && !touching ? " " : "") + p.str.trim();
      prevEnd = p.width !== undefined ? p.x + p.width : undefined;
    }
    return line;
  });
}
