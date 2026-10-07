import type { AdditionalDoc, DocumentRec, LedgerState, LineItem } from "../domain/types.js";
import { childBudget, daysUntil } from "../rules/budget.js";
import { displayStatus, evaluateItem, requestedCents, type RulesContext } from "../rules/readiness.js";
import type { MirrorCell, MirrorColumn, MirrorSheet, MirrorWorkbook } from "./model.js";

export const MAIN_SHEET = "FES UA Tracking Spreadsheet";
const MIN_ADDITIONAL_COLUMNS = 3;

export interface MirrorOptions {
  /** ISO timestamp, injected for determinism in tests. */
  generatedAt: string;
  appVersion?: string;
  eventCounts?: Record<string, number>;
}

const STATUS_FILL: Record<string, string> = {
  "Unfiled (Ready to Submit)": "FFD9EAD3",
  "Unfiled (Missing Things)": "FFFFF2CC",
  Submitted: "FFDDEBF7",
  Approved: "FFC6E0B4",
  Adjusted: "FFFCE4D6",
  Paid: "FFA9D08E",
  "Denied (Initial)": "FFF8CBAD",
  "Denied (Final)": "FFF4B183",
  Forfeited: "FFD9D9D9",
};

const dollars = (cents: number | undefined): number | null => (cents === undefined ? null : cents / 100);
export const shortId = (id: string): string => id.replace(/[^A-Za-z0-9]/g, "").slice(0, 8).toUpperCase();

