import "dotenv/config";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { connectToStepUpSession } from "./form/browser.js";
import {
  browserChoose,
  browserContinue,
  browserInfo,
  browserInfoHtml,
  clearBanner,
  startConnectionHeartbeat,
} from "./form/browserPrompt.js";
import {
  autoCheckDetectedItems,
  checkForDashboardModal,
  checkItemScan,
  clickContinue,
  ensureOnNewReimbursementForm,
  fillItemDetails,
  scrollToFirstItem,
  formatMoney,
  parseExcelDate,
  readReimbursementId,
  selectStudent,
  uploadFile,
  waitForLogin,
  waitForStep,
  type CategoryFixHooks,
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
import { applyCategoryRename, attachCategoryTreeListener } from "./categorySync.js";
import { attachPreauthSyncListener } from "./preauthSync.js";
import {
  buildGroups,
  checkScholarshipEligibility,
  loadUnfiledRows,
  type ReimbursementGroup,
  type Table1Row,
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
  const amount = r.data["Amount"] ? `$${formatMoney(r.data["Amount"])}` : "$?";
  const description = r.data["Description"]?.trim();
  const truncated = description && description.length > 80 ? `${description.slice(0, 80)}…` : description;
  const detail = truncated ? `${r.data["Item"]} — ${truncated}` : r.data["Item"];
  return `ID ${r.data["ID"]} · ${r.data["Child"]} · ${amount}: "${detail}"`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** mm/dd/yyyy — matches what StepUp's own date inputs display (the underlying value they hold is
 *  ISO, but that's not what's shown on screen, and this banner is meant to read the same as the
 *  real page next to it). Formatted with UTC getters, not local ones: parseExcelDate() treats bare
 *  serial numbers as UTC and Date's own ISO-string parsing does too, so local getters could shift
 *  the date by a day depending on the machine's timezone. */
function excelDateDisplay(rawDate: string | undefined): string | undefined {
  const trimmed = rawDate?.trim();
  if (!trimmed) return undefined;
  const parsed = parseExcelDate(trimmed);
  if (Number.isNaN(parsed.getTime())) return trimmed;
  const mm = String(parsed.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(parsed.getUTCDate()).padStart(2, "0");
  const yyyy = parsed.getUTCFullYear();
  return `${mm}/${dd}/${yyyy}`;
}

function reviewFieldRow(label: string, value: string | undefined): string {
  const v = value?.trim();
  if (!v) return "";
  return `<div><span style="opacity:.65;">${escapeHtml(label)}:</span> ${escapeHtml(v)}</div>`;
}

/**
 * One card per matched row for the post-fill review banner, fields ordered to match the real
 * Item/Service Details page top-to-bottom (Purchase Date -> Invoice # -> Category -> Quantity ->
 * Cost -> Tax/Shipping -> Who did you pay -> Benefit Message -> URL) so checking the banner against
 * the actual page reads the same direction instead of jumping around. Each field is its own line
 * (not one long dash-joined run-on) so a long Category cascade or URL wraps cleanly rather than
 * making the whole line unreadable — matters once there are several items each with several fields.
 */
function reviewItemCardHtml(r: { data: Record<string, string> }): string {
  const amount = r.data["Amount"] ? `$${formatMoney(r.data["Amount"])}` : "$?";
  const description = r.data["Description"]?.trim();
  const detail = description ? `${r.data["Item"]} — ${description}` : r.data["Item"];
  const vendor = r.data["Service Provider"] || r.data["Vendor"];

  const fields = [
    reviewFieldRow("Purchase Date", excelDateDisplay(r.data["Date"])),
    reviewFieldRow("Invoice/Receipt #", r.data["Invoice #"]),
    reviewFieldRow("Category", r.data["Category"]),
    reviewFieldRow("Quantity", r.data["Quantity"]),
    reviewFieldRow("Cost per Item", formatMoney(r.data["Amount"])),
    reviewFieldRow("Tax, Shipping, etc", formatMoney(r.data["Tax, Shipping, etc."])),
    reviewFieldRow("Who did you pay", vendor),
    reviewFieldRow("Benefit Message", r.data["Benefit Message"]),
    reviewFieldRow("Item/Service URL", r.data["Item/Service URL"]),
  ].join("");

  return (
    `<div style="background:rgba(255,255,255,.08);border-radius:6px;padding:10px 12px;">` +
    `<div style="font-weight:600;margin-bottom:4px;">ID ${escapeHtml(r.data["ID"] ?? "")} · ${escapeHtml(r.data["Child"] ?? "")} · ${escapeHtml(amount)}: "${escapeHtml(detail ?? "")}"</div>` +
    `<div style="font-size:12.5px;line-height:1.7;">${fields}</div>` +
    `</div>`
  );
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
  <iframe src="${escapeHtml(pathToFileURL(localPath).href)}" style="width:100%;height:calc(100vh - 62px);border:none;display:block;"></iframe>
</body></html>`;
  await writeFile(wrapperPath, html, "utf-8");
  const previewPage = await context.newPage();
  await previewPage.goto(pathToFileURL(wrapperPath).href);
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
  // So any banner still up in the browser can tell you if this process dies (crash, Ctrl+C,
  // closed terminal) instead of just sitting there looking like it's still waiting on you.
  startConnectionHeartbeat(page);

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
    const unopenable: string[] = [];
    for (const fileName of candidates) {
      const wanted = fileName.trim().toLowerCase();
      const fileChild =
        folderChildren.find((c) => c.name === fileName) ??
        folderChildren.find((c) => c.name.trim().toLowerCase() === wanted);
      if (!fileChild) {
        console.warn(`  Couldn't find "${fileName}" in the OneDrive folder — no preview tab for it.`);
        unopenable.push(fileName);
        continue;
      }
      const localPath = path.join(dataDir, fileChild.name);
      try {
        previewByFile.set(
          fileName,
          await openLabeledPreview(context, folderRef, fileChild.id, localPath, fileName, summarizeRow(row))
        );
      } catch (err) {
        console.warn(`  Couldn't open a preview tab for "${fileName}": ${err instanceof Error ? err.message : err}`);
        unopenable.push(fileName);
      }
    }

    const WRONG_DOCUMENTATION = "__wrong_documentation__";
    const choice = await browserChoose(
      page,
      `${summarizeRow(row)} has multiple documentation files — each is now open in its own labeled tab for review. Which one should be uploaded first (the main receipt)?` +
        (unopenable.length
          ? `\n\nWarning: not listed below because they couldn't be found/opened in the OneDrive folder (check the spreadsheet for typos): ${unopenable.join(", ")}`
          : ""),
      [
        ...candidates.filter((f) => !unopenable.includes(f)).map((f) => ({ label: f, value: f, page: previewByFile.get(f) })),
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
      await runGroup(page, group, excelRef, folderRef, folderChildren, dataDir, table1Headers, scholarshipByChild, rows);
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
      : "All groups processed. Click Continue to finish. The browser stays open — re-run \"npm start\" for more rows, or click the \"All done — close browser\" button (top-left of the page) when you're fully done."
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
  scholarshipByChild: Map<string, string>,
  allRows: Table1Row[]
): Promise<void> {
  console.log(`\nNavigating to a new reimbursement request for ${group.child}...`);
  await ensureOnNewReimbursementForm(page);
  const program =
    group.rows[0].data["Program"]?.trim() || scholarshipByChild.get(group.child) || DEFAULT_PROGRAM;
  console.log(`Selecting student "${group.child} : ${program}"...`);
  await selectStudent(page, group.child, program);
  await clickContinue(page);
  await waitForStep(page, "upload");

  await browserInfo(page, `Downloading and uploading the receipt "${group.mainReceiptFile}"...`);
  const mainReceiptChild = findFile(folderChildren, group.mainReceiptFile);
  const mainReceiptPath = path.join(dataDir, group.mainReceiptFile);
  await downloadItem(folderRef.driveId, mainReceiptChild.id, mainReceiptPath);
  console.log(`Uploading main receipt "${group.mainReceiptFile}"...`);
  await uploadFile(page, mainReceiptPath);
  await clearBanner(page);
  console.log("Upload done, clicking Continue and waiting for StepUp's AI scan...");
  await clickContinue(page);
  await waitForStep(page, "itemSelection");
  console.log("On the Item/Service Selection screen.");

  let scanOutcome = await checkItemScan(page);

  if (scanOutcome === "readError") {
    // StepUp says it couldn't even read the document at all (distinct from reading it fine and
    // finding nothing) — that's just as likely to mean the file itself is broken as it is a
    // transient StepUp hiccup, so before assuming it's safe to fall back to manual entry, have a
    // human actually look at it: open it in its own tab and ask.
    console.log(`\nStepUp couldn't read "${group.mainReceiptFile}" at all — opening it for you to check.`);
    const rowsSummary = group.rows.map((r) => summarizeRow(r)).join("\n");
    const preview = await openLabeledPreview(
      page.context(),
      folderRef,
      mainReceiptChild.id,
      mainReceiptPath,
      group.mainReceiptFile,
      rowsSummary
    );
    const OPENED_FINE = "opened_fine";
    const BROKEN = "broken";
    const choice = await browserChoose(
      page,
      `StepUp couldn't read "${group.mainReceiptFile}" at all (not just "no items found" — an actual read failure). ` +
        `It's now open in its own tab for you to check. Did it open properly for you?\n${rowsSummary}`,
      [
        { label: "Yes, it opened fine — StepUp's problem, not the file's", value: OPENED_FINE },
        { label: "No, it's broken/won't open", value: BROKEN },
      ]
    );
    await preview.close();

    if (choice === BROKEN) {
      const today = new Date().toISOString().slice(0, 10);
      const note = `[${today}] StepUp couldn't read "${group.mainReceiptFile}" and it didn't open properly for you either — needs a real fix in the spreadsheet.`;
      for (const row of group.rows) {
        const existingNotes = (row.data["Notes"] ?? "").trim();
        const updatedNotes = existingNotes ? `${existingNotes} | ${note}` : note;
        await updateTableRowByIndex(excelRef, TABLE1, row.rowIndex, row.rawValues, table1Headers, {
          Notes: updatedNotes,
          Status: MISSING_THINGS_STATUS,
        });
      }
      console.log(`Marked ${group.rows.length} row(s) as "${MISSING_THINGS_STATUS}" — document is broken.`);
      throw new Error(`"${group.mainReceiptFile}" is broken — marked "${MISSING_THINGS_STATUS}" in the spreadsheet, skipping this group.`);
    }

    // Confirmed genuinely readable — treat exactly like the ordinary "read fine, found nothing"
    // case below rather than duplicating that whole branch.
    console.log("Confirmed the document opens fine — treating this like an ordinary detection failure.");
    scanOutcome = "notDetected";
  }

  if (scanOutcome === "notDetected") {
    const rowsSummary = group.rows.map((r) => summarizeRow(r)).join("\n");
    console.log(
      `\nStepUp couldn't detect items on this document. Filling in ${group.rows.length} item block(s) directly for:\n${rowsSummary}`
    );
    console.log('Auto-clicking "Continue to Item/Service Details"...');
    await clickContinue(page);
    // No OCR data to match against, and no manual "Add an Item" step needed either —
    // fillItemDetails() below creates as many blocks as it needs on its own, matching each one
    // to the next row in order (noOcrData=true) rather than prompting per block for no reason.
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

  // Wired so a live Category dropdown mismatch (see fillCategory() in reimbursementFlow.ts) gets
  // persisted the moment it's resolved, instead of only living in that file's in-memory
  // categoryOverrides for this process's lifetime: the corrected value is written back to Table1
  // for every affected row, and Table5 (the categories reference table) is renamed to match.
  const categoryIdx = table1Headers.indexOf("Category");
  const categoryFixHooks: CategoryFixHooks = {
    onRenamed: (oldPath, newPath) => applyCategoryRename(excelRef, oldPath, newPath),
    onRowsFixed: async (rowsToFix, newValue) => {
      for (const r of rowsToFix) {
        await updateTableRowByIndex(excelRef, TABLE1, r.rowIndex, r.rawValues, table1Headers, { Category: newValue });
        // Keep this row's own in-memory copies in sync immediately: later write-backs for the same
        // row (Status/Submitted/Notes, below and in the catch-block error path) reuse this same
        // rawValues array as updateTableRowByIndex's "currentValues" and would otherwise silently
        // revert this fix by re-sending the stale Category value alongside their own changes.
        if (categoryIdx !== -1) r.rawValues[categoryIdx] = newValue;
        r.data["Category"] = newValue;
      }
    },
  };

  const { matchedRows, unmatchedBlockIndexes } = await fillItemDetails(
    page,
    group.rows,
    scanOutcome === "notDetected",
    allRows,
    categoryFixHooks
  );
  let reviewHtml =
    `<div style="font-weight:600;margin-bottom:10px;">Review the filled details against these row(s), then click Continue yourself in StepUp:</div>` +
    `<div style="display:flex;flex-direction:column;gap:8px;">${matchedRows.map((r) => reviewItemCardHtml(r)).join("")}</div>`;
  if (unmatchedBlockIndexes.length > 0) {
    const unmatchedList = unmatchedBlockIndexes.map((i) => `Item block ${i + 1}`).join(", ");
    console.log(`\n${unmatchedBlockIndexes.length} item block(s) had no candidate row left — fill those in manually.`);
    reviewHtml += `<div style="margin-top:10px;color:#ffb3b3;">${unmatchedBlockIndexes.length} item block(s) had no candidate row left and need filling in manually: ${escapeHtml(unmatchedList)}.</div>`;
  }
  // Filling the blocks leaves the page scrolled to the last one; jump back to the first item so
  // the page lines up with the review box instead of showing the bottom of the form.
  await scrollToFirstItem(page);
  await browserInfoHtml(page, reviewHtml);
  await waitForStep(page, "additionalDocuments");

  let attachedAdditionalFiles: string[] = [];
  const missingAdditionalFiles: string[] = [];
  if (group.additionalFiles.length > 0) {
    await browserInfo(page, `Downloading ${group.additionalFiles.length} additional document(s)...`);
    const additionalPaths: string[] = [];
    for (const fileName of group.additionalFiles) {
      const child = folderChildren.find((c) => c.name === fileName);
      if (!child) {
        missingAdditionalFiles.push(fileName);
        continue;
      }
      const localPath = path.join(dataDir, fileName);
      await downloadItem(folderRef.driveId, child.id, localPath);
      additionalPaths.push(localPath);
    }
    await clearBanner(page);
    if (missingAdditionalFiles.length > 0) {
      const choice = await browserChoose(
        page,
        `${missingAdditionalFiles.length} additional file(s) not found in the reference folder: ${missingAdditionalFiles.join(", ")}\n` +
          "Proceeding will submit this reimbursement WITHOUT these documents attached. Are you sure that's OK?",
        [
          { label: "Yes, proceed without them", value: "proceed" },
          { label: "Documentation is wrong — I'll fix it in the spreadsheet", value: "note" },
          { label: "No, stop this group", value: "stop" },
        ]
      );
      if (choice === "note") {
        const today = new Date().toISOString().slice(0, 10);
        const note = `[${today}] Missing documentation file(s) referenced: ${missingAdditionalFiles.join(", ")} — needs fixing in spreadsheet.`;
        for (const row of group.rows) {
          const existingNotes = (row.data["Notes"] ?? "").trim();
          const updatedNotes = existingNotes ? `${existingNotes} | ${note}` : note;
          await updateTableRowByIndex(excelRef, TABLE1, row.rowIndex, row.rawValues, table1Headers, {
            Notes: updatedNotes,
            Status: MISSING_THINGS_STATUS,
          });
        }
        console.log(`Marked ${group.rows.length} row(s) as "${MISSING_THINGS_STATUS}" and noted the documentation issue.`);
        throw new Error(`Group stopped — documentation issue noted in spreadsheet for missing file(s): ${missingAdditionalFiles.join(", ")}`);
      }
      if (choice !== "proceed") {
        throw new Error(`Group stopped — missing file(s) not confirmed: ${missingAdditionalFiles.join(", ")}`);
      }
    }
    if (additionalPaths.length > 0) {
      await browserInfo(page, `Uploading ${additionalPaths.length} additional document(s)...`);
      await uploadFile(page, additionalPaths);
      attachedAdditionalFiles = additionalPaths.map((p) => path.basename(p));
      console.log(`Uploaded ${attachedAdditionalFiles.length} additional document(s): ${attachedAdditionalFiles.join(", ")}`);
      await clearBanner(page);
    }
  } else {
    console.log("No additional documents for this group.");
  }
  console.log('Auto-clicking "Continue to Summary"...');
  await clickContinue(page);
  await waitForStep(page, "summary");
  // Uploading additional documents just above happened without pausing for you (auto-clicked
  // straight through to here), so the list below is the first chance to see what got attached.

  // Compute total expected reimbursement from matched rows: Amount * Quantity + Tax/Shipping.
  const totalExpected = matchedRows.reduce((sum, r) => {
    const parseNum = (s: string | undefined) => {
      if (!s) return 0;
      const cleaned = String(s).replace(/[^0-9.\-]/g, "");
      const n = Number.parseFloat(cleaned);
      return Number.isFinite(n) ? n : 0;
    };
    const amount = parseNum(r.data["Amount"]);
    const qtyRaw = (r.data["Quantity"] || "").trim();
    const quantity = qtyRaw === "" ? 1 : parseNum(qtyRaw) || 1;
    const additional = parseNum(r.data["Tax, Shipping, etc."]);
    const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
    return sum + round2(amount) * quantity + round2(additional);
  }, 0);
  const totalFormatted = `$${totalExpected.toFixed(2)}`;

  const attachmentItems = [group.mainReceiptFile, ...attachedAdditionalFiles].map((f) => `<li>${escapeHtml(f)}</li>`);
  missingAdditionalFiles.forEach((f) => attachmentItems.push(`<li>${escapeHtml(f)} (missing, not attached)</li>`));
  await browserInfoHtml(
    page,
    `<div style="font-weight:600;margin-bottom:4px;">Review everything on the Summary page carefully, then click "Submit for approval" yourself when ready.</div>` +
      `<ul style="margin:0;padding-left:20px;line-height:1.35;">` +
      `<li>Child: ${escapeHtml(group.child)}</li>` +
      `<li>File(s) attached this submission:<ul style="margin:0;padding-left:20px;">${attachmentItems.join("")}</ul></li>` +
      `<li>Total expected reimbursement: ${escapeHtml(totalFormatted)}</li>` +
      `</ul>`
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

  // Deliberately not navigating away from the confirmation page here — it stays up so you can see
  // it until the next group is actually selected, at which point ensureOnNewReimbursementForm()
  // (called at the start of the next runGroup()) clicks "Request Another Reimbursement" itself.
}

main().catch((err) => {
  console.error("\nRun failed:", err.message ?? err);
  process.exit(1);
});
