import { readFileSync } from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import {
  applyObservedCategories,
  openLedgerFolders,
  readYearSnapshot,
  applyStepUpStatuses,
  claimItems,
  claimedByOthers,
  deleteDraft,
  filingGroups,
  findDraft,
  releaseItems,
  renewClaims,
  saveDraft,
  type ClaimOwner,
  publishYearMirror,
  recordCategoryFix,
  recordDraftNumber,
  recordNeedsAttention,
  recordSubmitted,
  resolveReference,
  validateCategoryReference,
  type CategoryReference,
  type DocumentRec,
  type FilingGroup,
  type ResolvedReference,
  type RulesContext,
} from "@step-up/shared";
import { downloadItem, type FolderChild } from "../graph/onedrive.js";
import type { DraftRecord } from "../draftTracker.js";
import type { OpenedYear } from "../ledgerYear.js";
import type { ReimbursementGroup, ScholarshipMismatch, Table1Row } from "../reimbursements.js";
import { attachCategoryTreeListener, type Cache } from "../categorySync.js";
import { nodesFromCache } from "../categoryNodes.js";
import { attachStatusSyncListenerWith } from "../statusSync.js";
import type { FilingStore } from "./store.js";

const REFERENCE_FILE = path.resolve(process.cwd(), "packages/web/public/reference/categories.json");

/** The published category tree, if present and valid; without it every category counts as known (as in the web app). */
function loadReference(): CategoryReference | undefined {
  try {
    const data: unknown = JSON.parse(readFileSync(REFERENCE_FILE, "utf-8"));
    return validateCategoryReference(data).length === 0 ? (data as CategoryReference) : undefined;
  } catch {
    return undefined;
  }
}

/** Files from the ledger: documents are found by OneDrive item id, and every result is appended to this device's event log. */
export class LedgerStore implements FilingStore {
  readonly kind = "ledger" as const;
  readonly describe: string;
  private readonly drive: string;
  private docs = new Map<string, DocumentRec>();
  /** This year's frozen category list; the published file is only the fallback. */
  private snapshot?: CategoryReference;
  private groups: FilingGroup[] = [];

  constructor(private readonly opened: OpenedYear, private readonly me: ClaimOwner = { actor: "cli", clientId: "cli" }) {
    this.describe = `the ${opened.year.label} ledger`;
    this.drive = opened.driveId;
  }

  /** Resume state lives in the ledger, so any machine (and the other person) can pick a draft up. Saving also renews our claim. */
  readonly drafts = {
    load: async (rowIds: string[]) => {
      await this.ledger.refresh();
      return findDraft(this.ledger.state, rowIds);
    },
    save: async (record: DraftRecord) => {
      saveDraft(this.ledger, record, this.me.actor);
      renewClaims(this.ledger, record.rowIds, this.me);
      await this.save();
    },
    delete: async (rowIds: string[]) => {
      deleteDraft(this.ledger, rowIds);
      await this.save();
    },
  };

  async claim(rows: Table1Row[]): Promise<{ ok: true } | { ok: false; reason: string }> {
    const result = await claimItems(this.ledger, this.itemIds(rows), this.me);
    if (result.ok) return result;
    const who = [...new Set(result.conflicts.map((c) => c.actor))].join(", ");
    return { ok: false, reason: `${who} is already filing ${result.conflicts.length === 1 ? "one of these items" : `${result.conflicts.length} of these items`}.` };
  }

  async release(rows: Table1Row[]): Promise<void> {
    await releaseItems(this.ledger, this.itemIds(rows), this.me);
  }

  private get ledger() {
    return this.opened.ledger;
  }

  private async loadSnapshot(): Promise<void> {
    try {
      const folders = await openLedgerFolders(this.drive, this.opened.year.folderId);
      if (folders) this.snapshot = await readYearSnapshot(this.drive, folders.ledgerId);
    } catch {
      /* fall back to the published list */
    }
  }

