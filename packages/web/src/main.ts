import {
  HlcClock,
  Ledger,
  createSubfolder,
  folderFromLink,
  inviteToFolder,
  listLooseFiles,
  myDriveRoot,
  sharedFolders,
  subfolders,
  type FolderEntry,
  planIngest,
  registerLooseFiles,
  addItem,
  attachAdditional,
  attachAsReceipt,
  buildQueue,
  duplicateItem,
  evaluateItem,
  fileNameHints,
  formatCents,
  itemsOf,
  newId,
  reallocateTax,
  observeActivity,
  fetchItemContent,
  uploadReceipt,
  setPurchaseArchived,
  remainingToItemize,
  startPurchaseFromDocument,
  suggestNextItem,
  toCents,
  type EventStore,
  type ResolvedReference,
  type CategoryReference,
  addOrFixCategory,
  exportCategoryEdits,
  resolveReference,
  type MapTarget,
  type RulesContext,
} from "@step-up/shared/web";
import { initAuth, signIn, signOut } from "./auth.js";
import { LocalEventStore, exportJsonl, parseJsonl } from "./localStore.js";
import { cacheKey, clearCache, deleteCache, readCache, readOutbox, writeCache, writeOutbox } from "./cache.js";
import { loadPointer, openFromCache, openWorkspace, revalidate, snapshotFor, NoLedgerYearError, isDeadPointer, pointerFromFolder, workspaceFolder, forgetLocalPointer, savePointer, startYear, type Pointer, type OpenWorkspace } from "./workspace.js";
import { loadBaseline as loadReference } from "./reference.js";
import { photoName, prepareUpload, previewKind, sha256Hex, type PreviewKind } from "./files.js";
import "./style.css";

const CLIENT_KEY = "stepup.clientId";
function clientId(): string {
  try {
    const have = localStorage.getItem(CLIENT_KEY);
    if (have) return have;
    const made = newId("web");
    localStorage.setItem(CLIENT_KEY, made);
    return made;
  } catch {
    return newId("web");
  }
}

const store = new LocalEventStore(clientId());
let ledger = new Ledger(store, new HlcClock(store.clientId), "web");
let account: Awaited<ReturnType<typeof initAuth>> = null;
let workspace: OpenWorkspace | undefined;
let activeStore: EventStore = store;
let status = "";
/** Folder picker (onboarding): `path` empty means the top level (own OneDrive + folders shared with the person). */
let picker: { path: FolderEntry[]; mine?: FolderEntry; shared: FolderEntry[]; list: FolderEntry[] } = { path: [], shared: [], list: [] };
let pendingYear: Pointer | undefined;
let sharing = false;

/** Shared category tree (plan §3.8), loaded in the background. Until it arrives (or if it cannot load) every category counts as known. */
let referenceBase: CategoryReference | undefined;
let resolved: { state: object; ref: ResolvedReference } | undefined;
/** Baseline tree plus this year's edits; recomputed only when the ledger state changes. */
function reference(): ResolvedReference | undefined {
  if (!referenceBase) return undefined;
  const state = ledger.state;
  if (resolved?.state !== state) resolved = { state, ref: resolveReference(referenceBase, state.categories) };
  return resolved.ref;
}
const anyCategory = (id: string) => ({ id, path: [], requiresServiceDate: false, eligibleScholarships: [], isActive: true });
const ctx = (): RulesContext => ({
  today: new Date().toISOString().slice(0, 10),
  // Ids from older imports ("legacy-cat-…") that the tree does not know stay accepted, as the importer always allowed them.
  category: (id) => {
    const ref = reference();
    return ref ? ref.category(id) ?? (id.startsWith("legacy-cat-") ? anyCategory(id) : undefined) : anyCategory(id);
  },
});
const categoryLabel = (i: { categoryId?: string; categoryPath?: string[] }) =>
  (i.categoryId && reference()?.category(i.categoryId)?.path.join(" - ")) || i.categoryPath?.join(" - ") || i.categoryId || "";

/** `draft` purchases exist only on screen until a detail is saved, so backing out never leaves an empty one behind. */
/** The receipt being looked at. Documents never change, so a downloaded copy is kept for the session. */
let preview: { docId: string; filename: string; url: string; kind: PreviewKind; webUrl?: string } | undefined;
const downloaded = new Map<string, { url: string; kind: PreviewKind }>();

async function openPreview(docId: string): Promise<void> {
  const doc = ledger.state.documents[docId];
  if (!doc?.driveItemId || !workspace) return;
  const filename = doc.filename ?? "receipt";
  let got = downloaded.get(docId);
  if (!got) {
    const res = await fetchItemContent(workspace.driveId, doc.driveItemId, `Downloading ${filename}…`);
    const blob = await res.blob();
    const kind = previewKind(filename, blob.type);
    const typed = kind === "pdf" && blob.type !== "application/pdf" ? new Blob([blob], { type: "application/pdf" }) : blob;
    got = { url: URL.createObjectURL(typed), kind };
    downloaded.set(docId, got);
  }
  preview = { docId, filename, ...got, ...(doc.webUrl ? { webUrl: doc.webUrl } : {}) };
}

