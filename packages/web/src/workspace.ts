import {
  HlcClock,
  Ledger,
  OneDriveEventStore,
  YEAR_FOLDER_RE,
  listYears,
  openLedgerFolders,
  parentOf,
  resolveShareLink,
  type YearInfo,
} from "@step-up/shared/web";

const KEY = "stepup.workspace.v1";

export interface Pointer {
  driveId: string;
  rootId: string;
  year?: string;
}

export function loadPointer(): Pointer | undefined {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "null") ?? undefined;
  } catch {
    return undefined;
  }
}

export function savePointer(p: Pointer | undefined): void {
  try {
    if (p) localStorage.setItem(KEY, JSON.stringify(p));
    else localStorage.removeItem(KEY);
  } catch {
    /* storage blocked: the pointer just isn't remembered */
  }
}

/** Turns a OneDrive sharing link to the workspace folder (or to one of its year folders) into a pointer. */
export async function pointerFromLink(link: string): Promise<Pointer> {
  const ref = await resolveShareLink(link.trim());
  if (!ref.isFolder) throw new Error("That link is to a file; share the StepUp folder (or a year folder) instead.");
  if (YEAR_FOLDER_RE.test(ref.name)) return { driveId: ref.driveId, rootId: await parentOf(ref.driveId, ref.itemId), year: ref.name };
  return { driveId: ref.driveId, rootId: ref.itemId };
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
  if (!year) throw new Error("No year in that folder is set up for the ledger yet (run `npm run year -- init <year> --apply` from the CLI).");
  const folders = (await openLedgerFolders(pointer.driveId, year.folderId))!;
  const ledger = new Ledger(new OneDriveEventStore(pointer.driveId, folders.eventsId, clientId), new HlcClock(clientId), "web");
  await ledger.refresh();
  return { pointer: { ...pointer, year: year.label }, years, year, driveId: pointer.driveId, ledger };
}
