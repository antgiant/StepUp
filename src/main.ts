import "dotenv/config";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadApplicant, markApplicantStatus } from "./applicants.js";
import { launchStepUpSession } from "./form/browser.js";
import type { FormConfig } from "./form/fieldMap.js";
import { fillPageAndConfirm } from "./form/fillAssist.js";
import { askYesNo, closePrompt, waitForEnter } from "./form/pause.js";
import { listFolderChildren, resolveShareLink } from "./graph/onedrive.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name} in .env`);
  return value;
}

async function loadConfig(): Promise<FormConfig> {
  const configPath = path.resolve(process.cwd(), "config", "form-config.json");
  try {
    const raw = await readFile(configPath, "utf-8");
    return JSON.parse(raw) as FormConfig;
  } catch (err) {
    throw new Error(
      `Couldn't read config/form-config.json (${(err as Error).message}). ` +
        `Copy config/form-config.example.json to config/form-config.json and fill it in using ` +
        `"npm run discover" (for Excel column/table names) and "npm run inspect" (for real form field selectors).`
    );
  }
}

async function main() {
  const matchValue = process.argv[2];
  if (!matchValue) {
    console.error('Usage: npm start -- "<value to match in the lookup column>"');
    console.error('Example: npm start -- "Jordan Smith"');
    process.exit(1);
  }

  const config = await loadConfig();

  console.log("Resolving OneDrive links...");
  const excelRef = await resolveShareLink(requireEnv("ONEDRIVE_EXCEL_URL"));
  const folderRef = await resolveShareLink(requireEnv("ONEDRIVE_FILES_FOLDER_URL"));

  console.log(`Looking up "${matchValue}" in "${config.matchColumn}"...`);
  const applicant = await loadApplicant(excelRef, config.tableName, config.matchColumn, matchValue);
  console.log(`Loaded applicant row (${applicant.headers.length} columns).`);

  const folderChildren = await listFolderChildren(folderRef);
  console.log(`Found ${folderChildren.length} item(s) in the reference files folder.`);

  const dataDir = path.resolve(process.cwd(), "data", matchValue.replace(/[^a-z0-9]+/gi, "_"));

  const { browser, page } = await launchStepUpSession();
  console.log("\nBrowser opened to the StepUp site.");

  for (const pageConfig of config.pages) {
    await waitForEnter(`Log in / navigate to the "${pageConfig.name}" page. Press Enter once it's loaded.`);
    await fillPageAndConfirm(page, pageConfig, applicant.data, folderRef, folderChildren, dataDir);
  }

  const finished = await askYesNo("Did you finish and submit the full application successfully?");
  if (finished && config.statusColumn) {
    const status = `Submitted ${new Date().toISOString().slice(0, 10)}`;
    await markApplicantStatus(
      excelRef,
      config.tableName,
      applicant.rowIndex,
      applicant.headers,
      applicant.rawValues,
      config.statusColumn,
      status
    );
    console.log(`Updated "${config.statusColumn}" to "${status}" in the spreadsheet.`);
  } else if (!finished) {
    console.log("Not marking status — rerun this applicant later to pick back up.");
  }

  await waitForEnter("Press Enter to close the browser and exit.");
  closePrompt();
  await browser.close();
}

main().catch((err) => {
  console.error("\nRun failed:", err.message ?? err);
  process.exit(1);
});
