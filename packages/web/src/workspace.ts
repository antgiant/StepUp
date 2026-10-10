import {
  HlcClock,
  Ledger,
  OneDriveEventStore,
  copyYearSetup,
  copyLegacyChildren,
  CHILDREN_TABLE,
  findChild,
  YEAR_FOLDER_RE,
  GraphError,
  ensureFolder,
  graphJson,
  ensureLedgerFolders,
  type FolderEntry,
  listYears,
  openLedgerFolders,
  loadRemotePointer,
  parentOf,
  saveRemotePointer,
  type CategoryReference,
  type Pointer,
  type YearInfo,
} from "@step-up/shared/web";

import type { WorkspaceCache } from "./cache.js";
import { openLegacyFromCache, openLegacyWorkspace, refreshLegacy, type LegacyState } from "./legacyYear.js";

const KEY = "stepup.workspace.v1";

export type { Pointer };

function readLocal(): Pointer | undefined {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "null") ?? undefined;
  } catch {
    return undefined;
  }
}

function writeLocal(p: Pointer | undefined): void {
  try {
    if (p) localStorage.setItem(KEY, JSON.stringify(p));
    else localStorage.removeItem(KEY);
  } catch {
    /* storage blocked: the browser copy just isn't kept */
  }
}

/** The account's own saved choice (OneDrive app folder) wins, so a new device needs no setup; the browser copy is the fallback. */
export async function loadPointer(): Promise<Pointer | undefined> {
  const local = readLocal();
  if (local) {
    // Don't wait on OneDrive for a choice we already have; pick up a change made on another device next visit.
    void loadRemotePointer()
      .then((remote) => {
        const still = readLocal();
        const sameFolder = still && still.driveId === local.driveId && still.rootId === local.rootId;
        if (remote && sameFolder && (remote.driveId !== local.driveId || remote.rootId !== local.rootId)) writeLocal(remote);
      })
      .catch(() => undefined);
    return local;
  }
  const remote = await loadRemotePointer().catch(() => undefined);
  if (remote) writeLocal(remote);
  return remote;
}

/** Remembers the choice on this browser and, best effort, in the account. `undefined` forgets it everywhere. */
export async function savePointer(p: Pointer | undefined): Promise<void> {
  writeLocal(p);
  await saveRemotePointer(p).catch(() => false);
}

/** Forgets only this browser's copy (used on sign-out so the account keeps its choice). */
export const forgetLocalPointer = () => writeLocal(undefined);

/** A picked folder is either the workspace root (holding year folders) or one of its year folders. */
export async function pointerFromFolder(folder: FolderEntry): Promise<Pointer> {
  if (YEAR_FOLDER_RE.test(folder.name)) return { driveId: folder.driveId, rootId: await parentOf(folder.driveId, folder.itemId), year: folder.name };
  return { driveId: folder.driveId, rootId: folder.itemId };
}

/** The chosen folder has no ledger year yet; the person can start one. */
export class NoLedgerYearError extends Error {
  constructor(readonly pointer: Pointer) {
    super("This folder has no school year set up yet.");
  }
}

/** Creates `<root>/<label>/` (if needed) with its ledger folders. */
export async function startYear(pointer: Pointer, label: string): Promise<Pointer> {
  if (!YEAR_FOLDER_RE.test(label)) throw new Error("Use the form 2026-2027.");
  const yearId = await ensureFolder(pointer.driveId, pointer.rootId, label);
  await ensureLedgerFolders(pointer.driveId, yearId);
  return { ...pointer, year: label };
}

export interface OpenWorkspace {
  pointer: Pointer;
  years: YearInfo[];
  year: YearInfo;
  driveId: string;
  ledger: Ledger;
  store: OneDriveEventStore;
  eventsId: string;
  /** True when this was built from the browser's cache and still needs `revalidate`. */
  fromCache?: boolean;
  /** What was copied in from an earlier year on this open (unsaved until the ledger is flushed). */
  carried: CarryResult;
  /** Set when this year is still kept in Excel and is only being viewed (see legacyYear.ts). Everything else is read-only then. */
  legacy?: LegacyState;
}

