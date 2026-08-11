import "dotenv/config";
import path from "node:path";
import { launchStepUpSession } from "./form/browser.js";
import { waitForEnter } from "./form/pause.js";
import {
  fillItemDetails,
  itemDetectionFailed,
  readReimbursementId,
  selectStudent,
  uploadFile,
} from "./form/reimbursementFlow.js";
import {
  downloadItem,
  getTableHeaderRow,
  getTableRows,
  listFolderChildren,
  resolveShareLink,
  updateTableRowByIndex,
  type FolderChild,
} from "./graph/onedrive.js";
import { attachCategoryTreeListener } from "./categorySync.js";
import { buildGroups, loadUnfiledRows, type ReimbursementGroup } from "./reimbursements.js";
import { attachStatusSyncListener } from "./statusSync.js";

const TABLE1 = "Table1";
const STATUSES_TABLE = "Table3";
// All current children are FES-UA; per your note, once other programs are supported this
// should come from a "Program" column on the row instead of a fixed constant.
const DEFAULT_PROGRAM = "FES-UA";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name} in .env`);
  return value;
}

function findFile(children: FolderChild[], name: string): FolderChild {
  const match = children.find((c) => c.name === name);
  if (!match) throw new Error(`File "${name}" not found in the reference files folder.`);
  return match;
}

async function main() {
  console.log("Resolving OneDrive links...");
  const excelRef = await resolveShareLink(requireEnv("ONEDRIVE_EXCEL_URL"));
  const folderRef = await resolveShareLink(requireEnv("ONEDRIVE_FILES_FOLDER_URL"));

  const rows = await loadUnfiledRows(excelRef);
  console.log(`Found ${rows.length} row(s) with Status = "Unfiled (Ready to Submit)".`);
  if (rows.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  const groups = await buildGroups(rows, async (row, candidates) => {
    console.log(`\nRow ID ${row.data["ID"]} ("${row.data["Item"]}") has multiple documentation files with no clear match:`);
    candidates.forEach((f, i) => console.log(`  [${i}] ${f}`));
    const answer = await waitForEnter("Type the number of the file that should be uploaded first (the main receipt):");
    const idx = Number(answer);
    if (Number.isNaN(idx) || !candidates[idx]) throw new Error(`Invalid selection "${answer}".`);
    return candidates[idx];
  });
  console.log(`\nBuilt ${groups.length} submission group(s).`);

  const folderChildren = await listFolderChildren(folderRef);
  const table1Headers = await getTableHeaderRow(excelRef, TABLE1);
  const dataDir = path.resolve(process.cwd(), "data");

  const { context, page } = await launchStepUpSession();
  console.log("\nBrowser opened to the StepUp site.");

  attachStatusSyncListener(page, excelRef);
  attachCategoryTreeListener(page, excelRef);

  const statusRows = await getTableRows(excelRef, STATUSES_TABLE);
  const validStatuses = statusRows.map((r) => String(r[0] ?? "")).filter(Boolean);
  console.log(`\nValid Status values (from ${STATUSES_TABLE}): ${validStatuses.join(" | ")}`);
  const submittedStatus = await waitForEnter(
    "Type the exact Status value to set on rows once actually submitted (will be reused for every group this run):"
  );
  if (!validStatuses.includes(submittedStatus.trim())) {
    throw new Error(`"${submittedStatus}" isn't one of the valid Status values listed above.`);
  }

  for (const [i, group] of groups.entries()) {
    console.log(`\n=== Group ${i + 1} of ${groups.length}: ${group.child} — ${group.mainReceiptFile} ===`);
    group.rows.forEach((r) =>
      console.log(`  ID ${r.data["ID"]}: "${r.data["Item"]}" — $${r.data["Amount"] || "?"}`)
    );

    const proceed = await waitForEnter('Press Enter to start this group, or type "skip" to move to the next one.');
    if (/^skip$/i.test(proceed)) continue;

    await runGroup(page, group, excelRef, folderRef, folderChildren, dataDir, submittedStatus.trim(), table1Headers);
  }

  await waitForEnter("All groups processed. Press Enter to close the browser and exit.");
  await context.close();
}

