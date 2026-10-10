/**
 * A school year that is still kept in (and edited in) its Excel workbook, shown read-only.
 *
 * Excel is the authority for such a year, so nothing here is stored as truth: every open reads the workbook again and
 * derives the same ledger shape the rest of the app understands, in memory. The only thing written is a small file beside
 * the workbook that remembers which file a person said is the receipt when the sheet could not tell. This whole module
 * (and the few `legacy` checks in main.ts / workspace.ts) can be deleted once the year is settled.
 */
import {
  LegacyLedger,
  OneDriveEventStore,
  choiceKey,
  deriveLegacyYear,
  findChild,
  formatCents,
  itemsOf,
  readLegacyWorkbook,
  readReceiptChoices,
  readReceiptFiles,
  requestedCents,
  effectiveDate,
  writeReceiptChoices,
  yearSummary,
  type DriveItemRef,
  type LedgerState,
  type LegacyYear,
  type Pointer,
  type Purchase,
  type RulesContext,
  type YearInfo,
} from "@step-up/shared/web";
import type { WorkspaceCache } from "./cache.js";
import type { OpenWorkspace } from "./workspace.js";

export interface LegacyState {
  year: LegacyYear;
  ledger: LegacyLedger;
  workbook: DriveItemRef & { webUrl?: string; eTag?: string };
  folder: DriveItemRef;
  /** When Excel was last read, for the banner. */
  readAt: number;
}

const refs = (driveId: string, year: YearInfo, book: { id: string; name: string; eTag?: string; webUrl?: string }) => ({
  workbook: { driveId, itemId: book.id, name: book.name, isFolder: false, webUrl: book.webUrl, eTag: book.eTag },
  folder: { driveId, itemId: year.folderId, name: year.label, isFolder: true } satisfies DriveItemRef,
});

/** Reads the workbook and receipts folder and builds a workspace around the in-memory, read-only ledger. */
export async function openLegacyWorkspace(pointer: Pointer, years: YearInfo[], year: YearInfo, clientId: string): Promise<OpenWorkspace> {
  const { driveId } = pointer;
  if (!year.workbookName) throw new Error(`${year.label} has no tracking workbook to read.`);
  const book = await findChild(driveId, year.folderId, year.workbookName);
  if (!book) throw new Error(`${year.workbookName} was not found.`);
  const r = refs(driveId, year, book);
  const [input, choices] = await Promise.all([readLegacyWorkbook(r.workbook, r.folder, year.label), readReceiptChoices(driveId, year.folderId)]);
  const derived = deriveLegacyYear(input, choices);
  const ledger = new LegacyLedger(derived.result.events);
  return {
    pointer: { ...pointer, year: year.label },
    years,
    year,
    driveId,
    ledger,
    // Never read or written: the ledger above has its own fixed store. Present only to satisfy the workspace shape.
    store: new OneDriveEventStore(driveId, "", clientId),
    eventsId: "",
    carried: { children: 0, paymentMethods: 0 },
    legacy: { year: derived, ledger, ...r, readAt: Date.now() },
  };
}

/** Builds the read-only workspace from what was last read out of Excel (no network). Call `revalidate` next. */
export function openLegacyFromCache(pointer: Pointer, years: YearInfo[], year: YearInfo, clientId: string, rec: NonNullable<WorkspaceCache["legacy"]>): OpenWorkspace {
  const { driveId } = pointer;
  const r = refs(driveId, year, { id: rec.workbook.itemId, name: rec.workbook.name, eTag: rec.workbook.eTag, webUrl: rec.workbook.webUrl });
  const derived = deriveLegacyYear(rec.input, rec.choices);
  const ledger = new LegacyLedger(derived.result.events);
  return {
    pointer: { ...pointer, year: year.label },
    years,
    year,
    driveId,
    ledger,
    store: new OneDriveEventStore(driveId, "", clientId),
    eventsId: "",
    fromCache: true,
    carried: { children: 0, paymentMethods: 0 },
    legacy: { year: derived, ledger, ...r, readAt: rec.readAt },
  };
}

