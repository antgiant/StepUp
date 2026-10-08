import {
  HlcClock,
  Ledger,
  OneDriveEventStore,
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
  const remote = await loadRemotePointer().catch(() => undefined);
  if (remote) writeLocal(remote);
  return remote ?? readLocal();
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
}

/** Opens the pointer's chosen (else newest ledger) year and loads its events. */
export async function openWorkspace(pointer: Pointer, clientId: string, yearLabel?: string): Promise<OpenWorkspace> {
  const years = await listYears(pointer.driveId, pointer.rootId);
  const ledgerYears = years.filter((y) => y.kind === "ledger");
  const want = yearLabel ?? pointer.year;
  const year = ledgerYears.find((y) => y.label === want) ?? ledgerYears[ledgerYears.length - 1];
  if (!year) throw new NoLedgerYearError(pointer);
  const folders = (await openLedgerFolders(pointer.driveId, year.folderId))!;
  const ledger = new Ledger(new OneDriveEventStore(pointer.driveId, folders.eventsId, clientId), new HlcClock(clientId), "web");
  await ledger.refresh();
  return { pointer: { ...pointer, year: year.label }, years, year, driveId: pointer.driveId, ledger };
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
