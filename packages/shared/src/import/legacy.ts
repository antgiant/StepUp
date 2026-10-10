import type { AdditionalDocKind, LedgerState } from "../domain/types.js";
import { toCents } from "../domain/money.js";
import { foldEvents, materialize } from "../events/fold.js";
import { formatHlc } from "../events/hlc.js";
import { SCHEMA_VERSION, type Json, type LedgerEvent } from "../events/types.js";
import { evaluateItem, type CategoryInfo, type RulesContext } from "../rules/readiness.js";
import { parseCategoryLevels } from "../rules.js";
import { categoryIdForPath } from "../reference/categories.js";
import { hashString } from "../util/hash.js";
import { childIdForName } from "../entry/actions.js";

/** Imports are stamped well in the past so any later human edit in the app always wins over imported values. */
const IMPORT_WALL = 1_600_000_000_000;
const IMPORT_CLIENT = "legacy-import";
const RECEIPT_KEYWORDS = ["invoice", "order", "receipt"];
const STEPUP_STATUSES = new Set(["Submitted", "Re-Submitted", "Approved", "Adjusted", "Paid", "Denied (Initial)", "Denied (Final)"]);
const UNFILED_READY = "Unfiled (Ready to Submit)";
const UNFILED_MISSING = "Unfiled (Missing Things)";

export interface LegacyRow {
  /** Table1 cell values keyed by header name (raw: numbers stay numbers; Excel dates are serial numbers). */
  values: Record<string, unknown>;
  /** Non-blank "Documentation File 1-6" values. */
  docFiles: string[];
}

export interface LegacyFile {
  name: string;
  id?: string;
  webUrl?: string;
  size?: number;
}

export interface LegacyInput {
  yearLabel: string;
  rows: LegacyRow[];
  children: Array<{ name: string; scholarship?: string; capDollars?: number }>;
  /** Table6: card-and-period label -> statement file. */
  paymentMethods: Array<{ label: string; file?: string }>;
  /** Listing of the receipts folder. */
  files: LegacyFile[];
  /** The CLI's remembered "which file is the main receipt" answers: sorted candidates joined by a space -> choice. */
  receiptChoices?: Record<string, string>;
  /** Table5: category path ("A - B") with its eligible scholarships. */
  categories?: Array<{ path: string; eligible: string[] }>;
  /**
   * "migrate" (default) is the one-time import: an unclear receipt takes a best guess. "view" is the read-only look at a
   * year Excel still owns: Excel's status is shown as written, an unclear receipt is never guessed (every candidate goes
   * to additional documentation until a person picks), and each statement file is kept as a document.
   */
  mode?: "migrate" | "view";
}

export interface ImportReport {
  rowsRead: number;
  itemsImported: number;
  rowsSkipped: Array<{ row: number; reason: string }>;
  purchases: number;
  submissions: number;
  documents: number;
  statusCounts: Record<string, number>;
  /** Files named in the sheet that are not in the receipts folder. */
  missingFiles: string[];
  itemsWithoutDocuments: string[];
  ambiguousReceipts: Array<{ itemId: string; candidates: string[]; chosen: string; resolvedFromCache: boolean }>;
  /** Statuses that are neither a StepUp status nor an Unfiled one; kept as overrides. */
  unknownStatuses: Array<{ itemId: string; status: string }>;
  /** Items whose date/invoice/vendor differ from the first row on the same receipt (kept as per-item values). */
  purchaseDisagreements: Array<{ receipt: string; field: string; values: string[] }>;
  /** Items put on hold because the old sheet's automation notes said so. */
  holds: Array<{ itemId: string; hold: string }>;
  /** Unfiled items where the rules engine and the old hand-set status disagree. */
  readinessMismatches: Array<{ itemId: string; legacy: string; computed: string; reasons: string[] }>;
  /** Per-child total Amount, to compare with the workbook's own Summary. */
  amountByChild: Record<string, number>;
}

export interface LegacyImportResult {
  events: LedgerEvent[];
  state: LedgerState;
  report: ImportReport;
  rules: RulesContext;
}

