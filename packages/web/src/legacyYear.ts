/**
 * A school year that is still kept in (and edited in) its Excel workbook, shown read-only.
 *
 * Excel is the authority for such a year, so nothing here is stored as truth: every open reads the workbook again and
 * derives the same ledger shape the rest of the app understands, in memory. The only thing written is a small file beside
 * the workbook that remembers which file a person said is the receipt when the sheet could not tell. This whole module
 * (and the few `legacy` checks in main.ts / workspace.ts) can be deleted once the year is settled.
 */
import {
  StorageEventStore,
  LegacyLedger,
  choiceKey,
  deriveLegacyYear,
  formatCents,
  itemsOf,
  readLegacyWorkbook,
  readReceiptChoices,
  readReceiptFiles,
  requestedCents,
  effectiveDate,
  writeReceiptChoices,
  budgetStage,
  displayStatus,
  evaluateItem,
  type DriveItemRef,
  type LedgerState,
  type LegacyYear,
  type Pointer,
  type Purchase,
  type RulesContext,
  type YearInfo,
} from "@step-up/shared/web";
import { storage } from "./storage.js";
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
  const book = await storage.find(driveId, year.folderId, year.workbookName);
  if (!book) throw new Error(`${year.workbookName} was not found.`);
  const r = refs(driveId, year, book);
  const [input, choices] = await Promise.all([readLegacyWorkbook(storage, r.workbook, r.folder, year.label), readReceiptChoices(storage, driveId, year.folderId)]);
  const derived = deriveLegacyYear(input, choices);
  const ledger = new LegacyLedger(derived.result.events);
  return {
    pointer: { ...pointer, year: year.label },
    years,
    year,
    driveId,
    ledger,
    // Never read or written: the ledger above has its own fixed store. Present only to satisfy the workspace shape.
    store: new StorageEventStore(storage, driveId, "", clientId),
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
    store: new StorageEventStore(storage, driveId, "", clientId),
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
    storage.find(driveId, ws.year.folderId, wantName),
    readReceiptChoices(storage, driveId, ws.year.folderId),
    readReceiptFiles(storage, l.folder),
  ]);
  if (!book) throw new Error(`${wantName} was not found.`);
  const unchanged = book.eTag !== undefined && book.eTag === l.workbook.eTag && book.id === l.workbook.itemId;
  if (!unchanged) l.workbook = { ...l.workbook, itemId: book.id, name: book.name };
  const input = unchanged ? { ...l.year.input, files } : await readLegacyWorkbook(storage, l.workbook, l.folder, ws.year.label);
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
  await writeReceiptChoices(storage, ws.driveId, ws.year.folderId, choices);
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

export const LEGACY_VIEWS = ["queue", "statements", "summary"] as const;

