import {
  stepUpStatusUrl,
  ledgerHistory,
  readHistoryFiles,
  type HistoryChange,
  type HistoryReadCache,
  type HistorySource,
  type LineItem,
  type StorageAccount,
  type LedgerEvent,
  HlcClock,
  isStorageError,
  scholarshipNamesMatch,
  Ledger,
  createSubfolder,
  listLooseFiles,
  type FolderEntry,
  planIngest,
  registerLooseFiles,
  addItem,
  attachAdditional,
  attachAsReceipt,
  detachAdditional,
  updateItem,
  moveReceiptToAdditional,
  buildQueue,
  awaitingReview,
  duplicateItem,
  evaluateItem,
  setReadyToSubmit,
  fileNameHints,
  formatCents,
  itemsOf,
  effectiveDate,
  newId,
  reallocateTax,
  clearTaxTotal,
  observeActivity,
  yearSummary,
  emlToText,
  parseEml,
  receiptAttachments,
  itemsBeingFiled,
  displayStatus,
  parseStatementText,
  saveStatement,
  clusterStatements,
  statementDisplayName,
  chargesForPurchase,
  purchasesForCharge,
  sortCandidates,
  type AssistSort,
  type ChargeCandidate,
  type PurchaseCandidate,
  editStatementDetails,
  editTransaction,
  addTransaction,
  removeTransaction,
  mergeReread,
  isIsoDate,
  matchStatement,
  linkTransaction,
  matchRefunds,
  matchSplitCharges,
  linkRefund,
  unlinkRefund,
  checkRedactionOutput,
  summarizeChanges,
  readableFileName,
  clockLooksWrong,
  serverClockSkewMs,
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
  staleRedactions,
  locateCharges,
  readReceiptText,
  redactedCopyOf,
  type RedactionPlan,
  type StatementData,
  type TransactionMatch,
  openLedgerFolders,
  uploadReceipt,
  setPurchaseArchived,
  setDocumentArchived,
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
  planSubmissions,
  hasErrors,
  verifyLedger,
  verifyFiles,
  zipBackup,
  backupFileName,
  archiveStepUpList,
  resultsFromSavedList,
  applyStepUpStatuses,
  messageOf,
  type ApiLineItem,
  type Finding,
} from "@step-up/shared/web";
import { storage } from "./storage.js";
import { microsoftAuth } from "./auth.js";
import { googleAuth, googleConfigured } from "./googleAuth.js";
import { rememberStorage, switchStorage } from "./storage.js";
import { LocalEventStore, exportJsonl, parseJsonl } from "./localStore.js";
import { cacheKey, clearCache, deleteCache, listQueuedUploads, queueUpload, readCache, readOutbox, removeQueuedUpload, writeCache, writeOutbox } from "./cache.js";
import { copyFromPreviousYear, hasEarlierYear, loadPointer, openFromCache, openWorkspace, revalidate, snapshotFor, NoLedgerYearError, isDeadPointer, pointerFromFolder, workspaceFolder, forgetLocalPointer, savePointer, startYear, type Pointer, type OpenWorkspace } from "./workspace.js";
import { enforceReadOnly } from "./readOnly.js";
import { isStepUpHello, loaderHref, stepUpListFrom } from "./stepUpBridge.js";
import { UNCLEAR_FILTER, chooseReceipt, clearableSearch, clearDrill, drillInto, getDrill, legacyBanner, listControls, listCount, listRowAttrs, legacySpreadsheet, pivotTables, resetPivots, setPivot } from "./legacyYear.js";
import { loadBaseline as loadReference, loadProviders } from "./reference.js";
import { ocrLanguageName, ocrLanguages, onOcrProgress, ocrImage, setOcrLanguages } from "./ocr.js";
import { shrinkToLimit } from "./shrink.js";
import { cacheDocument, clearCachedDocuments, getCachedDocument, hasSharedFiles, takeSharedFiles } from "./docCache.js";
import { addScanPage, buildScanPdf, type ScanPage } from "./scan.js";
import { pdfFirstPageOcrText, pdfLines, pdfToText, renderPdfPagesJpeg, renderRedactedPdf } from "./pdfText.js";
import { photoName, prepareUpload, previewKind, sha256Hex, type PreviewKind } from "./files.js";
import { enablePullToRefresh } from "./pullRefresh.js";
import "./style.css";

enablePullToRefresh();

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
let account: StorageAccount | undefined;
let workspace: OpenWorkspace | undefined;
let activeStore: EventStore = store;
let status = "";
/** Folder picker (onboarding): `path` empty means the top level (own OneDrive + folders shared with the person). */
let picker: { path: FolderEntry[]; mine?: FolderEntry; shared: FolderEntry[]; list: FolderEntry[] } = { path: [], shared: [], list: [] };
let pendingYear: Pointer | undefined;
let sharing = false;
let newYearOpen = false;
/** The add-child fields stay hidden until "New child" is pressed. */
let addingChild = false;
/** The purchase whose receipt is being replaced: only then are the ways to add a receipt shown. */
let replacingReceipt: string | undefined;
/** The statement row open for correcting (its id), or "new" while a missed row is being added. */
let editingTxn: string | undefined;
/**
 * The manual-linking helper: the charge (on a statement) or the purchase it is open for, and how its list is ordered and
 * narrowed. Opening it for something else starts the ordering and filters over.
 */
let assist: { kind: "txn"; docId: string; txnId: string } | { kind: "purchase"; purchaseId: string } | undefined;
let assistView: { sort: AssistSort; card: string; child: string; vendor: string; method: string; noProof: boolean } = { sort: "best", card: "", child: "", vendor: "", method: "", noProof: false };
const resetAssistView = () => { assistView = { sort: "best", card: "", child: "", vendor: "", method: "", noProof: false }; };
/** The item the add-an-item form is working on: once its required details are filled in it exists and edits update it. */
let itemEdit: { purchaseId: string; itemId?: string } | undefined;
const itemDraftKey = (purchaseId: string) => `stepup.itemdraft.${purchaseId}`;
function readItemDraft(purchaseId: string): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(itemDraftKey(purchaseId)) ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
}
function writeItemDraft(purchaseId: string, values: Record<string, string> | undefined): void {
  try {
    if (values) localStorage.setItem(itemDraftKey(purchaseId), JSON.stringify(values));
    else localStorage.removeItem(itemDraftKey(purchaseId));
  } catch {
    /* storage blocked: the half-filled form is just not remembered */
  }
}

/** Shared category tree (plan §3.8), loaded in the background. Until it arrives (or if it cannot load) every category counts as known. */
/** The latest published category list; each year works from its own frozen copy of it (`referenceBase`). */
let publishedRef: CategoryReference | undefined;
let yearSnapshot: CategoryReference | undefined;
let referenceBase: CategoryReference | undefined;
let ledgerFolderId: { yearFolderId: string; id: string } | undefined;

