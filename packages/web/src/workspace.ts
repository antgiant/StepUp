import {
  HlcClock,
  Ledger,
  OneDriveEventStore,
  copyYearSetup,
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
  type Pointer,
  type YearInfo,
} from "@step-up/shared/web";

import type { WorkspaceCache } from "./cache.js";

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
  carried: { children: number; paymentMethods: number };
}

/** Opens the pointer's chosen (else newest ledger) year and loads its events. */
export async function openWorkspace(pointer: Pointer, clientId: string, yearLabel?: string): Promise<OpenWorkspace> {
  const years = await listYears(pointer.driveId, pointer.rootId);
  const ledgerYears = years.filter((y) => y.kind === "ledger");
  const want = yearLabel ?? pointer.year;
  const year = ledgerYears.find((y) => y.label === want) ?? ledgerYears[ledgerYears.length - 1];
  if (!year) throw new NoLedgerYearError(pointer);
  const folders = (await openLedgerFolders(pointer.driveId, year.folderId))!;
  const store = new OneDriveEventStore(pointer.driveId, folders.eventsId, clientId);
  const ledger = new Ledger(store, new HlcClock(clientId), "web");
  await ledger.refresh();
  const carried = Object.keys(ledger.state.children).length ? { children: 0, paymentMethods: 0 } : await carryOver(pointer, ledger, ledgerYears, year.label, clientId);
  return { pointer: { ...pointer, year: year.label }, years, year, driveId: pointer.driveId, ledger, store, eventsId: folders.eventsId, carried };
}

/** A new year starts empty: copy the students, payment methods and tax rate from the most recent earlier year that has students (read-only on that year). */
async function carryOver(pointer: Pointer, ledger: Ledger, ledgerYears: YearInfo[], current: string, clientId: string): Promise<{ children: number; paymentMethods: number }> {
  const earlier = ledgerYears.filter((y) => y.label < current).sort((a, b) => b.label.localeCompare(a.label));
  for (const y of earlier) {
    const folders = await openLedgerFolders(pointer.driveId, y.folderId);
    if (!folders) continue;
    const past = new Ledger(new OneDriveEventStore(pointer.driveId, folders.eventsId, clientId), new HlcClock(clientId), "web");
    await past.refresh();
    if (!Object.keys(past.state.children).length) continue;
    const copied = copyYearSetup(ledger, past.state);
    ledger.set("setting", "year", { year: current }, { label: "setting.yearNamed" });
    return copied;
  }
  return { children: 0, paymentMethods: 0 };
}

/** Builds the workspace from what this browser remembered: no network, so the first paint is instant. Call `revalidate` next. */
export function openFromCache(pointer: Pointer, clientId: string, rec: WorkspaceCache): OpenWorkspace | undefined {
  const year = rec.years.find((y) => y.label === rec.yearLabel);
  if (!year) return undefined;
  const store = new OneDriveEventStore(pointer.driveId, rec.eventsId, clientId);
  store.seedCache(rec.logs);
  const ledger = new Ledger(store, new HlcClock(clientId), "web");
  ledger.loadKnown(store.cachedEvents());
  return { pointer: { ...pointer, year: year.label }, years: rec.years, year, driveId: pointer.driveId, ledger, store, eventsId: rec.eventsId, fromCache: true, carried: { children: 0, paymentMethods: 0 } };
}

/** Brings a cache-built workspace up to date: re-lists the years and downloads only the logs whose ETag changed. Returns whether anything changed. */
export async function revalidate(ws: OpenWorkspace): Promise<boolean> {
  const before = JSON.stringify([ws.ledger.state, ws.years]);
  ws.years = await listYears(ws.pointer.driveId, ws.pointer.rootId);
  await ws.ledger.refresh();
  ws.fromCache = false;
  return JSON.stringify([ws.ledger.state, ws.years]) !== before;
}

export function snapshotFor(ws: OpenWorkspace): WorkspaceCache {
  return { v: 1, years: ws.years, yearLabel: ws.year.label, eventsId: ws.eventsId, logs: ws.store.exportCache(), savedAt: Date.now() };
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