/** Looks at Excel again. Returns whether what is shown changed. The workbook itself is only re-read if it was saved since. */
export async function refreshLegacy(ws: OpenWorkspace): Promise<boolean> {
  const l = ws.legacy;
  if (!l) return false;
  const { driveId } = ws;
  // A copy saved more recently since the last look takes over as the authoritative one.
  const latest = ws.years.find((y) => y.label === ws.year.label);
  if (latest) ws.year = latest;
  const wantName = latest?.workbookName ?? l.workbook.name;
  const [book, choices, files] = await Promise.all([
    findChild(driveId, ws.year.folderId, wantName),
    readReceiptChoices(driveId, ws.year.folderId),
    readReceiptFiles(l.folder),
  ]);
  if (!book) throw new Error(`${wantName} was not found.`);
  const unchanged = book.eTag !== undefined && book.eTag === l.workbook.eTag && book.id === l.workbook.itemId;
  if (!unchanged) l.workbook = { ...l.workbook, itemId: book.id, name: book.name };
  const input = unchanged ? { ...l.year.input, files } : await readLegacyWorkbook(l.workbook, l.folder, ws.year.label);
  const derived = deriveLegacyYear(input, choices);
  const before = JSON.stringify(l.year.result.events);
  const after = JSON.stringify(derived.result.events);
  l.readAt = Date.now();
  l.workbook.eTag = book.eTag;
  l.workbook.webUrl = book.webUrl;
  if (before === after) return false;
  l.year = derived;
  l.ledger.replace(derived.result.events);
  return true;
}

/** Remembers which file is a purchase's receipt (beside the workbook). `file` undefined takes the answer back. */
export async function chooseReceipt(ws: OpenWorkspace, candidates: readonly string[], file: string | undefined, purchaseId?: string): Promise<string | undefined> {
  const l = ws.legacy;
  if (!l) return undefined;
  const itemIds = purchaseId ? itemsOf(l.ledger.state, purchaseId).map((i) => i.id) : [];
  const choices = { ...l.year.choices };
  if (file) choices[choiceKey(candidates)] = file;
  else delete choices[choiceKey(candidates)];
  await writeReceiptChoices(ws.driveId, ws.year.folderId, choices);
  const derived = deriveLegacyYear(l.year.input, choices);
  l.year = derived;
  l.ledger.replace(derived.result.events);
  // A purchase's id comes from its receipt file, so choosing (or un-choosing) one gives it a new id.
  for (const id of itemIds) {
    const moved = l.ledger.state.items[id]?.purchaseId;
    if (moved) return moved;
  }
  return purchaseId;
}

// ---- screens (plain HTML strings, like the rest of the app) -----------------------------------------------------

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const money = (c: number | undefined) => (c === undefined ? "" : formatCents(c));

export const LEGACY_VIEWS = ["queue", "statements", "summary", "reports"] as const;

export function legacyTabs(current: string): string {
  const tab = (name: string, label: string) => `<a href="#" data-go="${name}"${current === name || (name === "queue" && current === "purchase") ? ` class="on" aria-current="page"` : ""}>${label}</a>`;
  return `<div class="tabs">${tab("queue", "Purchases")}${tab("statements", "Proof of payment")}${tab("summary", "Summary")}${tab("reports", "Reports")}</div>`;
}