async function runGroup(
  page: Awaited<ReturnType<typeof launchStepUpSession>>["page"],
  group: ReimbursementGroup,
  excelRef: Awaited<ReturnType<typeof resolveShareLink>>,
  folderRef: Awaited<ReturnType<typeof resolveShareLink>>,
  folderChildren: FolderChild[],
  dataDir: string,
  submittedStatus: string,
  table1Headers: string[]
): Promise<void> {
  await waitForEnter(
    `Log in / navigate to a new reimbursement request in StepUp. Press Enter once you're on the student picker.`
  );
  await selectStudent(page, `${group.child} : ${DEFAULT_PROGRAM}`);
  await waitForEnter("Review the student selection, then click Continue yourself. Press Enter once you're on the Receipt/Invoice Upload page.");

  const mainReceiptChild = findFile(folderChildren, group.mainReceiptFile);
  const mainReceiptPath = path.join(dataDir, group.mainReceiptFile);
  await downloadItem(folderRef.driveId, mainReceiptChild.id, mainReceiptPath);
  await uploadFile(page, mainReceiptPath);
  await waitForEnter("Review the upload, then click Continue yourself. Press Enter once processing finishes (or you see a 'not detected' message).");

  if (await itemDetectionFailed(page)) {
    console.log(
      "\nStepUp couldn't detect items on this document. You can upload a different document, or continue and manually " +
        `click "Add an Item" ${group.rows.length} time(s) on the Item/Service Details screen.`
    );
    await waitForEnter("Handle that in the browser, then press Enter once you're on the Item/Service Details screen (with the right number of item blocks added).");
  } else {
    console.log("\nManually check the box(es) for these row(s) on the Item/Service Selection screen:");
    group.rows.forEach((r) => console.log(`  ID ${r.data["ID"]}: "${r.data["Item"]}" — $${r.data["Amount"] || "?"}`));
    await waitForEnter("Then click Continue yourself. Press Enter once you're on the Item/Service Details screen.");
  }

  const { matchedRows, unmatchedBlockIndexes } = await fillItemDetails(page, group.rows);
  if (unmatchedBlockIndexes.length > 0) {
    console.log(`\n${unmatchedBlockIndexes.length} item block(s) had no candidate row left — fill those in manually.`);
  }
  await waitForEnter("Review the filled details, then click Continue yourself. Press Enter once you're on Additional Documents.");

  if (group.additionalFiles.length > 0) {
    const additionalPaths: string[] = [];
    for (const fileName of group.additionalFiles) {
      const child = findFile(folderChildren, fileName);
      const localPath = path.join(dataDir, fileName);
      await downloadItem(folderRef.driveId, child.id, localPath);
      additionalPaths.push(localPath);
    }
    await uploadFile(page, additionalPaths);
    console.log(`Uploaded ${additionalPaths.length} additional document(s): ${group.additionalFiles.join(", ")}`);
  } else {
    console.log("No additional documents for this group.");
  }
  await waitForEnter("Review, then click Continue to Summary yourself. Press Enter once you're on the Summary page.");

  await waitForEnter(
    "Review everything on the Summary page carefully, then click \"Submit for approval\" yourself when ready. Press Enter once you see the confirmation screen with a Reimbursement #."
  );
  const reimbursementId = await readReimbursementId(page);
  console.log(`Captured Reimbursement #${reimbursementId}.`);

  const today = new Date().toISOString().slice(0, 10);
  for (const [idx, row] of matchedRows.entries()) {
    await updateTableRowByIndex(excelRef, TABLE1, row.rowIndex, row.rawValues, table1Headers, {
      Status: submittedStatus,
      Submitted: today,
      "Reimbursement ID": reimbursementId,
      "Line Number": String(idx + 1),
    });
  }
  console.log(`Updated ${matchedRows.length} row(s) in the spreadsheet.`);
}

main().catch((err) => {
  console.error("\nRun failed:", err.message ?? err);
  process.exit(1);
});
