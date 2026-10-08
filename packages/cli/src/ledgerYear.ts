import { HlcClock, Ledger, OneDriveEventStore, listYears, openLedgerFolders, parentOf, resolveShareLink, type YearInfo } from "@step-up/shared";
import "./graph/client.js"; // registers the Node token provider
import { getClientId } from "./clientId.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name} (see .env.example).`);
  return value;
}

export interface OpenedYear {
  driveId: string;
  year: YearInfo;
  ledger: Ledger;
}

/** Opens a ledger year from OneDrive and loads its events. Fails for years that are not ledger years. */
export async function openYearLedger(label: string): Promise<OpenedYear> {
  const current = await resolveShareLink(requireEnv("ONEDRIVE_FILES_FOLDER_URL"));
  const driveId = current.driveId;
  const rootId = await parentOf(driveId, current.itemId);
  const year = (await listYears(driveId, rootId)).find((y) => y.label === label);
  if (!year) throw new Error(`No year folder named "${label}".`);
  if (year.kind !== "ledger") throw new Error(`${label} is not set up for the ledger yet. Run: npm run year -- init ${label} --apply`);
  const folders = (await openLedgerFolders(driveId, year.folderId))!;
  const clientId = await getClientId();
  const ledger = new Ledger(new OneDriveEventStore(driveId, folders.eventsId, clientId), new HlcClock(clientId), "cli");
  await ledger.refresh();
  return { driveId, year, ledger };
}