export function legacyBanner(ws: OpenWorkspace): string {
  const l = ws.legacy!;
  const at = new Date(l.readAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const copies = (ws.year.workbookCopies ?? 1) > 1 ? `, the most recently edited of ${ws.year.workbookCopies} copies` : "";
  const edited = ws.year.workbookModified ? ` (edited ${esc(new Date(ws.year.workbookModified).toLocaleDateString())})` : "";
  return `<p class="note banner">Showing <strong>${esc(ws.year.label)}</strong> from its Excel workbook, read-only: <em>${esc(l.workbook.name)}</em>${edited}${copies}. Excel is the source of truth: this page reads it again whenever you open it.
    Last read ${esc(at)}. <button id="legacy-refresh">Refresh from Excel</button>${l.workbook.webUrl ? ` <a href="${esc(l.workbook.webUrl)}" target="_blank" rel="noopener">Open in Excel</a>` : ""}</p>`;
}

function purchaseName(state: LedgerState, p: Purchase): string {
  const auto = [p.vendor, p.date].filter(Boolean).join(", ");
  return p.name?.trim() || auto || state.documents[p.receiptDocumentId ?? ""]?.filename || "Purchase without a receipt";
}

function purchaseTotal(state: LedgerState, id: string): number {
  return itemsOf(state, id).reduce((sum, i) => sum + requestedCents(i), 0);
}

/** A search field with a small x that clears it (phones have no reliable native one). */
export function clearableSearch(id: string, placeholder: string): string {
  return `<span class="clearable"><input id="${id}" type="search" placeholder="${esc(placeholder)}" aria-label="${esc(placeholder)}"><button type="button" class="clear-x" data-clear="${id}" aria-label="Clear">&times;</button></span>`;
}

/** What a purchase list row needs so main.ts can filter and sort it in place (see filterLegacyList). */
export interface ListRowFacts { order: number; text: string; statuses: string[]; childIds: string[]; vendor: string; name: string; date: string; totalCents: number }
export const vendorKey = (v: string | undefined): string => (v ?? "").trim().toLowerCase();

export function listRowAttrs(f: ListRowFacts): string {
  return `data-order="${f.order}" data-text="${esc(f.text)}" data-statuses="${esc(f.statuses.join("|"))}" data-children="${esc(f.childIds.join("|"))}" data-vendor="${esc(vendorKey(f.vendor))}" data-name="${esc(f.name.toLowerCase())}" data-date="${esc(f.date)}" data-total="${f.totalCents}"`;
}

/** The search box and dropdowns above a purchase list: status, student (only when there are several), vendor, and sort. */
export function listControls(o: { statuses: string[]; unclearCount?: number; children: Array<{ id: string; name?: string }>; vendors: string[] }): string {
  const vendors = new Map<string, string>();
  for (const v of o.vendors) if (v.trim() && !vendors.has(vendorKey(v))) vendors.set(vendorKey(v), v.trim());
  const opt = (v: string, label: string) => `<option value="${esc(v)}">${esc(label)}</option>`;
  const sel = (id: string, label: string, first: string, options: string) => `<select id="${id}" aria-label="${label}" style="width:auto"><option value="">${first}</option>${options}</select>`;
  return `<p class="row">${clearableSearch("legacy-search", "Search purchases, items, students")}</p>
    <p class="row">${sel("legacy-status", "Status", "All statuses", `${o.unclearCount ? `<option value="${UNCLEAR_FILTER}">Receipt unclear (${o.unclearCount})</option>` : ""}${o.statuses.map((s) => `<option>${esc(s)}</option>`).join("")}`)}${o.children.length > 1 ? sel("legacy-child", "Student", "All students", o.children.map((c) => opt(c.id, c.name ?? c.id)).join("")) : ""}${vendors.size ? sel("legacy-vendor", "Vendor", "All vendors", [...vendors.entries()].sort((a, b) => a[1].localeCompare(b[1])).map(([k, v]) => opt(k, v)).join("")) : ""}<select id="legacy-sort" aria-label="Sort by" style="width:auto"><option value="">Sort: newest first</option><option value="oldest">Sort: oldest first</option><option value="name">Sort: name A–Z</option><option value="vendor">Sort: vendor A–Z</option><option value="high">Sort: amount, high to low</option><option value="low">Sort: amount, low to high</option></select></p>`;
}

/** The "(n)" after a list's heading; filterLegacyList rewrites it to "(shown of n)" while a filter hides some. */
export const listCount = (n: number): string => `(<span id="legacy-count" data-total="${n}">${n}</span>)`;

/** The status filter's value for purchases whose receipt the sheet leaves unclear (main.ts matches it against data-unclear). */
export const UNCLEAR_FILTER = "__receipt_unclear__";
const statusOf = (i: { statusOverride?: string; stepUpStatus?: string }) => i.statusOverride ?? i.stepUpStatus ?? "(no status)";

/** Every purchase, newest first, with a search box and a status filter (both filter in place; see main.ts). */
export function legacyQueueView(l: LegacyState): string {
  const state = l.ledger.state;
  const unclear = new Map(l.year.unclear.map((u) => [u.purchaseId, u]));
  const purchases = Object.values(state.purchases)
    .filter((p) => !p.archived)
    .map((p) => {
      const items = itemsOf(state, p.id);
      const statuses = [...new Set(items.map(statusOf))];
      const dates = items.map((i) => effectiveDate(i, p)).filter((d): d is string => Boolean(d)).sort();
      return { p, items, statuses, date: dates[dates.length - 1] ?? p.date ?? "" };
    })
    .sort((a, b) => b.date.localeCompare(a.date) || a.p.id.localeCompare(b.p.id));
  const orderOf = new Map(purchases.map((x, n) => [x.p.id, n]));
  const allStatuses = [...new Set(purchases.flatMap((x) => x.statuses))].sort();
  const row = (x: (typeof purchases)[number]) => {
    const name = purchaseName(state, x.p);
    const counts = new Map<string, number>();
    for (const i of x.items) counts.set(statusOf(i), (counts.get(statusOf(i)) ?? 0) + 1);
    const summary = [...counts.entries()].map(([s, n]) => `${n} ${s}`).join(", ");
    const note = unclear.has(x.p.id) ? ` <span class="badge warn">Receipt unclear</span>` : "";
    const text = `${name} ${x.items.map((i) => `${i.description ?? ""} ${state.children[i.childId ?? ""]?.name ?? ""}`).join(" ")}`.toLowerCase();
    const vendor = x.p.vendor ?? x.items.map((i) => i.vendor).find(Boolean) ?? "";
    const attrs = listRowAttrs({ order: orderOf.get(x.p.id) ?? 0, text: `${text} ${vendor}`.toLowerCase(), statuses: x.statuses, childIds: [...new Set(x.items.map((i) => i.childId).filter((c): c is string => Boolean(c)))], vendor, name, date: x.date, totalCents: purchaseTotal(state, x.p.id) });
    return `<li class="q" ${attrs}${unclear.has(x.p.id) ? " data-unclear" : ""}><button class="row-button" data-open="${esc(x.p.id)}"><span><strong>${esc(name)}</strong>${note}<br><small>${esc(x.date)}${x.date ? " · " : ""}${money(purchaseTotal(state, x.p.id))} · ${esc(summary || "no items")}</small></span><span class="chev" aria-hidden="true">&rsaquo;</span></button></li>`;
  };
  const unclearRows = purchases.filter((x) => unclear.has(x.p.id));
  const children = Object.values(state.children);
  // Files in the folder that no purchase uses (receipts the sheet never names, forms, letters): never hidden, just kept apart.
  const used = new Set<string>([...Object.values(state.purchases).flatMap((p) => (p.receiptDocumentId ? [p.receiptDocumentId] : [])), ...Object.values(state.additionalDocs).flatMap((a) => (a.documentId ? [a.documentId] : []))]);
  const unlinked = Object.values(state.documents).filter((d) => !used.has(d.id) && d.contentKind !== "statement").sort((a, b) => (a.filename ?? a.id).localeCompare(b.filename ?? b.id));
  const unlinkedList = unlinked.length
    ? `<details><summary>Files not linked to a purchase (${unlinked.length})</summary><ul class="queue">${unlinked.map((d) => `<li class="q"><span>${esc(d.filename ?? d.id)}</span><span class="actions">${d.driveItemId ? `<button data-preview="${esc(d.id)}">Preview</button>` : ""}</span></li>`).join("")}</ul>
        <p class="note">Nothing in the workbook points to these. Some may be receipts the sheet does not name.</p></details>`
    : "";
  return `<h2>Purchases ${listCount(purchases.length)}</h2>
    <p class="note">${children.length ? `Students: ${esc(children.map((c) => c.name).join(", "))}. ` : ""}Open a purchase to see its items and files.</p>
    ${unclearRows.length ? `<p class="note warn">${unclearRows.length} purchase(s) list several files and the sheet does not say which is the receipt. They are shown with every file as additional documentation until you pick one; the answer is kept beside the workbook.</p>` : ""}
    ${listControls({ statuses: allStatuses, unclearCount: unclearRows.length, children, vendors: purchases.map((x) => x.p.vendor ?? x.items.map((i) => i.vendor).find(Boolean) ?? "") })}
    <ul class="queue" id="legacy-list">${purchases.map(row).join("") || "<li>The workbook has no purchases.</li>"}</ul>${unlinkedList}`;
}

export function legacyPurchaseView(l: LegacyState, id: string, ctx: RulesContext): string {
  const state = l.ledger.state;
  const p = state.purchases[id];
  if (!p) return `<p><a href="#" data-go="queue">&larr; Back to the list</a></p><p>That purchase is not in the workbook any more.</p>`;
  const items = itemsOf(state, id);
  const receipt = p.receiptDocumentId ? state.documents[p.receiptDocumentId] : undefined;
  const extras = Object.values(state.additionalDocs).filter((a) => a.ownerKind === "purchase" && a.ownerId === id);
  const unclear = l.year.unclear.find((u) => u.purchaseId === id);
  const picked = l.year.result.report.ambiguousReceipts.find((a) => a.resolvedFromCache && state.items[a.itemId]?.purchaseId === id);
  const docByName = (name: string) => Object.values(state.documents).find((d) => d.filename === name);
  const file = (docId: string | undefined, label?: string) => {
    const d = docId ? state.documents[docId] : undefined;
    if (!d) return `<span>${esc(label ?? "file")}</span>`;
    return `<span>${esc(d.filename ?? d.id)}</span> <span class="actions">${d.driveItemId ? `<button data-preview="${esc(d.id)}">Preview</button>` : `<small class="warn">not found in the folder</small>`}</span>`;
  };
  const kindLabel: Record<string, string> = { "payment-proof": "Proof of payment", refund: "Refund", explanation: "Explanation", preauth: "Pre-authorization", other: "Other" };
  const extraRows = extras.map((a) => `<li class="q"><div>${file(a.documentId)}<br><small>${esc(kindLabel[a.kind ?? "other"] ?? "Other")}</small></div></li>`);
  const pick = unclear
    ? `<section><h3>Which file is the receipt?</h3>
        <p class="note">The workbook lists these files on this purchase's rows and none is clearly the receipt. Pick the one that is. This is remembered beside the workbook; nothing in Excel changes.</p>
        <ul class="queue">${unclear.candidates.map((name, n) => `<li class="q"><div>${file(docByName(name)?.id, name)}</div><div class="actions"><button data-legacy-pick="${esc(id)}" data-file-index="${n}">This is the receipt</button></div></li>`).join("")}</ul></section>`
    : "";
  const undo = picked
    ? `<p class="note">You chose this file as the receipt. <button data-legacy-clear="${esc(id)}">Take my choice back</button></p>`
    : "";
  const itemRows = items.map((i) => {
    const ev = i.paidCents ?? i.approvedCents;
    return `<tr><td>${esc(state.children[i.childId ?? ""]?.name ?? "?")}</td><td>${esc(i.description)}${i.notes ? `<br><small>${esc(i.notes)}</small>` : ""}</td><td class="num">${money(i.amountCents)}</td><td class="num">${money(i.taxShippingCents)}</td>
      <td>${esc((i.categoryId && ctx.category(i.categoryId)?.path.join(" - ")) || i.categoryPath?.join(" - ") || "")}</td><td>${esc(statusOf(i))}</td><td class="num">${money(ev)}</td></tr>`;
  });
  const total = purchaseTotal(state, id);
  return `<p><a href="#" data-go="queue">&larr; Back to the list</a></p>
    <h2>${esc(purchaseName(state, p))}</h2>
    <dl class="facts">
      ${p.vendor ? `<div><dt>Vendor</dt><dd>${esc(p.vendor)}</dd></div>` : ""}${p.date ? `<div><dt>Date</dt><dd>${esc(p.date)}</dd></div>` : ""}${p.invoiceNo ? `<div><dt>Invoice #</dt><dd>${esc(p.invoiceNo)}</dd></div>` : ""}
      <div><dt>Items total</dt><dd>${money(total)}</dd></div>${p.paymentMethodId && state.paymentMethods[p.paymentMethodId]?.label ? `<div><dt>Paid with</dt><dd>${esc(state.paymentMethods[p.paymentMethodId]!.label)}</dd></div>` : ""}
    </dl>
    ${pick}
    <h3>Receipt</h3>
    ${receipt ? `<p>${file(receipt.id)}</p>${undo}` : unclear ? `<p class="note warn">Not chosen yet.</p>` : `<p class="note warn">The sheet names no receipt file for this purchase.</p>`}
    <h3>Items</h3>
    ${items.length ? `<table><thead><tr><th>Child</th><th>Description</th><th>Amount</th><th>Tax/ship</th><th>Category</th><th>Status in Excel</th><th>Reimbursed</th></tr></thead><tbody>${itemRows.join("")}</tbody></table>` : "<p>No items.</p>"}
    <h3>Additional documentation</h3>
    ${extraRows.length ? `<ul class="queue">${extraRows.join("")}</ul>` : "<p><small>None.</small></p>"}`;
}

export function legacyStatementsView(l: LegacyState): string {
  const state = l.ledger.state;
  const docs = Object.values(state.documents).filter((d) => d.contentKind === "statement").sort((a, b) => (a.filename ?? a.id).localeCompare(b.filename ?? b.id));
  const methodsFor = (name: string | undefined) => l.year.input.paymentMethods.filter((m) => m.file === name).map((m) => m.label);
  const usedBy = (docId: string) => new Set(Object.values(state.additionalDocs).filter((a) => a.documentId === docId && a.kind === "payment-proof" && a.ownerId).map((a) => a.ownerId!)).size;
  const rows = docs.map((d) => {
    const labels = methodsFor(d.filename);
    const n = usedBy(d.id);
    return `<li class="q"><div><strong>${esc(d.filename ?? d.id)}</strong><br><small>${esc(labels.join(", "))}${labels.length ? " · " : ""}${n} purchase(s) point to it</small></div>
      <div class="actions">${d.driveItemId ? `<button data-preview="${esc(d.id)}">Preview</button>` : `<small class="warn">not found in the folder</small>`}</div></li>`;
  });
  return `<h2>Proof of payment</h2>
    <p class="note">The statement files the workbook lists for each card and period, and the files its rows name as proof of payment. Statements are not read or matched for a year kept in Excel.</p>
    ${rows.length ? `<ul class="queue">${rows.join("")}</ul>` : "<p>The workbook lists no statement files.</p>"}`;
}

export function legacySummaryView(l: LegacyState, ctx: RulesContext): string {
  const state = l.ledger.state;
  const s = yearSummary(state, ctx);
  const rows = s.children.map((b) => {
    const c = state.children[b.childId]!;
    const width = b.capCents > 0 ? Math.min(100, Math.round(((b.paidCents + b.approvedCents + b.pendingCents) / b.capCents) * 100)) : 0;
    return `<tr><td><strong>${esc(c.name ?? c.id)}</strong><br><small>${esc(c.scholarship)}</small></td>
      <td class="num">${b.capCents ? money(b.capCents) : "&ndash;"}<div class="bar" title="${width}% used"><span style="width:${width}%"></span></div></td>
      <td class="num">${money(b.paidCents)}</td><td class="num">${money(b.approvedCents)}</td><td class="num">${money(b.pendingCents)}</td>
      <td class="num ${b.capCents && b.remainingCents < 0 ? "warn" : "ok"}">${b.capCents ? money(b.remainingCents) : "&ndash;"}</td><td class="num">${money(b.unfiledCents)}</td></tr>`;
  });
  const counts = Object.entries(s.statusCounts).sort(([a], [b]) => a.localeCompare(b));
  return `<h2>Summary</h2>
    <h3>Awards</h3>
    ${rows.length ? `<table><thead><tr><th>Student</th><th>Award</th><th>Paid</th><th>Approved</th><th>Pending</th><th>Remaining</th><th>Not yet filed</th></tr></thead><tbody>${rows.join("")}</tbody></table>
      <p class="note">Remaining = award &minus; paid &minus; approved &minus; pending. Awards come from the workbook's Summary sheet.</p>` : "<p>The workbook lists no students.</p>"}
    <h3>Items by status</h3>
    ${counts.length ? `<ul class="queue">${counts.map(([k, n]) => `<li><span>${esc(k)}</span><strong>${n}</strong></li>`).join("")}</ul>` : "<p>No items.</p>"}`;
}

interface Bucket {
  count: number;
  cents: number;
}

function group(state: LedgerState, key: (i: LedgerState["items"][string], p: Purchase | undefined) => string): Array<[string, Bucket]> {
  const out = new Map<string, Bucket>();
  for (const i of Object.values(state.items)) {
    if (i.archived) continue;
    const k = key(i, state.purchases[i.purchaseId ?? ""]) || "(none)";
    const b = out.get(k) ?? { count: 0, cents: 0 };
    b.count += 1;
    b.cents += requestedCents(i);
    out.set(k, b);
  }
  return [...out.entries()].sort(([a], [b]) => a.localeCompare(b));
}

export function legacyReportsView(l: LegacyState, ctx: RulesContext): string {
  const state = l.ledger.state;
  const table = (title: string, first: string, rows: Array<[string, Bucket]>) => `<h3>${esc(title)}</h3>
    <table><thead><tr><th>${esc(first)}</th><th>Items</th><th>Amount</th></tr></thead><tbody>${rows.map(([k, b]) => `<tr><td>${esc(k)}</td><td class="num">${b.count}</td><td class="num">${money(b.cents)}</td></tr>`).join("")}
    <tr><td><strong>Total</strong></td><td class="num"><strong>${rows.reduce((n, [, b]) => n + b.count, 0)}</strong></td><td class="num"><strong>${money(rows.reduce((n, [, b]) => n + b.cents, 0))}</strong></td></tr></tbody></table>`;
  const childOf = (i: { childId?: string }) => state.children[i.childId ?? ""]?.name ?? "";
  const top = (i: { categoryId?: string; categoryPath?: string[] }) => ((i.categoryId && ctx.category(i.categoryId)?.path[0]) || i.categoryPath?.[0]) ?? "";
  return `<h2>Reports</h2>
    <p class="note">Everything below is worked out from the workbook as it is right now. Amounts are what was requested (item amount plus tax and shipping).</p>
    <p class="row"><button id="legacy-download" class="primary">Download as a spreadsheet</button> <small>The same tracking sheet, summary and document list the app keeps for its own years.</small></p>
    ${table("By student", "Student", group(state, (i) => childOf(i)))}
    ${table("By status", "Status in Excel", group(state, (i) => statusOf(i)))}
    ${table("By category", "Category", group(state, (i) => top(i)))}
    ${table("By month", "Month", group(state, (i, p) => (effectiveDate(i, p) ?? "").slice(0, 7)))}`;
}

/**
 * The year as a spreadsheet, built on this device and handed to the browser to save. It is never written to OneDrive
 * (that would need the year's `_ledger` folders, which would turn it into a ledger year). ExcelJS loads only now.
 */
export async function legacySpreadsheet(ws: OpenWorkspace): Promise<{ name: string; bytes: Uint8Array }> {
  const l = ws.legacy!;
  const lib = await import("@step-up/shared/mirror");
  const rules = { ...l.year.result.rules, today: new Date().toISOString().slice(0, 10) };
  const model = lib.buildMirror(l.ledger.state, rules, { generatedAt: new Date().toISOString(), appVersion: "web (read from Excel)" });
  // "Needs Attention" is the app's own rules talking; for a year Excel owns, the sheet's status is the authority.
  model.sheets = model.sheets.filter((s) => s.name !== "Needs Attention");
  return { name: `${ws.year.label} FES UA Tracking (read from Excel).xlsx`, bytes: await lib.renderMirrorXlsx(model) };
}
