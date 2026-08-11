import type { Page } from "playwright";
import { parseCategoryLevels, type Table1Row } from "../reimbursements.js";
import { waitForEnter } from "./pause.js";

// Selectors for stable, semantically-named fields (verified against the live site).
const STUDENT_SELECT = "#Student__Select";
const FILE_INPUT = "#inputDrop__";
const CATEGORY_BUTTON = "#category";
// categoryType/categoryDetail only exist in the DOM once the level above them has been picked
// (not just hidden — genuinely absent until then), so unlike #category they can't be indexed by
// item-block position from the start. fillCategory() targets them with .last() instead, right
// after picking the parent level, on the assumption the just-revealed one is appended at the end
// of the page's current collection of that field.
const CATEGORY_TYPE_BUTTON = "#categoryType";
const CATEGORY_DETAIL_BUTTON = "#categoryDetail"; // visible label is "Description*"
const SERVICE_DATE = "#serviceDate"; // only present for categories with RequiresServiceDate
// "Who did you pay?" — present instead of #vendorName for categories with RequiresServiceProvider.
// It's a plain click-to-select dropdown (not a type-ahead search) pre-loaded with known
// businesses (confirmed: includes ordinary retailers like Apple and Amazon, not just specialized
// service providers), plus a "Provider not Listed" option that reveals #vendorName as a manual
// fallback text field when the desired business isn't in the list.
const PROVIDER_BUTTON = "#provider";
const PROVIDER_NOT_LISTED_TEXT = "Provider not Listed";
const EDUCATIONAL_BENEFIT = "#educationalBenefit";
const ITEM_SERVICE_URL = "#itemServiceUrl";
const VENDOR_NAME = "#vendorName";
const PURCHASE_DATE = "#purchaseDate";
const INVOICE_NUMBER = "#invoiceNumber";
const COST_PER_ITEM = '[placeholder="Enter Cost per Item"]';
const ADDITIONAL_COSTS = '[placeholder="Enter Additional Costs"]';
const QUANTITY = '[placeholder="Enter Quantity"]';
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

/**
 * Clicks a "Continue" button by visible text/role. UNVERIFIED against the live DOM — unlike
 * Pre-Auth, this flow's buttons don't have stable IDs, so this uses a role/text locator instead
 * of a selector; adjust the matcher if StepUp's actual button text differs from a plain "Continue".
 */
export async function clickContinue(page: Page): Promise<void> {
  await page.getByRole("button", { name: /continue/i }).first().click();
}

/**
 * Waits for StepUp's OCR/AI scan of an uploaded receipt to actually finish — either it renders
 * the first Item/Service Details block, or it reports it couldn't detect anything. Used after
 * auto-clicking Continue on the upload step, so the next pause is for reviewing the scan's
 * *results*, not the upload itself.
 */
export async function waitForScanProcessing(page: Page, timeoutMs = 60000): Promise<void> {
  await Promise.race([
    page.getByText(NOT_DETECTED_HEADING).waitFor({ state: "visible", timeout: timeoutMs }),
    page.locator(CATEGORY_BUTTON).first().waitFor({ state: "visible", timeout: timeoutMs }),
  ]);
}

interface FillResult {
  matchedRows: Table1Row[];
  unmatchedBlockIndexes: number[];
}