const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v).trim());
const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** Excel serial number (or already-formatted date text) to ISO `YYYY-MM-DD`. */
export function toIsoDate(v: unknown): string | undefined {
  const s = str(v);
  if (!s) return undefined;
  if (/^\d+(\.\d+)?$/.test(s)) {
    const d = new Date(Date.UTC(1899, 11, 30) + Number(s) * 86_400_000);
    return d.toISOString().slice(0, 10);
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (us) return `${us[3]}-${us[1]!.padStart(2, "0")}-${us[2]!.padStart(2, "0")}`;
  const parsed = new Date(s);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString().slice(0, 10);
}

export function buildLegacyImport(input: LegacyInput): LegacyImportResult {
  let n = 0;
  const events: LedgerEvent[] = [];
  const emit = (entity: LedgerEvent["entity"], entityId: string, fields: Record<string, Json>, label: string) => {
    const wall = IMPORT_WALL + Math.floor(n / 90_000);
    const hlc = formatHlc({ wall, counter: n % 90_000, clientId: IMPORT_CLIENT });
    n += 1;
    events.push({ id: hlc, hlc, clientId: IMPORT_CLIENT, actor: "legacy-import", schemaVersion: SCHEMA_VERSION, op: "set", entity, entityId, fields, label });
  };
  const clean = (o: Record<string, Json | undefined>): Record<string, Json> => {
    const out: Record<string, Json> = {};
    for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== "") out[k] = v;
    return out;
  };

  const report: ImportReport = {
    rowsRead: input.rows.length,
    itemsImported: 0,
    rowsSkipped: [],
    purchases: 0,
    submissions: 0,
    documents: 0,
    statusCounts: {},
    missingFiles: [],
    itemsWithoutDocuments: [],
    ambiguousReceipts: [],
    unknownStatuses: [],
    purchaseDisagreements: [],
    holds: [],
    readinessMismatches: [],
    amountByChild: {},
  };

  emit("setting", "year", clean({ year: input.yearLabel, defaultTaxRate: 0.07, mirror: true }), "legacy.year");

  const childIds = new Map<string, string>();
  for (const c of input.children) {
    const id = childIdForName(c.name);
    childIds.set(c.name.trim().toLowerCase(), id);
    emit("child", id, clean({ name: c.name, scholarship: c.scholarship, capCents: c.capDollars === undefined ? undefined : Math.round(c.capDollars * 100) }), "legacy.child");
  }

  const methodIds = new Map<string, string>();
  const methodFile = new Map<string, string>();
  for (const pm of input.paymentMethods) {
    const id = `pm-${slug(pm.label)}`;
    methodIds.set(pm.label.trim().toLowerCase(), id);
    if (pm.file) methodFile.set(id, pm.file);
    emit("paymentMethod", id, clean({ label: pm.label, requiresStatement: true }), "legacy.paymentMethod");
  }

  const fileByName = new Map(input.files.map((f) => [f.name, f]));
  const docIds = new Map<string, string>();
  const viewing = input.mode === "view";
  const ensureDoc = (name: string, contentKind?: "statement"): string => {
    let id = docIds.get(name);
    if (id) return id;
    id = `doc-${hashString(name)}`;
    docIds.set(name, id);
    const f = fileByName.get(name);
    if (!f) report.missingFiles.push(name);
    emit("document", id, clean({ filename: name, driveItemId: f?.id, webUrl: f?.webUrl, sizeBytes: f?.size, contentKind }), "legacy.document");
    return id;
  };

  // A read-only view lists each card statement as a document, so it can be opened from the proof-of-payment page.
  if (viewing) for (const file of methodFile.values()) ensureDoc(file, "statement");

  const purchases = new Map<string, { id: string; date?: string; invoice?: string; vendor?: string }>();
  const submissionsSeen = new Set<string>();
  const additionalSeen = new Set<string>();
  const legacyStatusById = new Map<string, string>();
  /** Categories the old automation found to require a Service Date (learned from StepUp at submission time). */
  const requiresServiceDate = new Set<string>();
  const choices = input.receiptChoices ?? {};

  /** Settles, for every row, which of its files is the receipt (if it can be told) before any purchase is built. */
  interface ReceiptPick {
    files: string[];
    main?: string;
    /** A read-only view found several candidates and nothing to choose between them. */
    unclear: boolean;
    /** The row listed several files and the keywords did not settle it. */
    ambiguous: boolean;
    /** Taken from a remembered answer rather than read off the row. */
    fromChoice: boolean;
    /** For an unclear row: the name its purchase is keyed by, shared by every row tied to it (see below). */
    cluster?: string;
  }
  const rowId = (row: LegacyRow) => str(row.values["ID"]);
  const vendorOf = (row: LegacyRow) => (str(row.values["Service Provider"]) || str(row.values["Vendor"])).toLowerCase();
  const picks: Array<ReceiptPick | undefined> = input.rows.map((row) => {
    const legacyId = rowId(row);
    if (!legacyId || (!str(row.values["Item"]) && !str(row.values["Amount"]))) return undefined;
    const files = [...new Set(row.docFiles)];
    if (files.length === 1) return { files, main: files[0], unclear: false, ambiguous: false, fromChoice: false };
    if (files.length === 0) return { files, unclear: false, ambiguous: false, fromChoice: false };
    const keyword = files.filter((f) => RECEIPT_KEYWORDS.some((k) => f.toLowerCase().includes(k)));
    // The old habit: "7 - Receipt Hats.jpeg" is row 7's own file, while "6,7,8 - Citi Ending August.pdf" is shared proof.
    const own = viewing ? files.filter((f) => new RegExp(`^\\s*${legacyId.replace(/\W/g, "")}\\s*-\\s`).test(f)) : [];
    if (keyword.length === 1) return { files, main: keyword[0], unclear: false, ambiguous: false, fromChoice: false };
    if (own.length === 1) return { files, main: own[0], unclear: false, ambiguous: false, fromChoice: false };
    const remembered = choices[[...files].sort().join(" ")];
    const known = remembered && files.includes(remembered) ? remembered : undefined;
    return { files, main: known ?? (viewing ? undefined : files[0]), unclear: viewing && !known, ambiguous: true, fromChoice: Boolean(known) };
  });
  if (viewing) {
    // A file that is only ever proof of payment is never taken as a receipt on a sibling's say-so.
    const proof = new Set<string>([...methodFile.values(), ...input.rows.map((r) => str(r.values["Payment File"])).filter(Boolean)]);
    const settled = new Map<string, Set<string>>();
    input.rows.forEach((row, i) => {
      const main = picks[i]?.main;
      if (!main || proof.has(main)) return;
      const set = settled.get(vendorOf(row)) ?? new Set<string>();
      set.add(main);
      settled.set(vendorOf(row), set);
    });
    // An unclear row that lists exactly one receipt a same-vendor sibling already settled is that sibling's purchase: no
    // second pick is needed, and a pick made for one row's list covers a row with a shorter or longer list.
    input.rows.forEach((row, i) => {
      const pick = picks[i];
      if (!pick?.unclear) return;
      const hits = pick.files.filter((f) => settled.get(vendorOf(row))?.has(f));
      if (hits.length === 1) {
        pick.main = hits[0];
        pick.unclear = false;
      }
    });
    // The rest stay together the way the command line groups them (by the receipt file): rows of one vendor are one purchase
    // when they list the same files in any order, or start with the same file. Nothing is chosen, only tied together.
    const parent = new Map<string, string>();
    const find = (x: string): string => {
      let r = x;
      while (parent.get(r) !== undefined && parent.get(r) !== r) r = parent.get(r)!;
      parent.set(x, r);
      return r;
    };
    const tie = (a: string, b: string) => {
      if (!parent.has(a)) parent.set(a, a);
      if (!parent.has(b)) parent.set(b, b);
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
    };
    const nodes = (row: LegacyRow, files: string[]) => [`set::${[...files].sort().join("|")}::${vendorOf(row)}`, `first::${files[0]}::${vendorOf(row)}`];
    input.rows.forEach((row, i) => {
      const pick = picks[i];
      if (pick?.unclear) tie(...(nodes(row, pick.files) as [string, string]));
    });
    input.rows.forEach((row, i) => {
      const pick = picks[i];
      if (pick?.unclear) pick.cluster = find(nodes(row, pick.files)[0]!);
    });
  }

  input.rows.forEach((row, index) => {
    const v = row.values;
    const legacyId = str(v["ID"]);
    if (!legacyId || (!str(v["Item"]) && !str(v["Amount"]))) {
      if (legacyId || str(v["Item"])) report.rowsSkipped.push({ row: index + 2, reason: "blank row" });
      return;
    }
    const itemId = `legacy-${legacyId}`;
    const status = str(v["Status"]);
    legacyStatusById.set(itemId, status);
    report.statusCounts[status || "(blank)"] = (report.statusCounts[status || "(blank)"] ?? 0) + 1;

    // ---- which document is the receipt?
    const { files, unclear, ambiguous, cluster } = picks[index]!;
    const main = picks[index]!.main;
    if (ambiguous) report.ambiguousReceipts.push({ itemId, candidates: files, chosen: main ?? "", resolvedFromCache: picks[index]!.fromChoice });
    if (files.length === 0) report.itemsWithoutDocuments.push(itemId);

    const vendor = str(v["Vendor"]);
    const provider = str(v["Service Provider"]);
    const vendorKey = (provider || vendor).toLowerCase();
    // Rows that share the same unclear set of files are still one purchase, so a later pick settles them together. Like the
    // command line's grouping, rows also tie together by their first file, not only by the whole list: a row that lists some
    // of its siblings' files (or adds its own statement) is still the same purchase.
    const purchaseKey = main ? `${main}::${vendorKey}` : unclear ? `unclear::${cluster}` : `no-receipt::${legacyId}`;
    const date = toIsoDate(v["Date"]);
    const invoice = str(v["Invoice #"]);
    const methodLabel = str(v["Payment Method"]);
    const paymentFile = str(v["Payment File"]);

    let purchase = purchases.get(purchaseKey);
    if (!purchase) {
      purchase = { id: `purchase-${hashString(purchaseKey)}`, date, invoice, vendor: vendor || provider };
      purchases.set(purchaseKey, purchase);
      emit(
        "purchase",
        purchase.id,
        clean({
          vendor: vendor || provider,
          date,
          invoiceNo: invoice,
          paymentMethodId: methodIds.get(methodLabel.toLowerCase()),
          receiptDocumentId: main ? ensureDoc(main) : undefined,
        }),
        "legacy.purchase"
      );
    }
    // StepUp takes date, invoice and vendor per item, so keep a per-item value whenever it differs from the receipt's first row.
    const overrides: Record<string, Json | undefined> = {};
    if (date && date !== purchase.date) overrides["date"] = date;
    if (invoice && invoice !== purchase.invoice) overrides["invoiceNo"] = invoice;
    if ((vendor || provider) && (vendor || provider) !== purchase.vendor) overrides["vendor"] = vendor || provider;
    for (const field of Object.keys(overrides)) {
      report.purchaseDisagreements.push({ receipt: main ?? purchaseKey, field, values: [String((field === "date" ? purchase.date : field === "invoiceNo" ? purchase.invoice : purchase.vendor) ?? ""), String(overrides[field])] });
    }

    // ---- additional documentation (the old sheet kept these per row; they belong to the purchase)
    const addDoc = (file: string, kind: AdditionalDocKind) => {
      const key = `${purchase!.id}::${file}`;
      if (additionalSeen.has(key)) return;
      additionalSeen.add(key);
      emit("additionalDoc", `add-${hashString(key)}`, clean({ ownerKind: "purchase", ownerId: purchase!.id, documentId: ensureDoc(file, viewing && kind === "payment-proof" ? "statement" : undefined), kind, source: "manual" }), "legacy.additionalDoc");
    };
    if (paymentFile && paymentFile !== main) addDoc(paymentFile, "payment-proof");
    for (const f of files) if (f !== main && f !== paymentFile) addDoc(f, "other");

    // ---- submission (one StepUp reimbursement = one purchase x one child)
    const reimbursementId = str(v["Reimbursement ID"]);
    const childName = str(v["Child"]);
    const childId = childIds.get(childName.toLowerCase());
    let submissionId: string | undefined;
    if (reimbursementId) {
      submissionId = `sub-${reimbursementId}`;
      if (!submissionsSeen.has(submissionId)) {
        submissionsSeen.add(submissionId);
        emit("submission", submissionId, clean({ reimbursementId, purchaseId: purchase.id, childId, submittedAt: toIsoDate(v["Submitted"]) }), "legacy.submission");
      }
    }

    // ---- status
    let stepUpStatus: string | undefined;
    let statusOverride: string | undefined;
    if (STEPUP_STATUSES.has(status)) stepUpStatus = status;
    else if (status && status !== UNFILED_READY && status !== UNFILED_MISSING) {
      statusOverride = status;
      report.unknownStatuses.push({ itemId, status });
    }

    const amountCents = toCents(str(v["Amount"]));
    const reimbursed = toCents(str(v["Reimbursed Amount"]));
    if (amountCents !== undefined) report.amountByChild[childName] = (report.amountByChild[childName] ?? 0) + amountCents;
    const categoryPath = parseCategoryLevels(str(v["Category"]));

    // The old automation recorded what it learned about a row as a dated note and set Status to "Missing Things".
    // Turn those into structured holds so they are not buried in free text.
    const notes = str(v["Notes"]);
    let hold: string | undefined;
    if (status === UNFILED_MISSING) {
      if (/missing service date/i.test(notes)) hold = "missing-service-date";
      else if (/needs to be split/i.test(notes)) hold = "needs-split";
      else if (/^\[[^\]]*\]\s*documentation files/i.test(notes)) hold = "documentation-problem";
    }
    if (hold) {
      report.holds.push({ itemId, hold });
      if (hold === "missing-service-date" && categoryPath.length) requiresServiceDate.add(categoryIdForPath(categoryPath));
    }

    emit(
      "item",
      itemId,
      clean({
        purchaseId: purchase.id,
        childId,
        serviceDate: toIsoDate(v["Service Date"]),
        serviceProvider: provider,
        description: str(v["Item"]) || str(v["Description"]),
        categoryId: categoryPath.length ? categoryIdForPath(categoryPath) : undefined,
        categoryPath: categoryPath.length ? categoryPath : undefined,
        quantity: v["Quantity"] === "" || v["Quantity"] === undefined ? undefined : Number(v["Quantity"]),
        amountCents,
        taxShippingCents: toCents(str(v["Tax, Shipping, etc."])),
        benefitMessage: str(v["Benefit Message"]),
        itemUrl: str(v["Item/Service URL"]),
        ...overrides,
        // In the old workbook a person set this status by hand, so it carries over as their decision.
        readyToSubmit: status === UNFILED_READY ? true : undefined,
        hold,
        holdNote: hold ? notes.slice(0, 300) : undefined,
        preAuthId: str(v["Pre-Auth #"]),
        submissionId,
        lineNumber: v["Line Number"] === "" || v["Line Number"] === undefined ? undefined : Number(v["Line Number"]),
        stepUpStatus,
        // In a read-only view the sheet is the authority, so its status is shown exactly as written.
        statusOverride: viewing && status ? status : statusOverride,
        approvedCents: stepUpStatus === "Approved" || stepUpStatus === "Adjusted" ? reimbursed : undefined,
        paidCents: stepUpStatus === "Paid" ? reimbursed : undefined,
        notes,
      }),
      "legacy.item"
    );
    report.itemsImported += 1;
  });

  // A read-only view also lists every other file in the folder, so none is hidden just because no row names it.
  if (viewing) for (const f of input.files) if (!/\.xlsx?$/i.test(f.name)) ensureDoc(f.name);

  report.purchases = purchases.size;
  report.submissions = submissionsSeen.size;
  report.documents = docIds.size;

  // ---- category knowledge from Table5, so the rules can run on imported data
  const known = new Map<string, CategoryInfo>();
  for (const c of input.categories ?? []) {
    const path = parseCategoryLevels(c.path);
    known.set(categoryIdForPath(path), { id: categoryIdForPath(path), path, requiresServiceDate: requiresServiceDate.has(categoryIdForPath(path)), eligibleScholarships: c.eligible, isActive: true });
  }
  const state = materialize(foldEvents(events));
  const rules: RulesContext = {
    today: "9999-12-31",
    category: (id) => known.get(id) ?? (id.startsWith("legacy-cat-") ? { id, path: [], requiresServiceDate: requiresServiceDate.has(id), eligibleScholarships: [], isActive: true } : undefined),
  };

  // ---- do the new rules agree with the old hand-set Unfiled statuses?
  for (const [itemId, legacy] of legacyStatusById) {
    if (legacy !== UNFILED_READY && legacy !== UNFILED_MISSING) continue;
    const ev = evaluateItem(state, itemId, rules);
    const computed = ev.readiness === "ready" ? UNFILED_READY : UNFILED_MISSING;
    if (computed !== legacy) report.readinessMismatches.push({ itemId, legacy, computed, reasons: ev.reasons.map((r) => r.code) });
  }

  return { events, state, report, rules };
}