function previewPanel(): string {
  if (!preview) return "";
  const open = preview.webUrl?.startsWith("https://") ? ` <a href="${esc(preview.webUrl)}" target="_blank" rel="noopener">Open in OneDrive</a>` : "";
  const body =
    preview.kind === "image" ? `<img src="${esc(preview.url)}" alt="${esc(preview.filename)}">`
    : preview.kind === "pdf" ? `<iframe src="${esc(preview.url)}" title="${esc(preview.filename)}"></iframe>`
    : `<p class="note">This file type cannot be previewed here.${open}</p>`;
  return `<section class="preview"><div class="preview-bar"><strong>${esc(preview.filename)}</strong><span>${preview.kind === "other" ? "" : open}<button id="close-preview">Close</button></span></div>${body}</section>`;
}

async function uploadFiles(files: File[], fromCamera: boolean): Promise<void> {
  if (!workspace || files.length === 0) return;
  const ws = workspace;
  await guarded(async () => {
    let added = 0;
    const dupes: string[] = [];
    for (const [i, file] of files.entries()) {
      note(`Preparing ${file.name} (${i + 1} of ${files.length})…`);
      const prepared = await prepareUpload(file);
      const name = fromCamera ? photoName(file) : prepared.name;
      const result = await uploadReceipt(ledger, ws.driveId, ws.year.folderId, { name, body: prepared.body, sha256: (await sha256Hex(prepared.body)) || undefined });
      if (result.status === "uploaded") added++;
      else dupes.push(result.name);
      await ledger.flush();
    }
    persist();
    status = [added ? `Added ${added} file(s) to the list.` : "", dupes.length ? `Already added, skipped: ${dupes.join(", ")}.` : ""].filter(Boolean).join(" ");
  }, "Uploading to OneDrive…");
}

type View = { name: "queue" } | { name: "purchase"; id: string; draft?: boolean };
let view: View = { name: "queue" };
const root = document.getElementById("app")!;

/** Spinner shown while we wait on OneDrive. Lives outside #app so re-rendering never removes it. */
const busyEl = Object.assign(document.createElement("div"), { className: "busy", hidden: true, role: "status" });
busyEl.setAttribute("aria-live", "polite");
document.body.append(busyEl);
let pending = 0;
let fallbackLabel = "";
/** Requests in flight right now, by id, with their plain-language label (see describeRequest in shared). */
const active = new Map<number, string>();
observeActivity((ev) => {
  if (ev.type === "end") active.delete(ev.id);
  else active.set(ev.id, ev.label);
  paintBusy();
});
/** Shows what we are actually waiting on (the newest request), else the operation the person started. */
function paintBusy(): void {
  const labels = [...active.values()];
  const main = labels[labels.length - 1] ?? fallbackLabel;
  if (!main || (pending === 0 && labels.length === 0)) {
    busyEl.hidden = true;
    document.body.removeAttribute("aria-busy");
    return;
  }
  const more = labels.length > 1 ? `<small>+${labels.length - 1} more</small>` : "";
  busyEl.innerHTML = `<span class="spinner" aria-hidden="true"></span><span>${esc(main)}</span>${more}`;
  busyEl.hidden = false;
  document.body.setAttribute("aria-busy", "true");
}
/** Names the current operation; shown whenever no more specific request is in flight. */
function note(label: string): void {
  fallbackLabel = label;
  paintBusy();
}
function showBusy(label: string): void {
  pending++;
  note(label);
}
function hideBusy(): void {
  pending = Math.max(0, pending - 1);
  if (pending === 0) fallbackLabel = "";
  paintBusy();
}

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const val = (form: HTMLFormElement, name: string) => (form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement | null)?.value.trim() ?? "";

/** The folder was deleted or access was removed while open: same as having no folder. */
async function dropWorkspace(): Promise<void> {
  forgetCache();
  clearPreviews();
  await savePointer(undefined);
  workspace = undefined;
  activeStore = store;
  ledger = new Ledger(store, new HlcClock(store.clientId), "web");
  await ledger.refresh();
  await pickerTop().catch(() => undefined);
  status = "That folder is no longer available. Choose a folder to continue.";
}

function clearPreviews(): void {
  preview = undefined;
  for (const d of downloaded.values()) URL.revokeObjectURL(d.url);
  downloaded.clear();
}

