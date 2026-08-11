import type { Page } from "playwright";
import { parseCategoryLevels, type Table1Row } from "../reimbursements.js";
import { waitForEnter } from "./pause.js";

// Selectors for stable, semantically-named fields (verified against the live site).
const STUDENT_SELECT = "#Student__Select";
const FILE_INPUT = "#inputDrop__";
const CATEGORY_BUTTON = "#category";
const EDUCATIONAL_BENEFIT = "#educationalBenefit";
const ITEM_SERVICE_URL = "#itemServiceUrl";
const VENDOR_NAME = "#vendorName";
const PURCHASE_DATE = "#purchaseDate";
const INVOICE_NUMBER = "#invoiceNumber";
const COST_PER_ITEM = '[placeholder="Enter Cost per Item"]';
const ADDITIONAL_COSTS = '[placeholder="Enter Additional Costs"]';
const NOT_DETECTED_HEADING = /not able to detect items or services/i;
const CONFIRMATION_PATTERN = /reimbursement request for Reimbursement #(\d+)/i;

/**
 * Opens the student picker and selects "<Child> : <Program>". Does NOT click Continue —
 * per the rest of this project, navigation stays a manual, human-confirmed action.
 */
export async function selectStudent(page: Page, studentLabel: string): Promise<void> {
  await page.locator(STUDENT_SELECT).click();
  // UNVERIFIED against the live open-dropdown DOM (we only ever saw it closed in discovery) —
  // if this doesn't land correctly during the end-to-end test, it needs a real selector swap.
  await page.getByText(studentLabel, { exact: true }).click();
}

/** Uploads one or more files via the file input. Leaves review/Continue to you. */
export async function uploadFile(page: Page, localPath: string | string[]): Promise<void> {
  await page.locator(FILE_INPUT).setInputFiles(localPath);
}

/** True if StepUp's OCR failed to detect any items on the uploaded receipt. */
export async function itemDetectionFailed(page: Page): Promise<boolean> {
  return page.getByText(NOT_DETECTED_HEADING).isVisible();
}

interface FillResult {
  matchedRows: Table1Row[];
  unmatchedBlockIndexes: number[];
}

/**
 * Walks each "Item N" detail block on the Item/Service Details screen, matches it to one of
 * `candidateRows` by comparing the OCR-filled Cost per Item against each row's Amount (asking
 * you to confirm or correct via the terminal), then fills Category (via the cascading dropdown),
 * Benefit Message, and Item/Service URL from that row. Also compares Date/Vendor/Invoice #/Tax
 * against what StepUp pre-filled and overwrites with the Excel value (warning first) per your
 * call that Excel is the source of truth.
 */
