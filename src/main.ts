import "dotenv/config";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { connectToStepUpSession } from "./form/browser.js";
import { browserChoose, browserContinue, browserInfo } from "./form/browserPrompt.js";
import {
  autoCheckDetectedItems,
  checkForDashboardModal,
  clickContinue,
  ensureOnNewReimbursementForm,
  fillItemDetails,
  itemDetectionFailed,
  readReimbursementId,
  requestAnotherReimbursement,
  selectStudent,
  uploadFile,
  waitForLogin,
  waitForStep,
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
import { attachPreauthSyncListener } from "./preauthSync.js";
import {
  buildGroups,
  checkScholarshipEligibility,
  loadUnfiledRows,
  type ReimbursementGroup,
} from "./reimbursements.js";
import { attachStatusSyncListener } from "./statusSync.js";
import { attachVendorListingListener } from "./vendorListingSync.js";

const TABLE1 = "Table1";
const STATUSES_TABLE = "Table3";
const CHILDREN_TABLE = "Table2";
// Fallback when a child isn't found in Table2's Scholarship column at all.
const DEFAULT_PROGRAM = "FES-UA";
// Status written back to Table1 once a submission actually goes through.
const SUBMITTED_STATUS = "Submitted";
// Status written back when documentation turns out to be missing/wrong, so the row doesn't
// keep coming up as ready to submit until you've actually fixed it.
const MISSING_THINGS_STATUS = "Unfiled (Missing Things)";

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

/** One-line summary (student, item/description, cost) shown across every group-related prompt. */
function summarizeRow(r: { data: Record<string, string> }): string {
  const amount = r.data["Amount"] ? `$${r.data["Amount"]}` : "$?";
  const description = r.data["Description"]?.trim();
  const truncated = description && description.length > 80 ? `${description.slice(0, 80)}…` : description;
  const detail = truncated ? `${r.data["Item"]} — ${truncated}` : r.data["Item"];
  return `ID ${r.data["ID"]} · ${r.data["Child"]} · ${amount}: "${detail}"`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Downloads a candidate file and opens it in a new tab wrapped with a clear label (filename + the row it's being reviewed for), so it's obvious what you're looking at and why. */
async function openLabeledPreview(
  context: Awaited<ReturnType<typeof connectToStepUpSession>>["context"],
  folderRef: Awaited<ReturnType<typeof resolveShareLink>>,
  fileId: string,
  localPath: string,
  fileName: string,
  itemSummary: string
) {
  await downloadItem(folderRef.driveId, fileId, localPath);
  const wrapperPath = `${localPath}.preview.html`;
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(fileName)}</title></head>
<body style="margin:0;font-family:-apple-system,BlinkMacSystemFont,sans-serif;">
  <div data-stepup-header style="background:#1a2b4c;color:#fff;padding:12px 18px;font-size:15px;display:flex;align-items:center;justify-content:space-between;gap:16px;">
    <span>
      <div style="font-weight:600;">Candidate document: ${escapeHtml(fileName)}</div>
      <div style="font-weight:400;font-size:13px;opacity:.85;margin-top:2px;">For: ${escapeHtml(itemSummary)}</div>
    </span>
  </div>
  <iframe src="file://${localPath}" style="width:100%;height:calc(100vh - 62px);border:none;display:block;"></iframe>
</body></html>`;
  await writeFile(wrapperPath, html, "utf-8");
  const previewPage = await context.newPage();
  await previewPage.goto(`file://${wrapperPath}`);
  return previewPage;
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

  const mismatches = await checkScholarshipEligibility(excelRef, rows);
  if (mismatches.length > 0) {
    console.log(`\nWarning: ${mismatches.length} row(s) have a Category that doesn't list the child's Scholarship as eligible:`);
    for (const m of mismatches) {
      console.log(
        `  ID ${m.row.data["ID"]}: ${m.child} (${m.childScholarship}) — "${m.category}" is only eligible for: ${m.eligibleScholarships.join(", ")}`
      );
    }
    console.log("Not blocking — double-check these before submitting.");
  }

  const folderChildren = await listFolderChildren(folderRef);
  const table1Headers = await getTableHeaderRow(excelRef, TABLE1);
  const dataDir = path.resolve(process.cwd(), "data");

  const childrenRows = await getTableRows(excelRef, CHILDREN_TABLE);
  const scholarshipByChild = new Map<string, string>();
  for (const r of childrenRows) {
    const name = String(r[0] ?? "").trim();
    const scholarship = String(r[1] ?? "").trim();
    if (name && scholarship) scholarshipByChild.set(name, scholarship);
  }

  const { context, page } = await connectToStepUpSession();
  console.log("\nConnected to the browser server. If you haven't already, log in manually — no prompts will show until you land on the Dashboard.");

  attachStatusSyncListener(page, excelRef);
  attachCategoryTreeListener(page, excelRef);
  attachVendorListingListener(page);
  attachPreauthSyncListener(page, excelRef);

  const statusRows = await getTableRows(excelRef, STATUSES_TABLE);
  const validStatuses = statusRows.map((r) => String(r[0] ?? "")).filter(Boolean);
  if (!validStatuses.includes(SUBMITTED_STATUS)) {
    throw new Error(`"${SUBMITTED_STATUS}" isn't one of ${STATUSES_TABLE}'s valid Status values: ${validStatuses.join(" | ")}`);
  }

  await waitForLogin(page);
  console.log("\nLogged in. Prompts from here on show up as a banner at the bottom of the page.");
  await checkForDashboardModal(page);

  const groups = await buildGroups(rows, async (row, candidates) => {
    console.log(`\n${summarizeRow(row)} has multiple documentation files with no clear match.`);

    // Filenames alone often aren't enough to tell which is the actual receipt — open each
    // candidate in its own clearly-labeled tab so it can be visually reviewed before choosing,
    // and wire a "Use this document" button right into that tab's own header so it can be
    // picked directly from there instead of switching back to the main page.
    const previewByFile = new Map<string, Awaited<ReturnType<typeof openLabeledPreview>>>();
    for (const fileName of candidates) {
      const fileChild = folderChildren.find((c) => c.name === fileName);
      if (!fileChild) continue;
      const localPath = path.join(dataDir, fileName);
      previewByFile.set(
        fileName,
        await openLabeledPreview(context, folderRef, fileChild.id, localPath, fileName, summarizeRow(row))
      );
    }

    const WRONG_DOCUMENTATION = "__wrong_documentation__";
    const choice = await browserChoose(
      page,
      `${summarizeRow(row)} has multiple documentation files — each is now open in its own labeled tab for review. Which one should be uploaded first (the main receipt)?`,
      [
        ...candidates.map((f) => ({ label: f, value: f, page: previewByFile.get(f) })),
        { label: "None of these — documentation is wrong, I'll fix it in the spreadsheet", value: WRONG_DOCUMENTATION },
      ]
    );

    for (const t of previewByFile.values()) await t.close();

    if (choice === WRONG_DOCUMENTATION) {
      const today = new Date().toISOString().slice(0, 10);
      const note = `[${today}] Documentation files (${candidates.join(", ")}) don't clearly identify the main receipt — needs fixing in spreadsheet.`;
      const existingNotes = (row.data["Notes"] ?? "").trim();
      const updatedNotes = existingNotes ? `${existingNotes} | ${note}` : note;
      await updateTableRowByIndex(excelRef, TABLE1, row.rowIndex, row.rawValues, table1Headers, {
        Notes: updatedNotes,
        Status: MISSING_THINGS_STATUS,
      });
      console.log(`Marked row ID ${row.data["ID"]} as "${MISSING_THINGS_STATUS}" and noted the documentation issue.`);
      return null;
    }

    return choice;
  });
  console.log(`\nBuilt ${groups.length} submission group(s).`);

  let stoppedEarly = false;
  for (const [i, group] of groups.entries()) {
    console.log(`\n=== Group ${i + 1} of ${groups.length}: ${group.child} — ${group.mainReceiptFile} ===`);
    group.rows.forEach((r) => console.log(`  ${summarizeRow(r)}`));

    const rowsSummary = group.rows.map((r) => summarizeRow(r)).join("\n");
    const choice = await browserChoose(
      page,
      `Group ${i + 1} of ${groups.length}: ${group.child} — ${group.mainReceiptFile}\n${rowsSummary}`,
      [
        { label: "Start this group", value: "" },
        { label: "Skip", value: "skip" },
        { label: "Stop for now", value: "exit" },
      ]
    );
    if (choice === "skip") continue;
    if (choice === "exit") {
      console.log(`\nStopping early at group ${i + 1} of ${groups.length}, per your choice.`);
      stoppedEarly = true;
      break;
    }

    try {
      await runGroup(page, group, excelRef, folderRef, folderChildren, dataDir, table1Headers, scholarshipByChild);
    } catch (err) {
      const message = (err as Error).message;
      console.error(`\nGroup ${i + 1} failed: ${message}`);
      console.error("Skipping to the next group rather than aborting the whole run.");
      // A failure must be visible in the browser too, not just the terminal — otherwise you're
      // left looking at whatever page the failure happened on with no indication anything broke.
      // Blocking (not just informational) on purpose: gives you a chance to inspect the page —
      // e.g. a stray draft request StepUp may have created — before moving to the next group.
      await browserContinue(
        page,
        `Group ${i + 1} failed: ${message}\nSkipping to the next group — check this page's state before continuing. Click Continue to proceed.`
      ).catch(() => {
        console.error("(Also failed to show the failure banner in the browser — the page itself may be broken.)");
      });
    }
  }

  await browserContinue(
    page,
    stoppedEarly
      ? "Stopped early. Everything submitted so far is already saved — just re-run \"npm start\" later to pick up the rest. Click Continue to finish."
      : "All groups processed. Click Continue to finish. The browser stays open — re-run \"npm start\" for more rows, or click the \"All done — close browser\" button (top-right of the page) when you're fully done."
  );
  // Deliberately not closing `context`/`browser` here — this process only connected to the
  // shared browser server (browserServer.ts owns its lifecycle), it didn't launch it. Force an
  // explicit clean exit instead of letting the CDP connection's open socket keep the process alive.
  process.exit(0);
}

async function runGroup(
  page: Awaited<ReturnType<typeof connectToStepUpSession>>["page"],
  group: ReimbursementGroup,
  excelRef: Awaited<ReturnType<typeof resolveShareLink>>,
  folderRef: Awaited<ReturnType<typeof resolveShareLink>>,
  folderChildren: FolderChild[],
  dataDir: string,
  table1Headers: string[],
  scholarshipByChild: Map<string, string>
): Promise<void> {
  console.log(`\nNavigating to a new reimbursement request for ${group.child}...`);
  await ensureOnNewReimbursementForm(page);
  const program =
    group.rows[0].data["Program"]?.trim() || scholarshipByChild.get(group.child) || DEFAULT_PROGRAM;
  console.log(`Selecting student "${group.child} : ${program}"...`);
  await selectStudent(page, group.child, program);
  await clickContinue(page);
  await waitForStep(page, "upload");

  const mainReceiptChild = findFile(folderChildren, group.mainReceiptFile);
  const mainReceiptPath = path.join(dataDir, group.mainReceiptFile);
  await downloadItem(folderRef.driveId, mainReceiptChild.id, mainReceiptPath);
  console.log(`Uploading main receipt "${group.mainReceiptFile}"...`);
  await uploadFile(page, mainReceiptPath);
  console.log("Upload done, clicking Continue and waiting for StepUp's AI scan...");
  await clickContinue(page);
  await waitForStep(page, "itemSelection");
  console.log("On the Item/Service Selection screen.");

  if (await itemDetectionFailed(page)) {
    const rowsSummary = group.rows.map((r) => summarizeRow(r)).join("\n");
    console.log(
      `\nStepUp couldn't detect items on this document. Need ${group.rows.length} item block(s) for:\n${rowsSummary}`
    );
    console.log('Auto-clicking "Continue to Item/Service Details"...');
    await clickContinue(page);
    await browserInfo(
      page,
      `StepUp couldn't detect items on this document — already clicked Continue for you.\n` +
        `On this screen, click "Add an Item" ${group.rows.length} time(s) — one block for each of:\n${rowsSummary}`
    );
  } else {
    console.log("StepUp detected item(s) — attempting to auto-check the matching box(es)...");
    const allMatched = await autoCheckDetectedItems(page, group.rows);
    if (allMatched) {
      console.log("All detected item(s) matched and checked — auto-continuing.");
      await clickContinue(page);
    } else {
      console.log("\nSome item(s) couldn't be auto-matched — check/fix the box(es) for these row(s) yourself:");
      group.rows.forEach((r) => console.log(`  ${summarizeRow(r)}`));
      const rowsSummary = group.rows.map((r) => summarizeRow(r)).join("\n");
      await browserInfo(
        page,
        `Some item(s) couldn't be auto-matched. Check/fix the box(es) for these row(s), then click Continue yourself in StepUp:\n${rowsSummary}`
      );
    }
  }
  await waitForStep(page, "itemDetails");

  const { matchedRows, unmatchedBlockIndexes } = await fillItemDetails(page, group.rows);
  if (unmatchedBlockIndexes.length > 0) {
    console.log(`\n${unmatchedBlockIndexes.length} item block(s) had no candidate row left — fill those in manually.`);
  }
  await browserInfo(page, "Review the filled details, then click Continue yourself in StepUp.");
  await waitForStep(page, "additionalDocuments");

  if (group.additionalFiles.length > 0) {
    const additionalPaths: string[] = [];
    const missing: string[] = [];
    for (const fileName of group.additionalFiles) {
      const child = folderChildren.find((c) => c.name === fileName);
      if (!child) {
        missing.push(fileName);
        continue;
      }
      const localPath = path.join(dataDir, fileName);
      await downloadItem(folderRef.driveId, child.id, localPath);
      additionalPaths.push(localPath);
    }
    if (missing.length > 0) {
      const choice = await browserChoose(
        page,
        `${missing.length} additional file(s) not found in the reference folder: ${missing.join(", ")}\n` +
          "Proceeding will submit this reimbursement WITHOUT these documents attached. Are you sure that's OK?",
        [
          { label: "Yes, proceed without them", value: "proceed" },
          { label: "Documentation is wrong — I'll fix it in the spreadsheet", value: "note" },
          { label: "No, stop this group", value: "stop" },
        ]
      );
      if (choice === "note") {
        const today = new Date().toISOString().slice(0, 10);
        const note = `[${today}] Missing documentation file(s) referenced: ${missing.join(", ")} — needs fixing in spreadsheet.`;
        for (const row of group.rows) {
          const existingNotes = (row.data["Notes"] ?? "").trim();
          const updatedNotes = existingNotes ? `${existingNotes} | ${note}` : note;
          await updateTableRowByIndex(excelRef, TABLE1, row.rowIndex, row.rawValues, table1Headers, {
            Notes: updatedNotes,
            Status: MISSING_THINGS_STATUS,
          });
        }
        console.log(`Marked ${group.rows.length} row(s) as "${MISSING_THINGS_STATUS}" and noted the documentation issue.`);
        throw new Error(`Group stopped — documentation issue noted in spreadsheet for missing file(s): ${missing.join(", ")}`);
      }
      if (choice !== "proceed") {
        throw new Error(`Group stopped — missing file(s) not confirmed: ${missing.join(", ")}`);
      }
    }
    if (additionalPaths.length > 0) {
      await uploadFile(page, additionalPaths);
      console.log(`Uploaded ${additionalPaths.length} additional document(s): ${additionalPaths.map((p) => path.basename(p)).join(", ")}`);
    }
  } else {
    console.log("No additional documents for this group.");
  }
  console.log('Auto-clicking "Continue to Summary"...');
  await clickContinue(page);
  await waitForStep(page, "summary");

  await browserInfo(
    page,
    'Review everything on the Summary page carefully, then click "Submit for approval" yourself when ready.'
  );
  await waitForStep(page, "confirmation");
  const reimbursementId = await readReimbursementId(page);
  console.log(`Captured Reimbursement #${reimbursementId}.`);

  const today = new Date().toISOString().slice(0, 10);
  for (const [idx, row] of matchedRows.entries()) {
    await updateTableRowByIndex(excelRef, TABLE1, row.rowIndex, row.rawValues, table1Headers, {
      Status: SUBMITTED_STATUS,
      Submitted: today,
      "Reimbursement ID": reimbursementId,
      "Line Number": String(idx + 1),
    });
  }
  console.log(`Updated ${matchedRows.length} row(s) in the spreadsheet.`);

  // Positions the browser for whatever group comes next (faster than the Dashboard/Reimbursements
  // path ensureOnNewReimbursementForm() would otherwise fall back to at the start of the next group).
  await requestAnotherReimbursement(page);
}

main().catch((err) => {
  console.error("\nRun failed:", err.message ?? err);
  process.exit(1);
});