/** Browser cache of the open workspace (see cache.ts). Best effort: failures just mean a slower next visit. */
const keyOf = (p: Pointer) => cacheKey(account?.homeAccountId ?? "", p.driveId, p.rootId, p.year ?? "");
function persist(): void {
  if (account && workspace) void writeCache(keyOf(workspace.pointer), snapshotFor(workspace));
}
function forgetCache(): void {
  if (account && workspace) {
    void deleteCache(keyOf(workspace.pointer));
    void writeOutbox(keyOf(workspace.pointer), []);
  }
}

/** Keeps unuploaded edits on this device, and takes back any left over from an earlier visit. */
async function useOutbox(ws: OpenWorkspace): Promise<void> {
  const key = keyOf(ws.pointer);
  const left = await readOutbox(key);
  ws.ledger.onPendingChange = (pending) => void writeOutbox(key, pending);
  if (left.length === 0 || workspace !== ws) return;
  ws.ledger.restorePending(left);
  status = `Recovered ${left.length} change(s) that had not been saved to OneDrive; saving them now.`;
  render();
  await save();
}
window.addEventListener("online", () => {
  if (workspace && ledger.unflushedCount > 0) void save();
  else render();
});
window.addEventListener("offline", render);
let lastRefresh = Date.now();
const typing = () => document.activeElement instanceof HTMLElement && root.contains(document.activeElement) && /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName);

/** Stale-while-revalidate: the cached view is already on screen; ask OneDrive what changed and update only if something did. */
async function refreshInBackground(ws: OpenWorkspace): Promise<void> {
  showBusy("Refreshing from OneDrive…");
  try {
    const changed = await revalidate(ws);
    lastRefresh = Date.now();
    if (workspace !== ws) return;
    persist();
    if (changed && !typing()) render(); // never replace a form someone is typing in; the next action shows the update
  } catch (err) {
    if (workspace !== ws) return;
    if (isDeadPointer(err)) await dropWorkspace();
    else status = `Showing saved data; could not refresh from OneDrive (${err instanceof Error ? err.message : err}).`;
    render();
  } finally {
    hideBusy();
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && workspace && !workspace.fromCache && pending === 0 && Date.now() - lastRefresh > 2 * 60_000) void refreshInBackground(workspace);
});

/** Runs an action that may hit the network; shows the error instead of leaving the page half-updated. */
async function guarded(action: () => Promise<void>, label = "Waiting for OneDrive…"): Promise<void> {
  status = "";
  showBusy(label);
  try {
    await action();
  } catch (err) {
    if (workspace && isDeadPointer(err)) {
      await dropWorkspace();
    } else {
      status = err instanceof Error ? err.message : String(err);
    }
  } finally {
    hideBusy();
  }
  render();
}

async function save(): Promise<void> {
  await guarded(() => ledger.flush(), "Saving to OneDrive…");
  persist();
}

function attach(next: OpenWorkspace | undefined): void {
  workspace = next;
  if (next) {
    ledger = next.ledger;
    activeStore = ledger.store;
    void savePointer(next.pointer);
    if (!next.fromCache) persist();
    void useOutbox(next);
    if (next.carriedChildren) {
      status = `Added ${next.carriedChildren} student(s) from last year.`;
      void ledger.flush().then(persist).catch((err) => { status = err instanceof Error ? err.message : String(err); render(); });
    }
  }
}

function connectionBar(): string {
  if (!account) return `<p class="note">Local mode: data stays in this browser. <button id="sign-in">Sign in with Microsoft</button></p>`;
  const who = esc(account.username);
  if (!workspace) return `<p class="note">Signed in as ${who}. <button id="sign-out">Sign out</button></p>`;
  const options = workspace.years.filter((y) => y.kind === "ledger").map((y) => `<option${y.label === workspace!.year.label ? " selected" : ""}>${esc(y.label)}</option>`).join("");
  return `<p class="note">Signed in as ${who}. Year <select id="year-pick" style="width:auto">${options}</select>
    <button id="check-files">Check for new files</button> <button id="share">Share</button> <button id="sign-out">Sign out</button></p>`;
}

function shareForm(): string {
  return `<form id="share-form" class="row"><input name="email" type="email" placeholder="Their Microsoft account email" required>
    <button>Invite to edit</button></form>
    <p class="note">OneDrive emails them an invitation. Once they have it, they should:</p>
    <ol class="note">
      <li>Open the invitation and choose to open the folder in OneDrive (sign in with the account you invited).</li>
      <li>In OneDrive, find the folder under <strong>Shared</strong> and choose <strong>Add shortcut to My files</strong> (the toolbar button, or right-click the folder).</li>
      <li>Open ${esc(location.origin)}, sign in with the same account, choose <strong>My OneDrive</strong>, and select the folder. Or paste the folder's sharing link instead.</li>
    </ol>
    <p class="note">If no email arrives, share the folder with them in OneDrive yourself; the steps above are the same.</p>`;
}