/**
 * Walks each "Item N" detail block on the Item/Service Details screen, matches it to one of
 * `candidateRows` by comparing the OCR-filled Cost per Item against each row's Amount (asking
 * you to confirm or correct via the terminal), then fills Category/Type/Description (the three
 * separate cascading dropdown buttons), Benefit Message, and Item/Service URL from that row.
 * Also compares Date/Vendor/Service Date/Invoice #/Tax/Quantity against what StepUp pre-filled
 * (or, for Vendor/Service Date, whether the field is even present — depends on the category)
 * and overwrites with the Excel value (warning first) per your call that Excel is the source of
 * truth. Service Provider selection isn't wired in yet — logs a reminder to do it manually.
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
      matchedRow = remaining[autoMatchIndex];
      console.log(`  Matched to row ID ${matchedRow.data["ID"]} ("${matchedRow.data["Item"]}") by amount.`);
    } else if (remaining.length === 1) {
      matchedRow = remaining[0];
      console.log(`  Only one candidate row left — matched to ID ${matchedRow.data["ID"]} ("${matchedRow.data["Item"]}").`);
    } else {
      const answer = await waitForEnter(
        "No automatic amount match and multiple candidate rows remain. Type the row ID this block corresponds to."
      );
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

    // Vendor Name / Service Date / Provider are conditional on the category just picked above
    // (a category requires either Vendor or Provider, never both, and Service Date only for some)
    // so — like categoryType/categoryDetail — they're targeted with .last() plus a presence
    // check rather than .nth(i), since whether they exist at all depends on this block's category.
    const hasDirectVendorField = (await page.locator(VENDOR_NAME).count()) > 0;
    if (hasDirectVendorField && matchedRow.data["Vendor"]) {
      await overwriteIfDifferent(page.locator(VENDOR_NAME).last(), matchedRow.data["Vendor"], "Vendor");
    } else if ((await page.locator(PROVIDER_BUTTON).count()) > 0) {
      const providerName = matchedRow.data["Service Provider"] || matchedRow.data["Vendor"];
      if (providerName) await selectVendorOrProvider(page, providerName);
    }
    if (matchedRow.data["Service Date"] && (await page.locator(SERVICE_DATE).count()) > 0) {
      await overwriteDateIfDifferent(page.locator(SERVICE_DATE).last(), matchedRow.data["Service Date"]);
    }
    await overwriteIfDifferent(page.locator(INVOICE_NUMBER).nth(i), matchedRow.data["Invoice #"], "Invoice #");
    await overwriteIfDifferent(costLocator, matchedRow.data["Amount"], "Cost per Item");
    await overwriteIfDifferent(page.locator(QUANTITY).nth(i), matchedRow.data["Quantity"], "Quantity");
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

/** Graph returns date cells as raw Excel serial numbers (e.g. "45888"), not formatted strings —
 *  days since the Excel epoch of 1899-12-30. Converts that to a real Date; falls through to
 *  normal Date parsing for anything that isn't a bare integer (already-ISO strings, etc.). */
function parseExcelDate(value: string): Date {
  if (/^\d+$/.test(value.trim())) {
    return new Date(Date.UTC(1899, 11, 30) + Number(value) * 86400000);
  }
  return new Date(value);
}

async function overwriteDateIfDifferent(locator: ReturnType<Page["locator"]>, excelDate: string | undefined): Promise<void> {
  if (!excelDate) return;
  const parsed = parseExcelDate(excelDate);
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
 * Opens the "Who did you pay?" dropdown and selects the option matching `name`. If it's not in
 * the pre-loaded list, clicks "Provider not Listed" instead — which reveals #vendorName as a
 * manual-entry fallback — and types `name` into that. UNVERIFIED: the open-dropdown option click
 * itself, same caveat as fillCategory() below.
 */
async function selectVendorOrProvider(page: Page, name: string): Promise<void> {
  await page.locator(PROVIDER_BUTTON).last().click();
  const option = page.getByText(name, { exact: true }).last();
  if (await option.isVisible().catch(() => false)) {
    await option.click();
    return;
  }
  console.log(`  "${name}" not found in the provider list — falling back to manual Vendor Name entry.`);
  await page.getByText(PROVIDER_NOT_LISTED_TEXT, { exact: true }).last().click();
  await page.locator(VENDOR_NAME).last().fill(name);
}

/**
 * Selects each cascading level parsed from the Excel "Category" column (e.g. "Bob - Smith - Widget")
 * across StepUp's three separate dropdown buttons: Category (#category, exists per item block from
 * the start) -> Type (#categoryType) -> Description (#categoryDetail) — the latter two only appear
 * in the DOM once their parent level has been picked, so they're targeted with .last() rather than
 * .nth(index). UNVERIFIED: the option-click itself (matching visible text) against the live
 * open-dropdown DOM — adjust if this doesn't land correctly during the end-to-end test.
 */
async function fillCategory(page: Page, index: number, categoryValue: string): Promise<void> {
  const levels = parseCategoryLevels(categoryValue);
  if (levels.length === 0) return;

  await page.locator(CATEGORY_BUTTON).nth(index).click();
  await page.getByText(levels[0], { exact: true }).last().click();
  if (levels.length === 1) return;

  await page.locator(CATEGORY_TYPE_BUTTON).last().click();
  await page.getByText(levels[1], { exact: true }).last().click();
  if (levels.length === 2) return;

  await page.locator(CATEGORY_DETAIL_BUTTON).last().click();
  await page.getByText(levels[2], { exact: true }).last().click();
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