/** Finds (or, the first time, freezes) this year's copy of the category list. */
async function loadYearReference(ws: OpenWorkspace): Promise<void> {
  if (ws.legacy) return; // a year Excel owns has no frozen category list of its own
  try {
    if (ledgerFolderId?.yearFolderId !== ws.year.folderId) {
      const folders = await openLedgerFolders(storage, ws.driveId, ws.year.folderId);
      if (!folders) return;
      ledgerFolderId = { yearFolderId: ws.year.folderId, id: folders.ledgerId };
    }
    let snap = await readYearSnapshot(storage, ws.driveId, ledgerFolderId.id);
    if (!snap && publishedRef) {
      await writeYearSnapshot(storage, ws.driveId, ledgerFolderId.id, publishedRef);
      snap = (await readYearSnapshot(storage, ws.driveId, ledgerFolderId.id)) ?? publishedRef;
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
  if (!ws || !publishedRef || !yearSnapshot || !ledgerFolderId || ledgerFolderId.yearFolderId !== ws.year.folderId) return;
  const d = diffReference(yearSnapshot, publishedRef);
  const ok = confirm(
    `Update this year's category list to version ${publishedRef.version}?\n\n${d.added.length} new, ${d.changed.length} changed${d.removed.length ? `, ${d.removed.length} no longer published (kept, marked inactive)` : ""}.\nItems already filed keep their category; your own category fixes stay on top.`
  );
  if (!ok) return;
  const merged = mergeReference(yearSnapshot, publishedRef);
  await writeYearSnapshot(storage, ws.driveId, ledgerFolderId.id, merged, true);
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

/**
 * A year Excel still owns is shown on the very same screens as a ledger year, read-only. Views are written once, for the
 * ledger; this flag only drops what edits (and the app's own rules talking where Excel's status is the authority).
 */
const readOnly = (): boolean => Boolean(workspace?.legacy);

/** What the status column reads for an item: Excel's own words for a year Excel owns, the app's otherwise. */
function statusLabel(i: (typeof ledger.state.items)[string], ev?: ReturnType<typeof evaluateItem>): string {
  if (readOnly()) return i.statusOverride ?? i.stepUpStatus ?? (i.submissionId ? "Submitted" : "(no status)");
  return displayStatus(i, ev ?? evaluateItem(ledger.state, i.id, ctx()), ctx(), ledger.state.settings["year"]?.submissionDeadline);
}

/**
 * For a year Excel owns, the one thing a person can change: which file is the receipt when the workbook's rows list
 * several and do not say. The answer is kept beside the workbook; nothing in Excel changes.
 */
function receiptChoice(purchaseId: string): string {
  const l = workspace?.legacy;
  if (!l) return "";
  const state = l.ledger.state;
  const unclear = l.year.unclear.find((u) => u.purchaseId === purchaseId);
  if (unclear) {
    const byName = (name: string) => Object.values(state.documents).find((d) => d.filename === name);
    return `<section><h4>Which file is the receipt?</h4>
      <p class="note">The workbook lists these files on this purchase's rows and none is clearly the receipt. Pick the one that is. This is remembered beside the workbook; nothing in Excel changes.</p>
      <ul class="queue">${unclear.candidates.map((name, n) => `<li class="q"><span>${esc(name)}</span><span class="actions">${byName(name)?.driveItemId ? `<button data-preview="${esc(byName(name)!.id)}">Preview</button>` : ""}<button data-legacy-pick="${esc(purchaseId)}" data-file-index="${n}">This is the receipt</button></span></li>`).join("")}</ul></section>`;
  }
  const picked = l.year.result.report.ambiguousReceipts.find((a) => a.resolvedFromCache && state.items[a.itemId]?.purchaseId === purchaseId);
  return picked ? `<p class="note">You chose this file as the receipt. <button data-legacy-clear="${esc(purchaseId)}">Take my choice back</button></p>` : "";
}

/** Purchases whose workbook rows list several files without saying which is the receipt (a year Excel owns only). */
const unclearReceipt = (purchaseId: string): boolean => Boolean(workspace?.legacy?.year.unclear.some((u) => u.purchaseId === purchaseId));

/** `draft` purchases exist only on screen until a detail is saved, so backing out never leaves an empty one behind. */
/** The receipt being looked at. Documents never change, so a downloaded copy is kept for the session. */
let preview: { docId: string; filename: string; url: string; kind: PreviewKind; webUrl?: string; pages?: string[]; marks?: PreviewMark[]; purchaseId?: string } | undefined;
/** A box to highlight on a previewed page, as percentages of that page so it follows however the picture is scaled. */
interface PreviewMark { page: number; left: number; top: number; width: number; height: number }
/** Set when a preview has highlighted charges: the next render scrolls the first one into view. */
let scrollToMark = false;

/**
 * iPhone and iPad show only the first page of a PDF inside an <iframe> and cannot scroll to the rest, so there a PDF is
 * drawn page by page as pictures instead. Everywhere else the browser's own viewer is better (zoom, search, select).
 */
const iosLike = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

async function pdfPagePictures(blob: Blob): Promise<string[]> {
  const pages = await renderPdfPagesJpeg(blob, 1.5, 0.82);
  return pages.map((p) => URL.createObjectURL(new Blob([p.jpeg as BlobPart], { type: "image/jpeg" })));
}

function clearPreview(): void {
  preview?.pages?.forEach((u) => URL.revokeObjectURL(u));
  preview = undefined;
}
const downloaded = new Map<string, { url: string; kind: PreviewKind; blob: Blob }>();
const emailTexts = new Map<string, string>();

/** Downloads a document once per session (documents never change) and keeps it for previews and for reading statements. */
async function loadDocument(docId: string): Promise<{ url: string; kind: PreviewKind; blob: Blob }> {
  const doc = ledger.state.documents[docId];
  if (!doc?.driveItemId || !workspace) throw new Error(`That file is not in ${storage.label}.`);
  const filename = doc.filename ?? "file";
  let got = downloaded.get(docId);
  if (!got) {
    const wsKey = keyOf(workspace.pointer);
    // Documents never change: use the copy kept on this device if there is one.
    let raw = await getCachedDocument(wsKey, docId, doc.sizeBytes);
    if (!raw) {
      raw = await storage.download(workspace.driveId, doc.driveItemId, `Downloading ${filename}…`);
      void cacheDocument(wsKey, docId, raw);
    }
    const kind = previewKind(filename, raw.type);
    const blob = kind === "pdf" && raw.type !== "application/pdf" ? new Blob([raw], { type: "application/pdf" }) : raw;
    got = { url: URL.createObjectURL(blob), kind, blob };
    downloaded.set(docId, got);
  }
  return got;
}

/** A receipt being photographed page by page. Nothing leaves this device until it is saved. */
/** `purchaseId`: the purchase the scan is for (the PDF becomes its receipt, or extra documentation if it has one). */
let scan: { name: string; pages: ScanPage[]; purchaseId?: string; role?: DocRole; statement?: boolean } | undefined;
type DocRole = "receipt" | "additional";

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
let redactionDraft: { docId: string; bytes: Uint8Array; url: string; plan: RedactionPlan; check: RedactionCheck; keeps: string[]; pages?: string[]; purchaseId?: string; viewOnly?: boolean } | undefined;
const MAX_PROOF_BYTES = 5 * 1024 * 1024;

function discardRedaction(): void {
  if (redactionDraft) {
    URL.revokeObjectURL(redactionDraft.url);
    redactionDraft.pages?.forEach((u) => URL.revokeObjectURL(u));
  }
  redactionDraft = undefined;
}

/**
 * Builds the redacted copy of a statement on this device: everything is blacked out except the issuer, the period, the
 * column headings and the charges already linked to purchases (plan §3.10a). Shown for review; nothing is saved yet.
 */
async function makeRedaction(docId: string, options: { pages: "all" | "matched"; purchaseId?: string; viewOnly?: boolean } = { pages: "all" }): Promise<void> {
  const links = Object.values(ledger.state.additionalDocs).filter((a) => a.documentId === docId && a.kind === "payment-proof" && a.transactionId && (!options.purchaseId || a.ownerId === options.purchaseId));
  const keep = new Set(links.map((a) => a.transactionId!));
  note("Finding what to keep…");
  const built = await buildRedaction(docId, keep, options.pages);
  discardRedaction();
  const redactedBlob = new Blob([built.bytes as BlobPart], { type: "application/pdf" });
  const pages = iosLike ? await pdfPagePictures(redactedBlob) : undefined;
  redactionDraft = { docId, bytes: built.bytes, url: URL.createObjectURL(redactedBlob), plan: built.plan, check: built.check, keeps: [...keep].sort(), ...(pages ? { pages } : {}), ...(options.purchaseId ? { purchaseId: options.purchaseId } : {}), ...(options.viewOnly ? { viewOnly: true } : {}) };
}

/** Blacks out everything except the header and the given charges, then reads the result again to check it. Nothing is saved. */
async function buildRedaction(docId: string, keep: ReadonlySet<string>, pages: "all" | "matched"): Promise<{ bytes: Uint8Array; plan: RedactionPlan; check: RedactionCheck }> {
  const got = await loadDocument(docId);
  if (got.kind !== "pdf") throw new Error("Only PDF statements can be redacted here.");
  if (keep.size === 0) throw new Error("Link at least one charge to a purchase first; only linked charges stay visible.");
  const read = await pdfLines(got.blob);
  const plan = planRedaction(read.pages, { keepTransactionIds: keep, pages });
  if (read.ocr) plan.warnings.push("Some pages were read with OCR, so the boxes may be less exact. Check every page carefully.");
  if (plan.keptTransactions === 0) throw new Error(plan.warnings.join(" ") || "Nothing on this statement could be kept.");
  note("Blacking out the rest, then reading the result to check it…");
  const { bytes, ocrTexts } = await renderRedactedPdf(got.blob, plan);
  if (bytes.byteLength > MAX_PROOF_BYTES) throw new Error("The redacted copy is over StepUp's 5 MB limit.");
  const missing = new Set(plan.missing);
  const keptTxns = (ledger.state.documents[docId]?.statement?.transactions ?? []).filter((t) => keep.has(t.id) && !missing.has(t.id));
  return { bytes, plan, check: checkRedactionOutput(ocrTexts, keptTxns, { headerKept: plan.headerKept, regionText: plan.regionText }) };
}

/** Uploads a redacted copy next to its statement and makes it the one that is sent. */
async function storeRedaction(docId: string, bytes: Uint8Array, keeps: string[]): Promise<void> {
  const ws = workspace;
  const original = ledger.state.documents[docId];
  if (!ws || !original) return;
  const body = new Blob([bytes as BlobPart], { type: "application/pdf" });
  const name = `${(original.filename ?? "Statement").replace(/\.pdf$/i, "")} (redacted).pdf`;
  for (const old of Object.values(ledger.state.documents)) if (old.redacted && old.derivedFrom === docId) ledger.set("document", old.id, { redacted: false }, { label: "document.redactionSuperseded" });
  const result = await uploadReceipt(ledger, storage, ws.driveId, ws.year.folderId, { name, body, sha256: (await sha256Hex(body)) || undefined });
  ledger.set("document", result.documentId, { derivedFrom: docId, redacted: true, redactedKeeps: keeps, contentKind: "statement" }, { label: "document.redacted" });
  await ledger.flush();
}

async function saveRedaction(): Promise<void> {
  const draft = redactionDraft;
  if (!draft || draft.viewOnly) return;
  await storeRedaction(draft.docId, draft.bytes, draft.keeps);
  discardRedaction();
  status = "Saved the redacted copy. It will be sent to StepUp instead of the original statement.";
}

let refreshingRedactions = false;
let redactionTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Keeps each statement's saved redacted copy matching the charges linked to purchases, so linking another charge never
 * means remaking and saving the copy by hand. A refreshed copy is saved only when reading it back finds every kept
 * charge legible and nothing else; otherwise the old copy stays and the statement page explains what to check.
 */
function scheduleRedactionRefresh(): void {
  if (redactionTimer) clearTimeout(redactionTimer);
  redactionTimer = setTimeout(() => void refreshRedactions(), 4000);
}

async function refreshRedactions(): Promise<void> {
  if (refreshingRedactions || !workspace || workspace.legacy || !navigator.onLine || redactionDraft) return;
  const stale = staleRedactions(ledger.state);
  if (stale.length === 0) return;
  refreshingRedactions = true;
  try {
    for (const s of stale) {
      try {
        const built = await buildRedaction(s.documentId, new Set(s.keep), "matched");
        if (built.check.leaks.length || built.check.unreadable.length || built.plan.missing.length) continue;
        await storeRedaction(s.documentId, built.bytes, s.keep);
      } catch { /* leave the old copy; a person can make one from the statement page */ }
    }
    persist();
    if (!typing()) render();
  } finally {
    refreshingRedactions = false;
  }
}

async function openPreview(docId: string): Promise<void> {
  const doc = ledger.state.documents[docId];
  if (!doc?.driveItemId || !workspace) return;
  const filename = doc.filename ?? "receipt";
  const got = await loadDocument(docId);
  if (got.kind === "email") emailTexts.set(docId, emlToText(await got.blob.text()));
  const pages = iosLike && got.kind === "pdf" ? await pdfPagePictures(got.blob) : undefined;
  clearPreview();
  preview = { docId, filename, url: got.url, kind: got.kind, ...(doc.webUrl ? { webUrl: doc.webUrl } : {}), ...(pages ? { pages } : {}) };
}

/**
 * Previews a statement from the purchase it proves: every page is drawn as a picture with the purchase's charge(s)
 * boxed, and the first one is scrolled into view. A file that cannot be read this way is shown plainly.
 */
async function openProofPreview(docId: string, purchaseId: string): Promise<void> {
  const doc = ledger.state.documents[docId];
  if (!doc?.driveItemId || !workspace) return;
  const ids = new Set(Object.values(ledger.state.additionalDocs).filter((a) => a.documentId === docId && a.kind === "payment-proof" && a.ownerId === purchaseId && a.transactionId).map((a) => a.transactionId!));
  const got = await loadDocument(docId);
  if (got.kind !== "pdf" || ids.size === 0) return openPreview(docId);
  const located = locateCharges((await pdfLines(got.blob)).pages, ids);
  const images = await renderPdfPagesJpeg(got.blob, 1.5, 0.82);
  const marks: PreviewMark[] = located.flatMap((c) => {
    const img = images[c.page];
    if (!img) return [];
    const pad = 2;
    return [{ page: c.page, left: (Math.max(0, c.rect.x0 - pad) / img.widthPt) * 100, top: ((img.heightPt - c.rect.y1 - pad) / img.heightPt) * 100, width: ((c.rect.x1 - c.rect.x0 + 2 * pad) / img.widthPt) * 100, height: ((c.rect.y1 - c.rect.y0 + 2 * pad) / img.heightPt) * 100 }];
  });
  const pages = images.map((p) => URL.createObjectURL(new Blob([p.jpeg as BlobPart], { type: "image/jpeg" })));
  clearPreview();
  preview = { docId, filename: doc.filename ?? "statement", url: got.url, kind: "pdf", pages, marks, purchaseId, ...(doc.webUrl ? { webUrl: doc.webUrl } : {}) };
  scrollToMark = marks.length > 0;
  if (marks.length < ids.size) status = `Found ${marks.length} of ${ids.size} linked charge(s) in this PDF; the rest could not be located on its pages.`;
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
      <span>${d.viewOnly ? "" : `<button id="save-redaction"><strong>Looks right: save it</strong></button>`}<button id="discard-redaction">${d.viewOnly ? "Close" : "Discard"}</button></span></div>
    ${d.viewOnly ? `<p class="note" style="padding:8px 14px;margin:0">Just a look at what is shown for ${esc(purchaseLabel(d.purchaseId ?? ""))}. Nothing is saved: the copy that is sent keeps every linked charge and refreshes itself when links change.</p>` : ""}
    <p class="note" style="padding:8px 14px;margin:0">Check every page. Only the statement's header, the column headings and ${d.plan.keptTransactions} linked charge(s) should be readable; everything else must be black.</p>
    ${verdict}${missing}${warnings}${d.pages ? `<div class="pages">${d.pages.map((u, i) => `<img src="${esc(u)}" alt="Redacted copy, page ${i + 1}">`).join("")}</div>` : `<iframe src="${esc(d.url)}" title="Redacted copy"></iframe>`}</section>`;
}

function previewPanel(): string {
  if (!preview) return "";
  const open = preview.webUrl?.startsWith("https://") ? ` <a href="${esc(preview.webUrl)}" target="_blank" rel="noopener">Open in ${esc(storage.label)}</a>` : "";
  const body =
    preview.kind === "image" ? `<img src="${esc(preview.url)}" alt="${esc(preview.filename)}">`
    : preview.kind === "pdf" && preview.pages ? `<div class="pages">${preview.pages.map((u, i) => {
        const boxes = (preview!.marks ?? []).filter((m) => m.page === i).map((m) => `<span class="hl" style="left:${m.left.toFixed(2)}%;top:${m.top.toFixed(2)}%;width:${m.width.toFixed(2)}%;height:${m.height.toFixed(2)}%"></span>`).join("");
        return preview!.marks ? `<div class="page-mark"><img src="${esc(u)}" alt="${esc(preview!.filename)}, page ${i + 1}">${boxes}</div>` : `<img src="${esc(u)}" alt="${esc(preview!.filename)}, page ${i + 1}">`;
      }).join("")}</div>`
    : preview.kind === "pdf" ? `<iframe src="${esc(preview.url)}" title="${esc(preview.filename)}"></iframe>`
    : preview.kind === "email" ? `<pre class="mail">${esc(emailTexts.get(preview.docId) ?? "")}</pre>`
    : `<p class="note">This file type cannot be previewed here.${open}</p>`;
  return `<section class="preview"><div class="preview-bar"><strong>${esc(preview.filename)}</strong><span>${preview.kind === "other" || preview.kind === "email" ? "" : open}${preview.purchaseId && preview.kind === "pdf" ? `<button data-redact-view="${esc(preview.docId)}" data-purchase="${esc(preview.purchaseId)}" title="Hides every other charge, account number and balance">See it redacted</button>` : ""}<button id="close-preview">Close</button></span></div>${preview.marks?.length ? `<p class="note" style="padding:8px 14px;margin:0">The highlighted line${preview.marks.length === 1 ? " is" : "s are"} the charge${preview.marks.length === 1 ? "" : "s"} linked to ${esc(purchaseLabel(preview.purchaseId ?? ""))}.</p>` : ""}${body}</section>`;
}

/**
 * Uploads a receipt file, or - if there is no connection - keeps it on this device and uploads it when there is one.
 * Returns what happened so the caller can tell the person.
 */
async function uploadOrQueue(file: { name: string; blob: Blob; sha256?: string }): Promise<{ status: "uploaded" | "duplicate" | "queued"; name: string; documentId?: string }> {
  const ws = workspace!;
  const queue = async () => {
    await queueUpload(keyOf(ws.pointer), file);
    queuedUploads = (await listQueuedUploads(keyOf(ws.pointer))).length;
    return { status: "queued" as const, name: file.name };
  };
  if (!navigator.onLine) return queue();
  try {
    const result = await uploadReceipt(ledger, storage, ws.driveId, ws.year.folderId, { name: file.name, body: file.blob, sha256: file.sha256 });
    await ledger.flush();
    return result;
  } catch (err) {
    // A dropped connection mid-upload: keep the file rather than lose the effort. Anything else is a real error.
    if (!navigator.onLine || err instanceof TypeError) return queue();
    throw err;
  }
}

let queuedUploads = 0;
let flushingUploads = false;

/** Uploads whatever was chosen while offline. Safe to call any time; one run at a time. */
async function flushQueuedUploads(): Promise<void> {
  const ws = workspace;
  if (!ws || ws.legacy || flushingUploads || !navigator.onLine) return;
  flushingUploads = true;
  try {
    const key = keyOf(ws.pointer);
    const waiting = await listQueuedUploads(key);
    queuedUploads = waiting.length;
    if (waiting.length === 0) return;
    showBusy(`Uploading ${waiting.length} file(s) saved while offline…`);
    let done = 0;
    try {
      for (const f of waiting) {
        await uploadReceipt(ledger, storage, ws.driveId, ws.year.folderId, { name: f.name, body: f.blob, sha256: f.sha256 });
        await ledger.flush();
        await removeQueuedUpload(f.id);
        done++;
      }
    } catch (err) {
      status = `Could not upload the waiting files yet (${err instanceof Error ? err.message : err}). They are kept and will be tried again.`;
    } finally {
      hideBusy();
    }
    queuedUploads = (await listQueuedUploads(key)).length;
    if (done) status = `Uploaded ${done} file(s) that were saved while offline.${status ? " " + status : ""}`;
    persist();
    render();
  } finally {
    flushingUploads = false;
  }
}

/**
 * Puts a file on a purchase as its receipt (replacing any earlier one) or as additional documentation. A purchase that
 * is still a blank draft is created here, with the file as its receipt.
 */
function attachToPurchase(purchaseId: string, docId: string, role: DocRole = "receipt"): void {
  const p = ledger.state.purchases[purchaseId];
  if (role === "receipt" && replacingReceipt === purchaseId) replacingReceipt = undefined;
  if (!p) {
    ledger.set("purchase", purchaseId, { receiptDocumentId: docId }, { label: "purchase.created" });
    if (view.name === "purchase" && view.id === purchaseId) view = { name: "purchase", id: purchaseId };
  } else if (role === "receipt") attachAsReceipt(ledger, purchaseId, docId, { replace: true });
  else attachAdditional(ledger, { kind: "purchase", id: purchaseId }, docId);
}

async function uploadFiles(files: File[], fromCamera: boolean, purchaseId?: string, role: DocRole = "receipt", asStatement = false): Promise<void> {
  if (!workspace || files.length === 0) return;
  await guarded(async () => {
    let added = 0;
    let waiting = 0;
    let attached = 0;
    let marked = 0;
    const markedIds: string[] = [];
    const receiptReads: Array<{ docId: string; purchaseId?: string }> = [];
    const dupes: string[] = [];
    for (const [i, file] of files.entries()) {
      note(`Preparing ${file.name} (${i + 1} of ${files.length})…`);
      const prepared = await prepareUpload(file);
      const name = fromCamera ? photoName(file) : prepared.name;
      const result = await uploadOrQueue({ name, blob: prepared.body, sha256: (await sha256Hex(prepared.body)) || undefined });
      if (result.status === "uploaded") added++;
      else if (result.status === "queued") waiting++;
      else dupes.push(result.name);
      if (asStatement && result.status === "uploaded" && result.documentId) {
        ledger.set("document", result.documentId, { contentKind: "statement" }, { label: "document.markedStatement" });
        marked++;
        markedIds.push(result.documentId);
      }
      if (purchaseId && result.documentId && result.status !== "queued") {
        attachToPurchase(purchaseId, result.documentId, role);
        attached++;
      }
      // A receipt (on a purchase, or unattached) is read as soon as it is added; extra documentation is not.
      if (!asStatement && result.status === "uploaded" && result.documentId && (!purchaseId || role === "receipt")) receiptReads.push({ docId: result.documentId, ...(purchaseId ? { purchaseId } : {}) });
    }
    if (attached || marked) await ledger.flush();
    const readNotes = [...(markedIds.length ? await autoReadStatements(markedIds) : []), ...(receiptReads.length ? await autoReadReceipts(receiptReads) : [])];
    if (receiptReads.length) await ledger.flush();
    persist();
    status = [
      asStatement ? (marked ? `Added ${marked} file(s) as proof of payment.` : "") : "",
      purchaseId ? (attached ? `Attached ${attached} file(s) to this purchase.` : "") : added && !asStatement ? `Added ${added} file(s) to your unattached files.` : "",
      purchaseId && added > attached ? `Added ${added - attached} file(s) to your unattached files.` : "",
      waiting ? `${waiting} file(s) saved on this device; they will upload when you are back online.` : "",
      dupes.length ? `Already added, skipped: ${dupes.join(", ")}.` : "",
      ...readNotes,
    ].filter(Boolean).join(" ");
  }, `Uploading to ${storage.label}…`);
}

type View = { name: "queue" } | { name: "summary" } | { name: "history" } | { name: "statements" } | { name: "statement"; id: string } | { name: "purchase"; id: string; draft?: boolean };
/** A refresh keeps the screen it was on: the browser hands back the history entry's state, which holds the view and how far it was scrolled. */
const restored = (() => {
  try {
    const saved = history.state as { view?: View; scroll?: number } | null;
    const v = saved?.view;
    const known = v && ((v.name === "queue" || v.name === "summary" || v.name === "history" || v.name === "statements") || ((v.name === "purchase" || v.name === "statement") && typeof v.id === "string"));
    return known ? { view: v, scroll: typeof saved?.scroll === "number" ? saved.scroll : undefined } : undefined;
  } catch {
    return undefined;
  }
})();
let view: View = restored?.view ?? { name: "queue" };
/** Where to scroll once the restored screen has its data, so a refresh puts you back where you were reading. */
let restoreScroll = restored?.scroll;
const root = document.getElementById("app")!;

/** Spinner shown while we wait on the storage provider. Lives outside #app so re-rendering never removes it. */
const busyEl = Object.assign(document.createElement("div"), { className: "busy", hidden: true, role: "status" });
busyEl.setAttribute("aria-live", "polite");
document.body.append(busyEl);
let pending = 0;
let fallbackLabel = "";
/** The current label is about work on this device (reading text), not OneDrive, so it is always shown as written. */
let fallbackLocal = false;

const DETAIL_KEY = "stepup.detailedRefresh";
/** Off by default: the spinner just says the storage provider's data is refreshing. On, it names each request. Remembered per browser. */
let detailedRefresh = (() => {
  try {
    return localStorage.getItem(DETAIL_KEY) === "1";
  } catch {
    return false;
  }
})();
function setDetailedRefresh(on: boolean): void {
  detailedRefresh = on;
  try {
    localStorage.setItem(DETAIL_KEY, on ? "1" : "0");
  } catch {
    /* storage blocked: the choice lasts until the page is closed */
  }
}
/** Requests in flight right now, by id, with their plain-language label (see describeRequest in shared). */
const active = new Map<number, string>();
observeActivity((ev) => {
  if (ev.type === "end") active.delete(ev.id);
  else active.set(ev.id, ev.label);
  paintBusy();
});
/** The summary shown instead of per-request detail, naming wherever the data actually lives. */
function refreshingLabel(): string {
  return storage.kind === "google" || storage.kind === "onedrive" ? `Refreshing ${storage.label} data` : "Refreshing…";
}
/** Shows what we are actually waiting on (the newest request), else the operation the person started. */
function paintBusy(): void {
  const labels = [...active.values()];
  const detailed = labels[labels.length - 1] ?? fallbackLabel;
  const main = detailedRefresh || (fallbackLocal && labels.length === 0) ? detailed : detailed ? refreshingLabel() : "";
  if (!main || (pending === 0 && labels.length === 0)) {
    busyEl.hidden = true;
    document.body.removeAttribute("aria-busy");
    return;
  }
  const more = detailedRefresh && labels.length > 1 ? `<small>+${labels.length - 1} more</small>` : "";
  busyEl.innerHTML = `<span class="spinner" aria-hidden="true"></span><span>${esc(main)}</span>${more}`;
  busyEl.hidden = false;
  document.body.setAttribute("aria-busy", "true");
}
onOcrProgress(({ status, progress }) => {
  if (status === "recognizing text") note(`Reading text on this device… ${Math.round(progress * 100)}%`, true);
  else if (status.includes("core")) note("Loading the text-reading engine (first time only)…", true);
  else if (status.includes("language") || status.includes("traineddata")) note("Loading language data (first time only)…", true);
});

/** Names the current operation; shown whenever no more specific request is in flight. */
function note(label: string, local = false): void {
  fallbackLabel = label;
  fallbackLocal = local;
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
  await clearCachedDocuments();
  await savePointer(undefined);
  workspace = undefined;
  activeStore = store;
  ledger = new Ledger(store, new HlcClock(store.clientId), "web");
  await ledger.refresh();
  await pickerTop().catch(() => undefined);
  status = "That folder is no longer available. Choose a folder to continue.";
}

function clearPreviews(): void {
  clearPreview();
  discardScan();
  discardRedaction();
  for (const d of downloaded.values()) URL.revokeObjectURL(d.url);
  downloaded.clear();
}

/**
 * Opens another year at once from what this browser remembers of it (a ledger year's events, or the last reading of an
 * Excel year), then lets the slow refresh from OneDrive catch up and tidy the screen and the cache when it finishes.
 * A year never opened here before has nothing remembered, so it is read from OneDrive.
 */
async function switchYear(from: Pointer, label: string): Promise<void> {
  const pointer = { ...from, year: label };
  const cached = account ? await readCache(keyOf(pointer)) : undefined;
  const quick = cached ? openFromCache(pointer, store.clientId, cached, workspace?.years) : undefined;
  if (!quick) {
    attach(await openWorkspace(from, store.clientId, label));
    return;
  }
  attach(quick);
  if (cached?.snapshot && !quick.legacy) {
    yearSnapshot = cached.snapshot;
    referenceBase = cached.snapshot;
  }
  void refreshInBackground(quick);
}

/** Browser cache of the open workspace (see cache.ts). Best effort: failures just mean a slower next visit. */
const keyOf = (p: Pointer) => cacheKey(account?.id ?? "", p.driveId, p.rootId, p.year ?? "");
function persist(): void {
  if (account && workspace) void writeCache(keyOf(workspace.pointer), snapshotFor(workspace, yearSnapshot));
}
/** Saves a refreshed year the person has already switched away from, keeping the category list its record already had. */
async function persistOther(ws: OpenWorkspace): Promise<void> {
  if (!account) return;
  const key = keyOf(ws.pointer);
  const old = await readCache(key);
  await writeCache(key, snapshotFor(ws, old?.snapshot));
}
function forgetCache(): void {
  if (account && workspace) {
    void deleteCache(keyOf(workspace.pointer));
    void writeOutbox(keyOf(workspace.pointer), []);
  }
}

/** Keeps unuploaded edits on this device, and takes back any left over from an earlier visit. */
async function useOutbox(ws: OpenWorkspace): Promise<void> {
  if (ws.legacy) return;
  const key = keyOf(ws.pointer);
  const left = await readOutbox(key);
  ws.ledger.onPendingChange = (pending) => void writeOutbox(key, pending);
  if (left.length === 0 || workspace !== ws) return;
  ws.ledger.restorePending(left);
  status = `Recovered ${left.length} change(s) that had not been saved to ${storage.label}; saving them now.`;
  render();
  await save();
}
window.addEventListener("online", () => {
  if (workspace && ledger.unflushedCount > 0) void save();
  else render();
  void flushQueuedUploads();
});
window.addEventListener("offline", render);
let lastRefresh = Date.now();
const typing = () => document.activeElement instanceof HTMLElement && root.contains(document.activeElement) && /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName);

/** Stale-while-revalidate: the cached view is already on screen; ask OneDrive what changed and update only if something did. */
async function refreshInBackground(ws: OpenWorkspace): Promise<void> {
  showBusy(`Refreshing from ${storage.label}…`);
  try {
    const changed = await revalidate(ws);
    lastRefresh = Date.now();
    if (workspace !== ws) {
      void persistOther(ws); // switched to another year meanwhile: still leave this one's cache up to date
      return;
    }
    if (ws.carried.children) {
      status = `Added ${ws.carried.children} student(s) from last year.`;
      await ledger.flush();
    } else if (ws.carried.problems?.length) status = `Could not find children to copy from an earlier year: ${ws.carried.problems.join("; ")}.`;
    persist();
    checkSince(ws);
    if ((changed || sinceLines.length) && !typing()) render(); // never replace a form someone is typing in; the next action shows the update
  } catch (err) {
    if (workspace !== ws) return;
    if (isDeadPointer(err)) await dropWorkspace();
    else status = `Showing saved data; could not refresh from ${storage.label} (${err instanceof Error ? err.message : err}).`;
    render();
  } finally {
    hideBusy();
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && workspace && !workspace.fromCache && pending === 0 && Date.now() - lastRefresh > 2 * 60_000) void refreshInBackground(workspace);
});

/** Runs an action that may hit the network; shows the error instead of leaving the page half-updated. */
async function guarded(action: () => Promise<void>, label = `Waiting for ${storage.label}…`): Promise<void> {
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

/**
 * A confirmation modal (a native <dialog>, so focus is trapped and Escape cancels). Resolves true only when the person
 * presses the confirm button; Cancel, Escape and a click on the backdrop all resolve false.
 */
function confirmModal(title: string, message: string, confirmLabel: string): Promise<boolean> {
  return new Promise((resolve) => {
    const dlg = document.createElement("dialog");
    dlg.className = "confirm-modal";
    dlg.innerHTML = `<form method="dialog"><h2>${esc(title)}</h2><p>${esc(message)}</p><div class="actions"><button value="cancel" autofocus>Cancel</button><button value="ok" class="danger">${esc(confirmLabel)}</button></div></form>`;
    dlg.addEventListener("click", (ev) => { if (ev.target === dlg) dlg.close("cancel"); });
    dlg.addEventListener("close", () => { resolve(dlg.returnValue === "ok"); dlg.remove(); });
    document.body.append(dlg);
    dlg.showModal();
  });
}

const ARCHIVE_FOLDER = "Archive";

/** `name`, or `name (2)`, `name (3)`... when the folder already holds that name. */
function freeName(taken: Set<string>, name: string): string {
  if (!taken.has(name.toLowerCase())) return name;
  const dot = name.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let n = 2; ; n++) {
    const next = `${stem} (${n})${ext}`;
    if (!taken.has(next.toLowerCase())) return next;
  }
}

/**
 * Puts a file away (or brings it back): it moves to an "Archive" folder inside the year's folder, so it is clear in
 * the storage too, and the ledger stops listing or matching it. Restoring moves it back to the year's folder.
 */
async function setArchived(docId: string, archived: boolean): Promise<void> {
  const doc = ledger.state.documents[docId];
  const ws = workspace;
  if (!doc) return;
  let moved = false;
  await guarded(async () => {
    if (ws && doc.driveItemId && !ws.legacy) {
      const target = archived ? await storage.ensureFolder(ws.driveId, ws.year.folderId, ARCHIVE_FOLDER) : ws.year.folderId;
      const taken = new Set((await storage.list(ws.driveId, target)).map((e) => e.name.toLowerCase()));
      const current = doc.filename ?? doc.id;
      const name = freeName(taken, current);
      const newId = await storage.move(ws.driveId, doc.driveItemId, target, name !== current ? name : undefined);
      if (newId !== doc.driveItemId || name !== current) ledger.set("document", docId, { driveItemId: newId, filename: name }, { label: "document.moved" });
      moved = true;
    }
    setDocumentArchived(ledger, docId, archived);
  }, archived ? "Moving the file to the Archive folder…" : "Moving the file back…");
  if (Boolean(ledger.state.documents[docId]?.archived) !== archived) return; // the move failed: its message is already showing
  await save();
  status = archived
    ? `Archived${moved ? ` to the "${ARCHIVE_FOLDER}" folder` : ""}. It is hidden, not deleted; find it under Archived files to restore it.`
    : "Restored.";
  render();
}

async function save(): Promise<void> {
  if (workspace?.legacy) return; // nothing in a year viewed from Excel is ever saved
  // New or changed purchases may now match a charge on a statement we already read.
  if (Object.values(ledger.state.documents).some((d) => d.statement)) {
    const linked = relinkAllStatements(ledger);
    if (linked) status = `Linked ${linked} charge(s) on your statements to purchases.`;
  }
  await guarded(() => ledger.flush(), `Saving to ${storage.label}…`);
  persist();
  scheduleMirror();
  scheduleRedactionRefresh();
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
  // On this device nobody can open the file in place, so it is built when asked for (and downloaded) instead of in the background.
  if (!workspace || workspace.legacy || !mirrorOn() || storage.kind === "browser") return;
  mirrorTimer = setTimeout(() => void guardedQuiet(() => publishMirrorNow()), 60_000);
}
/** Saves the year's spreadsheet copy to the person's computer (for storage they cannot open in a file manager). */
async function downloadMirror(): Promise<void> {
  const ws = workspace;
  if (!ws || !reportsFolder) return;
  const lib = await import("@step-up/shared/mirror");
  const name = lib.mirrorFileName(ws.year.label);
  const file = await storage.find(ws.driveId, reportsFolder.id, name);
  if (!file) return;
  const url = URL.createObjectURL(await storage.download(ws.driveId, file.id));
  Object.assign(document.createElement("a"), { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
async function publishMirrorNow(): Promise<"written" | "unchanged" | "locked"> {
  const ws = workspace;
  if (!ws || ws.legacy) return "unchanged";
  const lib = await import("@step-up/shared/mirror");
  const same = reportsFolder?.yearFolderId === ws.year.folderId;
  const result = await lib.publishYearMirror({ storage,
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
    void useOutbox(next).then(() => flushQueuedUploads());
    void adoptOldLocalEvents(next).catch(() => undefined);
    checkSince(next);
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
  if (!account) return "";
  const who = esc(account.name);
  const signedIn = storage.kind === "browser" ? "Stored on this device only." : `Signed in as ${who}.`;
  if (!workspace) return `<p class="note">${signedIn}</p>`;
  const options = workspace.years.filter((y) => y.kind === "ledger" || y.kind === "legacy-excel" || y.kind === "stepup").map((y) => `<option value="${esc(y.label)}"${y.label === workspace!.year.label ? " selected" : ""}>${esc(y.label)}${y.kind === "legacy-excel" ? " (Excel, read-only)" : y.kind === "stepup" ? " (StepUp history, read-only)" : ""}</option>`).join("");
  const refresh = workspace.legacy ? "" : `<button id="check-files">Refresh data</button>`;
  return `<p class="note">${signedIn} Year <select id="year-pick" style="width:auto">${options}</select>
    ${refresh} ${storage.invite ? `<button id="share">Share</button>` : ""}</p>`;
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
  if (storage.kind === "google") {
    return `<form id="share-form" class="row"><input name="email" type="email" placeholder="Their Google account email" required>
    <button>Invite to edit</button></form>
    <p class="note">Google Drive emails them an invitation. Once they have it, they should:</p>
    <ol class="note">
      <li>Open the invitation and choose to open the folder in Google Drive (sign in with the account you invited).</li>
      <li>Open ${esc(location.origin)}, choose <strong>Sign in with Google</strong> with the same account, and pick the folder under <strong>Shared with you</strong>. Or paste the folder's sharing link instead.</li>
    </ol>
    <p class="note">If no email arrives, share the folder with them in Google Drive yourself; the steps above are the same.</p>`;
  }
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
  return `<header><h1><a href="#" data-go="queue"><img src="./icon.svg" alt="" class="logo">Step Up Helper</a></h1>
    <nav>${navigator.onLine ? "" : `<span class="badge warn">Offline: changes are kept on this device</span>`}${unsaved ? `<span class="badge warn">${unsaved} unsaved</span>` : ""}${queuedUploads ? `<span class="badge warn">${queuedUploads} file(s) waiting to upload</span>` : ""}
    ${workspace?.legacy ? `<details class="menu"><summary class="btn">Advanced</summary><div class="menu-panel"><button id="legacy-download">Download as a spreadsheet</button><button id="show-bookmarklet">Get the StepUp bookmarklet</button><button id="toggle-detail">Detailed refresh messages: ${detailedRefresh ? "on" : "off"}</button><button id="disconnect" class="danger">Disconnect</button>${account ? `<button id="sign-out">${storage.kind === "browser" ? "Use Microsoft instead" : "Sign out"}</button>` : ""}</div></details>` : `<details class="menu"><summary class="btn">Advanced</summary>
      <div class="menu-panel">
        <label class="btn">Import events<input type="file" id="import" accept=".jsonl,.json,.txt" hidden></label>
        <button id="export">Export events</button>
        <button id="toggle-detail">Detailed refresh messages: ${detailedRefresh ? "on" : "off"}</button>
        ${workspace ? `<button id="new-year">New year</button>` : ""}
        ${workspace && hasEarlierYear(workspace) ? `<button id="copy-children" title="Adds anyone who is missing; nothing is overwritten">Copy children from previous year</button>` : ""}
        ${ocrLanguages().available.length > 1 ? `<label>Reading scans in<select id="ocr-lang">${[...ocrLanguages().available.map((l) => [l, ocrLanguageName(l)] as const), ["all", "All installed (slower)"] as const].map(([v, n]) => `<option value="${esc(v)}"${(v === "all" ? ocrLanguages().current.length === ocrLanguages().available.length : ocrLanguages().current.join("+") === v) ? " selected" : ""}>${esc(n)}</option>`).join("")}</select></label>` : ""}
        ${workspace && referenceUpdate() ? `<button id="update-reference">Update category list (${referenceUpdate()!.added} new, ${referenceUpdate()!.changed} changed)</button>` : ""}
        ${workspace ? (storage.kind === "browser" ? `<button id="update-mirror">Download spreadsheet</button>` : `<button id="update-mirror">Update spreadsheet now</button><button id="toggle-mirror">Automatic spreadsheet: ${mirrorOn() ? "on" : "off"}</button>`) : ""}
        ${workspace && storage.kind !== "browser" ? `<button id="check-year" title="Reads the whole ledger and looks for anything that points at something that is not there">Check this year</button><button id="check-year-files" title="Also asks ${esc(storage.label)} whether every receipt file is still there">Check this year and its files</button><button id="check-year-contents" title="Downloads every file to confirm it is unchanged (slow)">Check this year and every file's contents</button><button id="backup-year">Back up this year (zip)</button><button id="backup-year-docs" title="Includes every receipt and statement file; can be large">Back up this year with documents (zip)</button><label class="btn" title="A saved copy of StepUp's reimbursements list (see the extension or the command line)">Bring in StepUp's list<input type="file" id="stepup-import" accept=".json,.txt" hidden></label><button id="show-bookmarklet">Get the StepUp bookmarklet</button>` : ""}
        ${Object.keys(ledger.state.categories).length ? `<button id="export-categories">Share category fixes</button><button id="issue-categories">Share them on GitHub</button>` : ""}
        ${workspace && storage.kind !== "browser" ? `<button id="disconnect" class="danger">Disconnect</button>` : ""}
        ${account ? `<button id="sign-out">${storage.kind === "browser" ? "Use Microsoft instead" : "Sign out"}</button>` : ""}
      </div></details>`}</nav></header>
    ${ledger.fromNewerVersion ? `<p class="warn">${ledger.fromNewerVersion} change(s) in this ledger were written by a newer version of the app and are not shown. Reload the page (or clear the site's cached files) to get the latest version.</p>` : ""}${clockLooksWrong() ? `<p class="warn">This device's clock is ${Math.abs(Math.round(serverClockSkewMs()! / 60000))} minute(s) ${serverClockSkewMs()! > 0 ? "behind" : "ahead of"} OneDrive's. Edits made on different devices may be ordered wrongly until it is corrected.</p>` : ""}${connectionBar()}${newYearOpen && workspace ? newYearForm() : ""}${sharing && workspace ? shareForm() : ""}${pendingStepUpBanner()}${bookmarkletPanel()}${status ? `<p class="warn notice" role="status">${esc(status)} <button id="dismiss-status">Dismiss</button></p>` : ""}${updateReady ? `<p class="note update-banner">A new version of Step Up Helper is ready. <button id="reload-app" class="primary">Reload</button></p>` : ""}`;
}

/** "Since you were last here": what other people and the command line did while this browser was away. */
let sinceLines: string[] = [];
let sinceChecked = false;
const lastSeenKey = (ws: OpenWorkspace) => `stepup.lastSeen.${keyOf(ws.pointer)}`;

function checkSince(ws: OpenWorkspace): void {
  if (sinceChecked || ws.fromCache || ws.legacy) return;
  sinceChecked = true;
  let last: number | undefined;
  try {
    last = Number(localStorage.getItem(lastSeenKey(ws))) || undefined;
  } catch {
    /* storage blocked: no summary */
  }
  if (last) sinceLines = summarizeChanges(ws.store.cachedEvents(), last, store.clientId).lines;
  try {
    localStorage.setItem(lastSeenKey(ws), String(Date.now()));
  } catch {
    /* ignore */
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "hidden" || !workspace) return;
  try {
    localStorage.setItem(lastSeenKey(workspace), String(Date.now()));
  } catch {
    /* ignore */
  }
});

function sinceBanner(): string {
  if (sinceLines.length === 0) return "";
  return `<section class="filing-banner"><div class="filing-head"><strong>Since you were last here</strong><button id="dismiss-since">Dismiss</button></div>
    <ul>${sinceLines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul></section>`;
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

/** The programs StepUp accepts, as the labels its category list uses (so a child's program can be matched to category eligibility). */
const SCHOLARSHIPS: Array<[string, string]> = [
  ["FES-UA", "FES-UA (Family Empowerment, Unique Abilities)"],
  ["FESEO", "FESEO (Family Empowerment, Educational Options)"],
  ["FTC", "FTC (Florida Tax Credit)"],
  ["FTCPEP", "FTC-PEP (Personalized Education Program)"],
  ["READ", "READ (Reading Scholarship Accounts)"],
];

/** A drop-down of the supported programs. A value saved earlier that is not on the list stays selectable so it is not lost silently. */
function scholarshipSelect(current: string | undefined, attrs: string): string {
  const known = SCHOLARSHIPS.some(([v]) => scholarshipNamesMatch(v, current ?? ""));
  const selected = (v: string) => (current && scholarshipNamesMatch(v, current) ? " selected" : "");
  return `<select ${attrs}>${current ? "" : `<option value="" selected disabled>Choose a program</option>`}${SCHOLARSHIPS.map(([v, n]) => `<option value="${esc(v)}"${selected(v)}>${esc(n)}</option>`).join("")}${current && !known ? `<option value="${esc(current)}" selected>${esc(current)} (not a supported program)</option>` : ""}</select>`;
}

function queueView(): string {
  const state = ledger.state;
  const all = buildQueue(state, ctx());
  const children = Object.values(state.children);
  const childForm = `<details${children.length === 0 || addingChild ? " open" : ""}><summary>Children (${children.length})</summary>
    <ul>${children.map((c) => `<li>${esc(c.name)} ${scholarshipSelect(c.scholarship, `data-child-scholarship="${esc(c.id)}" aria-label="Program for ${esc(c.name)}" style="width:auto"`)}</li>`).join("")}</ul>
    ${addingChild || readOnly() ? "" : `<p><button id="new-child">New child</button></p>`}
    ${!addingChild ? "" : `<form id="add-child" class="row"><input name="name" placeholder="Name" required>${scholarshipSelect(undefined, `name="scholarship" required aria-label="Program"`)}<button>Add child</button><button type="button" id="cancel-child">Cancel</button></form>`}</details>`;
  const banner = sinceBanner() + filingBanner();
  const startBlank = `<p class="row"><button id="new-purchase">New purchase</button></p>`;
  const archived = Object.values(state.purchases).filter((p) => p.archived);
  const archivedList = archived.length
    ? `<details><summary>Archived purchases (${archived.length})</summary><ul class="queue">${archived.map((p) => `<li class="q"><span>${esc(purchaseName(p))}</span><button data-unarchive="${esc(p.id)}">Restore</button></li>`).join("")}</ul></details>`
    : "";

  // Files that belong to nothing yet are kept apart: only purchases are listed under "Needs your attention".
  const loose = all.filter((e) => e.kind === "unattached-document");
  const looseRows = loose.map((e) => {
    const sugg = (e.suggestions ?? []).map((s) => {
      const name = s.target.kind === "purchase" ? (state.purchases[s.target.id] ? purchaseName(state.purchases[s.target.id]!) : s.target.id) : state.items[s.target.id]?.description ?? s.target.id;
      return `<button data-attach="${esc(e.id)}" data-kind="${s.target.kind}" data-target="${esc(s.target.id)}" data-role="${s.role}">${s.role === "receipt" ? "Receipt of" : "Attach to"} ${esc(name)}</button>`;
    }).join("");
    const doc = state.documents[e.id];
    const actions = `<button data-start="${esc(e.id)}">Start purchase</button>${doc?.driveItemId && workspace ? `<button data-preview="${esc(e.id)}">Preview</button>` : ""}${/\.eml$/i.test(doc?.filename ?? "") && workspace ? `<button data-eml-attachments="${esc(e.id)}">Save its attachments</button>` : ""}${doc?.contentKind !== "statement" ? `<button data-mark-statement="${esc(e.id)}">Mark as Proof of Payment</button>` : `<button data-statement="${esc(e.id)}">Open proof of payment</button>`}${sugg}<button class="danger" data-archive-doc="${esc(e.id)}" title="Hide this file (added by mistake). You can restore it.">Archive</button>`;
    const hint = e.hints?.vendor || e.hints?.date ? `<small>Looks like: ${esc([e.hints.vendor, e.hints.date].filter(Boolean).join(", "))}</small>` : "";
    return `<li class="q"><div><strong>${esc(e.title)}</strong> ${hint}</div><div class="actions wide">${actions}</div></li>`;
  });
  const archivedDocs = Object.values(state.documents).filter((d) => d.archived && d.contentKind !== "statement").sort((a, b) => (a.filename ?? a.id).localeCompare(b.filename ?? b.id));
  const archivedFiles = archivedDocs.length
    ? `<details><summary>Archived files (${archivedDocs.length})</summary><ul class="queue">${archivedDocs.map((d) => `<li class="q"><span>${esc(d.filename ?? d.id)}</span><button data-unarchive-doc="${esc(d.id)}">Restore</button></li>`).join("")}</ul></details>`
    : "";
  const keepForLater = workspace && !readOnly() ? `<p class="row"><label class="btn">Keep a file for later<input type="file" id="upload-later" multiple accept="application/pdf,image/*" hidden></label> <small>It waits here until you attach it to a purchase.</small></p>` : "";
  const looseList = loose.length || workspace ? `<details><summary>Unattached files (${loose.length})</summary>${keepForLater}${loose.length ? `<ul class="queue">${looseRows.join("")}</ul>` : ""}</details>` : "";

  // One row per purchase: receipts with no items, and purchases with items that cannot be filed yet.
  const byPurchase = new Map<string, { title: string; reasons: string[] }>();
  for (const e of all) {
    if (e.kind === "unattached-document" || !e.purchaseId) continue;
    const row = byPurchase.get(e.purchaseId) ?? { title: purchaseLabel(e.purchaseId), reasons: [] };
    for (const r of e.kind === "item-blocked" ? e.reasons.map((x) => `${e.title}: ${x}`) : e.reasons) if (!row.reasons.includes(r)) row.reasons.push(r);
    byPurchase.set(e.purchaseId, row);
  }
  const allPurchases = purchaseListing();
  // Excel's own status is the authority for its year, so the app's "needs your attention" rules stay out of it.
  if (readOnly()) {
    const unclear = workspace?.legacy?.year.unclear.length ?? 0;
    return `${childForm}<p class="note">Open a purchase to see its items and files.</p>${unclear ? `<p class="note warn">${unclear} purchase(s) list several files and the workbook does not say which is the receipt. Every file is shown as additional documentation.</p>` : ""}${allPurchases || "<p>The workbook has no purchases.</p>"}${looseList}${archivedFiles}${archivedList}`;
  }
  if (byPurchase.size === 0) return `${banner}${childForm}${startBlank}<p>No purchases need attention.</p>${allPurchases}${looseList}${archivedFiles}${archivedList}`;
  const rows = [...byPurchase.entries()].map(([id, r]) => `<li class="q"><button class="row-button" data-open="${esc(id)}"><span><strong>${esc(r.title)}</strong><br><small>${esc(r.reasons.join("; "))}</small></span><span class="chev" aria-hidden="true">&rsaquo;</span></button></li>`);
  return `${banner}${childForm}${startBlank}<h2>Needs your attention (${byPurchase.size})</h2><ul class="queue">${rows.join("")}</ul>${allPurchases}${looseList}${archivedFiles}${archivedList}`;
}

/** Every purchase with a search box and a status filter, the same as the Excel view's list (both narrow in place; see filterLegacyList). */
function purchaseListing(): string {
  const state = ledger.state;
  const rows = Object.values(state.purchases).filter((p) => !p.archived).map((p) => {
    const items = itemsOf(state, p.id);
    const labels = items.map((i) => statusLabel(i));
    const dates = items.map((i) => effectiveDate(i, p)).filter((d): d is string => Boolean(d)).sort();
    return { p, items, labels, date: dates[dates.length - 1] ?? p.date ?? "" };
  }).sort((a, b) => b.date.localeCompare(a.date) || a.p.id.localeCompare(b.p.id));
  if (!rows.length) return "";
  const allStatuses = [...new Set(rows.flatMap((r) => r.labels))].sort();
  const items = rows.map((r, n) => {
    const counts = new Map<string, number>();
    for (const l of r.labels) counts.set(l, (counts.get(l) ?? 0) + 1);
    const summary = [...counts.entries()].map(([s, n]) => `${n} ${s}`).join(", ");
    const total = purchaseTotalCents(state, r.p);
    const vendor = r.p.vendor ?? r.items.map((i) => i.vendor).find(Boolean) ?? "";
    const text = `${purchaseName(r.p)} ${vendor} ${r.items.map((i) => `${i.description ?? ""} ${state.children[i.childId ?? ""]?.name ?? ""}`).join(" ")}`.toLowerCase();
    const attrs = listRowAttrs({ order: n, itemIds: r.items.map((i) => i.id), text, statuses: [...new Set(r.labels)], childIds: [...new Set(r.items.map((i) => i.childId).filter((c): c is string => Boolean(c)))], vendor, name: purchaseName(r.p), date: r.date, totalCents: total ?? 0 });
    return `<li class="q" ${attrs}${unclearReceipt(r.p.id) ? " data-unclear" : ""}><button class="row-button" data-open="${esc(r.p.id)}"><span><strong>${esc(purchaseName(r.p))}</strong>${unclearReceipt(r.p.id) ? ` <span class="badge warn">Receipt unclear</span>` : ""}<br><small>${esc(r.date)}${r.date ? " · " : ""}${total !== undefined ? formatCents(total) + " · " : ""}${esc(summary || "no items")}</small></span><span class="chev" aria-hidden="true">&rsaquo;</span></button></li>`;
  });
  const vendors = rows.map((r) => r.p.vendor ?? r.items.map((i) => i.vendor).find(Boolean) ?? "");
  return `<h2>All purchases ${listCount(rows.length)}</h2>
    ${listControls({ statuses: allStatuses, unclearCount: rows.filter((r) => unclearReceipt(r.p.id)).length, children: Object.values(state.children), vendors })}
    <ul class="queue" id="legacy-list">${items.join("")}</ul>`;
}

// ---- History: every change, from every source (ledger events, StepUp's list, the Excel workbook)
const historyFiles: HistoryReadCache = new Map();
const historyUi: { year?: string; loading: boolean; fromFiles: HistoryChange[]; error?: string; source: "" | HistorySource; search: string; limit: number } = { loading: false, fromFiles: [], source: "", search: "", limit: 200 };

/** Reads the changes kept for StepUp and Excel (small files that never change, so a refresh reads only new ones). */
async function loadHistory(): Promise<void> {
  const ws = workspace;
  if (!ws || historyUi.loading) return;
  historyUi.loading = true;
  historyUi.year = ws.year.label;
  try {
    historyUi.fromFiles = await readHistoryFiles(storage, ws.driveId, ws.year.folderId, historyFiles);
    historyUi.error = undefined;
  } catch (err) {
    historyUi.error = err instanceof Error ? err.message : String(err);
  } finally {
    historyUi.loading = false;
  }
  if (view.name === "history") render();
}

/** All changes, newest first: the ledger's (from its event log, when this year has one) with what StepUp and Excel did. */
function allHistory(): HistoryChange[] {
  const own = workspace && !workspace.legacy ? ledgerHistory(workspace!.store.cachedEvents(), ledger.state) : [];
  return [...own, ...historyUi.fromFiles].sort((a, b) => b.at.localeCompare(a.at));
}

function historyList(): string {
  const q = historyUi.search.toLowerCase().split(/\s+/).filter(Boolean);
  const all = allHistory().filter((c) => (!historyUi.source || c.source === historyUi.source)
    && q.every((w) => `${c.summary} ${c.actor ?? ""} ${c.subject.label ?? ""} ${(c.details ?? []).map((d) => `${d.field} ${d.from ?? ""} ${d.to ?? ""}`).join(" ")}`.toLowerCase().includes(w)));
  if (all.length === 0) return `<p class="note">${historyUi.loading ? "Reading the history…" : "Nothing has changed yet that matches."}</p>`;
  const shown = all.slice(0, historyUi.limit);
  const sources: Record<HistorySource, string> = { ledger: "Ledger", stepup: "StepUp", excel: "Excel" };
  const purchaseFor = (c: HistoryChange): string | undefined => c.subject.purchaseId
    ?? (c.subject.kind === "reimbursement" ? Object.values(ledger.state.submissions).find((s) => s.reimbursementId === c.subject.id)?.purchaseId : undefined);
  let day = "";
  const rows = shown.map((c) => {
    const when = new Date(c.at);
    const d = when.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric", year: "numeric" });
    const head = d !== day ? `<h3 class="history-day">${esc(d)}</h3>` : "";
    day = d;
    const p = purchaseFor(c);
    const what = p && ledger.state.purchases[p] ? `<button class="link" data-open="${esc(p)}">${esc(c.summary)}</button>` : esc(c.summary);
    const details = (c.details ?? []).map((x) => `<li><strong>${esc(x.field)}</strong>: ${x.from !== undefined ? `${esc(x.from)} &rarr; ` : ""}${esc(x.to ?? "")}</li>`).join("");
    return `${head}<li class="q history-row"><div><span class="badge history-${c.source}">${esc(sources[c.source])}</span> ${what}
      <br><small>${esc(when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }))}${c.actor ? ` &middot; ${esc(c.actor)}` : ""}</small>${details ? `<ul class="history-details">${details}</ul>` : ""}</div></li>`;
  });
  return `<ul class="queue history-list">${rows.join("")}</ul>${all.length > shown.length ? `<p class="row"><button data-history-more="1">Show more (${all.length - shown.length} older)</button></p>` : ""}`;
}

function historyView(): string {
  if (workspace && historyUi.year !== workspace.year.label && !historyUi.loading) void loadHistory();
  const sel = (v: string, label: string) => `<option value="${v}"${historyUi.source === v ? " selected" : ""}>${label}</option>`;
  return `<h2>History</h2>
    <p class="note">Every change, from every source: what was done in this app, what StepUp itself changed, and what changed in the Excel workbook. Newest first.</p>
    <p class="row">${clearableSearch("history-search", "Search the history")}<select id="history-source" aria-label="Source" style="width:auto">${sel("", "All sources")}${sel("ledger", "Ledger")}${sel("stepup", "StepUp")}${sel("excel", "Excel")}</select></p>
    ${historyUi.error ? `<p class="warn">StepUp's and Excel's changes could not be read: ${esc(historyUi.error)}</p>` : ""}
    <div id="history-list">${historyList()}</div>`;
}

/**
 * StepUp's list, however it arrived (a saved file, or the bookmarklet): kept per year in `_stepup`, and the open year's
 * ledger records what StepUp says about the items it filed.
 */
async function bringInStepUpList(results: unknown[]): Promise<void> {
  const ws = workspace;
  if (!ws) return;
  const done = await archiveStepUpList({ storage, driveId: ws.driveId, rootId: ws.pointer.rootId }, results);
  // The command line does the same for every ledger year it can reach; other years show StepUp's side through `_stepup`.
  if (!ws.legacy) {
    const lines = (results as Array<Record<string, unknown> & { SchoolYear?: string; LineItems?: Array<Record<string, unknown>> }>)
      .filter((r) => r.SchoolYear === ws.year.label)
      .flatMap((r) => (r.LineItems ?? []).map((li) => ({ ...li, ReimbursementGuid: typeof r["Id"] === "string" ? r["Id"] : undefined, Message: messageOf(li) }) as unknown as ApiLineItem));
    if (lines.length && applyStepUpStatuses(ledger, lines) > 0) await save();
  }
  status = done.listed === 0 ? "StepUp's list had no reimbursements that could be read." : done.changed === 0 ? `StepUp's list is already up to date (${done.listed} reimbursement(s)).` : `Brought in ${done.changed} changed reimbursement(s) of ${done.listed}: ${done.years.filter((y) => y.changed).map((y) => `${y.label} (${y.changed})`).join(", ")}.`;
  await refreshInBackground(ws);
}

/** A list sent by the bookmarklet, waiting for the person to say yes (nothing is written until they do). */
let pendingStepUp: unknown[] | undefined;
let bookmarkletOpen = false;

window.addEventListener("message", (ev) => {
  if (isStepUpHello(ev.origin, ev.data)) {
    (ev.source as Window | null)?.postMessage({ type: "stepup-ready" }, ev.origin);
    return;
  }
  const list = stepUpListFrom(ev.origin, ev.data);
  if (!list) return;
  pendingStepUp = list;
  render();
});

const appHome = (): string => new URL("./", location.href).href;

function bookmarkletPanel(): string {
  if (!bookmarkletOpen) return "";
  return `<section class="panel"><h3 class="panel-title">StepUp bookmarklet<small>Brings StepUp's list in with one click; works in any desktop browser and in Safari on iPhone and iPad</small></h3>
    <ol>
      <li>Drag this link to your bookmarks bar: <a href="${esc(loaderHref(appHome()))}" class="btn" draggable="true">Send StepUp's list</a>
        <small>(or <button id="copy-bookmarklet">copy it</button> and paste it as the address of a new bookmark)</small></li>
      <li>Sign in to StepUp and open its Dashboard.</li>
      <li>Click the bookmark. This app opens, and asks before anything is saved.</li>
    </ol>
    <p class="note">The bookmark only loads a small script from this site each time you click it, so updates reach you without making a new bookmark. The script reads your StepUp sign-in only inside StepUp's own page, asks StepUp for the same list its dashboard shows, and sends just that list here. Your sign-in never leaves StepUp's page and is never stored.</p>
    <p class="row"><button id="close-bookmarklet">Close</button></p></section>`;
}

function pendingStepUpBanner(): string {
  if (!pendingStepUp) return "";
  return `<p class="banner" role="status">StepUp sent ${pendingStepUp.length} reimbursement(s). Bring them in? <button id="stepup-apply" class="primary">Bring in</button> <button id="stepup-ignore">Ignore</button></p>`;
}

/** The last "Check this year" result, shown on the Summary page until the next one. */
let yearCheck: { at: string; label: string; files: "no" | "sizes" | "contents"; events: number; findings: Finding[] } | undefined;

function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  Object.assign(document.createElement("a"), { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** The integrity check the command line's `verify` runs: nothing points at nothing, logs are clean, files are where they were. */
async function checkYear(files: "no" | "sizes" | "contents"): Promise<void> {
  const ws = workspace;
  if (!ws || ws.legacy) return;
  const events = await activeStore.readAll();
  const findings: Finding[] = verifyLedger(ledger.state, events);
  if (files !== "no") {
    findings.push(...(await verifyFiles(storage, ws.driveId, ledger.state, { hash: files === "contents", progress: (done, total) => showBusy(`Checking file ${done + 1} of ${total}…`) })));
  }
  if (clockLooksWrong()) findings.push({ severity: "warn", code: "clock-skew", message: `This device's clock is ${Math.abs(Math.round(serverClockSkewMs()! / 60000))} minute(s) ${serverClockSkewMs()! > 0 ? "behind" : "ahead of"} ${storage.label}'s. Edits made on different devices may be ordered wrongly.` });
  yearCheck = { at: new Date().toISOString(), label: ws.year.label, files, events: events.length, findings };
  go({ name: "summary" });
}

function yearCheckPanel(): string {
  const c = yearCheck;
  if (!c || c.label !== workspace?.year.label) return "";
  const what = c.files === "no" ? "" : c.files === "sizes" ? " and that every file is still there" : " and every file's contents";
  const bad = hasErrors(c.findings);
  return `<section class="panel"><h3 class="panel-title">Year check<small>${esc(c.label)}: ${c.events} change(s) read${what} · ${esc(new Date(c.at).toLocaleString())}</small></h3>
    <p class="${bad ? "warn" : "note"} banner">${bad ? "Something is inconsistent; details below." : "Nothing is wrong."}</p>
    <ul>${c.findings.map((f) => `<li class="${f.severity === "error" ? "warn" : ""}"><strong>${f.severity === "error" ? "Problem" : f.severity === "warn" ? "Look at" : "Note"}:</strong> ${esc(f.message)}${f.ids?.length ? ` <small>e.g. ${esc(f.ids.slice(0, 3).join(", "))}</small>` : ""}</li>`).join("")}</ul>
    <p class="row"><button data-dismiss-check>Hide this</button></p></section>`;
}

/** What the filing tool would send to StepUp, and what is holding the rest back. Only a look; filing happens in StepUp's own tab. */
function planPanel(): string {
  if (readOnly() || !workspace) return "";
  const plan = planSubmissions(ledger.state, ctx());
  if (!plan.groups.length && !plan.blocked.length) return "";
  const groups = plan.groups.map((g) => `<li><strong>${esc(g.childName)}</strong> · ${esc(g.receipt.filename ?? g.receipt.id)}
      <ul>${g.items.map((i) => `<li>${esc(i.description ?? i.id)} <small>${formatCents(i.amountCents ?? 0)}</small></li>`).join("")}</ul>
      ${g.additionalDocs.length ? `<small>Also sends: ${g.additionalDocs.map((d) => esc(d.filename ?? d.id)).join(", ")}</small>` : ""}
      ${g.unredactedStatements.length ? `<small class="warn">Statement sent unredacted: ${g.unredactedStatements.map(esc).join(", ")}</small>` : ""}</li>`).join("");
  const blocked = plan.blocked.map((b) => `<li>${esc(b.item.description ?? b.item.id)} <small>(${esc(b.status)}): ${b.reasons.map((r) => esc(r.message)).join("; ")}</small></li>`).join("");
  return `<section class="panel"><h3 class="panel-title">Ready to file<small>${plan.groups.length} submission(s) ready, ${plan.blocked.length} item(s) held back, ${plan.skipped} already filed</small></h3>
    ${groups ? `<ul>${groups}</ul>` : `<p class="note">Nothing is ready yet.</p>`}
    ${blocked ? `<details><summary>Held back (${plan.blocked.length})</summary><ul>${blocked}</ul></details>` : ""}</section>`;
}

function summaryView(): string {
  const state = ledger.state;
  const s = yearSummary(state, ctx());
  const d = s.deadline;
  const banner = d
    ? `<p class="${d.daysLeft < 0 ? "warn" : d.daysLeft <= 30 ? "warn" : "note"} banner">${d.daysLeft < 0 ? `The submission deadline passed ${-d.daysLeft} day(s) ago (${esc(d.date)}).` : `${d.daysLeft} day(s) until the submission deadline (${esc(d.date)}).`}</p>`
    : readOnly() ? "" : `<p class="note banner">No submission deadline set.</p>`;
  const deadlineForm = readOnly() && !d ? "" : `<form id="deadline-form" class="row"><label>Submission deadline<input name="deadline" type="date" value="${esc(d?.date)}"></label><button>Save deadline</button></form>`;
  // Awards are typed in here; the pivot tables below show them against what has been spent.
  const awards = s.children.map((b) => {
    const c = state.children[b.childId]!;
    return `<form class="inline" data-cap="${esc(c.id)}"><label>${esc(c.name ?? c.id)}<input name="cap" inputmode="decimal" value="${b.capCents ? (b.capCents / 100).toFixed(2) : ""}" placeholder="0.00"></label><button>Save</button></form>`;
  });
  return `<h2>Summary</h2>${banner}${deadlineForm}
    ${awards.length ? `<h3>Award for each student</h3>${awards.join("")}` : readOnly() ? "" : `<p>Add a student on the list page first.</p>`}
    ${Object.keys(filingNow()).length ? `<p class="banner">${Object.keys(filingNow()).length} item(s) are being filed with StepUp right now (see the list page).</p>` : ""}
    ${yearCheckPanel()}${planPanel()}
    ${pivotTables(state, ctx())}
    ${readOnly() ? `<p class="row"><button id="legacy-download" class="primary">Download as a spreadsheet</button> <small>The same tracking sheet, summary and document list the app keeps for its own years.</small></p>` : ""}`;
}

/** The purchase's own name if it has one, else "Vendor, date", else the receipt's file name. */
function purchaseName(p: { name?: string; vendor?: string; date?: string; receiptDocumentId?: string }): string {
  if (p.name?.trim()) return p.name.trim();
  const auto = [p.vendor, p.date].filter(Boolean).join(", ");
  return auto || ledger.state.documents[p.receiptDocumentId ?? ""]?.filename || "Untitled purchase";
}

const purchaseLabel = (id: string) => {
  const p = ledger.state.purchases[id];
  if (!p) return "(removed purchase)";
  const total = purchaseTotalCents(ledger.state, p);
  return `${purchaseName(p)}${total !== undefined ? `, ${formatCents(total)}` : ""}`;
};

const ASSIST_LIMIT = 25;
const assistDays = (n: number | undefined) =>
  n === undefined ? "no receipt date" : n === 0 ? "same day" : n > 0 ? `${n} day${n === 1 ? "" : "s"} after the receipt` : `${-n} day${n === -1 ? "" : "s"} before the receipt`;
const assistAmount = (cents: number | undefined) =>
  cents === undefined ? "purchase has no total yet" : cents === 0 ? "exact amount" : `charge is ${formatCents(Math.abs(cents))} ${cents > 0 ? "more" : "less"}`;

function assistSelect(name: string, label: string, options: Array<[string, string]>, value: string): string {
  return `<label>${label}<select data-assist="${name}">${options.map(([v, l]) => `<option value="${esc(v)}"${v === value ? " selected" : ""}>${esc(l)}</option>`).join("")}</select></label>`;
}

const assistSortSelect = () =>
  assistSelect("sort", "Sort by", [["best", "Best match (date and amount)"], ["date", "Closest date"], ["amount", "Closest dollar amount"]], assistView.sort);

/** The helper for one charge on a statement: purchases it could have paid for, ordered and filtered as chosen. */
function purchaseAssist(docId: string, txnId: string): string {
  const state = ledger.state;
  const all = purchasesForCharge(state, docId, txnId);
  const unique = (xs: string[]) => [...new Set(xs.filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const children = unique(all.flatMap((c) => c.childIds)).map((id) => [id, state.children[id]?.name ?? id] as [string, string]);
  const vendors = unique(all.map((c) => c.vendor)).map((v) => [v, v] as [string, string]);
  const methods = unique(all.map((c) => c.methodId ?? "")).map((id) => [id, state.paymentMethods[id]?.label ?? id] as [string, string]);
  const shown = all.filter((c) =>
    (!assistView.child || c.childIds.includes(assistView.child)) &&
    (!assistView.vendor || c.vendor === assistView.vendor) &&
    (!assistView.method || c.methodId === assistView.method) &&
    (!assistView.noProof || !c.hasProof));
  const list = sortCandidates(shown, assistView.sort);
  const row = (c: PurchaseCandidate) => `<li class="q"><span><strong>${esc(purchaseLabel(c.purchaseId))}</strong>${c.date ? ` <small>${esc(c.date)}</small>` : ""}${c.hasProof ? ` <small class="ok">has proof already</small>` : ""}${c.vendorHit ? ` <small class="ok">vendor looks right</small>` : ""}<br>
    <small${c.beforeReceipt ? ` class="warn"` : ""}>${esc(assistAmount(c.amountDiffCents))} &middot; ${esc(assistDays(c.dayDiff))}${c.childIds.length ? ` &middot; ${esc(c.childIds.map((id) => state.children[id]?.name ?? id).join(", "))}` : ""}</small></span>
    <span class="actions"><button data-link="${esc(c.purchaseId)}" data-txn="${esc(txnId)}" data-doc="${esc(docId)}">Link</button></span></li>`;
  return `<div class="assist"><p class="row">${assistSortSelect()}
    ${children.length > 1 ? assistSelect("child", "Child", [["", "Any child"], ...children], assistView.child) : ""}
    ${vendors.length > 1 ? assistSelect("vendor", "Vendor", [["", "Any vendor"], ...vendors], assistView.vendor) : ""}
    ${methods.length > 1 ? assistSelect("method", "Paid with", [["", "Any card"], ...methods], assistView.method) : ""}
    <label class="check"><input type="checkbox" data-assist="noProof"${assistView.noProof ? " checked" : ""}> Only purchases without proof yet</label>
    <button type="button" data-assist-close="1">Close</button></p>
    ${list.length ? `<ul class="queue">${list.slice(0, ASSIST_LIMIT).map(row).join("")}</ul>${list.length > ASSIST_LIMIT ? `<p class="note">Showing the first ${ASSIST_LIMIT} of ${list.length}. Narrow it with the filters above.</p>` : ""}`
      : `<p class="note">No purchases${shown.length < all.length ? " match those filters" : " to choose from yet"}.</p>`}
    <p class="note">A payment does not normally show before its receipt, so purchases dated after the charge are listed last. They can still be right (a receipt dated at shipping, or billing ahead).</p></div>`;
}

/** The helper for one purchase: charges on any statement that could have paid for it, ordered and filtered as chosen. */
function chargeAssist(purchaseId: string): string {
  const all = chargesForPurchase(ledger.state, purchaseId);
  if (all.length === 0) return "";
  if (assist?.kind !== "purchase" || assist.purchaseId !== purchaseId) {
    return `<p class="row"><button data-assist-purchase="${esc(purchaseId)}">Link a charge from a statement</button> <small>Pick the statement charge that paid for this purchase; the closest matches are listed first.</small></p>`;
  }
  const cards = new Map(all.map((c) => [c.cardKey, c.cardLabel]));
  const shown = all.filter((c) => !assistView.card || c.cardKey === assistView.card);
  const list = sortCandidates(shown, assistView.sort);
  const row = (c: ChargeCandidate) => `<li class="q"><span><strong>${esc(c.date)} &middot; ${formatCents(c.amountCents)}</strong> ${esc(c.descriptor)}${c.vendorHit ? ` <small class="ok">looks like this vendor</small>` : ""}<br>
    <small${c.beforeReceipt ? ` class="warn"` : ""}>${esc(assistAmount(c.amountDiffCents))} &middot; ${esc(assistDays(c.dayDiff))} &middot; ${esc(c.cardLabel)}</small></span>
    <span class="actions"><button data-link="${esc(purchaseId)}" data-txn="${esc(c.transactionId)}" data-doc="${esc(c.documentId)}">Link</button></span></li>`;
  return `<div class="assist"><h4>Link a charge from a statement</h4><p class="row">${assistSortSelect()}
    ${cards.size > 1 ? assistSelect("card", "Card", [["", "Any card"], ...[...cards].map(([k, l]) => [k, l] as [string, string])], assistView.card) : ""}
    <button type="button" data-assist-close="1">Close</button></p>
    ${list.length ? `<ul class="queue">${list.slice(0, ASSIST_LIMIT).map(row).join("")}</ul>${list.length > ASSIST_LIMIT ? `<p class="note">Showing the first ${ASSIST_LIMIT} of ${list.length}. Narrow it with the card filter.</p>` : ""}` : `<p class="note">No charges on that card.</p>`}
    <p class="note">A payment does not normally show before its receipt, so charges dated before it are listed last. They can still be right (a receipt dated at shipping, or billing ahead).</p></div>`;
}

function statementsView(): string {
  const state = ledger.state;
  const docs = Object.values(state.documents).filter((d) => d.contentKind === "statement" && !d.derivedFrom && !d.archived);
  const linkedBy = (docId: string) => new Set(Object.values(state.additionalDocs).filter((a) => a.documentId === docId && a.transactionId).map((a) => a.transactionId));
  const row = (d: (typeof docs)[number]) => {
    const charges = d.statement?.transactions.filter((t) => t.kind === "purchase") ?? [];
    const linked = linkedBy(d.id);
    const period = d.statement?.periodStart && d.statement.periodEnd ? `${d.statement.periodStart} to ${d.statement.periodEnd}${d.statement.periodInferred ? " (estimated)" : ""}` : "period not found";
    // A year Excel owns never has its statements read: say which cards the workbook files them under instead.
    const named = readOnly() ? (workspace?.legacy?.year.input.paymentMethods ?? []).filter((m) => m.file === d.filename).map((m) => m.label) : [];
    const pointing = new Set(Object.values(state.additionalDocs).filter((a) => a.documentId === d.id && a.kind === "payment-proof" && a.ownerId).map((a) => a.ownerId)).size;
    const summary = readOnly() ? `${named.join(", ")}${named.length ? " &middot; " : ""}${pointing} purchase(s) point to it` : d.statement ? `${period} &middot; ${charges.length} charge(s), ${charges.filter((t) => linked.has(t.id)).length} linked` : "Not read yet";
    // The whole row opens the statement (archiving is on the statement's own screen).
    return `<li class="q"><button class="row-button" data-statement="${esc(d.id)}"><span><strong>${esc(statementDisplayName(d))}</strong><br><small>${d.statement || readOnly() ? summary : esc(summary)}${d.statement || readOnly() ? "" : " &middot; tap to read it"}</small></span><span class="chev" aria-hidden="true">&rsaquo;</span></button></li>`;
  };
  const groups = clusterStatements(docs);
  const rows = groups.map((g) => `<h3>${esc(g.label)} <small>(${g.items.length})</small></h3><ul class="queue">${g.items.map(row).join("")}</ul>`);
  const archivedStatements = Object.values(state.documents).filter((d) => d.contentKind === "statement" && !d.derivedFrom && d.archived);
  const archivedList = archivedStatements.length
    ? `<details><summary>Archived proof of payment (${archivedStatements.length})</summary><ul class="queue">${archivedStatements.map((d) => `<li class="q"><span>${esc(statementDisplayName(d))}</span><button data-unarchive-doc="${esc(d.id)}">Restore</button></li>`).join("")}</ul></details>`
    : "";
  return `<h2>Proof of payment</h2>
    ${readOnly() ? `<p class="note">The statement files the workbook lists for each card and period, and the files its rows name as proof of payment. Statements are not read or matched for a year kept in Excel.</p>` : `<p class="note"><span>A card or bank statement can prove payment for many purchases at once. Add one below (or mark a file already on the list page as proof of payment): it is read on this device as soon as it is added, charges are matched to your purchases, and the confident matches are linked for you. Statements are grouped by card or bank, oldest first.</span></p>`}
    ${readOnly() ? "" : workspace ? `<p class="row"><label class="btn">Add proof of payment<input type="file" id="upload-statement" multiple accept="application/pdf,image/*" hidden></label><label class="btn">Take a photo<input type="file" id="photo-statement" accept="image/*" capture="environment" hidden></label><button id="start-scan" data-as-statement="1">Scan (several pages)</button></p>` : `<p class="note">Connect a folder to add files.</p>`}
    ${rows.length ? rows.join("") : `<p>${readOnly() ? "The workbook lists no statement files." : "Nothing marked as proof of payment yet."}</p>`}${archivedList}`;
}

function statementReview(id: string): string {
  const state = ledger.state;
  const doc = state.documents[id];
  if (!doc) return `<p>That proof of payment no longer exists.</p>`;
  const data: StatementData | undefined = doc.statement;
  const head = `<p><a href="#" data-go="statements">&larr; All proof of payment</a></p><h2>${esc(doc.contentKind === "statement" ? statementDisplayName(doc) : doc.filename ?? id)}</h2>
    <p class="row">${doc.driveItemId && workspace ? `<button data-preview="${esc(id)}">Preview</button>` : ""}<button data-read-statement="${esc(id)}">${data ? "Read again" : "Read it"}</button>${data ? `<button data-relink="1">Match again</button>` : ""}</p>
    ${doc.driveItemId && workspace ? `<details><summary>Rename the file</summary><form id="rename-statement-form" class="row" data-doc="${esc(id)}"><label>File name<input name="name" value="${esc(statementDisplayName(doc).replace(/\.[^.]+$/, ""))}" required></label><button>Rename</button></form></details>` : ""}`;
  // Like a purchase's, the archive control sits at the very bottom of the screen.
  const linkedCount = new Set(Object.values(state.additionalDocs).filter((a) => a.documentId === id && a.transactionId).map((a) => a.transactionId)).size;
  const archive = `<hr><p><button data-archive-doc="${esc(id)}" data-linked="${linkedCount}" class="danger">Archive this proof of payment</button> <small>Hides it; you can restore it from the proof of payment list.</small></p>`;
  const proofOwners = [...new Set(Object.values(state.additionalDocs).filter((a) => a.documentId === id && a.kind === "payment-proof" && a.ownerId).map((a) => a.ownerId!))];
  const redactForm = data && proofOwners.length
    ? `<form id="redact-form" class="row" data-doc="${esc(id)}"><label>Pages<select name="pages"><option value="all">Every page that shows something</option><option value="matched">Only pages with the linked charges</option></select></label>
        <label>Charges to show<select name="purchase"><option value="">Every charge linked this year</option>${proofOwners.map((o) => `<option value="${esc(o)}">Only ${esc(purchaseLabel(o))}</option>`).join("")}</select></label>
        <button>Make redacted copy</button></form>`
    : "";
  const redacted = redactedCopyOf(state, doc);
  const refundSuggestions = new Map(data ? matchRefunds(state, id, data).map((r) => [r.transactionId, r]) : []);
  const refundLinks = new Map(Object.values(state.additionalDocs).filter((a) => a.documentId === id && a.kind === "refund" && a.transactionId).map((a) => [a.transactionId!, a]));
  const redactedNote = redacted ? `<p class="note"><span class="ok">Redacted copy saved</span>: ${esc(redacted.filename)} <button data-preview="${esc(redacted.id)}">Preview</button> It is sent to StepUp instead of this statement.</p>` : data ? `<p class="note">Please link transactions to this statement to be able to generate a redacted version. Until a redacted version is generated the full statement will be sent.</p>` : "";
  if (!data && readOnly()) return `${head}<p class="note">Statements are not read for a year kept in Excel. ${new Set(Object.values(state.additionalDocs).filter((a) => a.documentId === id && a.kind === "payment-proof" && a.ownerId).map((a) => a.ownerId)).size} purchase(s) in the workbook point to this file.</p>`;
  if (!data) return `${head}<p class="note">Not read yet. Only PDFs with selectable text can be read automatically; for others, attach the file to a purchase by hand.</p>${archive}`;

  const cardKnown = data.last4 ? Object.values(state.paymentMethods).find((p) => p.last4?.includes(data.last4!)) : undefined;
  const card = data.last4
    ? cardKnown
      ? `<p class="note">Card: ${esc(cardKnown.label ?? `ending ${data.last4}`)}</p>`
      : `<form id="card-form" class="row" data-last4="${esc(data.last4)}" data-issuer="${esc(data.issuer)}"><input name="label" value="${esc(`${data.issuer ?? "Card"} ${data.last4}`)}" aria-label="Card name" required><button>Save this card</button></form>`
    : "";
  const period = data.periodStart && data.periodEnd ? `${data.periodStart} to ${data.periodEnd}${data.periodInferred ? " (estimated from the charges)" : ""}` : "period not found";
  const detailsForm = `<details${data.periodInferred || !data.periodStart ? " open" : ""}><summary>Correct the card, bank or period</summary>
    <form id="statement-details-form" class="row" data-doc="${esc(id)}"><label>Bank or card issuer<input name="issuer" value="${esc(data.issuer ?? "")}"></label><label>Last 4 digits<input name="last4" value="${esc(data.last4 ?? "")}" inputmode="numeric" maxlength="4" pattern="\\d{4}"></label>
      <label>Period starts<input type="date" name="periodStart" value="${esc(data.periodStart ?? "")}"></label><label>Period ends<input type="date" name="periodEnd" value="${esc(data.periodEnd ?? "")}"></label><button>Save</button></form></details>`;
  const kinds: Array<[string, string]> = [["purchase", "Purchase"], ["credit", "Refund or credit"], ["payment", "Payment to the card"], ["fee", "Fee or interest"]];
  const txnForm = (t: { id: string; date: string; descriptor: string; amountCents: number; kind: string } | undefined) =>
    `<tr><td colspan="4"><form id="txn-form" class="row" data-doc="${esc(id)}" data-txn="${esc(t?.id ?? "")}"><label>Date<input type="date" name="date" value="${esc(t?.date ?? "")}" required></label>
      <label>Description<input name="descriptor" value="${esc(t?.descriptor ?? "")}" required></label><label>Amount (negative for a refund or payment)<input name="amount" value="${t ? (t.amountCents / 100).toFixed(2) : ""}" inputmode="decimal" required></label>
      <label>Kind<select name="kind">${kinds.map(([v, l]) => `<option value="${v}"${(t?.kind ?? "purchase") === v ? " selected" : ""}>${l}</option>`).join("")}</select></label><button>Save row</button><button type="button" data-cancel-txn="1">Cancel</button></form></td></tr>`;
  const matches = new Map<string, TransactionMatch>(matchStatement(state, id, data).map((m) => [m.transactionId, m]));
  const links = new Map(Object.values(state.additionalDocs).filter((a) => a.documentId === id && a.transactionId).map((a) => [a.transactionId!, a]));
  const rows = data.transactions.map((t) => {
    if (editingTxn === t.id) return txnForm(t);
    const amount = `<td class="num">${formatCents(t.amountCents)}</td>`;
    const base = `<td>${esc(t.date)}</td><td>${esc(t.descriptor)}${t.edited ? ` <small>(corrected)</small>` : t.confidence < 0.8 ? ` <small class="warn">check this row</small>` : ""}<br><button data-edit-txn="${esc(t.id)}">Edit</button> <button class="danger" data-remove-txn="${esc(t.id)}" data-doc="${esc(id)}">Remove</button></td>${amount}`;
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
    const open = assist?.kind === "txn" && assist.docId === id && assist.txnId === t.id;
    const find = open ? "" : `<button data-assist-txn="${esc(t.id)}" data-doc="${esc(id)}">Find a purchase</button>`;
    return `<tr>${base}<td>${buttons || `<small>No matching purchase yet</small>`}${buttons && find ? "<br>" : " "}${find}</td></tr>${open ? `<tr><td colspan="4">${purchaseAssist(id, t.id)}</td></tr>` : ""}`;
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
    ${detailsForm}
    ${redactForm}
    <p class="row"><button data-add-txn="1">Add a missed row</button></p>
    <table><thead><tr><th>Date</th><th>Description</th><th>Amount</th><th>Matched purchase</th></tr></thead><tbody>${editingTxn === "new" ? txnForm(undefined) : ""}${rows.join("")}</tbody></table>${splitSection}${archive}`;
}

/**
 * Downloads a statement, reads its text on this device (OCR for photos and scans), saves the charges and links the
 * confident matches. Rows a person already corrected survive a second read. Returns what to tell the person.
 */
async function readStatement(docId: string): Promise<string> {
  const got = await loadDocument(docId);
  note("Reading the statement on this device…");
  let text: string;
  let ocr = false;
  if (got.kind === "pdf") ({ text, ocr } = await pdfToText(got.blob));
  else if (got.kind === "image") ({ text } = await ocrImage(got.blob)), (ocr = true);
  else throw new Error("This file type can't be read. Attach it to a purchase by hand.");
  const parsed = parseStatementText(text, { confidencePenalty: ocr ? 0.2 : 0 });
  if (parsed.transactions.length === 0) return parsed.warnings.join(" ") + (ocr ? " The text was read by OCR and may be too unclear." : "");
  const merged = { ...mergeReread(ledger.state.documents[docId]?.statement, parsed), unparsedLines: parsed.unparsedLines, warnings: parsed.warnings };
  saveStatement(ledger, docId, merged);
  const auto = linkConfidentMatches(ledger, docId, matchStatement(ledger.state, docId, merged));
  await ledger.flush();
  const period = merged.periodInferred ? " The period was estimated from the charges; check it." : "";
  return `Read ${merged.transactions.length} line(s)${ocr ? " using OCR (check each row)" : ""}; linked ${auto} charge(s) automatically.${merged.unparsedLines.length ? ` ${merged.unparsedLines.length} line(s) could not be read.` : ""}${period}`;
}

/** Reads each newly added proof of payment, one failure never stopping the rest. Returns one sentence per file. */
async function autoReadStatements(docIds: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const [i, id] of docIds.entries()) {
    const name = ledger.state.documents[id]?.filename ?? "file";
    note(`Reading ${name} (${i + 1} of ${docIds.length})…`);
    try {
      out.push(`${name}: ${await readStatement(id)}`);
    } catch (err) {
      out.push(`${name} could not be read (${err instanceof Error ? err.message : err}). Open it to try again or correct it by hand.`);
    }
  }
  return out;
}

/** The text of a receipt or other document: its text layer, or OCR for scans and photos. Kept for the session. */
const documentTexts = new Map<string, { text: string; ocr: boolean }>();
async function documentText(docId: string): Promise<{ text: string; ocr: boolean }> {
  const cached = documentTexts.get(docId);
  if (cached) return cached;
  const got = await loadDocument(docId);
  note("Reading the file on this device…");
  let read: { text: string; ocr: boolean };
  if (got.kind === "pdf") {
    read = await pdfToText(got.blob);
    // A printed email's header (with the sent date) is often a picture. When the text has no date, read the first page too.
    if (!read.ocr && !readReceiptText(read.text).date) {
      const header = await pdfFirstPageOcrText(got.blob).catch(() => "");
      if (readReceiptText(header).date) read = { text: `${read.text}\n${header}`, ocr: true };
    }
  } else if (got.kind === "image") read = { text: (await ocrImage(got.blob)).text, ocr: true };
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
  const result = await uploadReceipt(ledger, storage, ws.driveId, ws.year.folderId, { name, body, sha256: (await sha256Hex(body)) || undefined });
  ledger.set("document", result.documentId, { derivedFrom: original.id, shrunk: true, contentKind: original.contentKind ?? "receipt-like", ...(original.paymentEvidenceConfidence !== undefined ? { paymentEvidenceConfidence: original.paymentEvidenceConfidence } : {}) }, { label: "document.shrunk" });
  ledger.set("purchase", purchaseId, { receiptDocumentId: result.documentId }, { label: "purchase.receiptShrunk" });
  await ledger.flush();
  status = `Made a smaller copy (${(small.bytes.byteLength / 1048576).toFixed(1)} MB: ${small.how}) and switched this purchase to it. The original is kept.`;
}

/** Fills only the blank fields of a purchase from its receipt, and records whether the receipt itself shows payment. */
async function readReceipt(purchaseId: string, opts: { quiet?: boolean } = {}): Promise<string> {
  const p = ledger.state.purchases[purchaseId];
  const docId = p?.receiptDocumentId;
  if (!p || !docId) return "";
  const { text, ocr } = await documentText(docId);
  const r = readReceiptText(text);
  const names: Record<string, string> = { vendor: "vendor", date: "date", invoiceNo: "invoice #", orderTotalCents: "total", taxShippingTotalCents: "tax/shipping" };
  const read: Record<string, string | number> = {};
  if (r.vendor) read["vendor"] = r.vendor;
  if (r.date) read["date"] = r.date;
  if (r.invoiceNo) read["invoiceNo"] = r.invoiceNo;
  if (r.totalCents !== undefined) read["orderTotalCents"] = r.totalCents;
  if (r.taxShippingCents !== undefined) read["taxShippingTotalCents"] = r.taxShippingCents;
  const saved: Record<string, string | number | undefined> = { vendor: p.vendor, date: p.date, invoiceNo: p.invoiceNo, orderTotalCents: p.orderTotalCents, taxShippingTotalCents: p.taxShippingTotalCents };
  const show = (k: string, v: string | number | undefined) => (typeof v === "number" ? formatCents(v) : String(v));
  const fields: Record<string, string | number> = {};
  const differs: string[] = [];
  for (const [k, v] of Object.entries(read)) {
    if (saved[k] === undefined || saved[k] === "") fields[k] = v;
    else if (saved[k] !== v) differs.push(k);
  }
  // Values already saved are never replaced silently (they may have been typed by hand), but a re-read that finds
  // something different is offered, so a wrong earlier reading can be corrected.
  if (differs.length && !opts.quiet && confirm(`The receipt now reads differently from what is saved:\n\n${differs.map((k) => `${names[k]}: ${show(k, saved[k])} \u2192 ${show(k, read[k])}`).join("\n")}\n\nReplace the saved values?`)) {
    for (const k of differs) fields[k] = read[k]!;
  }
  if (Object.keys(fields).length) ledger.set("purchase", purchaseId, fields, { label: "purchase.readFromReceipt" });
  if (fields["taxShippingTotalCents"] !== undefined) reallocateTax(ledger, purchaseId);
  if (r.paymentEvidence) ledger.set("document", docId, { paymentEvidenceConfidence: r.paymentEvidence.confidence, paymentEvidenceSnippet: r.paymentEvidence.snippet }, { label: "document.paymentEvidence" });
  await ledger.flush();
  const filled = Object.keys(fields).map((k) => names[k]);
  const proof = r.paymentEvidence ? (r.paymentEvidence.confidence >= 0.8 ? " The receipt shows payment, so it counts as proof." : " It does not clearly show payment; a statement may be needed.") : " No sign of payment was found on it.";
  if (text.trim().length < 10) return `No text could be read from this file${ocr ? " (even with OCR)" : ""}. Fill in the details by hand.`;
  if (Object.keys(read).length === 0 && !r.paymentEvidence) return "The text was read, but no vendor, date, order number or total could be found in it. Fill in the details by hand.";
  if (filled.length) return `Filled in ${filled.join(", ")}${ocr ? " (read by OCR: please check)" : ""}.${proof}`;
  if (differs.length) return `Kept the saved ${differs.map((k) => names[k]).join(", ")}.${proof}`;
  return `Everything it could read (${Object.keys(read).map((k) => names[k]).join(", ") || "payment"}) is already filled in.${proof}`;
}

/**
 * Reads files that were just added as receipts, so nothing has to be pressed. On a purchase the blank fields are filled
 * in; an unattached file keeps what was read so that starting a purchase from it begins filled in. One failure never
 * stops the rest. Returns one sentence per file.
 */
async function autoReadReceipts(items: Array<{ docId: string; purchaseId?: string }>): Promise<string[]> {
  const out: string[] = [];
  for (const [i, { docId, purchaseId }] of items.entries()) {
    const name = ledger.state.documents[docId]?.filename ?? "file";
    note(`Reading ${name} (${i + 1} of ${items.length})…`);
    try {
      if (purchaseId && ledger.state.purchases[purchaseId]?.receiptDocumentId === docId) {
        out.push(`${name}: ${await readReceipt(purchaseId, { quiet: true })}`);
        continue;
      }
      const { text, ocr } = await documentText(docId);
      const r = readReceiptText(text);
      const reading = {
        ...(r.vendor ? { vendor: r.vendor } : {}),
        ...(r.date ? { date: r.date } : {}),
        ...(r.invoiceNo ? { invoiceNo: r.invoiceNo } : {}),
        ...(r.totalCents !== undefined ? { orderTotalCents: r.totalCents } : {}),
        ...(r.taxShippingCents !== undefined ? { taxShippingTotalCents: r.taxShippingCents } : {}),
      };
      ledger.set("document", docId, { reading, ...(r.paymentEvidence ? { paymentEvidenceConfidence: r.paymentEvidence.confidence, paymentEvidenceSnippet: r.paymentEvidence.snippet } : {}) } as never, { label: "document.read" });
      await ledger.flush();
      const found = Object.keys(reading).length;
      out.push(found ? `${name}: read ${found} detail(s)${ocr ? " by OCR (check them)" : ""}; they will fill in when you start a purchase.` : `${name}: nothing could be read from it.`);
    } catch (err) {
      out.push(`${name} could not be read (${err instanceof Error ? err.message : err}). You can fill in the details by hand.`);
    }
  }
  return out;
}

function tabs(): string {
  const tab = (name: string, label: string) => `<a href="#" data-go="${name}"${view.name === name || (name === "queue" && view.name === "purchase") || (name === "statements" && view.name === "statement") ? ` class="on" aria-current="page"` : ""}>${label}</a>`;
  return `<div class="tabs">${tab("queue", readOnly() ? "Purchases" : "Needs attention")}${tab("statements", "Proof of payment")}${tab("summary", "Summary")}${tab("history", "History")}</div>`;
}

/**
 * The item being worked on. Nothing to press: once child, description, amount, category and benefit message are filled in
 * the item is saved, and every later change to a field is saved as the field is left. "Add another" starts the next one.
 */
function itemForm(purchaseId: string, next: ReturnType<typeof suggestNextItem>): string {
  const state = ledger.state;
  const children = Object.values(state.children);
  const money = (c: number | undefined) => (c === undefined ? "" : (c / 100).toFixed(2));
  const current = itemEdit?.purchaseId === purchaseId && itemEdit.itemId ? state.items[itemEdit.itemId] : undefined;
  const draft = current ? {} : readItemDraft(purchaseId);
  const text = (k: string, saved: string | undefined) => esc(current ? saved : draft[k]);
  const childId = current?.childId ?? draft["childId"] ?? next.childId;
  const categoryText = current ? categoryLabel(current) : draft["categoryId"];
  const needsDate = Boolean(reference() ? reference()!.category(reference()!.idForLabel(categoryText ?? "") ?? "")?.requiresServiceDate : false);
  const categories = reference() ? [] : [...new Set(Object.values(state.items).map((i) => categoryLabel(i)).filter(Boolean))];
  return `<form id="item-form" class="grid" data-id="${esc(purchaseId)}">
    <label>Child<select name="childId" required>${children.map((c) => `<option value="${esc(c.id)}"${c.id === childId ? " selected" : ""}>${esc(c.name)}</option>`).join("")}</select></label>
    <label class="wide">Description<input name="description" required value="${text("description", current?.description)}"></label>
    <label>Amount<input name="amount" inputmode="decimal" required value="${esc(current ? money(current.amountCents) : (draft["amount"] ?? money(next.amountCents)))}"></label>
    <label class="wide">Category${categoryPicker(categoryText)}</label><datalist id="cats">${categories.map((c) => `<option value="${esc(c)}">`).join("")}</datalist>
    <label class="wide">Benefit message<input name="benefitMessage" required value="${text("benefitMessage", current?.benefitMessage)}"></label>
    <label data-service-date${needsDate || !reference() ? "" : " hidden"}>Service date<input name="serviceDate" type="date" value="${text("serviceDate", current?.serviceDate)}"></label>
    <label class="wide">Service provider${providerBox(current ? current.serviceProvider : (draft["serviceProvider"] ?? next.serviceProvider), categoryText)}</label>
    <label class="check wide"><input type="checkbox" name="includeTax"${(current ? current.includeTax !== false : draft["includeTax"] !== "0") ? " checked" : ""}> Include a share of the receipt's tax/shipping</label>
    ${saveIndicator("item-save-state")}</form>`;
}

/** The "Saving… / Saved" mark next to the purchase details. Updated in place so typing and focus are never disturbed. */
const saveIndicator = (elId = "save-state") => `<span class="save-state" id="${elId}" role="status" aria-live="polite"></span>`;
let saveStateTimer: ReturnType<typeof setTimeout> | undefined;
/** What to tell the person when a save did not reach the storage provider (their change is already kept on this device). */
function saveFailure(err: unknown): string {
  // A conflict is not a connection problem, and its message already says what happens next.
  if (isStorageError(err, "changed")) return err.message;
  return `Could not reach ${storage.label} (${err instanceof Error ? err.message : err}). Your change is kept on this device.`;
}

function showSaveState(state: "saving" | "saved" | "local" | "error", detail = "", elId = "save-state"): void {
  const el = document.getElementById(elId);
  if (!el) return;
  clearTimeout(saveStateTimer);
  el.className = `save-state ${state}`;
  el.innerHTML =
    state === "saving" ? `<span class="spinner" aria-hidden="true"></span> Saving…`
    : state === "saved" ? `<span class="tick" aria-hidden="true">&#10003;</span> Saved`
    : state === "local" ? `<span class="tick" aria-hidden="true">&#10003;</span> Saved on this device; it will sync when ${storage.label} is reachable`
    : `<span aria-hidden="true">&#9888;</span> ${esc(detail)}`;
  if (state === "saved") saveStateTimer = setTimeout(() => { el.textContent = ""; el.className = "save-state"; }, 2500);
}

let autosaveChain: Promise<void> = Promise.resolve();
/**
 * Saves the purchase's details when a field is left. The change is written to the ledger first, which keeps it on this
 * device at once (so it survives a reload or a lost connection), and is then sent to OneDrive. Runs one at a time.
 */
function autosavePurchase(form: HTMLFormElement, focusNext?: string): Promise<void> {
  autosaveChain = autosaveChain.then(() => autosavePurchaseNow(form, focusNext)).catch(() => undefined);
  return autosaveChain;
}

async function autosavePurchaseNow(form: HTMLFormElement, focusNext?: string): Promise<void> {
  const id = form.dataset["id"]!;
  const existing = ledger.state.purchases[id];
  const draft = !existing;
  const fields: Record<string, string | number> = {};
  const saved: Record<string, string | number | undefined> = { name: existing?.name, vendor: existing?.vendor, date: existing?.date, invoiceNo: existing?.invoiceNo, orderTotalCents: existing?.orderTotalCents, taxShippingTotalCents: existing?.taxShippingTotalCents };
  for (const k of ["name", "vendor", "date", "invoiceNo"]) {
    const v = val(form, k);
    if (v !== (saved[k] ?? "")) fields[k] = v; // an emptied field is saved as empty
  }
  const total = toCents(val(form, "orderTotal"));
  const tax = toCents(val(form, "taxTotal"));
  if (total !== undefined && total !== saved["orderTotalCents"]) fields["orderTotalCents"] = total;
  if (tax !== undefined && tax !== saved["taxShippingTotalCents"]) fields["taxShippingTotalCents"] = tax;
  // Blanking a tax total that was set means it is not known again: the items go back to estimates.
  const clearTax = !draft && tax === undefined && saved["taxShippingTotalCents"] !== undefined && val(form, "taxTotal") === "";
  if (Object.keys(fields).length === 0 && !clearTax) return;
  if (draft && Object.values(fields).every((v) => v === "")) return;
  showSaveState("saving");
  if (Object.keys(fields).length) ledger.set("purchase", id, fields, { label: draft ? "purchase.created" : "purchase.edited" });
  if (fields["taxShippingTotalCents"] !== undefined) reallocateTax(ledger, id);
  if (clearTax) clearTaxTotal(ledger, id);
  if (Object.values(ledger.state.documents).some((d) => d.statement)) relinkAllStatements(ledger);
  try {
    await ledger.flush();
    persist();
    scheduleMirror();
    showSaveState("saved");
  } catch (err) {
    // The edit is already kept on this device; it is sent again with the next save or refresh.
    showSaveState(navigator.onLine ? "error" : "local", saveFailure(err));
  }
  if (draft) {
    // The purchase now exists, so the full screen (items, documentation) replaces the blank one. Keep the cursor where it was going.
    view = { name: "purchase", id };
    remember(false);
    render();
    if (focusNext) document.getElementById("app")?.querySelector<HTMLElement>(`#purchase-form [name="${focusNext}"]`)?.focus();
  }
}

let itemChain: Promise<void> = Promise.resolve();
/** Saves the item being worked on when a field is left (see `itemForm`). Runs one at a time. */
function autosaveItem(form: HTMLFormElement, focusNext?: string): Promise<void> {
  itemChain = itemChain.then(() => autosaveItemNow(form, focusNext)).catch(() => undefined);
  return itemChain;
}

async function autosaveItemNow(form: HTMLFormElement, focusNext?: string): Promise<void> {
  const purchaseId = form.dataset["id"]!;
  const itemId = itemEdit?.purchaseId === purchaseId ? itemEdit.itemId : undefined;
  const dateField = form.querySelector<HTMLElement>("[data-service-date]");
  const dateShown = !dateField?.hidden;
  const raw = Object.fromEntries(["childId", "description", "amount", "categoryId", "benefitMessage", "serviceDate", "serviceProvider"].map((k) => [k, val(form, k)]));
  if (!dateShown) raw["serviceDate"] = "";
  const includeTax = (form.elements.namedItem("includeTax") as HTMLInputElement | null)?.checked !== false;
  raw["includeTax"] = includeTax ? "1" : "0";
  if (!itemId) writeItemDraft(purchaseId, raw); // kept on this device even while the form is incomplete
  const amountCents = toCents(raw["amount"]!);
  // An item is saved as soon as it has a child, a description and an amount. The category, benefit message and the rest
  // can come later: what is still missing shows on the item, and it cannot be marked ready until it is there.
  if (!raw["childId"] || !raw["description"] || amountCents === undefined) return;
  const input = {
    childId: raw["childId"],
    description: raw["description"],
    amountCents,
    ...(raw["categoryId"] ? categoryFields(raw["categoryId"]) : { categoryId: "", categoryPath: [] as string[] }),
    benefitMessage: raw["benefitMessage"] ?? "",
    serviceDate: raw["serviceDate"] ?? "",
    serviceProvider: raw["serviceProvider"] ?? "",
    includeTax,
  };
  const existing = itemId ? ledger.state.items[itemId] : undefined;
  if (existing) {
    const same = existing.childId === input.childId && existing.description === input.description && existing.amountCents === input.amountCents && (existing.categoryId ?? "") === input.categoryId && (existing.benefitMessage ?? "") === input.benefitMessage && (existing.serviceDate ?? "") === input.serviceDate && (existing.serviceProvider ?? "") === input.serviceProvider && (existing.includeTax !== false) === input.includeTax;
    if (same) return;
  }
  showSaveState("saving", "", "item-save-state");
  let created = false;
  if (existing) updateItem(ledger, existing.id, input);
  else {
    const { categoryId, categoryPath, benefitMessage, ...rest } = input;
    const id = addItem(ledger, purchaseId, {
      ...rest,
      ...(categoryId ? { categoryId, ...(categoryPath?.length ? { categoryPath } : {}) } : {}),
      ...(benefitMessage ? { benefitMessage } : {}),
      serviceDate: input.serviceDate || undefined,
      serviceProvider: input.serviceProvider || undefined,
    });
    itemEdit = { purchaseId, itemId: id };
    writeItemDraft(purchaseId, undefined);
    created = true;
  }
  if (ledger.state.purchases[purchaseId]?.taxShippingTotalCents !== undefined) reallocateTax(ledger, purchaseId);
  try {
    await ledger.flush();
    persist();
    scheduleMirror();
    showSaveState("saved", "", "item-save-state");
  } catch (err) {
    showSaveState(navigator.onLine ? "error" : "local", saveFailure(err), "item-save-state");
  }
  if (created) {
    // The new item now shows in the list above, so draw the screen again and put the cursor back where it was heading.
    render();
    if (focusNext) root.querySelector<HTMLElement>(`#item-form [name="${focusNext}"]`)?.focus();
  }
}

/** Cards on the purchase page the person has folded away; remembered while the page is open, across redraws. */
const collapsedPanels = new Set<string>();
function panel(key: string, title: string, body: string, cls = ""): string {
  return `<details class="panel${cls ? " " + cls : ""}" data-panel="${key}"${collapsedPanels.has(key) ? "" : " open"}><summary class="panel-title">${title}</summary>${body}</details>`;
}
root.addEventListener("toggle", (ev) => {
  const el = ev.target;
  const key = el instanceof HTMLDetailsElement ? el.dataset["panel"] : undefined;
  if (key) (el as HTMLDetailsElement).open ? collapsedPanels.delete(key) : collapsedPanels.add(key);
}, true);

/** What StepUp (or a person) said about a submitted item, in full, plus a link to the item's page on StepUp's site. */
function stepUpDetails(i: LineItem): string {
  const guid = i.submissionId ? ledger.state.submissions[i.submissionId]?.guid : undefined;
  const link = guid ? `<a href="${esc(stepUpStatusUrl(guid))}" target="_blank" rel="noopener">View on StepUp</a>` : "";
  const said = (label: string, text: string | undefined) => (text?.trim() ? `<div class="note"><strong>${label}:</strong> <span style="white-space:pre-wrap">${esc(text.trim())}</span></div>` : "");
  const notes = i.notes?.trim() && i.notes.trim() !== i.holdNote?.trim() ? i.notes : undefined;
  // StepUp holds the item at another amount than the ledger has: say so, with both.
  const requested = (i.amountCents ?? 0) + (i.taxShippingCents ?? 0);
  const adjusted = i.stepUpAmountCents !== undefined && i.amountCents !== undefined && i.stepUpAmountCents !== i.amountCents && i.stepUpAmountCents !== requested
    ? `<div class="note warn"><strong>Adjusted:</strong> StepUp has ${formatCents(i.stepUpAmountCents)} for this item; the ledger has ${formatCents(i.amountCents)}${requested !== i.amountCents ? ` (${formatCents(requested)} with tax/shipping)` : ""}.</div>`
    : "";
  return `${link ? `<div>${link}</div>` : ""}${adjusted}${said("StepUp says", i.stepUpMessage)}${said("Hold", i.holdNote)}${said("Notes", notes)}`;
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
    const label = statusLabel(i, ev);
    if (readOnly()) return `<span class="ok">${esc(label)}</span>${stepUpDetails(i)}`;
    if (i.stepUpStatus || i.submissionId) return `<span class="ok">${esc(label)}</span>${stepUpDetails(i)}`;
    if (awaitingReview(ev)) return `<small class="warn">Has what it needs. Check whether it needs anything more, then mark it ready.</small>`;
    return ev.readiness === "ready" ? `<span class="ok">Ready to file</span>` : `<small class="warn">${esc(ev.reasons.map((r) => r.message).join("; "))}</small>`;
  };
  // Marking ready is always a person's call: it is offered once the minimum is there, and can be taken back.
  const markButton = (i: (typeof items)[number], ev: ReturnType<typeof evaluateItem>): string => {
    if (i.stepUpStatus || i.submissionId || filing[i.id]) return "";
    if (i.readyToSubmit) return `<button data-unready="${esc(i.id)}">Not ready</button> `;
    return awaitingReview(ev) ? `<button data-ready="${esc(i.id)}" class="primary">Mark ready to submit</button> ` : "";
  };
  const rows = items.map((i) => {
    const ev = readOnly() ? undefined as never : evaluateItem(state, i.id, ctx());
    const who = state.children[i.childId ?? ""]?.name ?? "?";
    const tax = i.includeTax === false ? " &middot; no tax/shipping" : i.taxShippingCents ? ` &middot; tax/shipping ${formatCents(i.taxShippingCents)}${i.taxShippingEstimated ? " (est.)" : ""}` : "";
    return `<li class="item-card"><div class="item-top"><strong>${esc(i.description)}</strong><span class="amt">${formatCents(i.amountCents)}</span></div>
      <div class="item-meta">${esc(who)} &middot; ${esc(categoryLabel(i)) || "<span class=\"warn\">no category</span>"}${tax}${readOnly() && (i.paidCents ?? i.approvedCents) !== undefined ? ` &middot; ${i.paidCents !== undefined ? "paid" : "approved"} ${formatCents((i.paidCents ?? i.approvedCents)!)}` : ""}</div>
      <div class="item-status">${statusCell(i, ev)}</div>
      <div class="actions">${markButton(i, ev)}<button data-edit-item="${esc(i.id)}">Edit</button><button data-dup="${esc(i.id)}">Duplicate</button></div></li>`;
  });
  if (draft) {
    return `<p><a href="#" data-go="queue">&larr; Back to the list</a></p>
  <h2>New purchase</h2>
  <p class="note">This purchase is saved as soon as you fill in a detail and move to the next field.</p>
  ${panel("details", "Purchase details", `<form id="purchase-form" class="grid" data-id="${esc(id)}" data-draft="1">
    <label class="wide">Name<input name="name" placeholder="e.g. Math curriculum"></label>
    <label class="wide">Vendor${storeBox("vendor", undefined)}</label>
    <label>Date<input name="date" type="date"></label>
    <label>Invoice #<input name="invoiceNo"></label>
    <label>Receipt total<input name="orderTotal" inputmode="decimal"></label>
    <label>Tax/shipping total<input name="taxTotal" inputmode="decimal"></label>
    ${saveIndicator()}</form>`)}
  ${documentation(id, undefined, "bottom", true)}`;
  }
  const categories = reference()
    ? reference()!.choices.map((c) => c.label)
    : [...new Set(Object.values(state.items).map((i) => categoryLabel(i)).filter(Boolean))];
  const filers = [...new Set(items.map((i) => filing[i.id]?.actor).filter((a): a is string => Boolean(a)))];
  const filingNotice = filers.length
    ? `<section class="filing-banner"><div class="filing-head"><strong>${esc(filers.join(" and "))} ${filers.length > 1 ? "are" : "is"} filing this purchase with StepUp right now</strong><button id="refresh-now">Refresh</button></div>
        <p class="note">Wait for the run to finish before changing it; edits made now may not be picked up. This page refreshes by itself every minute.</p></section>`
    : "";
  // A receipt that does not itself show payment is fine once a statement charge is linked to this purchase.
  const provedByStatement = Object.values(state.additionalDocs).some((a) => a.ownerKind === "purchase" && a.ownerId === id && a.kind === "payment-proof" && a.transactionId);
  const tooBig = !readOnly() && (doc?.sizeBytes ?? 0) > MAX_PROOF_BYTES;
  const receipt = {
    tools: doc?.driveItemId && workspace ? `<button data-read-receipt="${esc(id)}">Read receipt</button>${tooBig ? `<button data-shrink="${esc(id)}">Shrink to under 5 MB</button>` : ""}${readableFileName(doc, p) !== doc.filename ? `<button data-rename-file="${esc(id)}" title="${esc(readableFileName(doc, p))}">Give the file a readable name</button>` : ""}` : "",
    notes: `${tooBig ? `<p class="note warn">This receipt is ${((doc?.sizeBytes ?? 0) / 1048576).toFixed(1)} MB; StepUp only accepts files under 5 MB.</p>` : ""}${doc?.paymentEvidenceConfidence !== undefined ? (doc.paymentEvidenceConfidence >= 0.8 ? `<p class="note"><span class="ok">Receipt shows payment</span>${doc.paymentEvidenceSnippet ? `: &ldquo;${esc(doc.paymentEvidenceSnippet)}&rdquo;` : ""}</p>` : (provedByStatement ? "" : `<p class="note warn">Receipt does not clearly show payment${doc.paymentEvidenceSnippet ? `: &ldquo;${esc(doc.paymentEvidenceSnippet)}&rdquo;` : ""}. A statement may be needed.</p>`)) : ""}`,
  };
  return `<p><a href="#" data-go="queue">&larr; Back to the list</a></p>
  ${filingNotice}${draftNote(items.map((i) => i.id))}
  <div class="page-title"><h2>${esc(purchaseName(p))}</h2><p class="note">${doc ? `Receipt file: ${esc(doc.filename)}` : "No receipt file yet"}</p></div>
  ${panel("details", "Purchase details", `<form id="purchase-form" class="grid" data-id="${esc(id)}">
    <label class="wide">Name<input name="name" value="${esc(p.name)}" placeholder="${esc(purchaseName({ ...p, name: undefined }))}"></label>
    <label class="wide">Vendor${storeBox("vendor", p.vendor)}</label>
    <label>Date<input name="date" type="date" value="${esc(p.date)}"></label>
    <label>Invoice #<input name="invoiceNo" value="${esc(p.invoiceNo)}"></label>
    <label>Receipt total<input name="orderTotal" inputmode="decimal" value="${money(p.orderTotalCents)}"></label>
    <label>Tax/shipping total<input name="taxTotal" inputmode="decimal" value="${money(p.taxShippingTotalCents)}"></label>
    ${saveIndicator()}</form>`)}
  ${documentation(id, p.receiptDocumentId, "bottom", false, receipt)}
  ${panel("items", `Items${items.length || remaining !== undefined ? ` <small>${items.length} item${items.length === 1 ? "" : "s"}${remaining !== undefined ? ` &middot; ${formatCents(remaining)} left to itemize` : ""}</small>` : ""}`, `
  ${items.length ? `<ul class="items">${rows.join("")}</ul>` : `<p class="note">${readOnly() ? "No items." : "No items yet. Add the first one below."}</p>`}
  ${readOnly() ? "" : `<h4>${itemEdit?.purchaseId === id && itemEdit.itemId ? "Editing this item" : "Add an item"}</h4>
  <p class="note">It is saved as soon as it has a child, a description and an amount. Add the category and benefit message now or later: the item lists what is still missing, and you can come back with <strong>Edit</strong>.</p>
  ${children.length === 0 ? `<p class="warn">Add a child on the list page first.</p>` : ""}
  ${itemForm(id, next)}
  <p><button type="button" id="add-another"${itemEdit?.purchaseId === id && itemEdit.itemId ? "" : " disabled"}>Add another</button></p>
  ${reference() ? `<details><summary>Category missing, or needs a Service Date?</summary>
    <form id="category-form" class="row"><input name="path" list="cats" placeholder="Category - Type - Detail" required>
      <label class="check"><input type="checkbox" name="needsDate"> Needs a Service Date</label><button>Save for this year</button></form>
    <p class="note">Adds the category (or updates it) for this year's data. Use <strong>Advanced &rarr; Share category fixes</strong> to send fixes back so everyone gets them.</p></details>` : ""}
  `}`)}
  ${readOnly() ? "" : `<section class="panel danger-zone"><p><button data-archive="${esc(id)}" class="danger">Archive this purchase</button> <small>Hides it and its items; you can restore it from the list page.</small></p></section>`}`;
}

/**
 * Documentation, in two clearly separate parts. The receipt is the one document showing what was bought and what was
 * paid for it; additional documentation is anything else that backs the purchase up (a card statement, an order email,
 * a letter). Each part has its own ways to add a file.
 */
function documentation(purchaseId: string, receiptId: string | undefined, part: "top" | "bottom", draft = false, receipt: { tools: string; notes: string } = { tools: "", notes: "" }): string {
  const state = ledger.state;
  const online = Boolean(workspace);
  const ro = readOnly();
  const nameOf = (id: string | undefined) => {
    const d = state.documents[id ?? ""];
    return esc(d ? (d.contentKind === "statement" ? statementDisplayName(d) : d.filename ?? "file") : "file");
  };
  const extras = Object.values(state.additionalDocs).filter((a) => a.ownerKind === "purchase" && a.ownerId === purchaseId);
  const used = new Set<string>([...Object.values(state.purchases).flatMap((q) => (q.receiptDocumentId ? [q.receiptDocumentId] : [])), ...Object.values(state.additionalDocs).flatMap((a) => (a.documentId ? [a.documentId] : []))]);
  const hasCopy = new Set(Object.values(state.documents).flatMap((d) => (d.derivedFrom ? [d.derivedFrom] : [])));
  const loose = Object.values(state.documents).filter((d) => !d.archived && !used.has(d.id) && !d.derivedFrom && !hasCopy.has(d.id)).sort((a, b) => (a.filename ?? a.id).localeCompare(b.filename ?? b.id));
  const adders = (role: DocRole) => online
    ? `<p class="row"><label class="btn">Add files<input type="file" id="upload" data-purchase="${esc(purchaseId)}" data-role="${role}" multiple accept="application/pdf,image/*" hidden></label>
        <label class="btn">Take a photo<input type="file" id="photo" data-purchase="${esc(purchaseId)}" data-role="${role}" accept="image/*" capture="environment" hidden></label>
        <button id="start-scan" data-for-purchase="${esc(purchaseId)}" data-role="${role}">Scan (several pages)</button></p>`
    : `<p class="note">Connect a folder to add files.</p>`;
  const pick = (role: DocRole, label: string) => loose.length
    ? `<details><summary>Use a file you already added (${loose.length})</summary><ul class="queue">${loose.map((d) => `<li class="q"><span>${esc(d.contentKind === "statement" ? statementDisplayName(d) : d.filename ?? d.id)}</span><span class="actions">${d.driveItemId && online ? `<button data-preview="${esc(d.id)}">Preview</button>` : ""}<button data-use-doc="${esc(d.id)}" data-purchase="${esc(purchaseId)}" data-role="${role}">${label}</button></span></li>`).join("")}</ul></details>`
    : "";
  const replacing = replacingReceipt === purchaseId;
  const receiptPart = receiptId && !replacing
    ? `<h4>Receipt</h4>
    <p>Current receipt: <strong>${nameOf(receiptId)}</strong></p>
    ${state.documents[receiptId]?.driveItemId && online ? `<p class="row"><button class="primary" data-preview="${esc(receiptId)}">Preview</button></p>` : ""}
    ${receipt.notes}${ro ? receiptChoice(purchaseId) : ""}
    <details class="more"><summary>More receipt options</summary><p class="row"><button data-replace-receipt="${esc(purchaseId)}">Replace Receipt</button><button data-receipt-to-extra="${esc(purchaseId)}">Move to additional documentation</button>${receipt.tools}</p></details>`
    : ro ? `<h4>Receipt</h4>${unclearReceipt(purchaseId) ? receiptChoice(purchaseId) : `<p class="warn">The workbook names no receipt file for this purchase.</p>`}`
    : `<h4>Receipt</h4>
    <p class="note">The one document that shows what you bought and what it cost: an order confirmation, invoice or store receipt.${receiptId ? " Whatever you choose here replaces the current receipt, which goes back to your unattached files." : ""}</p>
    ${receiptId ? `<p>Current receipt: <strong>${nameOf(receiptId)}</strong></p>` : `<p class="warn">No receipt yet.</p>`}
    ${ro ? "" : `${adders("receipt")}${pick("receipt", receiptId ? "Replace the receipt with this" : "Use as the receipt")}`}
    ${receiptId ? `<p><button data-cancel-replace="1">Keep the current receipt</button></p>` : ""}`;
  // Proof of payment (a card statement showing the charge) is called out on its own, like the receipt; everything else
  // that backs the purchase up stays under additional documentation.
  const isProof = (a: { kind?: string; documentId?: string }) => a.kind === "payment-proof" || state.documents[a.documentId ?? ""]?.contentKind === "statement";
  const listOf = (rows: typeof extras) => [...new Map(rows.map((a) => [a.documentId, a])).values()].map((a) => {
    const hasCharge = a.kind === "payment-proof" && extras.some((x) => x.documentId === a.documentId && x.transactionId);
    const canPreview = state.documents[a.documentId ?? ""]?.driveItemId && online;
    return `<li class="q"><span>${nameOf(a.documentId)}</span><span class="actions">${canPreview ? (hasCharge ? `<button class="primary" data-preview-proof="${esc(a.documentId)}" data-purchase="${esc(purchaseId)}" title="Shows the statement with this purchase's charge highlighted">Preview</button><button data-redact-view="${esc(a.documentId)}" data-purchase="${esc(purchaseId)}" title="Hides every other charge, account number and balance">See it redacted</button>` : `<button class="primary" data-preview="${esc(a.documentId)}">Preview</button>`) : ""}${ro ? "" : `<details class="more inline"><summary>More</summary><button class="danger" data-unlink-extra="${esc(a.documentId)}" data-purchase="${esc(purchaseId)}">Remove from this purchase</button></details>`}</span></li>`;
  }).join("");
  const proofs = extras.filter(isProof);
  const others = extras.filter((a) => !isProof(a));
  const saveFirst = (what: string) => `<p class="note">Save the purchase details above (or add a receipt) first; then you can add ${what} here.</p>`;
  // Once the linked charges cover the purchase, linking more and adding statements is tucked away.
  const linkedCents = extras.filter((a) => a.kind === "payment-proof" && a.transactionId).reduce((sum, a) => sum + Math.abs(state.documents[a.documentId ?? ""]?.statement?.transactions.find((t) => t.id === a.transactionId)?.amountCents ?? 0), 0);
  const orderTotal = state.purchases[purchaseId]?.orderTotalCents;
  const allLinked = linkedCents > 0 && (orderTotal === undefined || linkedCents >= orderTotal * 0.99 - 100);
  const manage = `${chargeAssist(purchaseId)}${adders("additional")}${pick("additional", "Use as proof of payment")}`;
  const manageProof = allLinked ? `<details${assist?.kind === "purchase" && assist.purchaseId === purchaseId ? " open" : ""}><summary>Link another charge or add a statement</summary>${manage}</details>` : manage;
  const proofPart = draft
    ? `<h4>Proof of payment</h4>${saveFirst("proof of payment")}`
    : `<h4>Proof of payment</h4>
    <p class="note">${ro ? "The card or bank statement file the workbook names as proof of payment for this purchase." : "The card or bank statement showing what was paid for this purchase. Link the charge below, and a copy that shows only that charge is what gets sent."}</p>
    ${proofs.length ? `<ul class="queue">${listOf(proofs)}</ul>` : `<p class="warn">No proof of payment yet.</p>`}
    ${ro ? "" : manageProof}`;
  const extraPart = draft
    ? `<h4>Additional documentation</h4>${saveFirst("more documentation")}`
    : `<h4>Additional documentation</h4>
    <p class="note">Anything else that backs this purchase up and is neither the receipt nor the proof of payment: an email, a letter.${ro ? "" : " It is optional, and you can add several."}</p>
    ${others.length ? `<ul class="queue">${listOf(others)}</ul>` : `<p><small>${ro ? "None." : "None yet."}</small></p>`}
    ${ro ? "" : `<p class="note">Remove only unlinks a file from this purchase; it stays in your unattached files.</p>
    ${adders("additional")}${pick("additional", "Add as additional documentation")}`}`;
  // One "Documents" section: the receipt first, then proof of payment, then anything else. (`top` is no longer used.)
  if (part === "top") return "";
  return panel("documents", "Documents", `${receiptPart}${proofPart}${extraPart}`);
}

/**
 * A search box with a list under it that narrows as you type (every word must appear somewhere in the row). Each row
 * leads with `title`, the part that tells options apart, with `detail` smaller beneath. Picking a row puts its `value`
 * in the box. `free` lets any text be kept, for names that are not in the list.
 */
function searchBox(name: string, value: string | undefined, rows: Array<{ value: string; title: string; detail?: string }>, o: { placeholder: string; required?: boolean; empty: string }): string {
  const items = rows.map((r) => `<li role="option" data-value="${esc(r.value)}" data-hay="${esc((r.value + " " + r.title + " " + (r.detail ?? "")).toLowerCase())}"><strong>${esc(r.title)}</strong>${r.detail ? `<small>${esc(r.detail)}</small>` : ""}</li>`);
  return `<span class="combo"><button type="button" class="clear-x" data-clear aria-label="Clear">&times;</button><input name="${esc(name)}"${o.required ? " required" : ""} value="${esc(value)}" autocomplete="off" data-combo placeholder="${esc(o.placeholder)}" role="combobox" aria-expanded="false">
    <ul class="combo-list" role="listbox" hidden>${items.join("")}<li class="combo-empty" hidden>${o.empty}</li></ul></span>`;
}

/** The category chooser: leads each row with the last part of the path, which is what tells categories apart. */
function categoryPicker(value?: string): string {
  const ref = reference();
  if (!ref) return `<input name="categoryId" list="cats" required value="${esc(value)}">`;
  return searchBox("categoryId", value, ref.choices.map((c) => ({ value: c.label, title: c.path[c.path.length - 1] ?? c.label, detail: c.path.slice(0, -1).join(" - ") || undefined })), {
    placeholder: "Search categories…",
    required: true,
    empty: "No category matches. Add it below under &ldquo;Category missing&rdquo;.",
  });
}

/** The stores and businesses already entered on purchases (the receipt's vendor is not tied to a category). */
function storeBox(name: string, value: string | undefined): string {
  const known = new Map<string, string>();
  for (const p of Object.values(ledger.state.purchases)) if (p.vendor?.trim() && !known.has(p.vendor.trim().toLowerCase())) known.set(p.vendor.trim().toLowerCase(), p.vendor.trim());
  const rows = [...known.values()].sort((a, b) => a.localeCompare(b)).map((v) => ({ value: v, title: v, detail: "Used before" }));
  return searchBox(name, value, rows, { placeholder: "Search, or type a name", empty: "No match. What you type is kept as it is." });
}

/** Providers StepUp has offered, by category id (when published). */
let publishedProviders: Record<string, string[]> = {};
const PROVIDER_PROMPT = "Choose a category first: StepUp's list of providers depends on it. You can still type a name.";

/** The category and the levels above it: a provider offered for a parent also applies below it. */
function categoryChain(id: string): string[] {
  const parent = new Map<string, string | undefined>();
  for (const n of referenceBase?.categories ?? []) parent.set(n.id, n.parentId);
  for (const n of Object.values(ledger.state.categories)) if (n.parentId) parent.set(n.id, n.parentId);
  const chain: string[] = [];
  for (let cur: string | undefined = id; cur && !chain.includes(cur); cur = parent.get(cur)) chain.push(cur);
  return chain;
}

/** Providers that fit a category: those StepUp offered for it, and those already used on items filed under it. */
function providersFor(categoryText: string): Array<{ value: string; title: string; detail: string }> {
  const id = reference()?.idForLabel(categoryText);
  if (!id) return [];
  const chain = categoryChain(id);
  const found = new Map<string, { value: string; title: string; detail: string }>();
  const add = (n: string | undefined, detail: string) => {
    const t = n?.trim();
    if (t && !found.has(t.toLowerCase())) found.set(t.toLowerCase(), { value: t, title: t, detail });
  };
  for (const c of chain) for (const n of publishedProviders[c] ?? []) add(n, "Offered by StepUp for this category");
  for (const i of Object.values(ledger.state.items)) if (i.categoryId && chain.includes(i.categoryId)) add(i.serviceProvider ?? i.vendor, "Used before in this category");
  return [...found.values()].sort((a, b) => a.title.localeCompare(b.title));
}

/** The "Who did you pay?" box: empty until a category is chosen, then it lists that category's providers. */
function providerBox(value: string | undefined, categoryText?: string): string {
  return searchBox("serviceProvider", value, categoryText ? providersFor(categoryText) : [], { placeholder: "Search, or type a name", empty: categoryText ? "No known provider for this category yet. What you type is kept as it is." : PROVIDER_PROMPT });
}

/** The category changed: refill the provider list, and drop a provider that was picked from the old category's list. */
function categoryChanged(input: HTMLInputElement): void {
  const form = input.form;
  // The Service date only exists on StepUp's form for categories that need one.
  const dateLabel = form?.querySelector<HTMLElement>("[data-service-date]");
  const ref = reference();
  if (dateLabel && ref) {
    const id = ref.idForLabel(input.value);
    dateLabel.hidden = !(id && ref.category(id)?.requiresServiceDate);
  }
  const provider = form?.elements.namedItem("serviceProvider") as HTMLInputElement | null;
  if (!provider || provider.dataset["combo"] === undefined) return;
  const rows = providersFor(input.value);
  const list = provider.nextElementSibling as HTMLUListElement;
  list.querySelectorAll("li[data-value]").forEach((li) => li.remove());
  const empty = list.querySelector<HTMLElement>(".combo-empty")!;
  for (const r of rows) {
    const li = document.createElement("li");
    li.setAttribute("role", "option");
    li.dataset["value"] = r.value;
    li.dataset["hay"] = `${r.value} ${r.detail}`.toLowerCase();
    li.innerHTML = `<strong>${esc(r.title)}</strong><small>${esc(r.detail)}</small>`;
    list.insertBefore(li, empty);
  }
  empty.textContent = reference()?.idForLabel(input.value) ? "No known provider for this category yet. What you type is kept as it is." : PROVIDER_PROMPT;
  // StepUp resets the provider when the category changes; a name picked from the old list does not carry over.
  if (provider.dataset["picked"] === "1" && provider.value && !rows.some((r) => r.value.toLowerCase() === provider.value.toLowerCase())) {
    provider.value = "";
    provider.dataset["picked"] = "";
  }
}

/** Shows the rows matching what was typed; returns how many. */
function filterCombo(input: HTMLInputElement): void {
  const list = input.nextElementSibling as HTMLUListElement;
  const words = input.value.toLowerCase().split(/\s+/).filter(Boolean);
  let shown = 0;
  list.querySelectorAll<HTMLLIElement>("li[data-hay]").forEach((li) => {
    const hit = words.every((w) => li.dataset["hay"]!.includes(w));
    li.hidden = !hit;
    li.classList.remove("active");
    if (hit) shown++;
  });
  list.querySelector<HTMLElement>(".combo-empty")!.hidden = shown > 0;
  list.hidden = false;
  input.setAttribute("aria-expanded", "true");
}

function closeCombo(input: HTMLInputElement): void {
  (input.nextElementSibling as HTMLElement).hidden = true;
  input.setAttribute("aria-expanded", "false");
}

/** The purchases list narrows and re-sorts in place, so typing never loses its focus to a re-render. */
let legacyFilter = { search: "", status: "", child: "", vendor: "", sort: "" };
/** Every option a filter dropdown was drawn with, so ones taken out for showing nothing can come back. */
const allOptions = new WeakMap<HTMLSelectElement, HTMLOptionElement[]>();

/** `restore` puts the remembered filters and sort back into freshly drawn controls (coming back to the list); otherwise the controls are the source and are remembered. */
function filterLegacyList(restore = false): void {
  const controls = {
    search: root.querySelector<HTMLInputElement>("#legacy-search"),
    status: root.querySelector<HTMLSelectElement>("#legacy-status"),
    child: root.querySelector<HTMLSelectElement>("#legacy-child"),
    vendor: root.querySelector<HTMLSelectElement>("#legacy-vendor"),
    sort: root.querySelector<HTMLSelectElement>("#legacy-sort"),
  };
  for (const k of Object.keys(controls) as Array<keyof typeof controls>) {
    const c = controls[k];
    if (!c) continue;
    if (restore) c.value = legacyFilter[k];
    legacyFilter[k] = c.value;
  }
  const q = legacyFilter.search.toLowerCase().split(/\s+/).filter(Boolean);
  const { status, child, vendor, sort } = legacyFilter;
  const list = root.querySelector<HTMLElement>("#legacy-list");
  if (!list) return;
  const rows = [...list.querySelectorAll<HTMLElement>(":scope > li[data-text]")];
  /** Whether a row passes every filter, with `over` standing in for the current choices (used to count what each option would show). */
  const passes = (li: HTMLElement, over: Partial<typeof legacyFilter> = {}): boolean => {
    const d = li.dataset;
    const f = { status, child, vendor, ...over };
    const has = f.status === UNCLEAR_FILTER ? d["unclear"] !== undefined : (d["statuses"] ?? "").split("|").includes(f.status);
    const behind = getDrill()?.ids;
    if (behind && !(d["items"] ?? "").split("|").some((id) => behind.has(id))) return false;
    return q.every((w) => (d["text"] ?? "").includes(w)) && (!f.status || has) && (!f.child || (d["children"] ?? "").split("|").includes(f.child)) && (!f.vendor || d["vendor"] === f.vendor);
  };
  let shown = 0;
  for (const li of rows) {
    const ok = passes(li);
    li.hidden = !ok;
    if (ok) shown++;
  }
  // Each option says how many purchases it would show given the search and the other dropdowns, so combined filters stay honest.
  for (const k of ["status", "child", "vendor"] as const) {
    const sel = controls[k];
    if (!sel) continue;
    // Options are taken out of the dropdown (not just hidden, which Safari ignores) when they would show nothing, and put back when they would show something again.
    const all = (allOptions.get(sel) ?? [...sel.options]);
    allOptions.set(sel, all);
    const keep: HTMLOptionElement[] = [];
    for (const o of all) {
      o.dataset["label"] ??= o.textContent ?? "";
      const label = (o.dataset["label"] ?? "").replace(/ \(\d+\)$/, "");
      if (o.value === "") { keep.push(o); continue; }
      const n = rows.filter((li) => passes(li, { [k]: o.value })).length;
      o.textContent = `${label} (${n})`;
      if (n > 0 || o.value === legacyFilter[k]) keep.push(o);
    }
    const value = sel.value;
    sel.replaceChildren(...keep);
    sel.value = value;
  }
  // A control that is narrowing the list is tinted, so it is clear why some purchases are missing.
  for (const k of ["search", "status", "child", "vendor"] as const) controls[k]?.classList.toggle("filtering", legacyFilter[k].trim() !== "");
  // Students with nothing in the displayed purchases are struck out in the note above the list.
  const withItems = new Set(rows.filter((li) => !li.hidden).flatMap((li) => (li.dataset["children"] ?? "").split("|")));
  for (const el of root.querySelectorAll<HTMLElement>(".student[data-student]")) {
    const none = !withItems.has(el.dataset["student"] ?? "");
    el.classList.toggle("none", none);
    if (none) el.title = "No displayed purchases"; else el.removeAttribute("title");
  }
  const num = (li: HTMLElement, k: string) => Number(li.dataset[k] ?? 0);
  const str = (li: HTMLElement, k: string) => li.dataset[k] ?? "";
  const byOrder = (a: HTMLElement, b: HTMLElement) => num(a, "order") - num(b, "order");
  const compare: Record<string, (a: HTMLElement, b: HTMLElement) => number> = {
    "": byOrder,
    oldest: (a, b) => str(a, "date").localeCompare(str(b, "date")) || byOrder(a, b),
    name: (a, b) => str(a, "name").localeCompare(str(b, "name")) || byOrder(a, b),
    vendor: (a, b) => (!str(a, "vendor") !== !str(b, "vendor") ? (str(a, "vendor") ? -1 : 1) : str(a, "vendor").localeCompare(str(b, "vendor"))) || byOrder(a, b),
    high: (a, b) => num(b, "total") - num(a, "total") || byOrder(a, b),
    low: (a, b) => num(a, "total") - num(b, "total") || byOrder(a, b),
  };
  for (const li of [...rows].sort(compare[sort] ?? byOrder)) list.appendChild(li);
  const count = root.querySelector<HTMLElement>("#legacy-count");
  if (count) {
    const total = Number(count.dataset["total"] ?? rows.length);
    count.textContent = shown === total ? String(total) : `${shown} of ${total}`;
  }
}

root.addEventListener("input", (ev) => {
  const t = ev.target as HTMLInputElement;
  if (t.id === "legacy-search") return filterLegacyList();
  if (t.id === "history-search") {
    historyUi.search = t.value;
    historyUi.limit = 200;
    const box = root.querySelector<HTMLElement>("#history-list");
    if (box) box.innerHTML = historyList();
    return;
  }
  if (t.dataset?.["combo"] !== undefined) {
    if (t.name === "categoryId") categoryChanged(t);
    else if (t.name === "serviceProvider") t.dataset["picked"] = "";
    filterCombo(t);
  }
});

/** Saves whichever form this field belongs to: the purchase details or the item being worked on. */
function autosaveFor(field: HTMLElement, nextName?: string): void {
  const form = (field as HTMLInputElement).form;
  if (form?.id === "purchase-form") void autosavePurchase(form, nextName);
  else if (form?.id === "item-form") void autosaveItem(form, nextName);
}

// Leaving a field saves it; a date picked on a phone may never blur, so a change does too.
let listTouch = false; // a finger is on a suggestion list (scrolling it), so the box losing focus must not close it
root.addEventListener("focusout", (ev) => {
  const t = ev.target as HTMLInputElement;
  if (t.dataset?.["combo"] !== undefined && !listTouch) closeCombo(t);
  if (!["INPUT", "SELECT"].includes(t.tagName) || !t.form) return;
  const next = (ev as FocusEvent).relatedTarget as HTMLInputElement | null;
  autosaveFor(t, next && next.form === t.form ? next.name : undefined);
});
root.addEventListener("change", (ev) => {
  const t = ev.target as HTMLInputElement;
  const pivotControl = t.dataset?.["pivot"];
  if (pivotControl !== undefined && setPivot(pivotControl, t.value)) return render();
  const assistControl = t.dataset?.["assist"];
  if (assistControl !== undefined) {
    if (assistControl === "noProof") assistView.noProof = t.checked;
    else if (assistControl === "sort") assistView.sort = (["best", "date", "amount"].includes(t.value) ? t.value : "best") as AssistSort;
    else if (assistControl === "card" || assistControl === "child" || assistControl === "vendor" || assistControl === "method") assistView[assistControl] = t.value;
    return render();
  }
  if (t.type === "date" || t.tagName === "SELECT" || t.name === "includeTax") autosaveFor(t);
});
root.addEventListener("focusin", (ev) => {
  const t = ev.target as HTMLInputElement;
  if (t.dataset?.["combo"] !== undefined) filterCombo(t);
});

/** Puts a suggestion in its box and saves. */
function pickRow(li: HTMLElement): void {
  const input = li.closest(".combo")!.querySelector<HTMLInputElement>("input")!;
  input.value = li.dataset["value"]!;
  input.dataset["picked"] = "1";
  closeCombo(input);
  if (input.name === "categoryId") categoryChanged(input);
  autosaveFor(input);
}

// A mouse keeps the box focused while it picks. A finger must not: pressing on the list is how it scrolls, so nothing is
// picked until the tap is finished (the click), and the list stays open while it is being touched.
root.addEventListener("pointerdown", (ev) => {
  if (!(ev.target as HTMLElement).closest(".combo-list")) return;
  if (ev.pointerType === "mouse") ev.preventDefault();
  else listTouch = true;
});
document.addEventListener("pointerdown", (ev) => {
  if ((ev.target as HTMLElement).closest(".combo")) return;
  listTouch = false;
  root.querySelectorAll<HTMLInputElement>("input[data-combo]").forEach(closeCombo);
});
root.addEventListener("click", (ev) => {
  const li = (ev.target as HTMLElement).closest<HTMLLIElement>(".combo-list li[data-value]");
  if (!li) return;
  // The box sits inside a <label>, whose first labelable child is the clear "x": left alone, the label would click it and empty what was just picked.
  ev.preventDefault();
  listTouch = false;
  pickRow(li);
});
root.addEventListener("keydown", (ev) => {
  const input = ev.target as HTMLInputElement;
  if (input.dataset?.["combo"] === undefined) return;
  const list = input.nextElementSibling as HTMLUListElement;
  const visible = [...list.querySelectorAll<HTMLLIElement>("li[data-hay]")].filter((li) => !li.hidden);
  const at = visible.findIndex((li) => li.classList.contains("active"));
  if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
    ev.preventDefault();
    if (list.hidden) filterCombo(input);
    const next = visible[(at + (ev.key === "ArrowDown" ? 1 : -1) + visible.length) % visible.length];
    visible.forEach((li) => li.classList.remove("active"));
    next?.classList.add("active");
    next?.scrollIntoView({ block: "nearest" });
  } else if (ev.key === "Enter" && !list.hidden && at >= 0) {
    ev.preventDefault();
    pickRow(visible[at]!);
  } else if (ev.key === "Escape") closeCombo(input);
});

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
      ${storage.kind === "browser" ? "" : `<p><button id="pick-again">Choose a different folder</button></p>`}`;
  }
  const open = (list: FolderEntry[]) => list.map((f, i) => `<li><button data-pick="${i}">&#128193; ${esc(f.name)}</button></li>`).join("") || "<li><small>No folders here.</small></li>";
  if (picker.path.length === 0) {
    const google = storage.kind === "google";
    const mine = google ? "My Drive" : "My OneDrive";
    return `<h2>Welcome</h2><div class="choices">
      <section class="card"><h3>Set up a new workspace</h3>
        <p class="note">Pick (or create) a folder in your own ${esc(storage.label)} to hold your school-year folders.</p>
        <p><button data-pick-mine="1">&#128193; Choose a folder in ${mine}</button></p></section>
      <section class="card"><h3>Join a shared workspace</h3>
        <p class="note">${google
          ? "If someone invited you to their folder, you will find it below under <strong>Shared with you</strong>. You can also paste the folder's sharing link here."
          : `If someone invited you to their folder, open the invitation, then in OneDrive choose <strong>Add shortcut to My files</strong> on it. After that, pick it from My OneDrive, or paste the folder's sharing link here.`}</p>
        <form id="pick-link" class="row"><input name="link" placeholder="${esc(storage.label)} sharing link" required><button>Join with this link</button></form>
        ${picker.shared.length ? `<h4>Shared with you</h4><ul class="queue">${picker.shared.map((f, i) => `<li><button data-pick-shared="${i}">&#128193; ${esc(f.name)}</button></li>`).join("")}</ul>` : ""}</section>
    </div>`;
  }
  const here = picker.path[picker.path.length - 1]!;
  return `<h2>Choose the folder to use</h2>
    <p>${picker.path.map((f) => esc(f.name)).join(" / ")}</p>
    <p class="row"><button id="pick-up">&larr; Up</button></p>
    <form id="new-folder" class="row"><input name="name" placeholder="New folder name" required><button class="secondary">Create folder in ${esc(here.name)}</button></form>
    <ul class="queue">${open(picker.list)}</ul>
    <p class="pick-bottom"><button id="pick-use" class="primary big">Use this folder</button></p>`;
}

/** For storage with no folders to browse (this device), the workspace is simply its top level. */
async function homePointer(): Promise<Pointer> {
  const home = await storage.home();
  return { driveId: home.driveId, rootId: home.itemId };
}

/**
 * Local-only mode used to keep its changes in this browser's localStorage, with no files. Once a year exists in this
 * device's storage those changes are moved into it (the originals are kept under another key as a backup).
 */
const OLD_EVENTS_KEY = "stepup.events.v1";
async function adoptOldLocalEvents(ws: OpenWorkspace): Promise<void> {
  if (storage.kind !== "browser" || ws.legacy || ws.fromCache) return;
  let old: LedgerEvent[];
  try {
    old = await new LocalEventStore(store.clientId).readAll();
  } catch {
    return;
  }
  if (old.length === 0) return;
  await ws.store.appendOwn(old);
  await ws.ledger.refresh();
  try {
    localStorage.setItem(`${OLD_EVENTS_KEY}.moved`, localStorage.getItem(OLD_EVENTS_KEY) ?? "");
    localStorage.removeItem(OLD_EVENTS_KEY);
  } catch {
    /* the copy is harmless: event ids make a second move a no-op */
  }
  status = `Moved ${old.length} change(s) from this browser's earlier local mode into ${ws.year.label}.`;
  render();
}

async function pickerTop(): Promise<void> {
  pendingYear = undefined;
  const [mine, shared] = await Promise.all([storage.home(), storage.sharedWithMe().catch(() => [] as FolderEntry[])]);
  picker = { path: [], mine, shared, list: [] };
}

async function pickerOpen(path: FolderEntry[]): Promise<void> {
  picker = { ...picker, path, list: path.length ? await storage.subfolders(path[path.length - 1]!) : [] };
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

/** Set when a newer copy of the app has taken over in the background; the banner offers a reload. */
let updateReady = false;

let authReady = false;

/** On every screen, including the one before anyone has chosen where their data lives. */
const footer = (): string => `<footer class="site-footer"><a href="./privacy.html">Privacy policy</a> &middot; <a href="./terms.html">Terms of use</a></footer>`;

/** Shown instead of the whole app until the person says where their data lives. */
function chooserView(): string {
  return `<main class="gate"><section class="card gate-card">
    <img src="./icon.svg" alt="" class="logo">
    <h1>Step Up Helper</h1>
    <p class="note">Where should your data be stored?</p>
    <div class="gate-choices">
      <button id="sign-in" class="primary big">Sign in with Microsoft<small>Stored in your OneDrive</small></button>
      ${googleConfigured ? `<button id="sign-in-google" class="big">Sign in with Google<small>Stored in your Google Drive</small></button>` : ""}
      <button id="use-local" class="big">Local only<small>Stays in this browser; no account</small></button>
    </div>
  </section></main>${footer()}`;
}

/**
 * While a file picker is open the page must not be redrawn: a redraw replaces the <input>, and the chosen files are then
 * reported to an element that is no longer on the page, so choosing files looks exactly like pressing Cancel. On iOS
 * the picker can stay open a while (files are fetched from iCloud), long enough for a background refresh, a
 * connection change or an app update to redraw the page. Redraws wait; anything the person presses ends the wait, so
 * the page can never stay frozen.
 */
let filePickerOpen = false;
let renderDeferred = false;
let filePickerTimer: ReturnType<typeof setTimeout> | undefined;
function filePickerClosed(): void {
  filePickerOpen = false;
  clearTimeout(filePickerTimer);
  setTimeout(() => {
    if (renderDeferred && !filePickerOpen) {
      renderDeferred = false;
      render();
    }
  }, 0);
}
const isFileInput = (el: EventTarget | null): boolean => el instanceof HTMLInputElement && el.type === "file";
root.addEventListener("click", (ev) => {
  if (isFileInput(ev.target)) {
    filePickerOpen = true;
    clearTimeout(filePickerTimer);
    filePickerTimer = setTimeout(filePickerClosed, 2 * 60_000);
  } else if (filePickerOpen) filePickerClosed();
}, true);
root.addEventListener("change", (ev) => { if (isFileInput(ev.target)) filePickerClosed(); }, true);
root.addEventListener("cancel", (ev) => { if (isFileInput(ev.target)) filePickerClosed(); }, true);

let previewShown = false;
let scrollBeforePreview: number | undefined;

/** Scroll adjustments that need the new page in place: back from a preview, or back to where a refresh left off. */
function afterRender(scrollBack: number | undefined): void {
  if (scrollBack !== undefined) {
    window.scrollTo({ top: scrollBack });
  } else if (restoreScroll !== undefined && workspace) {
    window.scrollTo({ top: restoreScroll });
    restoreScroll = undefined;
  }
}

function render(): void {
  if (filePickerOpen) {
    renderDeferred = true;
    return;
  }
  if (!account) {
    root.innerHTML = authReady ? chooserView() : "";
    return;
  }
  const onboarding = account && !workspace;
  // Closing a preview puts the page back where it was when the preview was opened, instead of leaving it at the top.
  const showingPreview = Boolean(preview || redactionDraft);
  if (showingPreview && !previewShown) scrollBeforePreview = window.scrollY;
  const scrollBack = !showingPreview && previewShown ? scrollBeforePreview : undefined;
  previewShown = showingPreview;
  const l = workspace?.legacy;
  if (l) {
    // A year Excel still owns: the ledger's own screens, read-only (see enforceReadOnly).
    const page = view.name === "summary" ? summaryView() : view.name === "history" ? historyView() : view.name === "statements" ? statementsView() : view.name === "statement" ? statementReview(view.id) : view.name === "purchase" ? purchaseView(view.id) : queueView();
    root.innerHTML = header() + tabs() + legacyBanner(workspace!) + previewPanel() + page + footer();
    enforceReadOnly(root);
    filterLegacyList(true);
    afterRender(scrollBack);
    return;
  }
  const body = onboarding ? onboardingView() : view.name === "queue" ? queueView() : view.name === "summary" ? summaryView() : view.name === "history" ? historyView() : view.name === "statements" ? statementsView() : view.name === "statement" ? statementReview(view.id) : purchaseView(view.id, view.draft);
  root.innerHTML = header() + (onboarding ? "" : tabs()) + scanPanel() + redactionPanel() + previewPanel() + body + footer();
  filterLegacyList(true);
  scheduleClaimPoll();
  afterRender(scrollBack);
  if (scrollToMark) {
    scrollToMark = false;
    requestAnimationFrame(() => root.querySelector(".preview .hl")?.scrollIntoView({ block: "center", behavior: "smooth" }));
  }
}

// Each screen is a history entry, so the phone's swipe-back / back button returns to the previous screen instead of leaving the app.
function remember(push: boolean, from?: View): void {
  try {
    // Leaving a screen keeps how far it was scrolled, so coming back drops you where you were.
    if (push && from) history.replaceState({ view: from, scroll: window.scrollY }, "");
    if (push) history.pushState({ view }, "");
    else history.replaceState({ view, scroll: (history.state as { scroll?: number } | null)?.scroll }, "");
  } catch { /* history unavailable: back simply leaves the app */ }
}
remember(false);
let scrollSaver: ReturnType<typeof setTimeout> | undefined;
window.addEventListener("scroll", () => {
  if (restoreScroll !== undefined) return; // still waiting to go back to where the refresh left off
  if (scrollSaver) clearTimeout(scrollSaver);
  scrollSaver = setTimeout(() => {
    try {
      history.replaceState({ view, scroll: window.scrollY }, "");
    } catch { /* history unavailable or rate limited: a refresh just opens at the top */ }
  }, 250);
}, { passive: true });
window.addEventListener("popstate", (ev) => {
  const saved = ev.state as { view?: View; scroll?: number } | null;
  const back = saved?.view;
  restoreScroll = undefined;
  view = back && typeof back.name === "string" ? back : { name: "queue" };
  replacingReceipt = undefined;
  itemEdit = undefined;
  clearPreview();
  status = "";
  render();
  window.scrollTo({ top: saved?.scroll ?? 0 });
});

function go(next: View): void {
  restoreScroll = undefined;
  if (next.name === "history") historyUi.year = undefined; // each visit looks for anything new
  const from = view;
  view = next;
  remember(true, from);
  replacingReceipt = undefined;
  itemEdit = undefined;
  status = ""; // a notice belongs to the screen it was shown on
  render();
  // A new page opens at its top, not wherever the previous one was scrolled to.
  window.scrollTo({ top: 0 });
}

root.addEventListener("click", async (ev) => {
  const t = (ev.target as HTMLElement).closest<HTMLElement>("button, a");
  if (!t) return;
  if (!t.closest(".menu")) root.querySelector<HTMLDetailsElement>("details.menu")?.removeAttribute("open");
  const d = t.dataset;
  if (d["clear"] !== undefined) {
    // The little x in a search field: empty it, tell the filters, and keep the keyboard up for the next search.
    const input = t.parentElement?.querySelector<HTMLInputElement>("input");
    if (input) {
      input.value = "";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.focus();
    }
    return;
  }
  if (workspace?.legacy) {
    // A year viewed from Excel: only looking around, picking a receipt, and the connection controls do anything.
    const legacy = workspace;
    if (t.id === "legacy-refresh") await guarded(async () => { await revalidate(legacy); persist(); status = legacy.legacy?.workbook ? "Read the workbook again." : "Read StepUp's list again."; }, legacy.legacy?.workbook ? "Reading the Excel workbook…" : "Reading StepUp's list…");
    else if (t.id === "legacy-download") {
      await guarded(async () => {
        const file = await legacySpreadsheet(legacy);
        const url = URL.createObjectURL(new Blob([file.bytes as BlobPart], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
        Object.assign(document.createElement("a"), { href: url, download: file.name }).click();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
      }, "Building the spreadsheet…");
    } else if (d["legacyPick"] || d["legacyClear"]) {
      const id = d["legacyPick"] ?? d["legacyClear"]!;
      const un = legacy.legacy!.year.unclear.find((u) => u.purchaseId === id);
      const picked = legacy.legacy!.year.result.report.ambiguousReceipts.find((a) => a.resolvedFromCache && legacy.legacy!.ledger.state.items[a.itemId]?.purchaseId === id);
      const candidates = un?.candidates ?? picked?.candidates;
      if (candidates) await guarded(async () => { const now = await chooseReceipt(legacy, candidates, d["legacyPick"] ? candidates[Number(d["fileIndex"])] : undefined, id); if (now && view.name === "purchase") view = { name: "purchase", id: now }; persist(); }, "Saving your answer…");
    } else if (d["go"] || d["historyMore"] !== undefined || d["pivotReset"] !== undefined || d["drillClear"] !== undefined || d["pcell"] !== undefined || d["open"] || d["preview"] || d["statement"] || t.id === "close-preview" || t.id === "dismiss-status" || t.id === "sign-out" || t.id === "disconnect" || t.id === "share" || t.id === "new-year" || t.id === "reload-app" || t.id === "toggle-detail" || t.id === "stepup-apply" || t.id === "stepup-ignore" || t.id === "show-bookmarklet" || t.id === "close-bookmarklet" || t.id === "copy-bookmarklet") {
      // fall through to the shared handlers below
    } else return;
    if (t.id === "legacy-refresh" || t.id === "legacy-download" || d["legacyPick"] || d["legacyClear"]) return;
  }
  if (d["historyMore"] !== undefined) { historyUi.limit += 200; render(); return; }
  if (d["pivotReset"] !== undefined) { resetPivots(); render(); return; }
  if (d["drillClear"] !== undefined) { clearDrill(); render(); return; }
  if (d["pcell"] !== undefined) {
    // A pivot cell: the purchase list, narrowed to the items that make the cell up.
    drillInto((workspace?.legacy?.ledger.state ?? ledger.state), ctx(), Number(d["pcell"]), d["prow"], d["pcol"]);
    // The dropdowns take on the cell's student / vendor / status where the pivot has one; a value the list has no option for falls back to "All".
    legacyFilter = { search: "", status: "", child: "", vendor: "", sort: "", ...getDrill()?.filters };
    go({ name: "queue" });
    root.querySelector(".drill")?.scrollIntoView({ block: "start" });
    return;
  }
  if (d["go"]) { ev.preventDefault(); go(d["go"] === "summary" ? { name: "summary" } : d["go"] === "history" ? { name: "history" } : d["go"] === "statements" ? { name: "statements" } : { name: "queue" }); }
  else if (d["pick"] !== undefined || d["pickMine"] || d["pickShared"] !== undefined) {
    const next = d["pickMine"] ? picker.mine : d["pickShared"] !== undefined ? picker.shared[Number(d["pickShared"])] : picker.list[Number(d["pick"])];
    if (next) await guarded(() => pickerOpen([...(d["pickMine"] || d["pickShared"] !== undefined ? [] : picker.path), next]), "Opening the folder…");
  }
  else if (t.id === "pick-up") await guarded(() => (picker.path.length <= 1 ? pickerTop() : pickerOpen(picker.path.slice(0, -1))), "Opening the folder…");
  else if (t.id === "pick-use") await guarded(() => useFolder(picker.path[picker.path.length - 1]!), "Opening your workspace…");
  else if (t.id === "reload-app") location.reload();
  else if (t.id === "use-local") switchStorage("local");
  else if (t.id === "pick-again") await guarded(pickerTop);
  else if (t.id === "sign-in") {
    // Microsoft is the default storage: forget any other choice, then go to Microsoft (the page leaves).
    rememberStorage(undefined);
    note("Redirecting to Microsoft to sign in…");
    showBusy("Redirecting to Microsoft to sign in…");
    await microsoftAuth.signIn();
  }
  else if (t.id === "sign-in-google") {
    // Google signs in in a window opened by this click; once it succeeds the page restarts on Google Drive.
    await guarded(async () => {
      await googleAuth.signIn();
      switchStorage("google");
    }, "Signing in to Google…");
  }
  else if (t.id === "sign-out") {
    // Local storage has no account to leave: this just stops using it. Everything stays on this device for next time.
    if (storage.kind === "browser") { switchStorage(undefined); return; }
    if (ledger.unflushedCount > 0 && !confirm(`${ledger.unflushedCount} change(s) have not been saved to ${storage.label} and will be lost if you sign out. Sign out anyway?`)) return;
    forgetLocalPointer(); await clearCache(); await clearCachedDocuments(); showBusy(`Signing out of ${storage.kind === "google" ? "Google" : "Microsoft"}…`); await storage.auth.signOut();
    // Google signs out without leaving the page; start over so the first screen asks again.
    if (storage.kind === "google") switchStorage(undefined);
  }
  else if (t.id === "disconnect") {
    if (ledger.unflushedCount > 0 && !confirm(`${ledger.unflushedCount} change(s) have not been saved to ${storage.label} and will be lost if you disconnect. Disconnect anyway?`)) return;
    await guarded(async () => {
      forgetCache();
      clearPreviews();
      await clearCachedDocuments();
      await savePointer(undefined);
      workspace = undefined;
      activeStore = store;
      ledger = new Ledger(store, new HlcClock(store.clientId), "web");
      await ledger.refresh();
      await pickerTop();
    }, "Disconnecting…");
  }
  else if (t.id === "share") { sharing = !sharing; render(); }
  else if (t.id === "new-year") { newYearOpen = !newYearOpen; root.querySelector<HTMLDetailsElement>("details.menu")?.removeAttribute("open"); render(); }
  else if (t.id === "check-files" && workspace) {
    await guarded(async () => {
      const ws = workspace!;
      const loose = planIngest(ledger.state, await listLooseFiles(storage, ws.driveId, ws.year.folderId));
      registerLooseFiles(ledger, loose.toRegister);
      // The inbox is where emails saved as .eml, print-to-PDF receipts and phone shares can be dropped.
      const folders = await openLedgerFolders(storage, ws.driveId, ws.year.folderId);
      const inbox = folders ? planIngest(ledger.state, await listLooseFiles(storage, ws.driveId, folders.inboxId)) : { toRegister: [], alreadyKnown: 0 };
      registerLooseFiles(ledger, inbox.toRegister, "inbox");
      const carried = Object.keys(ledger.state.children).length ? undefined : await copyFromPreviousYear(ws, store.clientId);
      await ledger.flush();
      const n = loose.toRegister.length + inbox.toRegister.length;
      status = [
        n ? `Registered ${n} new file(s)${inbox.toRegister.length ? ` (${inbox.toRegister.length} from the inbox folder)` : ""}.` : "No new files.",
        carried?.children ? `Added ${carried.children} child(ren) from the previous year.` : carried?.problems?.length ? `Could not find children to copy: ${carried.problems.join("; ")}.` : "",
      ].filter(Boolean).join(" ");
    }, `Checking ${storage.label} for new files…`);
  }
  else if (t.id === "export") {
    await guarded(async () => {
      await ledger.flush();
      const url = URL.createObjectURL(new Blob([exportJsonl(await activeStore.readAll())], { type: "text/plain" }));
      const a = Object.assign(document.createElement("a"), { href: url, download: "events.jsonl" });
      a.click();
      URL.revokeObjectURL(url);
    }, "Preparing export…");
  } else if (t.id === "dismiss-since") {
    sinceLines = [];
    render();
  } else if (t.id === "update-reference") {
    await guarded(updateYearReference, "Updating the category list…");
    persist();
  } else if (t.id === "refresh-now") {
    if (workspace) await refreshInBackground(workspace);
    render();
  } else if (t.id === "stepup-apply") {
    const list = pendingStepUp;
    pendingStepUp = undefined;
    if (list) await guarded(() => bringInStepUpList(list), "Bringing in StepUp's list…");
  } else if (t.id === "stepup-ignore") {
    pendingStepUp = undefined;
    render();
  } else if (t.id === "show-bookmarklet" || t.id === "close-bookmarklet") {
    bookmarkletOpen = t.id === "show-bookmarklet";
    render();
  } else if (t.id === "copy-bookmarklet") {
    try {
      await navigator.clipboard.writeText(loaderHref(appHome()));
      status = "Copied. Paste it as the address of a new bookmark.";
    } catch {
      status = "Your browser would not let this page copy; drag the link to the bookmarks bar instead.";
    }
    render();
  } else if (t.id === "check-year" || t.id === "check-year-files" || t.id === "check-year-contents") {
    await guarded(() => checkYear(t.id === "check-year" ? "no" : t.id === "check-year-files" ? "sizes" : "contents"), "Checking the year…");
  } else if (t.id === "backup-year" || t.id === "backup-year-docs") {
    const ws = workspace;
    if (!ws || ws.legacy) return;
    const documents = t.id === "backup-year-docs";
    await guarded(async () => {
      const { blob, manifest } = await zipBackup(storage, ws.driveId, ws.year.folderId, ws.year.label, ledger.state, { documents, progress: (done, total, name) => showBusy(`Backing up ${done + 1} of ${total}: ${name}`) });
      saveBlob(blob, backupFileName(ws.year.label, manifest.takenAt, documents));
      status = `Backed up ${manifest.files.length} file(s) from ${ws.year.label}${documents ? "" : " (no documents; use the \"with documents\" option for those)"}.`;
    }, "Backing up…");
  } else if (t.dataset["dismissCheck"] !== undefined) {
    yearCheck = undefined;
    render();
  } else if (t.id === "update-mirror") {
    await guarded(async () => {
      const result = await publishMirrorNow();
      if (storage.kind === "browser" && result !== "locked") {
        await downloadMirror();
        status = "Spreadsheet downloaded.";
        return;
      }
      status = result === "written" ? "Spreadsheet updated." : result === "unchanged" ? "Spreadsheet is already up to date." : "The spreadsheet is open in Excel; close it and try again.";
    }, "Building the spreadsheet…");
  } else if (t.id === "toggle-detail") {
    setDetailedRefresh(!detailedRefresh);
    paintBusy();
    render();
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
  } else if (d["editItem"] && view.name === "purchase") {
    writeItemDraft(view.id, undefined);
    itemEdit = { purchaseId: view.id, itemId: d["editItem"] };
    render();
    root.querySelector<HTMLElement>("#item-form")?.scrollIntoView({ block: "center" });
  } else if (t.id === "add-another" && view.name === "purchase") {
    writeItemDraft(view.id, undefined);
    itemEdit = { purchaseId: view.id };
    render();
    root.querySelector<HTMLElement>('#item-form [name="description"]')?.focus();
  } else if (t.id === "new-child") {
    addingChild = true;
    render();
    root.querySelector<HTMLInputElement>("#add-child input[name=name]")?.focus();
  } else if (t.id === "cancel-child") {
    addingChild = false;
    render();
  } else if (t.id === "copy-children" && workspace) {
    await guarded(async () => {
      const got = await copyFromPreviousYear(workspace!, store.clientId);
      await ledger.flush();
      status = got.children ? `Added ${got.children} child(ren) from the previous year.` : got.problems?.length ? `Could not find children to copy: ${got.problems.join("; ")}.` : "Everyone from the previous year is already here.";
    }, "Copying from the previous year…");
    persist();
  } else if (t.id === "new-purchase") {
    go({ name: "purchase", id: newId("purchase"), draft: true });
  } else if (d["open"]) go({ name: "purchase", id: d["open"] });
  else if (d["start"]) {
    const doc = ledger.state.documents[d["start"]];
    const hints = fileNameHints(doc?.filename ?? "");
    const read = doc?.reading;
    const id = startPurchaseFromDocument(ledger, d["start"], {
      vendor: read?.vendor ?? hints.vendor,
      date: read?.date ?? hints.date,
      ...(read?.invoiceNo ? { invoiceNo: read.invoiceNo } : {}),
      ...(read?.orderTotalCents !== undefined ? { orderTotalCents: read.orderTotalCents } : {}),
      ...(read?.taxShippingTotalCents !== undefined ? { taxShippingTotalCents: read.taxShippingTotalCents } : {}),
    });
    await guarded(() => ledger.flush(), `Saving to ${storage.label}…`);
    go({ name: "purchase", id });
  } else if (d["attach"]) {
    const target: MapTarget = { kind: d["kind"] as "purchase" | "item", id: d["target"]! };
    const result = d["role"] === "receipt" ? attachAsReceipt(ledger, target.id, d["attach"]) : attachAdditional(ledger, target, d["attach"]);
    if (!result.ok) alert(`Could not attach: ${result.reason}`);
    await save();
  } else if (d["replaceReceipt"]) {
    replacingReceipt = d["replaceReceipt"];
    render();
  } else if (d["cancelReplace"]) {
    replacingReceipt = undefined;
    render();
  } else if (d["receiptToExtra"]) {
    moveReceiptToAdditional(ledger, d["receiptToExtra"]);
    status = "Moved the receipt to additional documentation. Add a new receipt below.";
    replacingReceipt = undefined;
    await save();
  } else if (d["unlinkExtra"]) {
    if (confirm("Remove this file from the purchase? The file itself is kept in your unattached files.")) {
      detachAdditional(ledger, { kind: "purchase", id: d["purchase"]! }, d["unlinkExtra"]);
      await save();
    }
  } else if (d["useDoc"]) {
    attachToPurchase(d["purchase"]!, d["useDoc"], d["role"] === "additional" ? "additional" : "receipt");
    await save();
  } else if (d["statement"]) {
    const from = view;
    view = { name: "statement", id: d["statement"] };
    status = "";
    remember(true, from);
    render();
    window.scrollTo({ top: 0 });
    if (!workspace?.legacy && !ledger.state.documents[d["statement"]]?.statement) await guarded(async () => { status = await readStatement(d["statement"]!); }, "Reading the statement…");
  } else if (t.id === "start-scan") {
    const now = new Date();
    const stamp = `${String(now.getMonth() + 1).padStart(2, "0")} ${String(now.getDate()).padStart(2, "0")} ${now.getFullYear()}`;
    scan = { name: `Scan ${stamp}.pdf`, pages: [], ...(d["asStatement"] ? { statement: true } : {}), ...(d["forPurchase"] ? { purchaseId: d["forPurchase"], role: d["role"] === "additional" ? "additional" as const : "receipt" as const } : {}) };
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
        const r = await uploadReceipt(ledger, storage, ws.driveId, ws.year.folderId, { name: a.filename, body, sha256: (await sha256Hex(body)) || undefined });
        if (r.status === "uploaded") added++;
      }
      await ledger.flush();
      status = found.length ? `Saved ${added} attachment(s) from the email as files${added < found.length ? ` (${found.length - added} were already there)` : ""}.` : "That email has no PDF or image attachments.";
    }, "Saving the email's attachments…");
    persist();
  } else if (d["renameFile"]) {
    await guarded(async () => {
      const p = ledger.state.purchases[d["renameFile"]!];
      const doc = p?.receiptDocumentId ? ledger.state.documents[p.receiptDocumentId] : undefined;
      if (!p || !doc?.driveItemId) return;
      const name = readableFileName(doc, p);
      const itemId = await storage.rename(workspace!.driveId, doc.driveItemId, name);
      ledger.set("document", doc.id, { filename: name, ...(itemId !== doc.driveItemId ? { driveItemId: itemId } : {}) }, { label: "document.renamed" });
      await ledger.flush();
      downloaded.delete(doc.id);
      status = `Renamed the file in ${storage.label} to "${name}".`;
    }, "Renaming the file…");
    persist();
  } else if (d["shrink"]) {
    await guarded(() => shrinkReceipt(d["shrink"]!), "Making a smaller copy…");
    persist();
  } else if (d["readReceipt"]) {
    await guarded(async () => { status = await readReceipt(d["readReceipt"]!); }, "Reading the receipt…");
    persist();
  } else if (d["readStatement"]) {
    await guarded(async () => {
      const had = ledger.state.documents[d["readStatement"]!]?.statement?.transactions.some((t) => t.edited);
      if (had && !(await confirmModal("Read again?", "Rows you corrected or added are kept, but charges that were read wrongly will be replaced by the new reading.", "Read again"))) return;
      status = await readStatement(d["readStatement"]!);
    }, "Reading the statement…");
    persist();
  } else if (d["editTxn"]) {
    editingTxn = d["editTxn"];
    render();
    return;
  } else if (d["addTxn"]) {
    editingTxn = "new";
    render();
    return;
  } else if (d["cancelTxn"]) {
    editingTxn = undefined;
    render();
    return;
  } else if (d["removeTxn"]) {
    if (await confirmModal("Remove this row?", "Use this for a line that is not a charge (a page heading read as a transaction). Any link to a purchase is undone.", "Remove")) {
      const doc = d["doc"]!;
      const link = Object.values(ledger.state.additionalDocs).find((a) => a.documentId === doc && a.transactionId === d["removeTxn"] && a.ownerId);
      if (link?.ownerId) unlinkTransaction(ledger, link.ownerId, doc, d["removeTxn"]!);
      removeTransaction(ledger, doc, d["removeTxn"]!);
      await save();
    }
    return;
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
  } else if (d["assistTxn"]) {
    resetAssistView();
    assist = { kind: "txn", docId: d["doc"]!, txnId: d["assistTxn"] };
    render();
    return;
  } else if (d["assistPurchase"]) {
    resetAssistView();
    assist = { kind: "purchase", purchaseId: d["assistPurchase"] };
    render();
    return;
  } else if (d["assistClose"]) {
    assist = undefined;
    render();
    return;
  } else if (d["link"]) {
    if (assist?.kind === "txn") assist = undefined;
    linkTransaction(ledger, d["link"], d["doc"]!, d["txn"]!, "manual");
    const txn = ledger.state.documents[d["doc"]!]?.statement?.transactions.find((x) => x.id === d["txn"]);
    if (txn && learnAlias(ledger, txn.descriptor, ledger.state.purchases[d["link"]]?.vendor)) status = "Linked. Next time this name will match by itself.";
    await save();
  } else if (d["unlink"]) {
    unlinkTransaction(ledger, d["unlink"], d["doc"]!, d["txn"]!);
    await save();
  } else if (d["archiveDoc"]) {
    const linkedCount = Number(d["linked"] ?? 0);
    const name = ledger.state.documents[d["archiveDoc"]]?.filename ?? "this file";
    const message = linkedCount
      ? `${linkedCount} charge(s) on ${name} are linked as proof for purchases. The links stay, and you can restore the file later.`
      : `${name} will be hidden and moved to the "${ARCHIVE_FOLDER}" folder. It is not deleted; you can restore it later.`;
    if (await confirmModal("Archive this file?", message, "Archive")) {
      await setArchived(d["archiveDoc"], true);
      if (view.name === "statement" && view.id === d["archiveDoc"] && ledger.state.documents[d["archiveDoc"]]?.archived) {
        // Archived from its own screen: go back to the list, which no longer shows it, and keep the notice.
        const notice = status;
        go({ name: "statements" });
        status = notice;
        render();
      }
    }
  } else if (d["unarchiveDoc"]) {
    await setArchived(d["unarchiveDoc"], false);
  } else if (d["markStatement"]) {
    ledger.set("document", d["markStatement"], { contentKind: "statement" }, { label: "document.markedStatement" });
    await ledger.flush();
    await guarded(async () => { status = (await autoReadStatements([d["markStatement"]!])).join(" "); }, "Reading the proof of payment…");
    await save();
  } else if (d["previewProof"]) {
    await guarded(() => openProofPreview(d["previewProof"]!, d["purchase"]!), "Finding the charge on the statement…");
    window.scrollTo({ top: 0 });
  } else if (d["redactView"]) {
    await guarded(async () => {
      clearPreview();
      await makeRedaction(d["redactView"]!, { pages: "matched", purchaseId: d["purchase"]!, viewOnly: true });
    }, "Making the redacted view…");
    window.scrollTo({ top: 0 });
  } else if (d["preview"]) {
    await guarded(() => openPreview(d["preview"]!), "Downloading the receipt…");
    window.scrollTo({ top: 0 });
  } else if (t.id === "dismiss-status") {
    status = "";
    render();
  } else if (t.id === "close-preview") {
    clearPreview();
    render();
  } else if (d["archive"]) {
    if (await confirmModal("Archive this purchase?", "It and its items are hidden from the list, plan and budget. You can restore it later.", "Archive")) {
      setPurchaseArchived(ledger, d["archive"]);
      view = { name: "queue" };
      remember(false);
      await save();
    }
  } else if (d["unarchive"]) {
    setPurchaseArchived(ledger, d["unarchive"], false);
    await save();
  } else if (d["ready"] || d["unready"]) {
    setReadyToSubmit(ledger, (d["ready"] ?? d["unready"])!, Boolean(d["ready"]));
    await save();
  } else if (d["dup"]) {
    duplicateItem(ledger, d["dup"]);
    await save();
  }
});

root.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const form = ev.target as HTMLFormElement;
  if (workspace?.legacy && !["share-form", "new-year-form", "start-year"].includes(form.id)) return;
  if (form.id === "purchase-form") {
    await autosavePurchase(form); // Enter in a field saves like leaving it does
    return;
  }
  if (form.id === "item-form") {
    await autosaveItem(form);
    return;
  }
  if (form.id === "pick-link") {
    await guarded(async () => useFolder(await storage.folderFromLink!(val(form, "link"))), "Opening the shared link…");
    return;
  }
  if (form.id === "new-folder") {
    await guarded(async () => {
      const made = await createSubfolder(storage, picker.path[picker.path.length - 1]!, val(form, "name"));
      await pickerOpen(picker.path);
      status = `Created "${made.name}".`;
    }, "Creating the folder…");
    return;
  }
  if (form.id === "share-form" && workspace) {
    await guarded(async () => {
      const email = val(form, "email");
      const folder = await workspaceFolder(workspace!.pointer);
      await storage.invite!(folder, email, storage.kind === "google"
        ? `Sharing our Step Up Helper folder. Open ${location.origin}/, sign in with Google and pick it under Shared with you.`
        : `Sharing our Step Up Helper folder. Open it in OneDrive and choose "Add shortcut to My files", then go to ${location.origin}/, sign in and pick it from My OneDrive.`);
      status = `Invited ${email}. If they do not get an email, share the folder with them in ${storage.label} instead.`;
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
      let readNotes: string[] = [];
      const result = await uploadOrQueue({ name, blob: body, sha256: (await sha256Hex(body)) || undefined });
      if (draft.purchaseId && result.documentId && result.status !== "queued") {
        attachToPurchase(draft.purchaseId, result.documentId, draft.role);
        await ledger.flush();
      }
      if (draft.statement && result.status === "uploaded" && result.documentId) {
        ledger.set("document", result.documentId, { contentKind: "statement" }, { label: "document.markedStatement" });
        await ledger.flush();
        readNotes = await autoReadStatements([result.documentId]);
      }
      status = readNotes.join(" ") + " " + (result.status === "uploaded" ? `Saved "${result.name}" (${draft.pages.length} page(s))${draft.purchaseId ? " on this purchase" : draft.statement ? " as proof of payment" : " to your unattached files"}.` : result.status === "queued" ? `Saved "${result.name}" on this device; it will upload when you are back online.` : `That scan was already added as "${result.name}".`);
      status = status.trim();
      discardScan();
      persist();
    }, "Building the PDF…");
    return;
  }
  if (form.id === "rename-statement-form" && workspace) {
    const doc = ledger.state.documents[form.dataset["doc"]!];
    const old = doc?.filename ?? "";
    const ext = /\.[^.]+$/.exec(old)?.[0] ?? "";
    const base = val(form, "name").replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().replace(/\.[^.]+$/, (m) => (m.toLowerCase() === ext.toLowerCase() ? "" : m));
    const name = base + ext;
    if (!doc?.driveItemId || !base || name === old) return;
    await guarded(async () => {
      const itemId = await storage.rename(workspace!.driveId, doc.driveItemId!, name);
      ledger.set("document", doc.id, { filename: name, ...(itemId !== doc.driveItemId ? { driveItemId: itemId } : {}) }, { label: "document.renamed" });
      await ledger.flush();
      downloaded.delete(doc.id);
      status = `Renamed the file in ${storage.label} to "${name}".`;
    }, "Renaming the file…");
    persist();
    return;
  }
  if (form.id === "statement-details-form") {
    const ps = val(form, "periodStart");
    const pe = val(form, "periodEnd");
    if ((ps && !isIsoDate(ps)) || (pe && !isIsoDate(pe)) || (ps && pe && ps > pe)) {
      status = "The period must be real dates, with the start no later than the end.";
      render();
      return;
    }
    editStatementDetails(ledger, form.dataset["doc"]!, { issuer: val(form, "issuer"), last4: val(form, "last4"), periodStart: ps, periodEnd: pe });
    await save();
    return;
  }
  if (form.id === "txn-form") {
    const doc = form.dataset["doc"]!;
    const amountCents = toCents(val(form, "amount"));
    if (amountCents === undefined) {
      status = "That amount is not a number.";
      render();
      return;
    }
    const edit = { date: val(form, "date"), descriptor: val(form, "descriptor"), amountCents, kind: val(form, "kind") as "purchase" | "credit" | "payment" | "fee" };
    const id = form.dataset["txn"];
    const ok = id ? editTransaction(ledger, doc, id, edit) : addTransaction(ledger, doc, edit) !== undefined;
    if (!ok) {
      status = "That row needs a real date and a description.";
      render();
      return;
    }
    editingTxn = undefined;
    await save();
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
    addingChild = false;
    ledger.set("child", newId("child"), { name: val(form, "name"), ...(val(form, "scholarship") ? { scholarship: val(form, "scholarship") } : {}) }, { label: "child.created" });
  }
  await save();
});

root.addEventListener("change", async (ev) => {
  const input = ev.target as HTMLInputElement;
  if (input.id === "history-source") {
    historyUi.source = (input as unknown as HTMLSelectElement).value as "" | HistorySource;
    historyUi.limit = 200;
    const box = root.querySelector<HTMLElement>("#history-list");
    if (box) box.innerHTML = historyList();
    return;
  }
  if (["legacy-status", "legacy-child", "legacy-vendor", "legacy-sort"].includes(input.id)) {
    filterLegacyList();
    return;
  }
  if (workspace?.legacy && input.id !== "year-pick") return;
  if (input.id === "year-pick" && workspace) {
    const pointer = workspace.pointer;
    clearDrill();
    await guarded(() => switchYear(pointer, input.value), `Opening ${input.value}…`);
    return;
  }
  if (input.dataset["childScholarship"]) {
    ledger.set("child", input.dataset["childScholarship"], { scholarship: (input as unknown as HTMLSelectElement).value }, { label: "child.programSet" });
    await save();
    return;
  }
  if (input.id === "ocr-lang") {
    const v = (input as unknown as HTMLSelectElement).value;
    setOcrLanguages(v === "all" ? ocrLanguages().available : [v]);
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
  if ((input.id === "upload-statement" || input.id === "photo-statement") && input.files?.length) {
    const files = [...input.files];
    const fromCamera = input.id === "photo-statement";
    input.value = "";
    await uploadFiles(files, fromCamera, undefined, "receipt", true);
    return;
  }
  if ((input.id === "upload" || input.id === "upload-later" || input.id === "photo") && input.files?.length) {
    const files = [...input.files];
    const purchaseId = input.dataset["purchase"];
    input.value = "";
    await uploadFiles(files, input.id === "photo", purchaseId, input.dataset["role"] === "additional" ? "additional" : "receipt");
    return;
  }
  if (input.id === "stepup-import" && input.files?.[0]) {
    const picked = input.files[0];
    input.value = "";
    await guarded(async () => {
      if (workspace) await bringInStepUpList(resultsFromSavedList(await picked.text()));
    }, "Bringing in StepUp's list…");
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
  note(storage.kind === "onedrive" ? "Completing Microsoft sign-in…" : storage.kind === "google" ? "Signing in to Google…" : "Opening your files…");
  account = await storage.auth.restore();
  authReady = true;
  if (!account && storage.auth.canAutoSignIn()) {
    // Signed in here before: go straight back to that account rather than asking again.
    note("Signing in to Microsoft…");
    showBusy("Signing in to Microsoft…");
    await storage.auth.autoSignIn();
    await new Promise<void>(() => {}); // the page is navigating away; keep the busy screen up
  }
  if (!account) render();
  if (account) note("Finding your saved folder…");
  // Storage inside this browser has no folders to browse: the workspace is simply its top.
  const pointer = account ? (await loadPointer()) ?? (storage.kind === "browser" ? await homePointer() : undefined) : undefined;
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
}, `Connecting to ${storage.label}…`);
if (workspace?.fromCache) void refreshInBackground(workspace);
// Files shared to the installed app from another app go to the unattached files. If we are not connected yet they wait on this device.
if (new URLSearchParams(location.search).has("shared")) history.replaceState(null, "", location.pathname);
if (workspace && (await hasSharedFiles())) await uploadFiles(await takeSharedFiles(), false);
else if (await hasSharedFiles()) {
  status = "Files you shared are waiting on this device. Sign in and connect your folder to add them.";
  render();
}
void loadProviders().then((byCategory) => {
  publishedProviders = byCategory;
});
void loadReference().then((r) => {
  publishedRef = r;
  if (!yearSnapshot) referenceBase = r; // before the year's own copy is known (or in local mode)
  if (workspace && !yearSnapshot) void loadYearReference(workspace);
  if (r && !typing()) render();
});

// Installable / works offline: the page and its scripts are cached by the service worker (public/sw.js).
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  // The worker takes over as soon as it installs, so a controller change after we already had one means a new version.
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController || updateReady) return;
    updateReady = true;
    if (!typing()) render();
  });
  navigator.serviceWorker.register("./sw.js").then((reg) => {
    // A long-open installed app only re-checks on launch; also check whenever it comes back to the foreground.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") void reg.update().catch(() => undefined);
    });
  }).catch(() => undefined);
}