function header(): string {
  const unsaved = ledger.unflushedCount;
  return `<header><h1><a href="#" data-go="queue">Step Up Helper</a></h1>
    <nav>${navigator.onLine ? "" : `<span class="badge warn">Offline: changes are kept on this device</span>`}${unsaved ? `<span class="badge warn">${unsaved} unsaved</span>` : ""}
    <details class="menu"><summary class="btn">Advanced</summary>
      <div class="menu-panel">
        <label class="btn">Import events<input type="file" id="import" accept=".jsonl,.json,.txt" hidden></label>
        <button id="export">Export events</button>
        ${Object.keys(ledger.state.categories).length ? `<button id="export-categories">Share category fixes</button>` : ""}
        ${workspace ? `<button id="disconnect" class="danger">Disconnect</button>` : ""}
      </div></details></nav></header>
    ${connectionBar()}${sharing && workspace ? shareForm() : ""}${status ? `<p class="warn">${esc(status)}</p>` : ""}`;
}

function queueView(): string {
  const state = ledger.state;
  const entries = buildQueue(state, ctx());
  const children = Object.values(state.children);
  const childForm = `<details><summary>Children (${children.length})</summary>
    <ul>${children.map((c) => `<li>${esc(c.name)} ${c.scholarship ? `<small>${esc(c.scholarship)}</small>` : ""}</li>`).join("")}</ul>
    <form id="add-child" class="row"><input name="name" placeholder="Name" required><input name="scholarship" placeholder="Scholarship (e.g. FES-UA)"><button>Add child</button></form></details>`;
  const uploads = workspace
    ? ` <label class="btn">Add receipt files<input type="file" id="upload" multiple accept="application/pdf,image/*" hidden></label>
        <label class="btn">Take a photo<input type="file" id="photo" accept="image/*" capture="environment" hidden></label>`
    : "";
  const startBlank = `<p class="row"><button id="new-purchase">New purchase without a file</button>${uploads}</p>`;
  const archived = Object.values(state.purchases).filter((p) => p.archived);
  const archivedList = archived.length
    ? `<details><summary>Archived purchases (${archived.length})</summary><ul class="queue">${archived.map((p) => `<li class="q"><span>${esc(p.vendor ?? state.documents[p.receiptDocumentId ?? ""]?.filename ?? "Untitled purchase")} <small>${esc(p.date)}</small></span><button data-unarchive="${esc(p.id)}">Restore</button></li>`).join("")}</ul></details>`
    : "";
  if (entries.length === 0) return `${childForm}${startBlank}<p>Nothing needs attention.</p>${archivedList}`;
  const rows = entries.map((e) => {
    const sugg = (e.suggestions ?? []).map((s) => {
      const name = s.target.kind === "purchase" ? state.purchases[s.target.id]?.vendor ?? s.target.id : state.items[s.target.id]?.description ?? s.target.id;
      return `<button data-attach="${esc(e.id)}" data-kind="${s.target.kind}" data-target="${esc(s.target.id)}" data-role="${s.role}">${s.role === "receipt" ? "Receipt of" : "Attach to"} ${esc(name)}</button>`;
    }).join("");
    const actions =
      e.kind === "unattached-document"
        ? `<button data-start="${esc(e.id)}">Start purchase</button>${state.documents[e.id]?.driveItemId && workspace ? `<button data-preview="${esc(e.id)}">Preview</button>` : ""}${sugg}`
        : `<button data-open="${esc(e.purchaseId ?? e.id)}">Open</button>${e.kind === "purchase-needs-items" ? `<button data-archive="${esc(e.id)}">Archive</button>` : ""}`;
    const hint = e.hints?.vendor || e.hints?.date ? `<small>Looks like: ${esc([e.hints.vendor, e.hints.date].filter(Boolean).join(", "))}</small>` : "";
    return `<li class="q"><div><strong>${esc(e.title)}</strong> ${hint}<br><small>${esc(e.reasons.join("; "))}</small></div><div class="actions">${actions}</div></li>`;
  });
  return `${childForm}${startBlank}<h2>Needs your attention (${entries.length})</h2><ul class="queue">${rows.join("")}</ul>${archivedList}`;
}

