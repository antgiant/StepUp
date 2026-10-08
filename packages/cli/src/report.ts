import "dotenv/config";
import { LedgerStore } from "./filing/ledgerStore.js";
import { openYearLedger } from "./ledgerYear.js";

/**
 * npm run report -- 2026-2027
 * Rebuilds that year's mirror spreadsheet from its ledger (the same file the web app and the filing run keep current).
 * Read-only apart from writing the spreadsheet into the year's reports folder.
 */
async function main() {
  const label = process.argv.slice(2).find((a) => /^\d{4}-\d{4}$/.test(a));
  if (!label) throw new Error("Usage: npm run report -- <year>   e.g. npm run report -- 2026-2027");
  const opened = await openYearLedger(label);
  const store = new LedgerStore(opened);
  await store.rebuildMirror();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