  private rules(): RulesContext {
    const base = this.snapshot ?? loadReference();
    const ref: ResolvedReference | undefined = base ? resolveReference(base, this.ledger.state.categories) : undefined;
    return {
      today: new Date().toISOString().slice(0, 10),
      // Ids from older imports that the tree does not know stay accepted, as in the web app.
      category: (id) => {
        if (!ref) return { id, path: [], requiresServiceDate: false, eligibleScholarships: [], isActive: true };
        return ref.category(id) ?? (id.startsWith("legacy-cat-") ? { id, path: [], requiresServiceDate: false, eligibleScholarships: [], isActive: true } : undefined);
      },
    };
  }

  private itemIds(rows: Table1Row[]): string[] {
    return rows.map((r) => r.data["ID"]!).filter(Boolean);
  }

  async loadRows(): Promise<Table1Row[]> {
    await this.ledger.refresh();
    await this.loadSnapshot();
    const planned = filingGroups(this.ledger.state, this.rules());
    const { blocked } = planned;
    // Items someone else is filing right now are theirs; leave them out (a stale claim, past its time-out, no longer counts).
    const groups = planned.groups.filter((g) => {
      const others = claimedByOthers(this.ledger.state, g.rows.map((r) => r.itemId), this.me, Date.now());
      if (others.length > 0) console.log(`\nSkipping ${g.child}'s "${g.receipt.filename ?? g.receipt.id}": ${[...new Set(others.map((o) => o.actor))].join(", ")} is filing it.`);
      return others.length === 0;
    });
    this.groups = groups;
    this.docs.clear();
    const rows: Table1Row[] = [];
    for (const g of groups) {
      for (const d of [g.receipt, ...g.additionalDocs]) this.docs.set(d.filename ?? d.id, d);
      for (const r of g.rows) {
        rows.push({ rowIndex: -1, data: r.data, rawValues: [], documentationFiles: [g.receipt.filename ?? g.receipt.id, ...g.additionalDocs.map((d) => d.filename ?? d.id)] });
      }
    }
    if (blocked.length > 0) {
      console.log(`\n${blocked.length} item(s) are not ready to file:`);
      for (const b of blocked.slice(0, 15)) console.log(`  ${b.item.description ?? b.item.id}: ${b.reasons.map((r) => r.message).join("; ")}`);
      if (blocked.length > 15) console.log(`  ... and ${blocked.length - 15} more (see the web app's list).`);
    }
    for (const g of groups) {
      for (const name of g.unredactedStatements) console.log(`\nWarning: "${name}" would be sent as it is (no redacted copy). Make one in the web app first if it shows other charges.`);
    }
    return rows;
  }

  async buildGroups(rows: Table1Row[]): Promise<ReimbursementGroup[]> {
    const byId = new Map(rows.map((r) => [r.data["ID"]!, r]));
    return this.groups.map((g) => ({
      child: g.child,
      mainReceiptFile: g.receipt.filename ?? g.receipt.id,
      rows: g.rows.map((r) => byId.get(r.itemId)!).filter(Boolean),
      additionalFiles: g.additionalDocs.map((d) => d.filename ?? d.id),
    }));
  }

  async files(): Promise<FolderChild[]> {
    const seen = new Map<string, DocumentRec>();
    for (const [name, doc] of this.docs) {
      const clash = seen.get(name);
      if (clash && clash.id !== doc.id) console.warn(`Warning: two different documents are both called "${name}"; the first one will be used.`);
      seen.set(name, doc);
    }
    return [...this.docs.entries()].flatMap(([name, d]) => (d.driveItemId ? [{ id: d.driveItemId, name, isFolder: false, size: d.sizeBytes ?? 0, ...(d.webUrl ? { webUrl: d.webUrl } : {}) }] : []));
  }

  download(fileId: string, destPath: string): Promise<void> {
    return downloadItem(this.drive, fileId, destPath);
  }