function purchaseView(id: string, draft = false): string {
  const state = ledger.state;
  const p = state.purchases[id] ?? (draft ? { id } : undefined);
  if (!p) return `<p>That purchase no longer exists.</p>`;
  const doc = p.receiptDocumentId ? state.documents[p.receiptDocumentId] : undefined;
  const items = itemsOf(state, id);
  const remaining = remainingToItemize(state, id);
  const next = suggestNextItem(state, id);
  const children = Object.values(state.children);
  const money = (c: number | undefined) => (c === undefined ? "" : (c / 100).toFixed(2));
  const rows = items.map((i) => {
    const ev = evaluateItem(state, i.id, ctx());
    return `<tr><td>${esc(state.children[i.childId ?? ""]?.name ?? "?")}</td><td>${esc(i.description)}</td><td class="num">${formatCents(i.amountCents)}</td>
      <td class="num">${formatCents(i.taxShippingCents)}${i.taxShippingEstimated ? " <small>est.</small>" : ""}</td><td>${esc(categoryLabel(i))}</td>
      <td>${ev.readiness === "ready" ? `<span class="ok">Ready</span>` : `<small class="warn">${esc(ev.reasons.map((r) => r.message).join("; "))}</small>`}</td>
      <td><button data-dup="${esc(i.id)}">Duplicate</button></td></tr>`;
  });
  if (draft) {
    return `<p><a href="#" data-go="queue">&larr; Back to the list</a></p>
  <h2>New purchase</h2>
  <p class="note">Nothing is saved until you enter at least one detail.</p>
  <form id="purchase-form" class="grid" data-id="${esc(id)}" data-draft="1">
    <label>Vendor<input name="vendor"></label>
    <label>Date<input name="date" type="date"></label>
    <label>Invoice #<input name="invoiceNo"></label>
    <label>Receipt total<input name="orderTotal" inputmode="decimal"></label>
    <label>Tax/shipping total<input name="taxTotal" inputmode="decimal"></label>
    <button>Save receipt details</button></form>`;
  }
  const categories = reference()
    ? reference()!.choices.map((c) => c.label)
    : [...new Set(Object.values(state.items).map((i) => categoryLabel(i)).filter(Boolean))];
  return `<p><a href="#" data-go="queue">&larr; Back to the list</a></p>
  <h2>Receipt${doc ? `: ${esc(doc.filename)}` : " (no file yet)"}</h2>
  ${doc?.driveItemId && workspace ? `<p><button data-preview="${esc(doc.id)}">Preview receipt</button></p>` : ""}
  <form id="purchase-form" class="grid" data-id="${esc(id)}">
    <label>Vendor<input name="vendor" value="${esc(p.vendor)}"></label>
    <label>Date<input name="date" type="date" value="${esc(p.date)}"></label>
    <label>Invoice #<input name="invoiceNo" value="${esc(p.invoiceNo)}"></label>
    <label>Receipt total<input name="orderTotal" inputmode="decimal" value="${money(p.orderTotalCents)}"></label>
    <label>Tax/shipping total<input name="taxTotal" inputmode="decimal" value="${money(p.taxShippingTotalCents)}"></label>
    <button>Save receipt details</button></form>
  <p><button data-archive="${esc(id)}">Archive this purchase</button> <small>Hides it and its items; you can restore it from the list page.</small></p>
  <h3>Items${remaining !== undefined ? ` <small>(${formatCents(remaining)} left to itemize)</small>` : ""}</h3>
  ${items.length ? `<table><thead><tr><th>Child</th><th>Description</th><th>Amount</th><th>Tax/ship</th><th>Category</th><th>Status</th><th></th></tr></thead><tbody>${rows.join("")}</tbody></table>` : "<p>No items yet.</p>"}
  ${items.length && p.taxShippingTotalCents !== undefined ? `<p><button data-realloc="${esc(id)}">Spread the real tax/shipping across items</button></p>` : ""}
  <h3>Add an item</h3>
  ${children.length === 0 ? `<p class="warn">Add a child on the list page first.</p>` : ""}
  <form id="item-form" class="grid" data-id="${esc(id)}">
    <label>Child<select name="childId" required>${children.map((c) => `<option value="${esc(c.id)}"${c.id === next.childId ? " selected" : ""}>${esc(c.name)}</option>`).join("")}</select></label>
    <label>Description<input name="description" required></label>
    <label>Amount<input name="amount" inputmode="decimal" required value="${money(next.amountCents)}"></label>
    <label>Category<input name="categoryId" list="cats" required${reference() ? ` placeholder="Start typing to search"` : ""}></label><datalist id="cats">${categories.map((c) => `<option value="${esc(c)}">`).join("")}</datalist>
    <label>Benefit message<input name="benefitMessage" required></label>
    <label>Service date<input name="serviceDate" type="date"></label>
    <label>Service provider<input name="serviceProvider" value="${esc(next.serviceProvider)}"></label>
    <button>Save and add another</button></form>
  ${reference() ? `<details><summary>Category missing, or needs a Service Date?</summary>
    <form id="category-form" class="row"><input name="path" list="cats" placeholder="Category - Type - Detail" required>
      <label class="check"><input type="checkbox" name="needsDate"> Needs a Service Date</label><button>Save for this year</button></form>
    <p class="note">Adds the category (or updates it) for this year's data. Use <strong>Advanced &rarr; Share category fixes</strong> to send fixes back so everyone gets them.</p></details>` : ""}`;
}

