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
  yearSummary,
  emlToText,
  parseEml,
  receiptAttachments,
  itemsBeingFiled,
  displayStatus,
  parseStatementText,
  saveStatement,
  matchStatement,
  linkTransaction,
  matchRefunds,
  matchSplitCharges,
  linkRefund,
  unlinkRefund,
  checkRedactionOutput,
  diffReference,
  mergeReference,
  readYearSnapshot,
  writeYearSnapshot,
  type RedactionCheck,
  unlinkTransaction,
  linkConfidentMatches,
  relinkAllStatements,
  learnAlias,
  purchaseTotalCents,
  planRedaction,
  readReceiptText,
  redactedCopyOf,
  type RedactionPlan,
  type StatementData,
  type TransactionMatch,
  openLedgerFolders,
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
import { onOcrProgress, ocrImage } from "./ocr.js";
import { shrinkToLimit } from "./shrink.js";
import { addScanPage, buildScanPdf, type ScanPage } from "./scan.js";
import { pdfLines, pdfToText, renderRedactedPdf } from "./pdfText.js";
import { photoName, prepareUpload, previewKind, sha256Hex, type PreviewKind } from "./files.js";
import "./style.css";

/** Where shared category fixes are sent (an issue on this project). */
const REPO = "antgiant/StepUp";
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
let newYearOpen = false;

/** Shared category tree (plan §3.8), loaded in the background. Until it arrives (or if it cannot load) every category counts as known. */
/** The latest published category list; each year works from its own frozen copy of it (`referenceBase`). */
let publishedRef: CategoryReference | undefined;
let yearSnapshot: CategoryReference | undefined;
let referenceBase: CategoryReference | undefined;
let ledgerFolderId: { yearFolderId: string; id: string } | undefined;

/** Finds (or, the first time, freezes) this year's copy of the category list. */
async function loadYearReference(ws: OpenWorkspace): Promise<void> {
  try {
    if (ledgerFolderId?.yearFolderId !== ws.year.folderId) {
      const folders = await openLedgerFolders(ws.driveId, ws.year.folderId);
      if (!folders) return;
      ledgerFolderId = { yearFolderId: ws.year.folderId, id: folders.ledgerId };
    }
    let snap = await readYearSnapshot(ws.driveId, ledgerFolderId.id);
    if (!snap && publishedRef) {
      await writeYearSnapshot(ws.driveId, ledgerFolderId.id, publishedRef);
      snap = (await readYearSnapshot(ws.driveId, ledgerFolderId.id)) ?? publishedRef;
    }
    if (workspace !== ws || !snap) return;
    yearSnapshot = snap;
    referenceBase = snap;
    persist();
    if (!typing()) render();
  } catch {
    /* the published list keeps working until the next try */
  }
}

/** What the published list has that this year's copy does not (or undefined when they agree). */
function referenceUpdate(): { added: number; changed: number; removed: number } | undefined {
  if (!publishedRef || !yearSnapshot || publishedRef.hash === yearSnapshot.hash) return undefined;
  const d = diffReference(yearSnapshot, publishedRef);
  return d.added.length + d.changed.length + d.removed.length ? { added: d.added.length, changed: d.changed.length, removed: d.removed.length } : undefined;
}

async function updateYearReference(): Promise<void> {
  const ws = workspace;
  if (!ws || !publishedRef || !yearSnapshot || !ledgerFolderId) return;
  const d = diffReference(yearSnapshot, publishedRef);
  const ok = confirm(
    `Update this year's category list to version ${publishedRef.version}?\n\n${d.added.length} new, ${d.changed.length} changed${d.removed.length ? `, ${d.removed.length} no longer published (kept, marked inactive)` : ""}.\nItems already filed keep their category; your own category fixes stay on top.`
  );
  if (!ok) return;
  const merged = mergeReference(yearSnapshot, publishedRef);
  await writeYearSnapshot(ws.driveId, ledgerFolderId.id, merged, true);
  yearSnapshot = merged;
  referenceBase = merged;
  status = `Updated this year's category list to version ${merged.version}.`;
}
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
const downloaded = new Map<string, { url: string; kind: PreviewKind; blob: Blob }>();
const emailTexts = new Map<string, string>();

/** Downloads a document once per session (documents never change) and keeps it for previews and for reading statements. */
async function loadDocument(docId: string): Promise<{ url: string; kind: PreviewKind; blob: Blob }> {
  const doc = ledger.state.documents[docId];
  if (!doc?.driveItemId || !workspace) throw new Error("That file is not in OneDrive.");
  const filename = doc.filename ?? "file";
  let got = downloaded.get(docId);
  if (!got) {
    const res = await fetchItemContent(workspace.driveId, doc.driveItemId, `Downloading ${filename}…`);
    const raw = await res.blob();
    const kind = previewKind(filename, raw.type);
    const blob = kind === "pdf" && raw.type !== "application/pdf" ? new Blob([raw], { type: "application/pdf" }) : raw;
    got = { url: URL.createObjectURL(blob), kind, blob };
    downloaded.set(docId, got);
  }
  return got;
}

/** A receipt being photographed page by page. Nothing leaves this device until it is saved. */
let scan: { name: string; pages: ScanPage[] } | undefined;

function discardScan(): void {
  for (const p of scan?.pages ?? []) URL.revokeObjectURL(p.url);
  scan = undefined;
}

function scanPanel(): string {
  if (!scan) return "";
  const pages = scan.pages.map((p, i) => `<li class="scan-page"><div class="scan-thumb"><img src="${esc(p.url)}" alt="Page ${i + 1}" style="transform:rotate(${p.rotation}deg)"></div>
      <div><strong>Page ${i + 1}</strong>${p.blurry ? ` <span class="warn">looks blurry: retake it</span>` : ""}<br>
      <button data-scan-rotate="${p.id}">Rotate</button>${i > 0 ? `<button data-scan-up="${p.id}">Move up</button>` : ""}<button data-scan-remove="${p.id}">Remove</button></div></li>`);
  return `<section class="preview scan"><div class="preview-bar"><strong>Scan a receipt</strong><span><button id="scan-cancel">Cancel</button></span></div>
    <div style="padding:10px 14px"><p class="note">Photograph each page in order. Check each one is sharp and upright, then save them as one PDF.</p>
    <ul class="scan-pages">${pages.join("")}</ul>
    <p class="row"><label class="btn">${scan.pages.length ? "Add another page" : "Take the first photo"}<input type="file" id="scan-add" accept="image/*" capture="environment" hidden></label></p>
    <form id="scan-form" class="row"><input name="name" value="${esc(scan.name)}" aria-label="File name" required><button${scan.pages.length ? "" : " disabled"}>Save as PDF (${scan.pages.length} page${scan.pages.length === 1 ? "" : "s"})</button></form></div></section>`;
}

/** A redacted copy that has been made but not saved: the person checks every page before it can be used. */
let redactionDraft: { docId: string; bytes: Uint8Array; url: string; plan: RedactionPlan; check: RedactionCheck } | undefined;
const MAX_PROOF_BYTES = 5 * 1024 * 1024;

function discardRedaction(): void {
  if (redactionDraft) URL.revokeObjectURL(redactionDraft.url);
  redactionDraft = undefined;
}

/**
 * Builds the redacted copy of a statement on this device: everything is blacked out except the issuer, the period, the
 * column headings and the charges already linked to purchases (plan §3.10a). Shown for review; nothing is saved yet.
 */
