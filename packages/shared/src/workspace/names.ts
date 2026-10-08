import type { DocumentRec, Purchase } from "../domain/types.js";

const UNSAFE = /[\\/:*?"<>|\u0000-\u001f]/g;

/**
 * A name a person can browse by in OneDrive: "2026-09-17 Amazon 54.28 a1b2c3.pdf" (purchase date, vendor, receipt total,
 * and the end of the document id so two receipts from one day never clash). Falls back to what is known.
 */
export function readableFileName(doc: DocumentRec, purchase: Purchase | undefined): string {
  const ext = /\.[A-Za-z0-9]{2,5}$/.exec(doc.filename ?? "")?.[0]?.toLowerCase() ?? "";
  const parts = [
    purchase?.date,
    purchase?.vendor?.replace(UNSAFE, " ").replace(/\s+/g, " ").trim().slice(0, 40),
    purchase?.orderTotalCents !== undefined ? (purchase.orderTotalCents / 100).toFixed(2) : undefined,
    doc.id.replace(/[^A-Za-z0-9]/g, "").slice(-6).toLowerCase(),
  ].filter(Boolean);
  return `${parts.join(" ")}${ext}`;
}