/** A picked/typed label becomes the StepUp category id (and its path); anything else is kept as typed and flagged as unknown. */
function categoryFields(text: string): { categoryId: string; categoryPath?: string[] } {
  const id = reference()?.idForLabel(text);
  const info = id ? reference()?.category(id) : undefined;
  return id && info ? { categoryId: id, categoryPath: info.path } : { categoryId: text };
}

function onboardingView(): string {
  if (pendingYear) {
    const now = new Date();
    const start = now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
    return `<h2>Set up a school year</h2><p>This folder has no school year yet. Create one here:</p>
      <form id="start-year" class="row"><input name="label" value="${start}-${start + 1}" pattern="\\d{4}-\\d{4}" required><button>Create year</button></form>
      <p><button id="pick-again">Choose a different folder</button></p>`;
  }
  const open = (list: FolderEntry[]) => list.map((f, i) => `<li><button data-pick="${i}">&#128193; ${esc(f.name)}</button></li>`).join("") || "<li><small>No folders here.</small></li>";
  if (picker.path.length === 0) {
    return `<h2>Choose the folder to use</h2><p class="note">Pick the folder that holds (or will hold) your school-year folders.</p>
      <h3>Your OneDrive</h3><ul class="queue"><li><button data-pick-mine="1">&#128193; My OneDrive</button></li></ul>
      <h3>A folder someone shared with you</h3>
      <p class="note">Paste its OneDrive sharing link, or in OneDrive choose "Add shortcut to My files" on the folder and open it from My OneDrive.</p>
      <form id="pick-link" class="row"><input name="link" placeholder="OneDrive sharing link" required><button>Use this link</button></form>
      ${picker.shared.length ? `<h3>Shared with you</h3><ul class="queue">${picker.shared.map((f, i) => `<li><button data-pick-shared="${i}">&#128193; ${esc(f.name)}</button></li>`).join("")}</ul>` : ""}`;
  }
  const here = picker.path[picker.path.length - 1]!;
  return `<h2>Choose the folder to use</h2>
    <p>${picker.path.map((f) => esc(f.name)).join(" / ")}</p>
    <p class="row"><button id="pick-up">&larr; Up</button><button id="pick-use"><strong>Use this folder</strong></button></p>
    <ul class="queue">${open(picker.list)}</ul>
    <form id="new-folder" class="row"><input name="name" placeholder="New folder name" required><button>Create folder in ${esc(here.name)}</button></form>`;
}

async function pickerTop(): Promise<void> {
  pendingYear = undefined;
  const [mine, shared] = await Promise.all([myDriveRoot(), sharedFolders().catch(() => [] as FolderEntry[])]);
  picker = { path: [], mine, shared, list: [] };
}

async function pickerOpen(path: FolderEntry[]): Promise<void> {
  picker = { ...picker, path, list: path.length ? await subfolders(path[path.length - 1]!) : [] };
}

async function useFolder(folder: FolderEntry): Promise<void> {
  const pointer = await pointerFromFolder(folder);
  try {
    attach(await openWorkspace(pointer, store.clientId));
    pendingYear = undefined;
  } catch (err) {
    if (err instanceof NoLedgerYearError) pendingYear = pointer;
    else throw err;
  }
}

function render(): void {
  const body = account && !workspace ? onboardingView() : view.name === "queue" ? queueView() : purchaseView(view.id, view.draft);
  root.innerHTML = header() + previewPanel() + body;
}

function go(next: View): void {
  view = next;
  render();
}