export function legacyTabs(current: string): string {
  const tab = (name: string, label: string) => `<a href="#" data-go="${name}"${current === name || (name === "queue" && current === "purchase") ? ` class="on" aria-current="page"` : ""}>${label}</a>`;
  return `<div class="tabs">${tab("queue", "Purchases")}${tab("statements", "Proof of payment")}${tab("summary", "Summary")}</div>`;
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
export interface ListRowFacts { order: number; itemIds?: string[]; text: string; statuses: string[]; childIds: string[]; vendor: string; name: string; date: string; totalCents: number }
export const vendorKey = (v: string | undefined): string => (v ?? "").trim().toLowerCase();

export function listRowAttrs(f: ListRowFacts): string {
  return `data-order="${f.order}" data-items="${esc((f.itemIds ?? []).join("|"))}" data-text="${esc(f.text)}" data-statuses="${esc(f.statuses.join("|"))}" data-children="${esc(f.childIds.join("|"))}" data-vendor="${esc(vendorKey(f.vendor))}" data-name="${esc(f.name.toLowerCase())}" data-date="${esc(f.date)}" data-total="${f.totalCents}"`;
}

/** The search box and dropdowns above a purchase list: status, student (only when there are several), vendor, and sort. */
export function listControls(o: { statuses: string[]; unclearCount?: number; children: Array<{ id: string; name?: string }>; vendors: string[] }): string {
  const vendors = new Map<string, string>();
  for (const v of o.vendors) if (v.trim() && !vendors.has(vendorKey(v))) vendors.set(vendorKey(v), v.trim());
  const opt = (v: string, label: string) => `<option value="${esc(v)}">${esc(label)}</option>`;
  const sel = (id: string, label: string, first: string, options: string) => `<select id="${id}" aria-label="${label}" style="width:auto"><option value="">${first}</option>${options}</select>`;
  const behind = drill
    ? `<p class="banner drill">Showing the purchases holding the ${drill.ids.size} item(s) behind <strong>${esc(drill.title)}</strong> in a pivot table. <button data-drill-clear>Show all purchases</button></p>`
    : "";
  return `${behind}<p class="row">${clearableSearch("legacy-search", "Search purchases, items, students")}</p>
    <p class="row">${sel("legacy-status", "Status", "All statuses", `${o.unclearCount ? `<option value="${UNCLEAR_FILTER}">Receipt unclear (${o.unclearCount})</option>` : ""}${o.statuses.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join("")}`)}${o.children.length > 1 ? sel("legacy-child", "Student", "All students", o.children.map((c) => opt(c.id, c.name ?? c.id)).join("")) : ""}${vendors.size ? sel("legacy-vendor", "Vendor", "All vendors", [...vendors.entries()].sort((a, b) => a[1].localeCompare(b[1])).map(([k, v]) => opt(k, v)).join("")) : ""}<select id="legacy-sort" aria-label="Sort by" style="width:auto"><option value="">Sort: newest first</option><option value="oldest">Sort: oldest first</option><option value="name">Sort: name A–Z</option><option value="vendor">Sort: vendor A–Z</option><option value="high">Sort: amount, high to low</option><option value="low">Sort: amount, low to high</option></select></p>`;
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
    const attrs = listRowAttrs({ order: orderOf.get(x.p.id) ?? 0, itemIds: x.items.map((i) => i.id), text: `${text} ${vendor}`.toLowerCase(), statuses: x.statuses, childIds: [...new Set(x.items.map((i) => i.childId).filter((c): c is string => Boolean(c)))], vendor, name, date: x.date, totalCents: purchaseTotal(state, x.p.id) });
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
    <p class="note"><span>${children.length ? `Students: ${children.map((c) => `<span class="student" data-student="${esc(c.id)}">${esc(c.name ?? c.id)}</span>`).join(", ")}. ` : ""}Open a purchase to see its items and files.</span></p>
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

/** The Summary page's two pivot tables, for a year kept in Excel or in the app's own ledger alike. */
export function pivotTables(state: LedgerState, ctx: RulesContext): string {
  return `<p class="note">Two pivot tables you can reshape: pick what to group by, add a second grouping to spread it across columns, and choose what to total. Dollars are what was requested (item amount plus tax and shipping), and archived items are left out.</p>
    <div class="pivots">${pivotPanel(0, state, ctx)}${pivotPanel(1, state, ctx)}</div>
    <p class="row"><button data-pivot-reset>Reset both tables to the default views</button></p>`;
}

export function legacySummaryView(l: LegacyState, ctx: RulesContext): string {
  return `<h2>Summary</h2>
    ${pivotTables(l.ledger.state, ctx)}
    <p class="row"><button id="legacy-download" class="primary">Download as a spreadsheet</button> <small>The same tracking sheet, summary and document list the app keeps for its own years.</small></p>`;
}

type Item = LedgerState["items"][string];
interface Dimension { label: string; of: (i: Item, p: Purchase | undefined, state: LedgerState, ctx: RulesContext) => string }

/** What a pivot table can group by. The key is stored in the person's saved choices, so keep keys stable. */
const DIMENSIONS: Record<string, Dimension> = {
  child: { label: "Student", of: (i, _p, st) => st.children[i.childId ?? ""]?.name ?? "" },
  vendor: { label: "Store / vendor", of: (_i, p) => (p?.vendor ?? "").trim() },
  // Same wording the rest of the app uses, so an item the sheet gives no status reads "Unfiled (...)" rather than blank.
  status: {
    label: "Status",
    of: (i, _p, st, ctx) => i.statusOverride ?? i.stepUpStatus ?? (i.submissionId ? "Submitted" : displayStatus(i, evaluateItem(st, i.id, ctx), ctx, Object.values(st.settings)[0]?.submissionDeadline)),
  },
  category: { label: "Category (top level)", of: (i, _p, _s, ctx) => ((i.categoryId && ctx.category(i.categoryId)?.path[0]) || i.categoryPath?.[0]) ?? "" },
  categoryFull: { label: "Category (full path)", of: (i, _p, _s, ctx) => ((i.categoryId && ctx.category(i.categoryId)?.path.join(" - ")) || i.categoryPath?.join(" - ")) ?? "" },
  provider: { label: "Service provider", of: (i) => (i.serviceProvider ?? "").trim() },
  month: { label: "Month", of: (i, p) => (effectiveDate(i, p) ?? "").slice(0, 7) },
  scholarship: { label: "Scholarship", of: (i, _p, st) => st.children[i.childId ?? ""]?.scholarship ?? "" },
};

/**
 * An "Across" choice that is not a grouping: the columns become the award and where its money stands (paid, approved,
 * pending, what is left, and what is not yet filed). Always dollars, and the award is only known for rows that are
 * students (or scholarships, which add their students' awards up).
 */
export const BUDGET_COLS = "budget";
const BUDGET_HEADS = ["Award", "Paid", "Approved", "Pending", "Remaining", "Not yet filed"] as const;
const STAGE_HEAD = { paid: "Paid", approved: "Approved", pending: "Pending", unfiled: "Not yet filed" } as const;

export interface PivotConfig { rows: string; cols: string; value: "dollars" | "count" | "both" }
const PIVOT_KEY = "stepup.pivots.2";
const PIVOT_DEFAULTS: PivotConfig[] = [
  { rows: "child", cols: BUDGET_COLS, value: "dollars" },
  { rows: "status", cols: "", value: "dollars" },
];
let pivots: PivotConfig[] | undefined;

function loadPivots(): PivotConfig[] {
  if (pivots) return pivots;
  let saved: unknown;
  try { saved = JSON.parse(localStorage.getItem(PIVOT_KEY) ?? "null"); } catch { /* storage blocked: defaults */ }
  const ok = (c: unknown): c is PivotConfig => !!c && typeof c === "object" && (c as PivotConfig).rows in DIMENSIONS && ((c as PivotConfig).cols === "" || (c as PivotConfig).cols === BUDGET_COLS || (c as PivotConfig).cols in DIMENSIONS) && ["dollars", "count", "both"].includes((c as PivotConfig).value);
  pivots = Array.isArray(saved) && saved.length === 2 && saved.every(ok) ? (saved as PivotConfig[]) : PIVOT_DEFAULTS.map((c) => ({ ...c }));
  return pivots;
}

/** Puts both pivot tables back to their default views and forgets any saved choice. */
export function resetPivots(): void {
  pivots = PIVOT_DEFAULTS.map((c) => ({ ...c }));
  try { localStorage.removeItem(PIVOT_KEY); } catch { /* nothing saved to forget */ }
}

/** Applies one changed dropdown (`data-pivot="<table>:<rows|cols|value>"`); returns false if it was not a pivot control. */
export function setPivot(which: string, value: string): boolean {
  const [n, field] = which.split(":");
  const all = loadPivots();
  const cfg = all[Number(n)];
  if (!cfg || !["rows", "cols", "value"].includes(field ?? "")) return false;
  (cfg as unknown as Record<string, string>)[field!] = value;
  if (!(cfg.rows in DIMENSIONS)) cfg.rows = "child";
  if (cfg.cols && cfg.cols !== BUDGET_COLS && !(cfg.cols in DIMENSIONS)) cfg.cols = "";
  if (!["dollars", "count", "both"].includes(cfg.value)) cfg.value = "dollars";
  try { localStorage.setItem(PIVOT_KEY, JSON.stringify(all)); } catch { /* kept for this visit only */ }
  return true;
}

interface Bucket { count: number; cents: number }
const addTo = (b: Bucket | undefined, cents: number): Bucket => {
  const x = b ?? { count: 0, cents: 0 };
  x.count += 1;
  x.cents += cents;
  return x;
};

/** One item as the pivot placed it: its row label and column label (a stage heading in award mode). */
interface PivotEntry { id: string; r: string; c: string }

/** Pivots the year's (unarchived) items: row labels, column labels (just "Total" when no column grouping) and the cells. */
export function pivot(state: LedgerState, ctx: RulesContext, cfg: PivotConfig): { rows: string[]; cols: string[]; cell: Map<string, Bucket>; rowTotal: Map<string, Bucket>; colTotal: Map<string, Bucket>; total: Bucket; entries: PivotEntry[] } {
  const rowDim = DIMENSIONS[cfg.rows]!;
  const budget = cfg.cols === BUDGET_COLS;
  const colDim = cfg.cols && !budget ? DIMENSIONS[cfg.cols] : undefined;
  // Names that differ only in case ("Amazon" / "amazon") are one row; the first spelling seen is shown.
  const spelling = new Map<string, string>();
  const label = (raw: string) => {
    const v = raw || "(none)";
    const k = v.toLowerCase();
    if (!spelling.has(k)) spelling.set(k, v);
    return spelling.get(k)!;
  };
  const cell = new Map<string, Bucket>();
  const rowTotal = new Map<string, Bucket>();
  const colTotal = new Map<string, Bucket>();
  const total: Bucket = { count: 0, cents: 0 };
  // Every student shows in an award table, even one with nothing filed yet; their award is what they have to spend.
  const award = new Map<string, number>();
  if (budget && (cfg.rows === "child" || cfg.rows === "scholarship")) {
    for (const c of Object.values(state.children)) {
      const r = label(rowDim.of({ childId: c.id } as Item, undefined, state, ctx));
      rowTotal.set(r, rowTotal.get(r) ?? { count: 0, cents: 0 });
      award.set(r, (award.get(r) ?? 0) + (c.capCents ?? 0));
    }
  }
  const entries: PivotEntry[] = [];
  for (const [id, i] of Object.entries(state.items)) {
    if (i.archived) continue;
    const p = state.purchases[i.purchaseId ?? ""];
    const r = label(rowDim.of(i, p, state, ctx));
    if (budget) {
      const at = budgetStage(i);
      if (!at) continue;
      const head = STAGE_HEAD[at.stage];
      entries.push({ id, r, c: head });
      cell.set(`${r}\u0000${head}`, addTo(cell.get(`${r}\u0000${head}`), at.cents));
      rowTotal.set(r, rowTotal.get(r) ?? { count: 0, cents: 0 });
      continue;
    }
    const c = colDim ? label(colDim.of(i, p, state, ctx)) : "Total";
    const cents = requestedCents(i);
    entries.push({ id, r, c });
    cell.set(`${r}\u0000${c}`, addTo(cell.get(`${r}\u0000${c}`), cents));
    rowTotal.set(r, addTo(rowTotal.get(r), cents));
    colTotal.set(c, addTo(colTotal.get(c), cents));
    addTo(total, cents);
  }
  if (budget) {
    const rows = [...rowTotal.keys()];
    const at = (r: string, h: string) => cell.get(`${r}\u0000${h}`)?.cents ?? 0;
    for (const r of rows) {
      for (const h of ["Paid", "Approved", "Pending", "Not yet filed"]) cell.set(`${r}\u0000${h}`, { count: cell.get(`${r}\u0000${h}`)?.count ?? 0, cents: at(r, h) });
      const cap = award.get(r) ?? 0;
      // No award on file: the Award and Remaining cells stay empty rather than showing a made-up zero.
      if (cap > 0) {
        cell.set(`${r}\u0000Award`, { count: 0, cents: cap });
        cell.set(`${r}\u0000Remaining`, { count: 0, cents: cap - at(r, "Paid") - at(r, "Approved") - at(r, "Pending") });
      }
    }
    for (const h of BUDGET_HEADS) {
      const got = rows.map((r) => cell.get(`${r}\u0000${h}`)).filter((b): b is Bucket => Boolean(b));
      if (got.length) colTotal.set(h, { count: 0, cents: got.reduce((n, b) => n + b.cents, 0) });
    }
  }
  const sorted = (m: Map<string, Bucket>) => [...m.keys()].sort((a, b) => (a === "(none)" ? 1 : b === "(none)" ? -1 : a.localeCompare(b)));
  return { rows: sorted(rowTotal), cols: budget ? [...BUDGET_HEADS] : colDim ? sorted(colTotal) : ["Total"], cell, rowTotal, colTotal, total, entries };
}

/** The items behind a cell: `row` / `col` left out mean the total row / total column. In award mode the award and what is left stand on the money that is spoken for. */
function membersOf(entries: PivotEntry[], budget: boolean, row?: string, col?: string): string[] {
  const cols = budget && (col === "Award" || col === "Remaining") ? ["Paid", "Approved", "Pending"] : col === undefined ? undefined : [col];
  return entries.filter((e) => (row === undefined || e.r === row) && (!cols || cols.includes(e.c))).map((e) => e.id);
}

/** What the purchase list is narrowed to after a pivot cell is clicked (see main.ts); undefined when showing everything. */
let drill: { title: string; ids: Set<string> } | undefined;
export const getDrill = (): { title: string; ids: Set<string> } | undefined => drill;
export const clearDrill = (): void => { drill = undefined; };

/** Narrows the purchase list to the items that make up one cell of pivot table `n`. */
export function drillInto(state: LedgerState, ctx: RulesContext, n: number, row?: string, col?: string): void {
  const cfg = loadPivots()[n]!;
  const pv = pivot(state, ctx, cfg);
  const budget = cfg.cols === BUDGET_COLS;
  const parts = [row !== undefined ? `${DIMENSIONS[cfg.rows]!.label} ${row}` : "", col !== undefined ? (budget ? col : `${DIMENSIONS[cfg.cols]!.label} ${col}`) : ""].filter(Boolean);
  drill = { title: parts.join(" \u00b7 ") || "the whole table", ids: new Set(membersOf(pv.entries, budget, row, col)) };
}

function pivotPanel(n: number, state: LedgerState, ctx: RulesContext): string {
  const cfg = loadPivots()[n]!;
  const pv = pivot(state, ctx, cfg);
  const budget = cfg.cols === BUDGET_COLS;
  const show = (b: Bucket | undefined): string => {
    if (!b) return "&ndash;";
    return cfg.value === "count" ? String(b.count) : cfg.value === "dollars" ? money(b.cents) : `${b.count} &middot; ${money(b.cents)}`;
  };
  const opts = (current: string, entries: Array<[string, string]>) => entries.map(([k, v]) => `<option value="${esc(k)}"${k === current ? " selected" : ""}>${esc(v)}</option>`).join("");
  const dims = Object.entries(DIMENSIONS).map(([k, d]) => [k, d.label] as [string, string]);
  /** A cell's figure as a button into the list of items behind it; plain text when nothing is behind it. */
  const link = (text: string, row?: string, col?: string): string =>
    membersOf(pv.entries, budget, row, col).length ? `<button class="cell-link" data-pcell="${n}"${row !== undefined ? ` data-prow="${esc(row)}"` : ""}${col !== undefined ? ` data-pcol="${esc(col)}"` : ""}>${text}</button>` : text;
  const rowLabel = DIMENSIONS[cfg.rows]!.label;
  const scholarship = new Map(Object.values(state.children).map((c) => [(c.name ?? "").toLowerCase(), c.scholarship] as const));
  const heading = budget ? "Awards" : cfg.cols ? `${rowLabel} by ${DIMENSIONS[cfg.cols]!.label.toLowerCase()}` : `${rowLabel}`;
  const rowHead = (r: string) => `${cfg.rows === "child" ? `<strong>${esc(r)}</strong>${scholarship.get(r.toLowerCase()) ? `<br><small>${esc(scholarship.get(r.toLowerCase()))}</small>` : ""}` : esc(r)}`;

  let head: string;
  let body: string;
  let foot: string;
  if (budget) {
    const cents = (r: string, h: string) => pv.cell.get(`${r}\u0000${h}`)?.cents ?? 0;
    head = `<th>${esc(rowLabel)}</th>${pv.cols.map((c) => `<th class="num">${c}</th>`).join("")}`;
    body = pv.rows.map((r) => {
      const award = pv.cell.get(`${r}\u0000Award`);
      // How much of the award is spoken for, as a bar under it.
      const used = award && award.cents > 0 ? Math.min(100, Math.round(((cents(r, "Paid") + cents(r, "Approved") + cents(r, "Pending")) / award.cents) * 100)) : 0;
      const left = pv.cell.get(`${r}\u0000Remaining`);
      return `<tr><th scope="row">${rowHead(r)}</th>
        <td class="num">${link(show(award), r, "Award")}${award ? `<div class="bar" title="${used}% used"><span style="width:${used}%"></span></div>` : ""}</td>
        ${["Paid", "Approved", "Pending"].map((h) => `<td class="num">${link(show(pv.cell.get(`${r}\u0000${h}`)), r, h)}</td>`).join("")}
        <td class="num ${left && left.cents < 0 ? "warn" : "ok"}">${link(show(left), r, "Remaining")}</td><td class="num">${link(show(pv.cell.get(`${r}\u0000Not yet filed`)), r, "Not yet filed")}</td></tr>`;
    }).join("");
    foot = `<tr><th scope="row">Total</th>${pv.cols.map((c) => `<td class="num">${link(`<strong>${show(pv.colTotal.get(c))}</strong>`, undefined, c)}</td>`).join("")}</tr>`;
  } else {
    const spread = Boolean(cfg.cols);
    head = `<th>${esc(rowLabel)}</th>${spread ? pv.cols.map((c) => `<th class="num">${esc(c)}</th>`).join("") : ""}<th class="num">Total</th>`;
    body = pv.rows.map((r) => `<tr><th scope="row">${rowHead(r)}</th>${spread ? pv.cols.map((c) => `<td class="num">${link(show(pv.cell.get(`${r}\u0000${c}`)), r, c)}</td>`).join("") : ""}<td class="num">${link(`<strong>${show(pv.rowTotal.get(r))}</strong>`, r)}</td></tr>`).join("");
    foot = `<tr><th scope="row">Total</th>${spread ? pv.cols.map((c) => `<td class="num">${link(`<strong>${show(pv.colTotal.get(c))}</strong>`, undefined, c)}</td>`).join("") : ""}<td class="num">${link(`<strong>${show(pv.total)}</strong>`)}</td></tr>`;
  }
  return `<section class="pivot">
    <h3>${esc(heading)}</h3>
    <div class="pivot-controls">
      <label>Group by<select data-pivot="${n}:rows">${opts(cfg.rows, dims)}</select></label>
      <label>Across<select data-pivot="${n}:cols">${opts(cfg.cols, [["", "(nothing)"], [BUDGET_COLS, "Award, paid, approved, pending, remaining"], ...dims])}</select></label>
      ${budget ? "" : `<label>Show<select data-pivot="${n}:value">${opts(cfg.value, [["dollars", "Dollars"], ["count", "Item count"], ["both", "Count and dollars"]])}</select></label>`}
    </div>
    ${pv.rows.length ? `<div class="pivot-scroll"><table><thead><tr>${head}</tr></thead><tbody>${body}${foot}</tbody></table></div>` : "<p>No items.</p>"}
    ${budget ? `<p class="note">Remaining = award &minus; paid &minus; approved &minus; pending. "Not yet filed" is informational and not counted against the award. Awards are only known when grouping by student or scholarship.</p>` : ""}
  </section>`;
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
