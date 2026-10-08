import "dotenv/config";
import { launchStepUpSession } from "./form/browser.js";
import { dumpFormFields, printFieldTable } from "./form/inspect.js";
import { closePrompt, waitForEnter } from "./form/pause.js";
import { acquireStepUpLock } from "./stepupLock.js";
import { attachVendorListingListener } from "./vendorListingSync.js";

/**
 * Live discovery tool: opens the StepUp site, lets you log in and click through
 * the real application manually, and on request dumps the current page's field
 * structure (labels/names/ids/selectors — never values) so we can build
 * config/form-config.json together against the real form.
 */
async function main() {
  const lock = await acquireStepUpLock(); // StepUp does not like two sessions on one account
  const { context, page } = await launchStepUpSession();
  // Passive bonus: exploration sessions often open the "Who did you pay?" dropdown too, so
  // may as well accumulate vendor data from that while we're here (no spreadsheet writes,
  // just a local cache — unlike statusSync/categorySync, kept out of this lightweight tool).
  attachVendorListingListener(page);

  console.log("Log into StepUp manually in the opened browser window.");
  while (true) {
    const answer = await waitForEnter(
      'Navigate to whichever page you want inspected, then press Enter to dump its fields (or type "done" to quit).'
    );
    if (/^done$/i.test(answer)) break;
    const fields = await dumpFormFields(page);
    printFieldTable(fields);
  }

  closePrompt();
  await context.close();
  await lock.release();
}

main().catch((err) => {
  console.error("Inspection session failed:", err.message ?? err);
  process.exit(1);
});