root.addEventListener("click", async (ev) => {
  const t = (ev.target as HTMLElement).closest<HTMLElement>("button, a");
  if (!t) return;
  if (!t.closest(".menu")) root.querySelector<HTMLDetailsElement>("details.menu")?.removeAttribute("open");
  const d = t.dataset;
  if (d["go"]) { ev.preventDefault(); go({ name: "queue" }); }
  else if (d["pick"] !== undefined || d["pickMine"] || d["pickShared"] !== undefined) {
    const next = d["pickMine"] ? picker.mine : d["pickShared"] !== undefined ? picker.shared[Number(d["pickShared"])] : picker.list[Number(d["pick"])];
    if (next) await guarded(() => pickerOpen([...(d["pickMine"] || d["pickShared"] !== undefined ? [] : picker.path), next]), "Opening the folder…");
  }
  else if (t.id === "pick-up") await guarded(() => (picker.path.length <= 1 ? pickerTop() : pickerOpen(picker.path.slice(0, -1))), "Opening the folder…");
  else if (t.id === "pick-use") await guarded(() => useFolder(picker.path[picker.path.length - 1]!), "Opening your workspace…");
  else if (t.id === "pick-again") await guarded(pickerTop);
  else if (t.id === "sign-in") { note("Redirecting to Microsoft to sign in…"); showBusy("Redirecting to Microsoft to sign in…"); await signIn(); }
  else if (t.id === "sign-out") {
    if (ledger.unflushedCount > 0 && !confirm(`${ledger.unflushedCount} change(s) have not been saved to OneDrive and will be lost if you sign out. Sign out anyway?`)) return;
    forgetLocalPointer(); await clearCache(); showBusy("Signing out of Microsoft…"); await signOut();
  }
  else if (t.id === "disconnect") {
    if (ledger.unflushedCount > 0 && !confirm(`${ledger.unflushedCount} change(s) have not been saved to OneDrive and will be lost if you disconnect. Disconnect anyway?`)) return;
    await guarded(async () => {
      forgetCache();
      clearPreviews();
      await savePointer(undefined);
      workspace = undefined;
      activeStore = store;
      ledger = new Ledger(store, new HlcClock(store.clientId), "web");
      await ledger.refresh();
      await pickerTop();
    }, "Disconnecting…");
  }
  else if (t.id === "share") { sharing = !sharing; render(); }
  else if (t.id === "check-files" && workspace) {
    await guarded(async () => {
      const plan = planIngest(ledger.state, await listLooseFiles(workspace!.driveId, workspace!.year.folderId));
      registerLooseFiles(ledger, plan.toRegister);
      await ledger.flush();
      status = plan.toRegister.length ? `Registered ${plan.toRegister.length} new file(s).` : "No new files.";
    }, "Checking OneDrive for new files…");
  }
  else if (t.id === "export") {
    await guarded(async () => {
      await ledger.flush();
      const url = URL.createObjectURL(new Blob([exportJsonl(await activeStore.readAll())], { type: "text/plain" }));
      const a = Object.assign(document.createElement("a"), { href: url, download: "events.jsonl" });
      a.click();
      URL.revokeObjectURL(url);
    }, "Preparing export…");
  } else if (t.id === "export-categories") {
    const url = URL.createObjectURL(new Blob([JSON.stringify(exportCategoryEdits(ledger.state.categories), null, 1)], { type: "application/json" }));
    Object.assign(document.createElement("a"), { href: url, download: "category-edits.json" }).click();
    URL.revokeObjectURL(url);
    status = "Saved category-edits.json. Send it to the maintainers (or open an issue on the project) so everyone gets these fixes.";
    render();
  } else if (t.id === "new-purchase") {
    go({ name: "purchase", id: newId("purchase"), draft: true });
  } else if (d["open"]) go({ name: "purchase", id: d["open"] });
  else if (d["start"]) {
    const doc = ledger.state.documents[d["start"]];
    const hints = fileNameHints(doc?.filename ?? "");
    const id = startPurchaseFromDocument(ledger, d["start"], { vendor: hints.vendor, date: hints.date });
    await guarded(() => ledger.flush(), "Saving to OneDrive…");
    go({ name: "purchase", id });
  } else if (d["attach"]) {
    const target: MapTarget = { kind: d["kind"] as "purchase" | "item", id: d["target"]! };
    const result = d["role"] === "receipt" ? attachAsReceipt(ledger, target.id, d["attach"]) : attachAdditional(ledger, target, d["attach"]);
    if (!result.ok) alert(`Could not attach: ${result.reason}`);
    await save();
  } else if (d["preview"]) {
    await guarded(() => openPreview(d["preview"]!), "Downloading the receipt…");
    window.scrollTo({ top: 0 });
  } else if (t.id === "close-preview") {
    preview = undefined;
    render();
  } else if (d["archive"]) {
    if (confirm("Archive this purchase? It and its items are hidden from the list, plan and budget. You can restore it later.")) {
      setPurchaseArchived(ledger, d["archive"]);
      view = { name: "queue" };
      await save();
    }
  } else if (d["unarchive"]) {
    setPurchaseArchived(ledger, d["unarchive"], false);
    await save();
  } else if (d["dup"]) {
    duplicateItem(ledger, d["dup"]);
    await save();
  } else if (d["realloc"]) {
    reallocateTax(ledger, d["realloc"]);
    await save();
  }
});