export async function fillItemDetails(page: Page, candidateRows: Table1Row[]): Promise<FillResult> {
  const count = await page.locator(CATEGORY_BUTTON).count();
  console.log(`\nFound ${count} item detail block(s) on this screen.`);

  const remaining = [...candidateRows];
  const matchedRows: Table1Row[] = [];
  const unmatchedBlockIndexes: number[] = [];

  for (let i = 0; i < count; i++) {
    const costLocator = page.locator(COST_PER_ITEM).nth(i);
    const rawCost = await costLocator.inputValue().catch(() => "");
    const ocrCost = Number.parseFloat(rawCost.replace(/[^0-9.]/g, ""));

    console.log(`\n--- Item block ${i + 1} of ${count} (OCR cost: ${rawCost || "(blank)"}) ---`);
    if (remaining.length === 0) {
      console.log("No unmatched candidate rows left for this group — leaving this block for you to handle manually.");
      unmatchedBlockIndexes.push(i);
      continue;
    }

    const autoMatchIndex = remaining.findIndex(
      (r) => Number.isFinite(ocrCost) && Math.abs(Number.parseFloat(r.data["Amount"] || "NaN") - ocrCost) < 0.01
    );

    console.log("Remaining candidate row(s) for this group:");
    remaining.forEach((r) => console.log(`  ID ${r.data["ID"]}: "${r.data["Item"]}" — $${r.data["Amount"] || "?"}`));

    let matchedRow: Table1Row;
    if (autoMatchIndex !== -1) {
      const guess = remaining[autoMatchIndex];
      const answer = await waitForEnter(
        `Guessing row ID ${guess.data["ID"]} ("${guess.data["Item"]}") matches this block by amount. Press Enter to accept, or type the correct row ID.`
      );
      matchedRow = answer.trim() ? findRowById(remaining, answer.trim()) : guess;
    } else {
      const answer = await waitForEnter("No automatic amount match. Type the row ID this block corresponds to.");
      matchedRow = findRowById(remaining, answer.trim());
    }

    remaining.splice(remaining.indexOf(matchedRow), 1);
    matchedRows.push(matchedRow);

    if (matchedRow.data["Category"]) {
      await fillCategory(page, i, matchedRow.data["Category"]);
    }
    if (matchedRow.data["Benefit Message"]) {
      await page.locator(EDUCATIONAL_BENEFIT).nth(i).fill(matchedRow.data["Benefit Message"]);
    }
    if (matchedRow.data["Item/Service URL"]) {
      await page.locator(ITEM_SERVICE_URL).nth(i).fill(matchedRow.data["Item/Service URL"]);
    }

    await overwriteIfDifferent(page.locator(VENDOR_NAME).nth(i), matchedRow.data["Vendor"], "Vendor");
    await overwriteIfDifferent(page.locator(INVOICE_NUMBER).nth(i), matchedRow.data["Invoice #"], "Invoice #");
    await overwriteIfDifferent(costLocator, matchedRow.data["Amount"], "Cost per Item");
    await overwriteIfDifferent(
      page.locator(ADDITIONAL_COSTS).nth(i),
      matchedRow.data["Tax, Shipping, etc."],
      "Tax/Shipping"
    );
    await overwriteDateIfDifferent(page.locator(PURCHASE_DATE).nth(i), matchedRow.data["Date"]);
  }

  return { matchedRows, unmatchedBlockIndexes };
}

function findRowById(rows: Table1Row[], id: string): Table1Row {
  const row = rows.find((r) => r.data["ID"] === id);
  if (!row) throw new Error(`No remaining candidate row with ID "${id}".`);
  return row;
}

async function overwriteIfDifferent(
  locator: ReturnType<Page["locator"]>,
  excelValue: string | undefined,
  label: string
): Promise<void> {
  if (!excelValue) return;
  const current = await locator.inputValue().catch(() => "");
  if (current.trim() === excelValue.trim()) return;
  console.log(`  ${label} mismatch: StepUp has "${current}", Excel has "${excelValue}" — overwriting with Excel's value.`);
  await locator.fill(excelValue);
}

async function overwriteDateIfDifferent(locator: ReturnType<Page["locator"]>, excelDate: string | undefined): Promise<void> {
  if (!excelDate) return;
  const parsed = new Date(excelDate);
  if (Number.isNaN(parsed.getTime())) {
    console.log(`  Date: couldn't parse Excel value "${excelDate}" as a date — leaving StepUp's value as-is.`);
    return;
  }
  const iso = parsed.toISOString().slice(0, 10);
  const current = await locator.inputValue().catch(() => "");
  if (current === iso) return;
  console.log(`  Purchase Date mismatch: StepUp has "${current}", Excel has "${excelDate}" — overwriting with Excel's value.`);
  await locator.fill(iso);
}

/**
 * Clicks the Category button for item block `index` and selects each cascading level parsed
 * from the Excel "Category" column (e.g. "Bob - Smith" -> click "Bob", then click "Smith" in
 * the sub-dropdown that appears). UNVERIFIED against the live open-dropdown DOM — the click
 * targets any visible element with matching exact text, preferring the most recently rendered
 * one; adjust if this doesn't land correctly during the end-to-end test.
 */
async function fillCategory(page: Page, index: number, categoryValue: string): Promise<void> {
  const levels = parseCategoryLevels(categoryValue);
  if (levels.length === 0) return;
  await page.locator(CATEGORY_BUTTON).nth(index).click();
  for (const level of levels) {
    await page.getByText(level, { exact: true }).last().click();
  }
}

/** Reads the Reimbursement ID off the post-submit confirmation screen. Call only after you've submitted. */
export async function readReimbursementId(page: Page): Promise<string> {
  const heading = await page.getByText(CONFIRMATION_PATTERN).textContent();
  const match = heading?.match(CONFIRMATION_PATTERN);
  if (!match) {
    throw new Error(`Couldn't find a Reimbursement # on the confirmation screen. Got heading text: "${heading}"`);
  }
  return match[1];
}
