import "dotenv/config";
import { connectToStepUpSession } from "./form/browser.js";
import { waitForLogin } from "./form/reimbursementFlow.js";
import { closePrompt, waitForEnter } from "./form/pause.js";
import { startConnectionHeartbeat } from "./form/browserPrompt.js";
import { resolveShareLink } from "./graph/onedrive.js";
import { ExcelStore } from "./filing/excelStore.js";
import { LedgerStore } from "./filing/ledgerStore.js";
import type { FilingStore } from "./filing/store.js";
import { openYearLedger } from "./ledgerYear.js";
import { acquireStepUpLock } from "./stepupLock.js";
import { getClientId } from "./clientId.js";
import { getSignedInName } from "./graph/auth.js";
import { attachSearchCapture } from "./statusSync.js";
import { archiveSearchResults, useArchiveYear } from "./stepUpArchive.js";
import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Brings the statuses (and what StepUp said about each item) up to date without filing anything:
 *
 *   npm run statuses                               the spreadsheet in .env
 *   npm run statuses -- --ledger=2026-2027         that year's ledger
 *   npm run statuses -- --capture-only             keep StepUp's raw list responses in .cache/ and write nothing
 *   npm run statuses -- --from-capture [--ledger=Y]  apply the last capture to the spreadsheet / ledger; no browser or login
 *   add --dry-run to the spreadsheet form to list what would change without writing
 *
 * You log in to StepUp in the browser that opens, then open the Reimbursements list (scroll through it so every page
 * loads). The list's own requests are what get read; this never starts, edits or submits a reimbursement.
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name} in .env`);
  return value;
}

async function chooseStore(): Promise<FilingStore> {
  const ledger = process.argv.find((a) => a.startsWith("--ledger="));
  if (ledger) {
    const me = { actor: await getSignedInName(), clientId: await getClientId() };
    return new LedgerStore(await openYearLedger(ledger.slice("--ledger=".length)), me);
  }
  return new ExcelStore(await resolveShareLink(requireEnv("ONEDRIVE_EXCEL_URL")), await resolveShareLink(requireEnv("ONEDRIVE_FILES_FOLDER_URL")));
}

async function applyCapture(): Promise<void> {
  const file = path.resolve(process.cwd(), ".cache", "stepup-search-responses.json");
  const saved = JSON.parse(await readFile(file, "utf-8")) as Record<string, { result: unknown }>;
  const results = Object.values(saved).map((v) => v.result);
  const store = await chooseStore();
  console.log(`Applying ${results.length} captured reimbursement(s) to ${store.describe}...`);
  await archiveSearchResults(results);
  const changed = await store.applyStatusResponse({ Results: results as never });
  await store.finish();
  console.log(`Updated ${changed} row(s).`);
}

async function main() {
  if (process.argv.includes("--from-capture")) return applyCapture().then(() => process.exit(0));
  const captureOnly = process.argv.includes("--capture-only");
  const lock = await acquireStepUpLock();
  try {
    const store = captureOnly ? undefined : await chooseStore();
    if (store) console.log(`Syncing statuses into ${store.describe}.`);
    else console.log("Capture only: nothing will be written to the spreadsheet or the ledger.");

    const { page } = await connectToStepUpSession();
    startConnectionHeartbeat(page);
    if (store) store.attachListeners(page);
    else attachSearchCapture(page);

    console.log("Log in to StepUp in the browser window, then open the Reimbursements list.");
    await waitForLogin(page);
    while (true) {
      const answer = await waitForEnter('Open the Reimbursements list and scroll to the end of it so every page loads. Press Enter to load it again, or type "done" to finish.');
      if (/^done$/i.test(answer)) break;
    }
    await store?.finish();
  } finally {
    closePrompt();
    await lock.release();
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("Status sync failed:", err.message ?? err);
  process.exit(1);
});
