import "dotenv/config";
import { launchStepUpSession } from "./form/browser.js";
import { dumpFormFields, printFieldTable } from "./form/inspect.js";
import { closePrompt, waitForEnter } from "./form/pause.js";

/**
 * Live discovery tool: opens the StepUp site, lets you log in and click through
 * the real application manually, and on request dumps the current page's field
 * structure (labels/names/ids/selectors — never values) so we can build
 * config/form-config.json together against the real form.
 */
async function main() {
  const { browser, page } = await launchStepUpSession();

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
  await browser.close();
}

main().catch((err) => {
  console.error("Inspection session failed:", err.message ?? err);
  process.exit(1);
});
