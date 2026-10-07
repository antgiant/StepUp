import type { MirrorCell, MirrorColumn, MirrorWorkbook } from "./model.js";

const FORMATS: Record<string, string> = { currency: '"$"#,##0.00', date: "yyyy-mm-dd", int: "0" };
const HEADER_FILL = "FF1F4E78";

function cellValue(cell: MirrorCell, col: MirrorColumn | undefined): string | number | boolean | Date | null {
  const v = cell.v ?? null;
  if (col?.format === "date" && typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) return new Date(`${v.slice(0, 10)}T00:00:00Z`);
  return v;
}

/** Renders the mirror model to an .xlsx. Values only: no formulas, no validation. ExcelJS is loaded lazily (browser and Node). */
export async function renderMirrorXlsx(model: MirrorWorkbook): Promise<Uint8Array> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = "Step Up Automator";
  wb.description = `Generated mirror. State ${model.stateHash}`;

  for (const sheet of model.sheets) {
    const ws = wb.addWorksheet(sheet.name, { views: [{ state: "frozen", ySplit: 1 }] });
    ws.columns = sheet.columns.map((c) => ({ header: c.header, width: c.width }));
    const header = ws.getRow(1);
    header.font = { bold: true, color: { argb: "FFFFFFFF" } };
    header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_FILL } };
    header.alignment = { vertical: "middle", wrapText: true };

    sheet.rows.forEach((cells, r) => {
      const row = ws.getRow(r + 2);
      cells.forEach((cell, c) => {
        const col = sheet.columns[c];
        const target = row.getCell(c + 1);
        const value = cellValue(cell, col);
        if (cell.link && typeof value === "string" && value !== "") {
          target.value = { text: value, hyperlink: cell.link };
          target.font = { color: { argb: "FF0563C1" }, underline: true };
        } else {
          target.value = value;
        }
        if (col?.format && FORMATS[col.format]) target.numFmt = FORMATS[col.format]!;
        if (cell.bold) target.font = { ...(target.font ?? {}), bold: true };
        if (cell.fill) target.fill = { type: "pattern", pattern: "solid", fgColor: { argb: cell.fill } };
      });
      row.commit();
    });

    if (sheet.autoFilter && sheet.columns.length > 0) {
      ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: sheet.columns.length } };
    }
  }
  const buffer = await wb.xlsx.writeBuffer();
  return new Uint8Array(buffer as ArrayBuffer);
}