/** cyrb53: small deterministic string hash, enough to detect "state unchanged". Not cryptographic. */
function hashString(str: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function stateHash(state: LedgerState): string {
  return hashString(canonical(state));
}

function docLink(doc: DocumentRec | undefined): MirrorCell {
  if (!doc) return { v: "" };
  return { v: doc.filename ?? doc.id, ...(doc.webUrl ? { link: doc.webUrl } : {}) };
}

function additionalFor(state: LedgerState, item: LineItem): AdditionalDoc[] {
  return Object.values(state.additionalDocs)
    .filter((a) => (a.ownerKind === "item" && a.ownerId === item.id) || (a.ownerKind === "purchase" && a.ownerId === item.purchaseId))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function buildMirror(state: LedgerState, ctx: RulesContext, opts: MirrorOptions): MirrorWorkbook {
  const deadline = state.settings["year"]?.submissionDeadline;
  const items = Object.values(state.items).sort((a, b) => {
    const da = state.purchases[a.purchaseId ?? ""]?.date ?? "";
    const db = state.purchases[b.purchaseId ?? ""]?.date ?? "";
    return da === db ? a.id.localeCompare(b.id) : da.localeCompare(db);
  });

  const maxAdditional = Math.max(MIN_ADDITIONAL_COLUMNS, ...items.map((i) => additionalFor(state, i).length));
  const columns: MirrorColumn[] = [
    { header: "ID", width: 11 },
    { header: "Child", width: 12 },
    { header: "Program", width: 10 },
    { header: "Item", width: 34 },
    { header: "Date", width: 12, format: "date" },
    { header: "Service Date", width: 12, format: "date" },
    { header: "Invoice #", width: 14 },
    { header: "Category", width: 38 },
    { header: "Quantity", width: 9, format: "int" },
    { header: "Amount", width: 12, format: "currency" },
    { header: "Tax, Shipping, etc.", width: 14, format: "currency" },
    { header: "Reim. $", width: 12, format: "currency" },
    { header: "Reimbursed Amount", width: 16, format: "currency" },
    { header: "Vendor", width: 22 },
    { header: "Service Provider", width: 22 },
    { header: "Payment Method", width: 22 },
    { header: "Benefit Message", width: 40 },
    { header: "Item/Service URL", width: 30 },
    { header: "Pre-Auth #", width: 12 },
    { header: "Status", width: 24 },
    { header: "Notes", width: 30 },
    { header: "Submitted", width: 12, format: "date" },
    { header: "Reimbursement ID", width: 16 },
    { header: "Line Number", width: 9, format: "int" },
    { header: "Documentation Count", width: 13, format: "int" },
    { header: "Receipt", width: 34 },
    ...Array.from({ length: maxAdditional }, (_, n) => ({ header: `Additional Documentation ${n + 1}`, width: 34 })),
  ];

  const attention: MirrorCell[][] = [];
  const rows: MirrorCell[][] = items.map((item) => {
    const purchase = state.purchases[item.purchaseId ?? ""];
    const child = state.children[item.childId ?? ""];
    const submission = state.submissions[item.submissionId ?? ""];
    const evaluation = evaluateItem(state, item.id, ctx);
    const status = displayStatus(item, evaluation, ctx, deadline);
    const additional = additionalFor(state, item);
    const receipt = purchase?.receiptDocumentId ? state.documents[purchase.receiptDocumentId] : undefined;
    const path = item.categoryId ? ctx.category(item.categoryId)?.path ?? item.categoryPath : item.categoryPath;

    if (evaluation.readiness === "blocked" && !item.submissionId && !item.stepUpStatus) {
      attention.push([
        { v: shortId(item.id) },
        { v: child?.name ?? "" },
        { v: item.description ?? "" },
        { v: purchase?.vendor ?? "" },
        { v: status, fill: STATUS_FILL[status] },
        { v: evaluation.reasons.map((r) => r.message).join("; ") },
      ]);
    }

    const cells: MirrorCell[] = [
      { v: shortId(item.id) },
      { v: child?.name ?? "" },
      { v: child?.scholarship ?? "" },
      { v: item.description ?? "" },
      { v: purchase?.date ?? null },
      { v: item.serviceDate ?? null },
      { v: purchase?.invoiceNo ?? "" },
      { v: path?.join(" - ") ?? "" },
      { v: item.quantity ?? null },
      { v: dollars(item.amountCents) },
      { v: dollars(item.taxShippingCents) },
      { v: dollars(requestedCents(item)) },
      { v: dollars(item.paidCents ?? item.approvedCents) },
      { v: purchase?.vendor ?? "" },
      { v: item.serviceProvider ?? "" },
      { v: state.paymentMethods[purchase?.paymentMethodId ?? ""]?.label ?? "" },
      { v: item.benefitMessage ?? "" },
      { v: item.itemUrl ?? "", ...(item.itemUrl ? { link: item.itemUrl } : {}) },
      { v: item.preAuthId ?? "" },
      { v: status, fill: STATUS_FILL[status] },
      { v: item.notes ?? "" },
      { v: submission?.submittedAt ?? null },
      { v: submission?.reimbursementId ?? "" },
      { v: item.lineNumber ?? null },
      { v: (receipt ? 1 : 0) + additional.length },
      docLink(receipt),
    ];
    for (let n = 0; n < maxAdditional; n++) {
      const a = additional[n];
      cells.push(a?.documentId ? docLink(state.documents[a.documentId]) : { v: "" });
    }
    return cells;
  });

  const main: MirrorSheet = { name: MAIN_SHEET, columns, rows, autoFilter: true };

  // ---- Summary
  const children = Object.values(state.children).sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
  const summaryRows: MirrorCell[][] = children.map((c) => {
    const b = childBudget(state, c.id);
    return [{ v: c.name ?? c.id }, ...[b.capCents, b.paidCents, b.approvedCents, b.pendingCents, b.unfiledCents, b.remainingCents].map((x) => ({ v: dollars(x) }))];
  });
  const totals = [0, 1, 2, 3, 4, 5].map((n) => summaryRows.reduce((sum, r) => sum + Number(r[n + 1]?.v ?? 0), 0));
  summaryRows.push([{ v: "Total", bold: true }, ...totals.map((x) => ({ v: x, bold: true }))]);
  summaryRows.push([{ v: "" }]);
  summaryRows.push([{ v: "Submission deadline" }, { v: deadline ?? "not set" }]);
  if (deadline) summaryRows.push([{ v: "Days remaining" }, { v: daysUntil(deadline, ctx.today) }]);
  const summary: MirrorSheet = {
    name: "Summary",
    columns: [
      { header: "Realtime Summary", width: 22 },
      ...["Cap", "Paid", "Approved", "Pending", "Unfiled", "Remaining"].map((header) => ({ header, width: 14, format: "currency" as const })),
    ],
    rows: summaryRows,
  };

  // ---- Needs Attention
  const needs: MirrorSheet = {
    name: "Needs Attention",
    columns: [
      { header: "ID", width: 11 },
      { header: "Child", width: 12 },
      { header: "Item", width: 34 },
      { header: "Vendor", width: 22 },
      { header: "Status", width: 24 },
      { header: "What is missing", width: 80 },
    ],
    rows: attention,
    autoFilter: true,
  };

  // ---- Documents
  const receiptUse = new Map<string, number>();
  for (const p of Object.values(state.purchases)) if (p.receiptDocumentId) receiptUse.set(p.receiptDocumentId, (receiptUse.get(p.receiptDocumentId) ?? 0) + 1);
  const additionalUse = new Map<string, number>();
  for (const a of Object.values(state.additionalDocs)) if (a.documentId) additionalUse.set(a.documentId, (additionalUse.get(a.documentId) ?? 0) + 1);
  const docs = Object.values(state.documents).sort((a, b) => (a.filename ?? a.id).localeCompare(b.filename ?? b.id));
  const documents: MirrorSheet = {
    name: "Documents",
    columns: [
      { header: "File", width: 44 },
      { header: "Kind", width: 14 },
      { header: "Size (KB)", width: 11, format: "int" },
      { header: "Pages", width: 8, format: "int" },
      { header: "Used as receipt", width: 15, format: "int" },
      { header: "Used as additional", width: 17, format: "int" },
      { header: "Unused", width: 9 },
      { header: "SHA-256", width: 66 },
    ],
    rows: docs.map((d) => {
      const asReceipt = receiptUse.get(d.id) ?? 0;
      const asAdditional = additionalUse.get(d.id) ?? 0;
      return [
        docLink(d),
        { v: d.contentKind ?? "" },
        { v: d.sizeBytes === undefined ? null : Math.round(d.sizeBytes / 1024) },
        { v: d.pages ?? null },
        { v: asReceipt },
        { v: asAdditional },
        { v: asReceipt + asAdditional === 0 ? "YES" : "" },
        { v: d.sha256 ?? "" },
      ];
    }),
    autoFilter: true,
  };

  // ---- Info
  const hash = stateHash(state);
  const info: MirrorSheet = {
    name: "Info",
    columns: [
      { header: "Key", width: 28 },
      { header: "Value", width: 60 },
    ],
    rows: [
      ["Generated at", opts.generatedAt],
      ["Year", state.settings["year"]?.year ?? ""],
      ["App version", opts.appVersion ?? ""],
      ["State hash", hash],
      ["Items", items.length],
      ["Purchases", Object.keys(state.purchases).length],
      ["Documents", docs.length],
      ["Note", "Generated output only. Edit data in the app; changes here are overwritten."],
      ...Object.entries(opts.eventCounts ?? {})
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([client, n]) => [`Events from ${client}`, n] as [string, number]),
    ].map(([k, v]) => [{ v: String(k) }, { v: v as string | number }]),
  };

  return { sheets: [main, summary, needs, documents, info], stateHash: hash };
}
