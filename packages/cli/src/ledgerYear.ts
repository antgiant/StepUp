import { HlcClock, Ledger, StorageEventStore, listYears, openLedgerFolders, type StorageProvider, type YearInfo } from "@step-up/shared";
import { getClientId } from "./clientId.js";
import { locateWorkspace } from "./storage/index.js";

export interface OpenedYear {
  storage: StorageProvider;
  driveId: string;
  year: YearInfo;
  ledger: Ledger;
}

/** Opens a ledger year from storage and loads its events. Fails for years that are not ledger years. */
export async function openYearLedger(label: string): Promise<OpenedYear> {
  const { storage, driveId, rootId } = await locateWorkspace();
  const year = (await listYears(storage, driveId, rootId)).find((y) => y.label === label);
  if (!year) throw new Error(`No year folder named "${label}".`);
  if (year.kind !== "ledger") throw new Error(`${label} is not set up for the ledger yet. Run: npm run year -- init ${label} --apply`);
  const folders = (await openLedgerFolders(storage, driveId, year.folderId))!;
  const clientId = await getClientId();
  const ledger = new Ledger(new StorageEventStore(storage, driveId, folders.eventsId, clientId), new HlcClock(clientId), "cli");
  await ledger.refresh();
  return { storage, driveId, year, ledger };
}