root.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const form = ev.target as HTMLFormElement;
  if (form.id === "pick-link") {
    await guarded(async () => useFolder(await folderFromLink(val(form, "link"))), "Opening the shared link…");
    return;
  }
  if (form.id === "new-folder") {
    await guarded(async () => {
      const made = await createSubfolder(picker.path[picker.path.length - 1]!, val(form, "name"));
      await pickerOpen(picker.path);
      status = `Created "${made.name}".`;
    }, "Creating the folder…");
    return;
  }
  if (form.id === "share-form" && workspace) {
    await guarded(async () => {
      const email = val(form, "email");
      const folder = await workspaceFolder(workspace!.pointer);
      await inviteToFolder(folder, email, `Sharing our Step Up Helper folder. Open it in OneDrive and choose "Add shortcut to My files", then go to ${location.origin}/, sign in and pick it from My OneDrive.`);
      status = `Invited ${email}. If they do not get an email, share the folder with them in OneDrive instead.`;
      sharing = false;
    }, "Inviting them to the folder…");
    return;
  }
  if (form.id === "start-year") {
    await guarded(async () => {
      const pointer = await startYear(pendingYear!, val(form, "label"));
      attach(await openWorkspace(pointer, store.clientId));
      pendingYear = undefined;
    }, "Setting up the school year…");
    return;
  }
  if (form.id === "category-form") {
    const ref = reference();
    if (ref) {
      const needs = (form.elements.namedItem("needsDate") as HTMLInputElement).checked;
      addOrFixCategory(ledger, ref, val(form, "path").split(" - "), needs);
      status = "Category saved for this year.";
    }
  } else if (form.id === "add-child") {
    ledger.set("child", newId("child"), { name: val(form, "name"), ...(val(form, "scholarship") ? { scholarship: val(form, "scholarship") } : {}) }, { label: "child.created" });
  } else if (form.id === "purchase-form") {
    const fields: Record<string, string | number> = {};
    for (const k of ["vendor", "date", "invoiceNo"]) if (val(form, k)) fields[k] = val(form, k);
    const total = toCents(val(form, "orderTotal"));
    const tax = toCents(val(form, "taxTotal"));
    if (total !== undefined) fields["orderTotalCents"] = total;
    if (tax !== undefined) fields["taxShippingTotalCents"] = tax;
    const draft = form.dataset["draft"] === "1";
    if (draft && Object.keys(fields).length === 0) {
      status = "Enter at least one detail to save this purchase.";
      render();
      return;
    }
    ledger.set("purchase", form.dataset["id"]!, fields, { label: draft ? "purchase.created" : "purchase.edited" });
    if (draft && view.name === "purchase") view = { name: "purchase", id: view.id };
    if (tax !== undefined) reallocateTax(ledger, form.dataset["id"]!);
  } else if (form.id === "item-form") {
    addItem(ledger, form.dataset["id"]!, {
      childId: val(form, "childId"),
      description: val(form, "description"),
      amountCents: toCents(val(form, "amount")),
      ...categoryFields(val(form, "categoryId")),
      benefitMessage: val(form, "benefitMessage"),
      serviceDate: val(form, "serviceDate") || undefined,
      serviceProvider: val(form, "serviceProvider") || undefined,
    });
  }
  await save();
});

root.addEventListener("change", async (ev) => {
  const input = ev.target as HTMLInputElement;
  if (input.id === "year-pick" && workspace) {
    const pointer = workspace.pointer;
    await guarded(async () => attach(await openWorkspace(pointer, store.clientId, input.value)), `Opening ${input.value}…`);
    return;
  }
  if ((input.id === "upload" || input.id === "photo") && input.files?.length) {
    const files = [...input.files];
    input.value = "";
    await uploadFiles(files, input.id === "photo");
    return;
  }
  if (input.id !== "import" || !input.files?.[0]) return;
  const file = input.files[0];
  await guarded(async () => {
    await activeStore.appendOwn(parseJsonl(await file.text()));
    await ledger.refresh();
  }, "Importing events…");
});

await ledger.refresh();
render();
await guarded(async () => {
  note("Completing Microsoft sign-in…");
  account = await initAuth();
  if (account) note("Finding your saved folder…");
  const pointer = account ? await loadPointer() : undefined;
  if (account && pointer) {
    try {
      // Cache first: show the last-known ledger at once, then refresh in the background.
      const cached = pointer.year ? await readCache(keyOf(pointer)) : undefined;
      const quick = cached ? openFromCache(pointer, store.clientId, cached) : undefined;
      if (quick) {
        note("Opening your saved ledger…");
        attach(quick);
      } else {
        note("Opening your workspace…");
        attach(await openWorkspace(pointer, store.clientId));
      }
    } catch (err) {
      if (err instanceof NoLedgerYearError) pendingYear = pointer;
      else if (isDeadPointer(err)) {
        // A pointer to a folder that is gone is the same as no pointer: forget it and start onboarding.
        await savePointer(undefined);
        await pickerTop();
      } else {
        // Probably a temporary problem (network, throttling): keep the saved choice and let the person retry.
        status = `Could not reach your saved folder (${err instanceof Error ? err.message : err}). Reload to try again, or choose another folder.`;
        await pickerTop();
      }
    }
  } else if (account) await pickerTop();
}, "Connecting to OneDrive…");
if (workspace?.fromCache) void refreshInBackground(workspace);
void loadReference().then((r) => {
  referenceBase = r;
  if (r && !typing()) render();
});

// Installable / works offline: the page and its scripts are cached by the service worker (public/sw.js).
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch(() => undefined);
}