  async childScholarships(): Promise<Map<string, string>> {
    return new Map(Object.values(this.ledger.state.children).flatMap((c) => (c.name && c.scholarship ? [[c.name, c.scholarship] as [string, string]] : [])));
  }

  async eligibilityMismatches(): Promise<ScholarshipMismatch[]> {
    return []; // already a readiness rule: an item whose category is ineligible for its child is not offered at all
  }

  async checkReady(): Promise<void> {
    if (!this.ledger.store) throw new Error("No ledger store.");
  }

  private async save(): Promise<void> {
    await this.ledger.flush();
  }

  async markNeedsAttention(rows: Table1Row[], note: string): Promise<void> {
    recordNeedsAttention(this.ledger, this.itemIds(rows), note, new Date().toISOString().slice(0, 10));
    await this.save();
  }

  async markSubmitted(rows: Table1Row[], reimbursementId: string, submittedDate: string): Promise<void> {
    recordSubmitted(this.ledger, this.itemIds(rows), { reimbursementId, submittedAt: submittedDate });
    await this.save();
    await this.rebuildMirror();
  }

  async recordDraftNumber(rows: Table1Row[], reimbursementId: string): Promise<void> {
    recordDraftNumber(this.ledger, this.itemIds(rows), reimbursementId);
    for (const r of rows) r.data["Reimbursement ID"] = reimbursementId;
    await this.save();
  }

  async fixCategory(rows: Table1Row[], newValue: string): Promise<void> {
    recordCategoryFix(this.ledger, this.itemIds(rows), newValue);
    for (const r of rows) r.data["Category"] = newValue;
    await this.save();
  }

  async renameCategory(oldPath: string, newPath: string): Promise<void> {
    console.log(`[category] StepUp lists "${newPath}" where we had "${oldPath}". Items were updated; run "npm run reference:build" to refresh the shared list.`);
  }

  attachListeners(page: Page): void {
    attachStatusSyncListenerWith(page, async (body) => {
      const lineItems = (body.Results ?? []).flatMap((r) => r.LineItems ?? []);
      const changed = applyStepUpStatuses(this.ledger, lineItems);
      await this.save();
      return changed;
    });
    // StepUp's own category list, as it is observed, becomes edits in this year's ledger (the old Table5 sync).
    attachCategoryTreeListener(page, (cache) => this.recordCategories(cache));
    // Pre-authorization status is not part of the ledger yet (plan: Pre-Auth is its own flow), so it is not synced here.
  }

  private async recordCategories(cache: Cache): Promise<void> {
    const base = this.snapshot ?? loadReference();
    if (!base) {
      console.log("[category sync] No shared category list found (packages/web/public/reference/categories.json); nothing recorded.");
      return;
    }
    const { added, updated } = applyObservedCategories(this.ledger, base, nodesFromCache(cache));
    if (added + updated === 0) return;
    await this.save();
    console.log(`[category sync] Recorded ${added} new and ${updated} changed categor${added + updated === 1 ? "y" : "ies"} in ${this.describe}.`);
  }

  /** Rebuilds the mirror spreadsheet exactly as the web app does (skipped if unchanged or switched off); never fails the run. */
  async rebuildMirror(): Promise<void> {
    try {
      const { status } = await publishYearMirror({
        ledger: this.ledger,
        ctx: this.rules(),
        driveId: this.drive,
        yearFolderId: this.opened.year.folderId,
        yearLabel: this.opened.year.label,
        appVersion: "cli",
      });
      const said: Record<string, string> = { written: "updated", unchanged: "already up to date", locked: "open in Excel, will update next time", off: "switched off for this year" };
      console.log(`[spreadsheet] ${said[status]}.`);
    } catch (err) {
      console.warn(`[spreadsheet] Could not rebuild it (${(err as Error).message}).`);
    }
  }

  async finish(): Promise<void> {
    await this.save();
    await this.rebuildMirror();
  }
}
