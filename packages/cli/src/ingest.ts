import "dotenv/config";
import {
  HlcClock,
  Ledger,
  OneDriveEventStore,
  guessContentKind,
  listLooseFiles,
  listYears,
  openLedgerFolders,
  parentOf,
  planIngest,
  registerLooseFiles,
  resolveShareLink,
} from "@step-up/shared";
import "./graph/client.js"; // registers the Node token provider
import { getClientId } from "./clientId.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name} (see .env.example).`);
  return value;
}

/**
 * npm run ingest -- 2026-2027            show the loose files that are not yet in the ledger (nothing is written)
 * npm run ingest -- 2026-2027 --apply    register them as documents so they appear in the entry queue
 * Files are never moved, renamed or deleted.
 */
async function main() {
  const [label, ...flags] = process.argv.slice(2);
  if (!label) throw new Error("Usage: npm run ingest -- <year> [--apply]");
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

  const loose = await listLooseFiles(driveId, year.folderId);
  const plan = planIngest(ledger.state, loose);
  console.log(`${label}: ${loose.length} loose file(s); ${plan.alreadyKnown} already registered, ${plan.toRegister.length} new.`);
  for (const f of plan.toRegister) console.log(`  ${guessContentKind(f.name).padEnd(13)} ${(f.size / 1024).toFixed(0).padStart(6)} KB  ${f.name}`);

  if (plan.toRegister.length === 0) return;
  if (!flags.includes("--apply")) {
    console.log("\nNothing written. Re-run with --apply to register these in the ledger (files stay where they are).");
    return;
  }
  registerLooseFiles(ledger, plan.toRegister);
  await ledger.flush();
  console.log(`\nRegistered ${plan.toRegister.length} document(s) as ${clientId}.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
