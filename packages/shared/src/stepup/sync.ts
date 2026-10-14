import { sha256OfBytes } from "../util/sha256.js";
import { writeHistoryFile } from "../history/store.js";
import { diffStepUp } from "../history/sources.js";
import type { HistoryChange } from "../history/types.js";
import type { StorageProvider } from "../storage/types.js";
import { LEDGER_DIR, STEPUP_DIR, listYears, type YearInfo } from "../workspace/workspace.js";
import {
  STEPUP_INDEX_FILE,
  STEPUP_REIMBURSEMENTS_DIR,
  STEPUP_SYNCED_FILE,
  projectReimbursement,
  readStepUpIndex,
  reimbursementFileName,
  type StepUpIndex,
  type StepUpIndexEntry,
  type StepUpReimbursement,
} from "./archive.js";

/**
 * Keeps StepUp's list of reimbursements with the year each belongs to (layout: archive.ts).
 *
 * One file per reimbursement, in that school year's own folder (Excel years included), plus a small index per year.
 * Which files changed is read off the year's index (a hash of each raw file), so a fresh copy of the whole list costs one
 * small download per year and one small upload per reimbursement that actually changed. Nothing changed, nothing sent.
 *
 * Environment-agnostic: the command line, the web app and (later) the browser extension all call this one function.
 */
const CONCURRENCY = 6;
/** Years are independent folders, so a few are brought up to date at once (each is several small round trips). */
const YEAR_CONCURRENCY = 4;

export interface StepUpTarget {
  storage: StorageProvider;
  driveId: string;
  /** The workspace folder (parent of the year folders). */
  rootId: string;
  /** The year folders as last listed; filled in when omitted. A year StepUp has that has no folder yet is added here. */
  years?: Map<string, YearInfo>;
}

export interface StepUpSyncResult {
  /** Reimbursements in the list that could be understood. */
  listed: number;
  /** Reimbursements whose file was (re)written. */
  changed: number;
  /** Per school year (oldest first): how many were listed and changed, and what changed, in words a person can read. */
  years: Array<{ label: string; listed: number; changed: number; created: boolean; changes: HistoryChange[] }>;
  /** Where the time went, in milliseconds: comparing against what is kept, and saving the differences. */
  timings: { compareMs: number; saveMs: number };
}

/** The raw list response StepUp's dashboard returns, or a saved copy of it (see `resultsFromSavedList`). */
export function resultsOf(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  if (body && typeof body === "object") {
    const results = (body as { Results?: unknown }).Results;
    if (Array.isArray(results)) return results;
  }
  return [];
}

/**
 * Reads the list out of whatever a person (or the extension) hands over: StepUp's response (`{ Results: [...] }`), a bare
 * array, the command line's capture file (`{ key: { capturedAt, result } }`), or the per-reimbursement files themselves
 * (`{ seenAt, result }`). Throws a readable error when it holds none.
 */
export function resultsFromSavedList(text: string): unknown[] {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error("That file is not JSON.");
  }
  const direct = resultsOf(body);
  if (direct.length) return direct;
  if (body && typeof body === "object") {
    const single = (body as { result?: unknown }).result;
    if (single && typeof single === "object" && !Array.isArray(single)) return [single];
    const wrapped = Object.values(body as Record<string, unknown>)
      .map((v) => (v && typeof v === "object" ? (v as { result?: unknown }).result : undefined))
      .filter((r): r is object => Boolean(r) && typeof r === "object");
    if (wrapped.length) return wrapped;
  }
  throw new Error("No StepUp reimbursements found in that file.");
}

async function forEachLimitedBy<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await work(items[next++]!);
  }));
}
const forEachLimited = <T>(items: T[], work: (item: T) => Promise<void>) => forEachLimitedBy(items, CONCURRENCY, work);

const sha = (value: unknown) => sha256OfBytes(new TextEncoder().encode(JSON.stringify(value)));

/**
 * Applies a fresh copy of the list: each reimbursement whose content differs from what is kept is written to its own
 * file in its year's folder, and the year's index, `synced.json` and the year's history are updated. Throws on a storage
 * failure; callers that treat this as best effort catch it.
 */