async function makeRedaction(docId: string, options: { pages: "all" | "matched"; purchaseId?: string } = { pages: "all" }): Promise<void> {
  const got = await loadDocument(docId);
  if (got.kind !== "pdf") throw new Error("Only PDF statements can be redacted here.");
  const links = Object.values(ledger.state.additionalDocs).filter((a) => a.documentId === docId && a.kind === "payment-proof" && a.transactionId && (!options.purchaseId || a.ownerId === options.purchaseId));
  const keep = new Set(links.map((a) => a.transactionId!));
  if (keep.size === 0) throw new Error("Link at least one charge to a purchase first; only linked charges stay visible.");
  note("Finding what to keep…");
  const read = await pdfLines(got.blob);
  const plan = planRedaction(read.pages, { keepTransactionIds: keep, pages: options.pages });
  if (read.ocr) plan.warnings.push("Some pages were read with OCR, so the boxes may be less exact. Check every page carefully.");
  if (plan.keptTransactions === 0) throw new Error(plan.warnings.join(" ") || "Nothing on this statement could be kept.");
  note("Blacking out the rest, then reading the result to check it…");
  const { bytes, ocrTexts } = await renderRedactedPdf(got.blob, plan);
  if (bytes.byteLength > MAX_PROOF_BYTES) throw new Error("The redacted copy is over StepUp's 5 MB limit.");
  const missing = new Set(plan.missing);
  const keptTxns = (ledger.state.documents[docId]?.statement?.transactions ?? []).filter((t) => keep.has(t.id) && !missing.has(t.id));
  const check = checkRedactionOutput(ocrTexts, keptTxns);
  discardRedaction();
  redactionDraft = { docId, bytes, url: URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/pdf" })), plan, check };
}

async function saveRedaction(): Promise<void> {
  const draft = redactionDraft;
  const ws = workspace;
  const original = draft ? ledger.state.documents[draft.docId] : undefined;
  if (!draft || !ws || !original) return;
  const body = new Blob([draft.bytes as BlobPart], { type: "application/pdf" });
  const name = `${(original.filename ?? "Statement").replace(/\.pdf$/i, "")} (redacted).pdf`;
  for (const old of Object.values(ledger.state.documents)) if (old.redacted && old.derivedFrom === draft.docId) ledger.set("document", old.id, { redacted: false }, { label: "document.redactionSuperseded" });
  const result = await uploadReceipt(ledger, ws.driveId, ws.year.folderId, { name, body, sha256: (await sha256Hex(body)) || undefined });
  ledger.set("document", result.documentId, { derivedFrom: draft.docId, redacted: true, contentKind: "statement" }, { label: "document.redacted" });
  await ledger.flush();
  discardRedaction();
  status = "Saved the redacted copy. It will be sent to StepUp instead of the original statement.";
}

async function openPreview(docId: string): Promise<void> {
  const doc = ledger.state.documents[docId];
  if (!doc?.driveItemId || !workspace) return;
  const filename = doc.filename ?? "receipt";
  const got = await loadDocument(docId);
  if (got.kind === "email") emailTexts.set(docId, emlToText(await got.blob.text()));
  preview = { docId, filename, url: got.url, kind: got.kind, ...(doc.webUrl ? { webUrl: doc.webUrl } : {}) };
}

function redactionPanel(): string {
  const d = redactionDraft;
  if (!d) return "";
  const name = esc(ledger.state.documents[d.docId]?.filename ?? "statement");
  const missing = d.plan.missing.length ? `<p class="warn">${d.plan.missing.length} linked charge(s) could not be found in the PDF and will be blacked out.</p>` : "";
  const warnings = d.plan.warnings.map((w) => `<p class="warn">${esc(w)}</p>`).join("");
  const c = d.check;
  const verdict = c.leaks.length || c.unreadable.length
    ? `<p class="warn"><strong>Check failed.</strong> ${c.leaks.length ? `Something that should be hidden can be read: ${esc(c.leaks.join("; "))}. ` : ""}${c.unreadable.length ? `Could not read ${c.unreadable.length} kept charge(s): ${esc(c.unreadable.join(", "))}.` : ""} Look at every page before saving.</p>`
    : `<p class="note"><span class="ok">Checked by reading the result again:</span> all ${c.legible} kept charge(s) are legible and nothing else (no other amounts, no account numbers) could be read.</p>`;
  return `<section class="preview"><div class="preview-bar"><strong>Redacted copy of ${name}</strong>
      <span><button id="save-redaction"><strong>Looks right: save it</strong></button><button id="discard-redaction">Discard</button></span></div>
    <p class="note" style="padding:8px 14px;margin:0">Check every page. Only the issuer, the period, the column headings and ${d.plan.keptTransactions} linked charge(s) should be readable; everything else must be black.</p>
    ${verdict}${missing}${warnings}<iframe src="${esc(d.url)}" title="Redacted copy"></iframe></section>`;
}

function previewPanel(): string {
  if (!preview) return "";
  const open = preview.webUrl?.startsWith("https://") ? ` <a href="${esc(preview.webUrl)}" target="_blank" rel="noopener">Open in OneDrive</a>` : "";
  const body =
    preview.kind === "image" ? `<img src="${esc(preview.url)}" alt="${esc(preview.filename)}">`
    : preview.kind === "pdf" ? `<iframe src="${esc(preview.url)}" title="${esc(preview.filename)}"></iframe>`
    : preview.kind === "email" ? `<pre class="mail">${esc(emailTexts.get(preview.docId) ?? "")}</pre>`
    : `<p class="note">This file type cannot be previewed here.${open}</p>`;
  return `<section class="preview"><div class="preview-bar"><strong>${esc(preview.filename)}</strong><span>${preview.kind === "other" || preview.kind === "email" ? "" : open}<button id="close-preview">Close</button></span></div>${body}</section>`;
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

type View = { name: "queue" } | { name: "summary" } | { name: "statements" } | { name: "statement"; id: string } | { name: "purchase"; id: string; draft?: boolean };
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
onOcrProgress(({ status, progress }) => {
  if (status === "recognizing text") note(`Reading text on this device… ${Math.round(progress * 100)}%`);
  else if (status.includes("core")) note("Loading the text-reading engine (first time only)…");
  else if (status.includes("language") || status.includes("traineddata")) note("Loading language data (first time only)…");
});

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
  discardScan();
  discardRedaction();
  for (const d of downloaded.values()) URL.revokeObjectURL(d.url);
  downloaded.clear();
}

/** Browser cache of the open workspace (see cache.ts). Best effort: failures just mean a slower next visit. */
const keyOf = (p: Pointer) => cacheKey(account?.homeAccountId ?? "", p.driveId, p.rootId, p.year ?? "");
function persist(): void {
  if (account && workspace) void writeCache(keyOf(workspace.pointer), snapshotFor(workspace, yearSnapshot));
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
  // New or changed purchases may now match a charge on a statement we already read.
  if (Object.values(ledger.state.documents).some((d) => d.statement)) {
    const linked = relinkAllStatements(ledger);
    if (linked) status = `Linked ${linked} charge(s) on your statements to purchases.`;
  }
  await guarded(() => ledger.flush(), "Saving to OneDrive…");
  persist();
  scheduleMirror();
}

/**
 * The mirror spreadsheet (plan §3.5): a values-only .xlsx copy of the ledger in the year's reports folder, for checking
 * the new system against the old way of working. Rebuilt about a minute after the last save, and on demand.
 * ExcelJS is large, so it is only loaded when this runs.
 */
let mirrorTimer: ReturnType<typeof setTimeout> | undefined;
let reportsFolder: { yearFolderId: string; id: string } | undefined;
const mirrorOn = () => ledger.state.settings["year"]?.mirror !== false;
function scheduleMirror(): void {
  clearTimeout(mirrorTimer);
  if (!workspace || !mirrorOn()) return;
  mirrorTimer = setTimeout(() => void guardedQuiet(() => publishMirrorNow()), 60_000);
}
async function publishMirrorNow(): Promise<"written" | "unchanged" | "locked"> {
  const ws = workspace;
  if (!ws) return "unchanged";
  const lib = await import("@step-up/shared/mirror");
  const same = reportsFolder?.yearFolderId === ws.year.folderId;
  const result = await lib.publishYearMirror({
    ledger,
    ctx: ctx(),
    driveId: ws.driveId,
    yearFolderId: ws.year.folderId,
    yearLabel: ws.year.label,
    ...(same ? { reportsId: reportsFolder!.id } : {}),
    appVersion: "web",
  });
  if (result.reportsId) reportsFolder = { yearFolderId: ws.year.folderId, id: result.reportsId };
  return result.status === "off" ? "unchanged" : result.status;
}
/** Background work: spinner while it runs, and a short note (not an error page) if it fails. */
async function guardedQuiet(work: () => Promise<unknown>): Promise<void> {
  showBusy("Updating the spreadsheet copy…");
  try {
    await work();
  } catch (err) {
    status = `Could not update the spreadsheet copy (${err instanceof Error ? err.message : err}).`;
    if (!typing()) render();
  } finally {
    hideBusy();
  }
}

function attach(next: OpenWorkspace | undefined): void {
  workspace = next;
  if (next) {
    ledger = next.ledger;
    activeStore = ledger.store;
    void savePointer(next.pointer);
    if (!next.fromCache) persist();
    void useOutbox(next);
    // Switching year (or workspace) means a different frozen category list.
    if (yearSnapshot && ledgerFolderId && ledgerFolderId.yearFolderId !== next.year.folderId) {
      yearSnapshot = undefined;
      referenceBase = publishedRef;
    }
    void loadYearReference(next);
    if (next.carried.children) {
      const pms = next.carried.paymentMethods ? ` and ${next.carried.paymentMethods} payment method(s)` : "";
      status = `Added ${next.carried.children} student(s)${pms} from last year.`;
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
    <button id="check-files">Check for new files</button> <button id="new-year">New year</button> <button id="share">Share</button> <button id="sign-out">Sign out</button></p>`;
}

/** The year after the newest one we know ("2025-2026" -> "2026-2027"); with none, the school year that includes today. */
function nextYearLabel(labels: string[]): string {
  const newest = labels.filter((l) => /^\d{4}-\d{4}$/.test(l)).sort().pop();
  if (newest) {
    const end = Number(newest.slice(5));
    return `${end}-${end + 1}`;
  }
  const now = new Date();
  const start = now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
  return `${start}-${start + 1}`;
}

function newYearForm(): string {
  const next = nextYearLabel(workspace!.years.map((y) => y.label));
  return `<form id="new-year-form" class="row"><input name="label" value="${esc(next)}" pattern="\\d{4}-\\d{4}" required aria-label="School year"><button>Create year</button></form>
    <p class="note">Creates the folder next to your other years and brings over the students, payment methods and tax rate from your latest year. Receipts and purchases start fresh.</p>`;
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
        ${workspace && referenceUpdate() ? `<button id="update-reference">Update category list (${referenceUpdate()!.added} new, ${referenceUpdate()!.changed} changed)</button>` : ""}
        ${workspace ? `<button id="update-mirror">Update spreadsheet now</button><button id="toggle-mirror">Automatic spreadsheet: ${mirrorOn() ? "on" : "off"}</button>` : ""}
        ${Object.keys(ledger.state.categories).length ? `<button id="export-categories">Share category fixes</button><button id="issue-categories">Share them on GitHub</button>` : ""}
        ${workspace ? `<button id="disconnect" class="danger">Disconnect</button>` : ""}
      </div></details></nav></header>
    ${connectionBar()}${newYearOpen && workspace ? newYearForm() : ""}${sharing && workspace ? shareForm() : ""}${status ? `<p class="warn">${esc(status)}</p>` : ""}`;
}

/** Who is filing which items right now (from the CLI's claims). Empty unless someone is mid-run. */
const filingNow = () => itemsBeingFiled(ledger.state, Date.now());
const clockTime = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/** Banner on the list page: purchases whose items are being filed this minute, so they are not mistaken for idle ones. */
function filingBanner(): string {
  const active = filingNow();
  const ids = Object.keys(active);
  if (ids.length === 0) return "";
  const state = ledger.state;
  const byPurchase = new Map<string, { actor: string; since: string; count: number }>();
  for (const id of ids) {
    const pid = state.items[id]?.purchaseId;
    if (!pid) continue;
    const have = byPurchase.get(pid);
    byPurchase.set(pid, { actor: active[id]!.actor, since: have && have.since < active[id]!.claimedAt ? have.since : active[id]!.claimedAt, count: (have?.count ?? 0) + 1 });
  }
  const rows = [...byPurchase.entries()].map(([pid, f]) => `<li><span><strong>${esc(f.actor)}</strong> is filing <button data-open="${esc(pid)}" class="link">${esc(purchaseLabel(pid))}</button> <small>(${f.count} item(s), since ${esc(clockTime(f.since))})</small></span></li>`);
  return `<section class="filing-banner"><div class="filing-head"><strong>Being filed with StepUp right now</strong><button id="refresh-now">Refresh</button></div>
    <ul>${rows.join("")}</ul><p class="note">These are in the middle of being submitted from the command line. They are not idle: wait for them to finish before changing them. This list refreshes by itself every minute.</p></section>`;
}

/** The StepUp draft (if any) covering these items, so "ready" but not yet submitted has an explanation. */
function draftNote(itemIds: string[]): string {
  const want = new Set(itemIds);
  const d = Object.values(ledger.state.drafts).find((x) => x.itemIds?.some((i) => want.has(i)));
  if (!d) return "";
  const number = d.sequenceNumber ? `Reimbursement #${esc(d.sequenceNumber)}` : "a draft";
  return `<p class="note">A StepUp draft (${number}) was started for these items${d.actor ? ` by ${esc(d.actor)}` : ""}${d.lastStep ? `, last at the <em>${esc(d.lastStep)}</em> step` : ""}${d.skipped ? "; it was set aside part-way" : ""}. It is not submitted yet; the next filing run offers to resume it.</p>`;
}

let claimPoll: ReturnType<typeof setTimeout> | undefined;
/** While anything is being filed, look again every minute so the page does not show stale "ready" items. */
function scheduleClaimPoll(): void {
  if (claimPoll || !workspace || Object.keys(filingNow()).length === 0) return;
  claimPoll = setTimeout(() => {
    claimPoll = undefined;
    const ws = workspace;
    if (ws && !ws.fromCache && pending === 0 && document.visibilityState === "visible") void refreshInBackground(ws).finally(scheduleClaimPoll);
    else scheduleClaimPoll();
  }, 60_000);
}

function queueView(): string {
  const state = ledger.state;
  const entries = buildQueue(state, ctx());
  const children = Object.values(state.children);
  const childForm = `<details><summary>Children (${children.length})</summary>
    <ul>${children.map((c) => `<li>${esc(c.name)} ${c.scholarship ? `<small>${esc(c.scholarship)}</small>` : ""}</li>`).join("")}</ul>
    <form id="add-child" class="row"><input name="name" placeholder="Name" required><input name="scholarship" placeholder="Scholarship (e.g. FES-UA)"><button>Add child</button></form></details>`;
  const banner = filingBanner();
  const uploads = workspace
    ? ` <label class="btn">Add receipt files<input type="file" id="upload" multiple accept="application/pdf,image/*" hidden></label>
        <label class="btn">Take a photo<input type="file" id="photo" accept="image/*" capture="environment" hidden></label>
        <button id="start-scan">Scan a receipt (several pages)</button>`
    : "";
  const startBlank = `<p class="row"><button id="new-purchase">New purchase without a file</button>${uploads}</p>`;
  const archived = Object.values(state.purchases).filter((p) => p.archived);
  const archivedList = archived.length
    ? `<details><summary>Archived purchases (${archived.length})</summary><ul class="queue">${archived.map((p) => `<li class="q"><span>${esc(p.vendor ?? state.documents[p.receiptDocumentId ?? ""]?.filename ?? "Untitled purchase")} <small>${esc(p.date)}</small></span><button data-unarchive="${esc(p.id)}">Restore</button></li>`).join("")}</ul></details>`
    : "";
  if (entries.length === 0) return `${banner}${childForm}${startBlank}<p>Nothing needs attention.</p>${archivedList}`;
  const rows = entries.map((e) => {
    const sugg = (e.suggestions ?? []).map((s) => {
      const name = s.target.kind === "purchase" ? state.purchases[s.target.id]?.vendor ?? s.target.id : state.items[s.target.id]?.description ?? s.target.id;
      return `<button data-attach="${esc(e.id)}" data-kind="${s.target.kind}" data-target="${esc(s.target.id)}" data-role="${s.role}">${s.role === "receipt" ? "Receipt of" : "Attach to"} ${esc(name)}</button>`;
    }).join("");
    const actions =
      e.kind === "unattached-document"
        ? `<button data-start="${esc(e.id)}">Start purchase</button>${state.documents[e.id]?.driveItemId && workspace ? `<button data-preview="${esc(e.id)}">Preview</button>` : ""}${/\.eml$/i.test(state.documents[e.id]?.filename ?? "") && workspace ? `<button data-eml-attachments="${esc(e.id)}">Save its attachments</button>` : ""}${state.documents[e.id]?.contentKind !== "statement" ? `<button data-mark-statement="${esc(e.id)}">Mark as statement</button>` : `<button data-statement="${esc(e.id)}">Open statement</button>`}${sugg}`
        : `<button data-open="${esc(e.purchaseId ?? e.id)}">Open</button>${e.kind === "purchase-needs-items" ? `<button data-archive="${esc(e.id)}">Archive</button>` : ""}`;
    const hint = e.hints?.vendor || e.hints?.date ? `<small>Looks like: ${esc([e.hints.vendor, e.hints.date].filter(Boolean).join(", "))}</small>` : "";
    return `<li class="q"><div><strong>${esc(e.title)}</strong> ${hint}<br><small>${esc(e.reasons.join("; "))}</small></div><div class="actions">${actions}</div></li>`;
  });
  return `${banner}${childForm}${startBlank}<h2>Needs your attention (${entries.length})</h2><ul class="queue">${rows.join("")}</ul>${archivedList}`;
}

function summaryView(): string {
  const state = ledger.state;
  const s = yearSummary(state, ctx());
  const money = (c: number) => formatCents(c);
  const d = s.deadline;
  const banner = d
    ? `<p class="${d.daysLeft < 0 ? "warn" : d.daysLeft <= 30 ? "warn" : "note"} banner">${d.daysLeft < 0 ? `The submission deadline passed ${-d.daysLeft} day(s) ago (${esc(d.date)}).` : `${d.daysLeft} day(s) until the submission deadline (${esc(d.date)}).`}</p>`
    : `<p class="note banner">No submission deadline set.</p>`;
  const deadlineForm = `<form id="deadline-form" class="row"><label>Submission deadline<input name="deadline" type="date" value="${esc(d?.date)}"></label><button>Save deadline</button></form>`;
  const rows = s.children.map((b) => {
    const c = state.children[b.childId]!;
    const width = b.capCents > 0 ? Math.min(100, Math.round(((b.paidCents + b.approvedCents + b.pendingCents) / b.capCents) * 100)) : 0;
    return `<tr><td><strong>${esc(c.name ?? c.id)}</strong><br><small>${esc(c.scholarship)}</small></td>
      <td><form class="inline" data-cap="${esc(c.id)}"><input name="cap" inputmode="decimal" aria-label="Award for ${esc(c.name)}" value="${b.capCents ? (b.capCents / 100).toFixed(2) : ""}" placeholder="0.00"><button>Save</button></form>
        <div class="bar" title="${width}% used"><span style="width:${width}%"></span></div></td>
      <td class="num">${money(b.paidCents)}</td><td class="num">${money(b.approvedCents)}</td><td class="num">${money(b.pendingCents)}</td>
      <td class="num ${b.remainingCents < 0 ? "warn" : "ok"}">${money(b.remainingCents)}</td><td class="num">${money(b.unfiledCents)}</td></tr>`;
  });
  const counts = Object.entries(s.statusCounts).sort(([a], [b]) => a.localeCompare(b));
  return `<h2>Summary</h2>${banner}${deadlineForm}
    <h3>Awards</h3>
    ${rows.length ? `<table><thead><tr><th>Student</th><th>Award</th><th>Paid</th><th>Approved</th><th>Pending</th><th>Remaining</th><th>Not yet filed</th></tr></thead><tbody>${rows.join("")}</tbody></table>
      <p class="note">Remaining = award &minus; paid &minus; approved &minus; pending. "Not yet filed" is informational and not counted against the award.</p>` : `<p>Add a student on the list page first.</p>`}
    ${Object.keys(filingNow()).length ? `<p class="banner">${Object.keys(filingNow()).length} item(s) are being filed with StepUp right now (see the list page).</p>` : ""}
    <h3>Items by status</h3>
    ${counts.length ? `<ul class="queue">${counts.map(([k, n]) => `<li><span>${esc(k)}</span><strong>${n}</strong></li>`).join("")}</ul>` : "<p>No items yet.</p>"}`;
}

const purchaseLabel = (id: string) => {
  const p = ledger.state.purchases[id];
  if (!p) return "(removed purchase)";
  const total = purchaseTotalCents(ledger.state, p);
  return `${p.vendor ?? "Untitled purchase"}${p.date ? `, ${p.date}` : ""}${total !== undefined ? `, ${formatCents(total)}` : ""}`;
};

function statementsView(): string {
  const state = ledger.state;
  const docs = Object.values(state.documents).filter((d) => d.contentKind === "statement" && !d.derivedFrom).sort((a, b) => (a.filename ?? a.id).localeCompare(b.filename ?? b.id));
  const linkedBy = (docId: string) => new Set(Object.values(state.additionalDocs).filter((a) => a.documentId === docId && a.transactionId).map((a) => a.transactionId));
  const rows = docs.map((d) => {
    const charges = d.statement?.transactions.filter((t) => t.kind === "purchase") ?? [];
    const linked = linkedBy(d.id);
    const summary = d.statement ? `${charges.length} charge(s), ${charges.filter((t) => linked.has(t.id)).length} linked` : "Not read yet";
    return `<li class="q"><div><strong>${esc(d.filename ?? d.id)}</strong><br><small>${esc(summary)}${d.statement?.last4 ? ` &middot; card ending ${esc(d.statement.last4)}` : ""}</small></div>
      <div class="actions"><button data-statement="${esc(d.id)}">${d.statement ? "Review" : "Read statement"}</button></div></li>`;
  });
  return `<h2>Statements</h2>
    <p class="note">A statement can prove payment for many purchases at once. Mark a file as a statement from the list page (<em>Mark as statement</em>), then read it here: it is read on this device, charges are matched to your purchases, and the confident matches are linked for you.</p>
    ${rows.length ? `<ul class="queue">${rows.join("")}</ul>` : "<p>No statements yet.</p>"}`;
}

function statementReview(id: string): string {
  const state = ledger.state;
  const doc = state.documents[id];
  if (!doc) return `<p>That statement no longer exists.</p>`;
  const data: StatementData | undefined = doc.statement;
  const head = `<p><a href="#" data-go="statements">&larr; All statements</a></p><h2>${esc(doc.filename ?? id)}</h2>
    <p class="row">${doc.driveItemId && workspace ? `<button data-preview="${esc(id)}">Preview</button>` : ""}<button data-read-statement="${esc(id)}">${data ? "Read again" : "Read statement"}</button>${data ? `<button data-relink="1">Match again</button>` : ""}</p>`;
  const proofOwners = [...new Set(Object.values(state.additionalDocs).filter((a) => a.documentId === id && a.kind === "payment-proof" && a.ownerId).map((a) => a.ownerId!))];
  const redactForm = data && proofOwners.length
    ? `<form id="redact-form" class="row" data-doc="${esc(id)}"><label>Pages<select name="pages"><option value="all">Keep every page</option><option value="matched">Only pages with the linked charges</option></select></label>
        <label>Charges to show<select name="purchase"><option value="">Every charge linked this year</option>${proofOwners.map((o) => `<option value="${esc(o)}">Only ${esc(purchaseLabel(o))}</option>`).join("")}</select></label>
        <button>Make redacted copy</button></form>`
    : "";
  const redacted = redactedCopyOf(state, doc);
  const refundSuggestions = new Map(data ? matchRefunds(state, id, data).map((r) => [r.transactionId, r]) : []);
  const refundLinks = new Map(Object.values(state.additionalDocs).filter((a) => a.documentId === id && a.kind === "refund" && a.transactionId).map((a) => [a.transactionId!, a]));
  const redactedNote = redacted ? `<p class="note"><span class="ok">Redacted copy saved</span>: ${esc(redacted.filename)} <button data-preview="${esc(redacted.id)}">Preview</button> It is sent to StepUp instead of this statement.</p>` : data ? `<p class="note">No redacted copy yet: this statement would be sent as it is. Make one once its charges are linked.</p>` : "";
  if (!data) return `${head}<p class="note">Not read yet. Only PDFs with selectable text can be read automatically; for others, attach the file to a purchase by hand.</p>`;

  const cardKnown = data.last4 ? Object.values(state.paymentMethods).find((p) => p.last4?.includes(data.last4!)) : undefined;
  const card = data.last4
    ? cardKnown
      ? `<p class="note">Card: ${esc(cardKnown.label ?? `ending ${data.last4}`)}</p>`
      : `<form id="card-form" class="row" data-last4="${esc(data.last4)}" data-issuer="${esc(data.issuer)}"><input name="label" value="${esc(`${data.issuer ?? "Card"} ${data.last4}`)}" aria-label="Card name" required><button>Save this card</button></form>`
    : "";
  const period = data.periodStart && data.periodEnd ? `${data.periodStart} to ${data.periodEnd}` : "period not found";
  const matches = new Map<string, TransactionMatch>(matchStatement(state, id, data).map((m) => [m.transactionId, m]));
  const links = new Map(Object.values(state.additionalDocs).filter((a) => a.documentId === id && a.transactionId).map((a) => [a.transactionId!, a]));
  const rows = data.transactions.map((t) => {
    const amount = `<td class="num">${formatCents(t.amountCents)}</td>`;
    const base = `<td>${esc(t.date)}</td><td>${esc(t.descriptor)}${t.confidence < 0.8 ? ` <small class="warn">check this row</small>` : ""}</td>${amount}`;
    if (t.kind === "credit") {
      const done = refundLinks.get(t.id);
      const suggestion = refundSuggestions.get(t.id);
      const cell = done?.ownerId
        ? `<span class="ok">Refund of</span> ${esc(purchaseLabel(done.ownerId))} <button data-unlink-refund="${esc(done.ownerId)}" data-txn="${esc(t.id)}" data-doc="${esc(id)}">Undo</button>`
        : suggestion
          ? `<small>Refund or credit.</small> <button data-link-refund="${esc(suggestion.purchaseId)}" data-txn="${esc(t.id)}" data-doc="${esc(id)}" data-amount="${suggestion.amountCents}" title="${esc(suggestion.reasons.join(", "))}">Mark as a refund of ${esc(purchaseLabel(suggestion.purchaseId))}</button>`
          : `<small>Refund or credit</small>`;
      return `<tr class="${done ? "" : "muted"}">${base}<td>${cell}</td></tr>`;
    }
    if (t.kind !== "purchase") return `<tr class="muted">${base}<td><small>${t.kind === "payment" ? "Payment to the card" : "Fee or interest"}</small></td></tr>`;
    const link = links.get(t.id);
    if (link?.ownerId) {
      return `<tr>${base}<td><span class="ok">Linked</span> to ${esc(purchaseLabel(link.ownerId))}${link.source === "auto" ? ` <small>(automatic)</small>` : ""}
        <button data-unlink="${esc(link.ownerId)}" data-txn="${esc(t.id)}" data-doc="${esc(id)}">Undo</button></td></tr>`;
    }
    const m = matches.get(t.id);
    const cands = [m?.best, ...(m?.alternatives ?? [])].filter(Boolean).slice(0, 3);
    const buttons = cands.map((c) => `<button data-link="${esc(c!.purchaseId)}" data-txn="${esc(t.id)}" data-doc="${esc(id)}" title="${esc(c!.reasons.join(", "))}">Link to ${esc(purchaseLabel(c!.purchaseId))} <small>${Math.round(c!.confidence * 100)}%</small></button>`).join(" ");
    return `<tr>${base}<td>${buttons || `<small>No matching purchase yet</small>`}</td></tr>`;
  });
  const charges = data.transactions.filter((t) => t.kind === "purchase");
  const splits = matchSplitCharges(state, id, data);
  const splitSection = splits.length
    ? `<h3>Charges that add up to one purchase</h3><ul class="queue">${splits.map((s) => {
        const txns = s.transactionIds.map((tid) => data.transactions.find((t) => t.id === tid)!);
        return `<li class="q"><span>${txns.map((t) => `${esc(t.date)} ${formatCents(t.amountCents)}`).join(" + ")} = ${formatCents(txns.reduce((a, t) => a + t.amountCents, 0))}</span>
          <button data-link-split="${esc(s.purchaseId)}" data-txns="${esc(s.transactionIds.join(","))}" data-doc="${esc(id)}">Link all to ${esc(purchaseLabel(s.purchaseId))}</button></li>`;
      }).join("")}</ul><p class="note">One order shipped in parts is charged in parts. Each charge is linked as proof for the purchase.</p>`
    : "";
  return `${head}${redactedNote}<p class="note">${esc(data.issuer ?? "Card statement")}${data.last4 ? ` ending ${esc(data.last4)}` : ""} &middot; ${esc(period)} &middot; ${charges.filter((t) => links.has(t.id)).length} of ${charges.length} charges linked</p>${card}
    ${redactForm}
    <table><thead><tr><th>Date</th><th>Description</th><th>Amount</th><th>Matched purchase</th></tr></thead><tbody>${rows.join("")}</tbody></table>${splitSection}`;
}

/** Downloads a statement PDF, reads its text on this device, saves the charges and links the confident matches. */
async function readStatement(docId: string): Promise<void> {
  const got = await loadDocument(docId);
  note("Reading the statement on this device…");
  let text: string;
  let ocr = false;
  if (got.kind === "pdf") ({ text, ocr } = await pdfToText(got.blob));
  else if (got.kind === "image") ({ text } = await ocrImage(got.blob)), (ocr = true);
  else throw new Error("This file type can't be read. Attach it to a purchase by hand.");
  const parsed = parseStatementText(text, { confidencePenalty: ocr ? 0.2 : 0 });
  if (parsed.transactions.length === 0) {
    status = parsed.warnings.join(" ") + (ocr ? " The text was read by OCR and may be too unclear." : "");
    return;
  }
  saveStatement(ledger, docId, parsed);
  const auto = linkConfidentMatches(ledger, docId, matchStatement(ledger.state, docId, parsed));
  await ledger.flush();
  status = `Read ${parsed.transactions.length} line(s)${ocr ? " using OCR (check each row)" : ""}; linked ${auto} charge(s) automatically.${parsed.unparsedLines.length ? ` ${parsed.unparsedLines.length} line(s) could not be read.` : ""}`;
}

/** The text of a receipt or other document: its text layer, or OCR for scans and photos. Kept for the session. */
const documentTexts = new Map<string, { text: string; ocr: boolean }>();
async function documentText(docId: string): Promise<{ text: string; ocr: boolean }> {
  const cached = documentTexts.get(docId);
  if (cached) return cached;
  const got = await loadDocument(docId);
  note("Reading the receipt on this device…");
  let read: { text: string; ocr: boolean };
  if (got.kind === "pdf") read = await pdfToText(got.blob);
  else if (got.kind === "image") read = { text: (await ocrImage(got.blob)).text, ocr: true };
  else if (got.kind === "email") read = { text: emlToText(await got.blob.text()), ocr: false };
  else throw new Error("This file type can't be read. Fill in the details by hand.");
  documentTexts.set(docId, read);
  return read;
}

/** StepUp rejects a receipt over 5 MB: make a smaller copy, use it for this purchase, and keep the original untouched. */
async function shrinkReceipt(purchaseId: string): Promise<void> {
  const ws = workspace;
  const p = ledger.state.purchases[purchaseId];
  const original = p?.receiptDocumentId ? ledger.state.documents[p.receiptDocumentId] : undefined;
  if (!ws || !p || !original) return;
  const got = await loadDocument(original.id);
  if (got.kind !== "pdf" && got.kind !== "image") throw new Error("Only PDFs and photos can be shrunk here.");
  note("Making a smaller copy…");
  const small = await shrinkToLimit(got.blob, got.kind, MAX_PROOF_BYTES);
  const body = new Blob([small.bytes as BlobPart], { type: small.mime });
  const name = `${(original.filename ?? "Receipt").replace(/\.\w+$/, "")} (smaller).${small.ext}`;
  const result = await uploadReceipt(ledger, ws.driveId, ws.year.folderId, { name, body, sha256: (await sha256Hex(body)) || undefined });
  ledger.set("document", result.documentId, { derivedFrom: original.id, shrunk: true, contentKind: original.contentKind ?? "receipt-like", ...(original.paymentEvidenceConfidence !== undefined ? { paymentEvidenceConfidence: original.paymentEvidenceConfidence } : {}) }, { label: "document.shrunk" });
  ledger.set("purchase", purchaseId, { receiptDocumentId: result.documentId }, { label: "purchase.receiptShrunk" });
  await ledger.flush();
  status = `Made a smaller copy (${(small.bytes.byteLength / 1048576).toFixed(1)} MB: ${small.how}) and switched this purchase to it. The original is kept.`;
}

/** Fills only the blank fields of a purchase from its receipt, and records whether the receipt itself shows payment. */
async function readReceipt(purchaseId: string): Promise<void> {
  const p = ledger.state.purchases[purchaseId];
  const docId = p?.receiptDocumentId;
  if (!p || !docId) return;
  const { text, ocr } = await documentText(docId);
  const r = readReceiptText(text);
  const fields: Record<string, string | number> = {};
  if (!p.vendor && r.vendor) fields["vendor"] = r.vendor;
  if (!p.date && r.date) fields["date"] = r.date;
  if (!p.invoiceNo && r.invoiceNo) fields["invoiceNo"] = r.invoiceNo;
  if (p.orderTotalCents === undefined && r.totalCents !== undefined) fields["orderTotalCents"] = r.totalCents;
  if (p.taxShippingTotalCents === undefined && r.taxShippingCents !== undefined) fields["taxShippingTotalCents"] = r.taxShippingCents;
  if (Object.keys(fields).length) ledger.set("purchase", purchaseId, fields, { label: "purchase.readFromReceipt" });
  if (fields["taxShippingTotalCents"] !== undefined) reallocateTax(ledger, purchaseId);
  if (r.paymentEvidence) ledger.set("document", docId, { paymentEvidenceConfidence: r.paymentEvidence.confidence, paymentEvidenceSnippet: r.paymentEvidence.snippet }, { label: "document.paymentEvidence" });
  await ledger.flush();
  const names: Record<string, string> = { vendor: "vendor", date: "date", invoiceNo: "invoice #", orderTotalCents: "total", taxShippingTotalCents: "tax/shipping" };
  const filled = Object.keys(fields).map((k) => names[k]);
  const proof = r.paymentEvidence ? (r.paymentEvidence.confidence >= 0.8 ? " The receipt shows payment, so it counts as proof." : " It does not clearly show payment; a statement may be needed.") : " No sign of payment was found on it.";
  status = filled.length || r.paymentEvidence ? `${filled.length ? `Filled in ${filled.join(", ")}${ocr ? " (read by OCR: please check)" : ""}.` : "Nothing new to fill in."}${proof}` : "Could not read anything useful from this receipt. Fill in the details by hand.";
}

function tabs(): string {
  const tab = (name: string, label: string) => `<a href="#" data-go="${name}"${view.name === name || (name === "queue" && view.name === "purchase") || (name === "statements" && view.name === "statement") ? ` class="on" aria-current="page"` : ""}>${label}</a>`;
  return `<div class="tabs">${tab("queue", "Needs attention")}${tab("statements", "Statements")}${tab("summary", "Summary")}</div>`;
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
  const filing = filingNow();
  const statusCell = (i: (typeof items)[number], ev: ReturnType<typeof evaluateItem>): string => {
    const mine = filing[i.id];
    if (mine) return `<span class="badge filing">Being filed by ${esc(mine.actor)}</span>`;
    const label = displayStatus(i, ev, ctx(), state.settings["year"]?.submissionDeadline);
    if (i.stepUpStatus || i.submissionId) return `<span class="ok">${esc(label)}</span>`;
    return ev.readiness === "ready" ? `<span class="ok">Ready to file</span>` : `<small class="warn">${esc(ev.reasons.map((r) => r.message).join("; "))}</small>`;
  };
  const rows = items.map((i) => {
    const ev = evaluateItem(state, i.id, ctx());
    return `<tr><td>${esc(state.children[i.childId ?? ""]?.name ?? "?")}</td><td>${esc(i.description)}</td><td class="num">${formatCents(i.amountCents)}</td>
      <td class="num">${formatCents(i.taxShippingCents)}${i.taxShippingEstimated ? " <small>est.</small>" : ""}</td><td>${esc(categoryLabel(i))}</td>
      <td>${statusCell(i, ev)}</td>
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
  const filers = [...new Set(items.map((i) => filing[i.id]?.actor).filter((a): a is string => Boolean(a)))];
  const filingNotice = filers.length
    ? `<section class="filing-banner"><div class="filing-head"><strong>${esc(filers.join(" and "))} ${filers.length > 1 ? "are" : "is"} filing this purchase with StepUp right now</strong><button id="refresh-now">Refresh</button></div>
        <p class="note">Wait for the run to finish before changing it; edits made now may not be picked up. This page refreshes by itself every minute.</p></section>`
    : "";
  return `<p><a href="#" data-go="queue">&larr; Back to the list</a></p>
  ${filingNotice}${draftNote(items.map((i) => i.id))}
  <h2>Receipt${doc ? `: ${esc(doc.filename)}` : " (no file yet)"}</h2>
  ${doc?.driveItemId && workspace ? `<p class="row"><button data-preview="${esc(doc.id)}">Preview receipt</button><button data-read-receipt="${esc(id)}">Read receipt</button>${(doc.sizeBytes ?? 0) > MAX_PROOF_BYTES ? `<button data-shrink="${esc(id)}">Shrink to under 5 MB</button>` : ""}</p>${(doc.sizeBytes ?? 0) > MAX_PROOF_BYTES ? `<p class="note warn">This receipt is ${((doc.sizeBytes ?? 0) / 1048576).toFixed(1)} MB; StepUp only accepts files under 5 MB.</p>` : ""}` : ""}
  ${doc?.paymentEvidenceConfidence !== undefined ? (doc.paymentEvidenceConfidence >= 0.8 ? `<p class="note"><span class="ok">Receipt shows payment</span>${doc.paymentEvidenceSnippet ? `: &ldquo;${esc(doc.paymentEvidenceSnippet)}&rdquo;` : ""}</p>` : `<p class="note warn">Receipt does not clearly show payment${doc.paymentEvidenceSnippet ? `: &ldquo;${esc(doc.paymentEvidenceSnippet)}&rdquo;` : ""}. A statement may be needed.</p>`) : ""}
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
    return `<h2>Welcome</h2><div class="choices">
      <section class="card"><h3>Set up a new workspace</h3>
        <p class="note">Pick (or create) a folder in your own OneDrive to hold your school-year folders.</p>
        <p><button data-pick-mine="1">&#128193; Choose a folder in My OneDrive</button></p></section>
      <section class="card"><h3>Join a shared workspace</h3>
        <p class="note">If someone invited you to their folder, open the invitation, then in OneDrive choose <strong>Add shortcut to My files</strong> on it. After that, pick it from My OneDrive, or paste the folder's sharing link here.</p>
        <form id="pick-link" class="row"><input name="link" placeholder="OneDrive sharing link" required><button>Join with this link</button></form>
        ${picker.shared.length ? `<h4>Shared with you</h4><ul class="queue">${picker.shared.map((f, i) => `<li><button data-pick-shared="${i}">&#128193; ${esc(f.name)}</button></li>`).join("")}</ul>` : ""}</section>
    </div>`;
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
  const onboarding = account && !workspace;
  const body = onboarding ? onboardingView() : view.name === "queue" ? queueView() : view.name === "summary" ? summaryView() : view.name === "statements" ? statementsView() : view.name === "statement" ? statementReview(view.id) : purchaseView(view.id, view.draft);
  root.innerHTML = header() + (onboarding ? "" : tabs()) + scanPanel() + redactionPanel() + previewPanel() + body;
  scheduleClaimPoll();
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
  if (d["go"]) { ev.preventDefault(); go(d["go"] === "summary" ? { name: "summary" } : d["go"] === "statements" ? { name: "statements" } : { name: "queue" }); }
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
  else if (t.id === "new-year") { newYearOpen = !newYearOpen; render(); }
  else if (t.id === "check-files" && workspace) {
    await guarded(async () => {
      const ws = workspace!;
      const loose = planIngest(ledger.state, await listLooseFiles(ws.driveId, ws.year.folderId));
      registerLooseFiles(ledger, loose.toRegister);
      // The inbox is where emails saved as .eml, print-to-PDF receipts and phone shares can be dropped.
      const folders = await openLedgerFolders(ws.driveId, ws.year.folderId);
      const inbox = folders ? planIngest(ledger.state, await listLooseFiles(ws.driveId, folders.inboxId)) : { toRegister: [], alreadyKnown: 0 };
      registerLooseFiles(ledger, inbox.toRegister, "inbox");
      await ledger.flush();
      const n = loose.toRegister.length + inbox.toRegister.length;
      status = n ? `Registered ${n} new file(s)${inbox.toRegister.length ? ` (${inbox.toRegister.length} from the inbox folder)` : ""}.` : "No new files.";
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
  } else if (t.id === "update-reference") {
    await guarded(updateYearReference, "Updating the category list…");
    persist();
  } else if (t.id === "refresh-now") {
    if (workspace) await refreshInBackground(workspace);
    render();
  } else if (t.id === "update-mirror") {
    await guarded(async () => {
      const result = await publishMirrorNow();
      status = result === "written" ? "Spreadsheet updated." : result === "unchanged" ? "Spreadsheet is already up to date." : "The spreadsheet is open in Excel; close it and try again.";
    }, "Building the spreadsheet…");
  } else if (t.id === "toggle-mirror") {
    ledger.set("setting", "year", { mirror: !mirrorOn() }, { label: "setting.mirrorToggled" });
    await save();
  } else if (t.id === "issue-categories") {
    // A prefilled "new issue" page: anyone with a GitHub account can send the fixes; the app holds no GitHub credentials.
    const json = JSON.stringify(exportCategoryEdits(ledger.state.categories), null, 1);
    const body = `These category fixes came from the Step Up Helper (no private data; only category names, ids and flags).\n\n\`\`\`json\n${json}\n\`\`\`\n\nMaintainer: \`npm run reference:promote -- category-edits.json\``;
    const url = `https://github.com/${REPO}/issues/new?title=${encodeURIComponent("Category fixes")}&body=${encodeURIComponent(body)}`;
    if (url.length < 7000) window.open(url, "_blank", "noopener");
    else {
      window.open(`https://github.com/${REPO}/issues/new?title=${encodeURIComponent("Category fixes")}`, "_blank", "noopener");
      status = "That is too much to prefill: attach the file you just downloaded to the new issue.";
      const dl = URL.createObjectURL(new Blob([json], { type: "application/json" }));
      Object.assign(document.createElement("a"), { href: dl, download: "category-edits.json" }).click();
      URL.revokeObjectURL(dl);
      render();
    }
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
  } else if (d["statement"]) {
    view = { name: "statement", id: d["statement"] };
    render();
    if (!ledger.state.documents[d["statement"]]?.statement) await guarded(() => readStatement(d["statement"]!), "Reading the statement…");
  } else if (t.id === "start-scan") {
    const now = new Date();
    const stamp = `${String(now.getMonth() + 1).padStart(2, "0")} ${String(now.getDate()).padStart(2, "0")} ${now.getFullYear()}`;
    scan = { name: `Scan ${stamp}.pdf`, pages: [] };
    render();
  } else if (t.id === "scan-cancel") {
    discardScan();
    render();
  } else if (d["scanRotate"] && scan) {
    const p = scan.pages.find((x) => x.id === Number(d["scanRotate"]));
    if (p) p.rotation = (((p.rotation + 90) % 360) as ScanPage["rotation"]);
    render();
  } else if (d["scanUp"] && scan) {
    const i = scan.pages.findIndex((x) => x.id === Number(d["scanUp"]));
    if (i > 0) [scan.pages[i - 1], scan.pages[i]] = [scan.pages[i]!, scan.pages[i - 1]!];
    render();
  } else if (d["scanRemove"] && scan) {
    const gone = scan.pages.find((x) => x.id === Number(d["scanRemove"]));
    if (gone) URL.revokeObjectURL(gone.url);
    scan.pages = scan.pages.filter((x) => x !== gone);
    render();
  } else if (d["emlAttachments"]) {
    await guarded(async () => {
      const ws = workspace!;
      const got = await loadDocument(d["emlAttachments"]!);
      const found = receiptAttachments(parseEml(await got.blob.text()));
      let added = 0;
      for (const a of found) {
        const body = new Blob([a.bytes as BlobPart], { type: a.contentType });
        const r = await uploadReceipt(ledger, ws.driveId, ws.year.folderId, { name: a.filename, body, sha256: (await sha256Hex(body)) || undefined });
        if (r.status === "uploaded") added++;
      }
      await ledger.flush();
      status = found.length ? `Saved ${added} attachment(s) from the email as files${added < found.length ? ` (${found.length - added} were already there)` : ""}.` : "That email has no PDF or image attachments.";
    }, "Saving the email's attachments…");
    persist();
  } else if (d["shrink"]) {
    await guarded(() => shrinkReceipt(d["shrink"]!), "Making a smaller copy…");
    persist();
  } else if (d["readReceipt"]) {
    await guarded(() => readReceipt(d["readReceipt"]!), "Reading the receipt…");
    persist();
  } else if (d["readStatement"]) {
    await guarded(() => readStatement(d["readStatement"]!), "Reading the statement…");
    persist();
  } else if (t.id === "save-redaction") {
    await guarded(saveRedaction, "Saving the redacted copy…");
    persist();
  } else if (t.id === "discard-redaction") {
    discardRedaction();
    render();
  } else if (d["linkRefund"]) {
    linkRefund(ledger, d["linkRefund"], d["doc"]!, d["txn"]!, Number(d["amount"]));
    await save();
  } else if (d["unlinkRefund"]) {
    unlinkRefund(ledger, d["unlinkRefund"], d["doc"]!, d["txn"]!);
    await save();
  } else if (d["linkSplit"]) {
    for (const tid of d["txns"]!.split(",")) linkTransaction(ledger, d["linkSplit"], d["doc"]!, tid, "manual");
    status = "Linked all of those charges to the purchase.";
    await save();
  } else if (d["relink"]) {
    const n = relinkAllStatements(ledger);
    status = n ? `Linked ${n} more charge(s).` : "No new confident matches.";
    await save();
  } else if (d["link"]) {
    linkTransaction(ledger, d["link"], d["doc"]!, d["txn"]!, "manual");
    const txn = ledger.state.documents[d["doc"]!]?.statement?.transactions.find((x) => x.id === d["txn"]);
    if (txn && learnAlias(ledger, txn.descriptor, ledger.state.purchases[d["link"]]?.vendor)) status = "Linked. Next time this name will match by itself.";
    await save();
  } else if (d["unlink"]) {
    unlinkTransaction(ledger, d["unlink"], d["doc"]!, d["txn"]!);
    await save();
  } else if (d["markStatement"]) {
    ledger.set("document", d["markStatement"], { contentKind: "statement" }, { label: "document.markedStatement" });
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
  if (form.id === "new-year-form" && workspace) {
    const label = val(form, "label");
    const pointer = workspace.pointer;
    const exists = workspace.years.some((y) => y.label === label && y.kind === "ledger");
    await guarded(async () => {
      const target = exists ? pointer : await startYear(pointer, label);
      attach(await openWorkspace(target, store.clientId, label));
      newYearOpen = false;
    }, `Setting up ${label}…`);
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
  if (form.id === "redact-form") {
    const docId = form.dataset["doc"]!;
    const pages = (form.elements.namedItem("pages") as HTMLSelectElement).value === "matched" ? "matched" : "all";
    const purchaseId = (form.elements.namedItem("purchase") as HTMLSelectElement).value || undefined;
    await guarded(() => makeRedaction(docId, { pages, ...(purchaseId ? { purchaseId } : {}) }), "Making the redacted copy…");
    window.scrollTo({ top: 0 });
    return;
  }
  if (form.id === "scan-form" && scan && workspace) {
    const ws = workspace;
    const draft = scan;
    const name = val(form, "name").replace(/\.pdf$/i, "") + ".pdf";
    await guarded(async () => {
      const bytes = await buildScanPdf(draft.pages, MAX_PROOF_BYTES);
      const body = new Blob([bytes as BlobPart], { type: "application/pdf" });
      const result = await uploadReceipt(ledger, ws.driveId, ws.year.folderId, { name, body, sha256: (await sha256Hex(body)) || undefined });
      await ledger.flush();
      status = result.status === "uploaded" ? `Saved "${result.name}" (${draft.pages.length} page(s)) to the list.` : `That scan was already added as "${result.name}".`;
      discardScan();
      persist();
    }, "Building the PDF…");
    return;
  }
  if (form.id === "card-form") {
    const last4 = form.dataset["last4"]!;
    ledger.set("paymentMethod", `pm-card-${last4}`, { label: val(form, "label"), kind: "card", last4: [last4], ...(form.dataset["issuer"] ? { issuer: form.dataset["issuer"] } : {}) }, { label: "paymentMethod.created" });
  } else if (form.id === "deadline-form") {
    ledger.set("setting", "year", { submissionDeadline: val(form, "deadline") }, { label: "setting.deadlineSet" });
  } else if (form.dataset["cap"]) {
    const cap = toCents(val(form, "cap"));
    ledger.set("child", form.dataset["cap"], { capCents: cap ?? 0 }, { label: "child.awardSet" });
  } else if (form.id === "category-form") {
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
  if (input.id === "scan-add" && input.files?.[0] && scan) {
    const file = input.files[0];
    input.value = "";
    await guarded(async () => {
      scan!.pages.push(await addScanPage(file));
    }, "Checking the photo…");
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
        if (cached?.snapshot) {
          yearSnapshot = cached.snapshot;
          referenceBase = cached.snapshot;
        }
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
  publishedRef = r;
  if (!yearSnapshot) referenceBase = r; // before the year's own copy is known (or in local mode)
  if (workspace && !yearSnapshot) void loadYearReference(workspace);
  if (r && !typing()) render();
});

// Installable / works offline: the page and its scripts are cached by the service worker (public/sw.js).
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch(() => undefined);
}