/** Opens the pointer's chosen (else newest ledger) year and loads its events. */
export async function openWorkspace(pointer: Pointer, clientId: string, yearLabel?: string): Promise<OpenWorkspace> {
  const years = await listYears(pointer.driveId, pointer.rootId);
  const ledgerYears = years.filter((y) => y.kind === "ledger");
  const want = yearLabel ?? pointer.year;
  // A year still kept in Excel is viewed from the workbook, read-only; it is never opened as a ledger.
  const excelYear = years.find((y) => y.kind === "legacy-excel" && y.label === want);
  if (excelYear) return openLegacyWorkspace(pointer, years, excelYear, clientId);
  const year = ledgerYears.find((y) => y.label === want) ?? ledgerYears[ledgerYears.length - 1];
  if (!year) throw new NoLedgerYearError(pointer);
  const folders = (await openLedgerFolders(pointer.driveId, year.folderId))!;
  const store = new OneDriveEventStore(pointer.driveId, folders.eventsId, clientId);
  const ledger = new Ledger(store, new HlcClock(clientId), "web");
  await ledger.refresh();
  const carried = Object.keys(ledger.state.children).length ? { children: 0, paymentMethods: 0 } : await carryOver(pointer, ledger, years.filter((y) => y.kind !== "empty"), year.label, clientId);
  return { pointer: { ...pointer, year: year.label }, years, year, driveId: pointer.driveId, ledger, store, eventsId: folders.eventsId, carried };
}

export interface CarryResult {
  children: number;
  paymentMethods: number;
  /** Why an earlier year could not be used (shown to the person so a silent miss is never a mystery). */
  problems?: string[];
}

type TableJson = { values: unknown[][] };

/** Reads the students (name and program) from an old year's tracking workbook, read-only, through OneDrive's Excel service. */
async function readLegacyChildren(driveId: string, year: YearInfo): Promise<Array<{ name: string; scholarship?: string }>> {
  if (!year.workbookName) return [];
  const book = await findChild(driveId, year.folderId, year.workbookName);
  if (!book) throw new Error(`${year.workbookName} was not found`);
  const tables = `/drives/${driveId}/items/${book.id}/workbook/tables`;
  // The children table is normally "Table2"; if it was renamed, any table with a "Children" column will do.
  const names = [CHILDREN_TABLE, ...(await graphJson<{ value: Array<{ name: string }> }>(`${tables}?$select=name`)).value.map((t) => t.name).filter((n) => n !== CHILDREN_TABLE)];
  for (const name of names) {
    let head: TableJson;
    try {
      head = await graphJson<TableJson>(`${tables}/${encodeURIComponent(name)}/headerRowRange?$select=values`);
    } catch (err) {
      if (err instanceof GraphError && err.status === 404) continue;
      throw err;
    }
    const headers = (head.values[0] ?? []).map((h) => String(h).trim().toLowerCase());
    const nameAt = headers.indexOf("children");
    if (nameAt < 0) continue;
    const programAt = headers.indexOf("scholarship");
    const rows = await graphJson<{ value: Array<{ values: unknown[][] }> }>(`${tables}/${encodeURIComponent(name)}/rows?$select=values`);
    return rows.value
      .map((r) => ({ name: String(r.values[0]?.[nameAt] ?? "").trim(), scholarship: programAt >= 0 ? String(r.values[0]?.[programAt] ?? "").trim() : "" }))
      .filter((c) => c.name)
      .map((c) => ({ name: c.name, ...(c.scholarship ? { scholarship: c.scholarship } : {}) }));
  }
  throw new Error(`${year.workbookName} has no table with a "Children" column`);
}