export async function archiveStepUpList(
  target: StepUpTarget,
  results: unknown[],
  log: (line: string) => void = () => undefined,
  progress: (text: string) => void = () => undefined,
): Promise<StepUpSyncResult> {
  const out: StepUpSyncResult = { listed: 0, changed: 0, years: [], timings: { compareMs: 0, saveMs: 0 } };
  if (results.length === 0) return out;
  const { storage, driveId, rootId } = target;
  const years = target.years ?? new Map((await listYears(storage, driveId, rootId)).map((y) => [y.label, y]));
  target.years = years;

  const t0 = Date.now();
  progress(`Comparing ${results.length} reimbursements with what is saved…`);
  const byYear = new Map<string, Array<{ raw: unknown; p: StepUpReimbursement; hash: string }>>();
  for (const raw of results) {
    const p = projectReimbursement(raw);
    if (!p) continue;
    const list = byYear.get(p.schoolYear) ?? [];
    list.push({ raw, p, hash: await sha(raw) });
    byYear.set(p.schoolYear, list);
  }
  out.timings.compareMs = Date.now() - t0;

  const t1 = Date.now();
  const labels = [...byYear.keys()].sort((a, b) => a.localeCompare(b));
  let finished = 0;
  const doYear = async (label: string): Promise<void> => {
    const list = byYear.get(label)!;
    let year = years.get(label);
    let created = false;
    if (!year) {
      // A year StepUp has reimbursements for gets its folder, so its history has somewhere to live.
      const folderId = await storage.ensureFolder(driveId, rootId, label);
      year = { label, folderId, kind: "empty", looseFileCount: 0 };
      years.set(label, year);
      created = true;
      log(`Created the ${label} folder.`);
    }
    const dir = await storage.ensureFolder(driveId, year.folderId, STEPUP_DIR);
    const reimbursements = await storage.ensureFolder(driveId, dir, STEPUP_REIMBURSEMENTS_DIR);
    const existing = await readStepUpIndex(storage, driveId, dir);
    const entries = new Map<string, StepUpIndexEntry>((existing?.index.reimbursements ?? []).map((e) => [e.id, e]));
    const changed = list.filter((x) => entries.get(x.p.id)?.hash !== x.hash);
    const seenAt = new Date().toISOString();
    const row = { label, listed: list.length, changed: changed.length, created, changes: [] as HistoryChange[] };
    out.years.push(row);
    // Every fresh copy is noted (a few bytes), so the app knows how current StepUp's side is even when nothing changed.
    await storage.write(driveId, dir, STEPUP_SYNCED_FILE, JSON.stringify({ at: seenAt, reimbursements: list.length, changed: changed.length }));
    if (changed.length > 0 || !existing) {
      // What StepUp changed, for the year's history. The first time a year is read there is nothing to compare to.
      const was = (existing?.index.reimbursements ?? []) as StepUpReimbursement[];
      const history: HistoryChange[] = existing
        ? diffStepUp(was, changed.map((x) => x.p), seenAt)
        : [{ id: `stepup:${seenAt}:baseline`, at: seenAt, source: "stepup", actor: "StepUp", kind: "note", subject: { kind: "year", id: label, label }, summary: `Started following StepUp: ${list.length} reimbursement(s) for ${label}` }];
      row.changes = history;
      await forEachLimited(changed, async (x) => {
        await storage.write(driveId, reimbursements, reimbursementFileName(x.p), JSON.stringify({ seenAt, result: x.raw }));
        entries.set(x.p.id, { ...x.p, hash: x.hash });
      });
      const index: StepUpIndex = { v: 1, year: label, savedAt: seenAt, reimbursements: [...entries.values()].sort((a, b) => a.number - b.number) };
      await storage.write(driveId, dir, STEPUP_INDEX_FILE, JSON.stringify(index));
      await writeHistoryFile(storage, driveId, year.folderId, "stepup", history, seenAt).catch(() => undefined);
      out.changed += changed.length;
      log(`${label}: kept ${changed.length} changed reimbursement(s) of ${list.length} listed (${entries.size} on file).`);
    }
    out.listed += list.length;
    progress(`Saved ${++finished} of ${labels.length} school years…`);
  };
  progress(`Saving ${labels.length} school year(s)…`);
  await forEachLimitedBy(labels, YEAR_CONCURRENCY, doYear);
  out.years.sort((a, b) => a.label.localeCompare(b.label));
  out.timings.saveMs = Date.now() - t1;

  // The first version kept everything in one file in a ledger year; it is replaced by the per-reimbursement files.
  await forEachLimitedBy([...years.values()].filter((y) => y.kind === "ledger"), YEAR_CONCURRENCY, async (year) => {
    const ledger = await storage.find(driveId, year.folderId, LEDGER_DIR);
    const old = ledger ? await storage.find(driveId, ledger.id, "stepup-reimbursements.json") : undefined;
    if (old) {
      await storage.remove(driveId, old.id);
      log(`Removed the old single-file copy from ${year.label}.`);
    }
  });
  return out;
}