/** A new year starts empty: copy the students, payment methods and tax rate from the most recent earlier year that has students (read-only on that year). */
async function carryOver(pointer: Pointer, ledger: Ledger, years: YearInfo[], current: string, clientId: string, force = false): Promise<CarryResult> {
  const earlier = years.filter((y) => y.label < current).sort((a, b) => b.label.localeCompare(a.label));
  const problems: string[] = [];
  const named = () => {
    if (!force || ledger.state.settings["year"]?.year === undefined) ledger.set("setting", "year", { year: current }, { label: "setting.yearNamed" });
  };
  for (const y of earlier) {
    if (y.kind === "ledger") {
      try {
        const folders = await openLedgerFolders(pointer.driveId, y.folderId);
        if (folders) {
          const past = new Ledger(new OneDriveEventStore(pointer.driveId, folders.eventsId, clientId), new HlcClock(clientId), "web");
          await past.refresh();
          if (Object.keys(past.state.children).length) {
            const copied = copyYearSetup(ledger, past.state);
            named();
            return copied;
          }
        }
      } catch (err) {
        problems.push(`${y.label}: ${err instanceof Error ? err.message : err}`);
      }
    }
    // A year kept in (or alongside) the old Excel workbook: its students are in the workbook's children table.
    if (y.workbookName) {
      try {
        const kids = await readLegacyChildren(pointer.driveId, y);
        if (kids.length) {
          const children = copyLegacyChildren(ledger, kids);
          named();
          return { children, paymentMethods: 0 };
        }
        problems.push(`${y.label}: the workbook's children table is empty`);
      } catch (err) {
        problems.push(`${y.label}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }
  if (!earlier.length) problems.push("there is no earlier school year folder");
  return { children: 0, paymentMethods: 0, problems };
}

/**
 * Copies the students (and payment methods, tax rate) from the most recent earlier year into the open one. Only adds
 * what is missing, so it is safe to run again. The caller flushes the ledger.
 */
export async function copyFromPreviousYear(ws: OpenWorkspace, clientId: string): Promise<CarryResult> {
  const ledgerYears = ws.years.filter((y) => y.kind !== "empty");
  return carryOver(ws.pointer, ws.ledger, ledgerYears, ws.year.label, clientId, true);
}

/** True when an earlier school year exists to copy from. */
export const hasEarlierYear = (ws: OpenWorkspace): boolean => ws.years.some((y) => y.kind !== "empty" && y.label < ws.year.label);

/** Builds the workspace from what this browser remembered: no network, so the first paint is instant. Call `revalidate` next. */
export function openFromCache(pointer: Pointer, clientId: string, rec: WorkspaceCache, years: YearInfo[] = rec.years): OpenWorkspace | undefined {
  const year = years.find((y) => y.label === rec.yearLabel);
  if (!year) return undefined;
  if (rec.legacy) return openLegacyFromCache(pointer, years, year, clientId, rec.legacy);
  const store = new OneDriveEventStore(pointer.driveId, rec.eventsId, clientId);
  store.seedCache(rec.logs);
  const ledger = new Ledger(store, new HlcClock(clientId), "web");
  ledger.loadKnown(store.cachedEvents());
  return { pointer: { ...pointer, year: year.label }, years, year, driveId: pointer.driveId, ledger, store, eventsId: rec.eventsId, fromCache: true, carried: { children: 0, paymentMethods: 0 } };
}

/** Brings a cache-built workspace up to date: re-lists the years and downloads only the logs whose ETag changed. Returns whether anything changed. */
export async function revalidate(ws: OpenWorkspace): Promise<boolean> {
  if (ws.legacy) {
    ws.years = await listYears(ws.pointer.driveId, ws.pointer.rootId);
    const changed = await refreshLegacy(ws);
    ws.fromCache = false;
    return changed;
  }
  const before = JSON.stringify([ws.ledger.state, ws.years]);
  ws.years = await listYears(ws.pointer.driveId, ws.pointer.rootId);
  await ws.ledger.refresh();
  ws.fromCache = false;
  // Opening from the cache skips the carry-over done on a fresh open, so a new year would stay without its students.
  ws.carried = { children: 0, paymentMethods: 0 };
  if (!Object.keys(ws.ledger.state.children).length) ws.carried = await copyFromPreviousYear(ws, ws.ledger.store.clientId);
  return JSON.stringify([ws.ledger.state, ws.years]) !== before;
}

export function snapshotFor(ws: OpenWorkspace, reference?: CategoryReference): WorkspaceCache {
  const l = ws.legacy;
  if (l) {
    const { itemId, name, eTag, webUrl } = l.workbook;
    const workbook = { itemId, name, ...(eTag ? { eTag } : {}), ...(webUrl ? { webUrl } : {}) };
    return { v: 1, years: ws.years, yearLabel: ws.year.label, eventsId: "", logs: [], legacy: { input: l.year.input, choices: l.year.choices, workbook, readAt: l.readAt }, savedAt: Date.now() };
  }
  return { v: 1, years: ws.years, yearLabel: ws.year.label, eventsId: ws.eventsId, logs: ws.store.exportCache(), ...(reference ? { snapshot: reference } : {}), savedAt: Date.now() };
}

/** The workspace root as a shareable folder entry. */
export async function workspaceFolder(pointer: Pointer): Promise<FolderEntry> {
  const item = await graphJson<{ name: string }>(`/drives/${pointer.driveId}/items/${pointer.rootId}?$select=name`);
  return { driveId: pointer.driveId, itemId: pointer.rootId, name: item.name };
}

/** The saved folder no longer exists or this account can no longer reach it (deleted, moved out of reach, or access removed). */
export function isDeadPointer(err: unknown): boolean {
  return err instanceof GraphError && [400, 403, 404, 410].includes(err.status);
}
