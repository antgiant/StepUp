import type { Page } from "playwright";
import { parseCategoryLevels, type Table1Row } from "../reimbursements.js";
import { browserChoose, browserContinue } from "./browserPrompt.js";

// Selectors for stable, semantically-named fields (verified against the live site).
const STUDENT_SELECT = "#Student__Select";
const STUDENT_DROPDOWN_MENU = "ul.dropdown-menu.show";
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
// Confirmed against the live DOM: it's NOT a single `#provider` element (that never matched
// anything, which is why vendor selection was silently skipped every time) — it's scoped per
// item block via a collapse-panel id, and it's *always* in the DOM for a block that needs it
// (not conditionally rendered), though its value gets reset back to empty on any category change.
// `providerContainer` is the `.dropdown` wrapper (button + its `ul.dropdown-menu` sibling); the
// button alone isn't enough to scope option-matching to just this dropdown's real choices, and an
// unscoped page-wide text search picks up unrelated matches elsewhere (confirmed in practice: a
// search for "Apple" found 2 hits when the dropdown itself only lists one "Apple Store" entry —
// the uploaded receipt's own filename contains "Apple" too, and was getting counted).
const providerContainer = (index: number) =>
  `#collapseOne____item_${index + 1} > div > div > div:nth-child(12) > div > div`;
const providerButton = (index: number) => `${providerContainer(index)} > button > div`;
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
const SCANNING_HEADING = /one moment while we read your document/i;
const CONFIRMATION_PATTERN = /reimbursement request for Reimbursement #(\d+)/i;
const DASHBOARD_URL_PATTERN = /\/Dashboard(?:[/?]|$)/i;
const REIMBURSEMENTS_NAV_LINK = "#sidenav > div.nav-items > div:nth-child(5) > a";
const NEW_REIMBURSEMENT_BUTTON = "#New__Reimbursement__Button";
const REQUEST_ANOTHER_BUTTON =
  "#Content__Wrapper > section > div.container-card.confirmation-container > div > button";

// The reimbursement wizard's steps are numbered directly in the URL (confirmed against the live
// site), so arrival at each one can be detected directly rather than relying on a human to click
// a separate "I'm there" confirmation on top of StepUp's own Continue button. Once a draft
// request exists, StepUp inserts a session GUID between the base path and the step number (e.g.
// .../SubmitReimbursement/00000000-0000-0000-0000-000000000000/1) — confirmed against a real
// stuck-URL report; the numbered patterns must account for it or they never match at all.
const UUID_SEGMENT = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const REIMBURSEMENT_STEP_PATTERNS = {
  studentSelection: new RegExp(`\\/SubmitReimbursement(?:\\/${UUID_SEGMENT})?\\/?(?:[?#]|$)`, "i"),
  upload: new RegExp(`\\/SubmitReimbursement\\/${UUID_SEGMENT}\\/1(?:[/?]|$)`, "i"),
  itemSelection: new RegExp(`\\/SubmitReimbursement\\/${UUID_SEGMENT}\\/2(?:[/?]|$)`, "i"),
  itemDetails: new RegExp(`\\/SubmitReimbursement\\/${UUID_SEGMENT}\\/3(?:[/?]|$)`, "i"),
  additionalDocuments: new RegExp(`\\/SubmitReimbursement\\/${UUID_SEGMENT}\\/4(?:[/?]|$)`, "i"),
  summary: new RegExp(`\\/SubmitReimbursement\\/${UUID_SEGMENT}\\/5(?:[/?]|$)`, "i"),
  confirmation: /\/SubmitReimbursement\/Confirmation\//i,
} as const;
export type ReimbursementStep = keyof typeof REIMBURSEMENT_STEP_PATTERNS;

/**
 * Waits (unbounded) for the page to reach a specific step of the reimbursement wizard, detected
 * via its URL — StepUp numbers each step directly (.../1 upload, .../2 AI results, .../3 item
 * details, .../4 additional documents, .../5 summary, .../Confirmation/{guid} after submit).
 */
export async function waitForStep(page: Page, step: ReimbursementStep): Promise<void> {
  await page.waitForURL(REIMBURSEMENT_STEP_PATTERNS[step], { timeout: 0 });
}

/**
 * Waits for you to finish logging in — detected by landing on /Dashboard — with no timeout at
 * all, since a real login (possibly with MFA) can easily take longer than Playwright's default
 * 30s action timeout, which would otherwise kill the browser mid-login. No browser-prompt banner
 * is shown during this wait: login's own page navigations would destroy it anyway, so it'd just
 * disappear and confuse things.
 */
export async function waitForLogin(page: Page): Promise<void> {
  await page.waitForURL(DASHBOARD_URL_PATTERN, { timeout: 0 });
}

/**
 * Pauses for a human check right after login: StepUp sometimes throws up a modal on the
 * Dashboard, and this automation must never auto-dismiss or click through one — that needs a
 * real human decision, so it waits for you to confirm before anything else proceeds.
 */
export async function checkForDashboardModal(page: Page): Promise<void> {
  await browserContinue(
    page,
    "If a modal/popup is showing on the Dashboard, handle it yourself first. Click Continue once it's clear."
  );
}

/**
 * Navigates to a new reimbursement request by clicking through the real UI (Reimbursements nav
 * link, then New) rather than visiting URLs directly — the site behaves unreliably with direct
 * `goto()` navigation (its client-side app state doesn't get set up the same way a real in-app
 * click does).
 */
export async function goToNewReimbursement(page: Page): Promise<void> {
  await page.locator(REIMBURSEMENTS_NAV_LINK).click();
  await page.locator(NEW_REIMBURSEMENT_BUTTON).click();
}

/**
 * From the post-submit confirmation page, clicks "Request Another Reimbursement" to jump
 * straight back to the student picker — faster than going back through the Dashboard and
 * Reimbursements list (`goToNewReimbursement`), which re-fetches the full reimbursements list
 * data each time.
 */
export async function requestAnotherReimbursement(page: Page): Promise<void> {
  await page.locator(REQUEST_ANOTHER_BUTTON).click();
  await waitForStep(page, "studentSelection");
}

/**
 * Gets you to a fresh new-reimbursement form for the next group, however you're currently
 * positioned: if you're already on the student picker (e.g. right after a prior group's
 * `requestAnotherReimbursement()`), this is a no-op; otherwise it falls back to the slower
 * Dashboard/Reimbursements-list path.
 */
export async function ensureOnNewReimbursementForm(page: Page): Promise<void> {
  if (REIMBURSEMENT_STEP_PATTERNS.studentSelection.test(page.url())) return;
  await goToNewReimbursement(page);
}

/**
 * Opens the student picker and selects the option for `child` + `program`. Confirmed via a real
 * open-dropdown screenshot: options render as "<Child> <LastName> : <Program>" (e.g.
 * "Child A : FES-UA") — a last name Table2 doesn't track — and multiple entries can
 * exist per child (other scholarships, "(NOT ENROLLED)" variants). So this matches by a regex
 * anchored on the child's name at the start and the program at the end, scoped to the open
 * dropdown menu specifically (never the picker button's own label, which can already show a
 * previously-selected value and would otherwise be an ambiguous second match) — rather than the
 * exact-text match this originally shipped with, which never matched anything and hung until
 * timeout. Does NOT click Continue — per the rest of this project, navigation stays a manual,
 * human-confirmed action.
 */
export async function selectStudent(page: Page, child: string, program: string): Promise<void> {
  await page.locator(STUDENT_SELECT).click();
  const pattern = new RegExp(`^${escapeRegExp(child)}\\b.*:\\s*${escapeRegExp(program)}\\s*$`, "i");
  await page.locator(STUDENT_DROPDOWN_MENU).getByText(pattern).click();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Uploads one or more files via the file input. Leaves review/Continue to you. */
export async function uploadFile(page: Page, localPath: string | string[]): Promise<void> {
  await page.locator(FILE_INPUT).setInputFiles(localPath);
}

/**
 * True if StepUp's OCR failed to detect any items on the uploaded receipt. Arriving at this
 * screen's URL only means StepUp has *started* reading the document — it shows its own loading
 * state ("One moment while we read your document... This could take up to 60 seconds") before
 * rendering either outcome, confirmed against a real screenshot. So this waits for that loading
 * state to clear first (covers either outcome, and resolves immediately if scanning already
 * finished by the time we check), then does a quick follow-up check for the "not detected"
 * heading specifically — a naive short timeout on the heading alone would catch the DOM mid-scan
 * and wrongly conclude detection succeeded (confirmed in practice).
 */
export async function itemDetectionFailed(page: Page, scanTimeoutMs = 90000): Promise<boolean> {
  await page
    .getByText(SCANNING_HEADING)
    .waitFor({ state: "hidden", timeout: scanTimeoutMs })
    .catch(() => {});
  return page
    .getByText(NOT_DETECTED_HEADING)
    .waitFor({ state: "visible", timeout: 5000 })
    .then(() => true)
    .catch(() => false);
}

/**
 * Clicks a "Continue" button by visible text/role. UNVERIFIED against the live DOM — unlike
 * Pre-Auth, this flow's buttons don't have stable IDs, so this uses a role/text locator instead
 * of a selector; adjust the matcher if StepUp's actual button text differs from a plain "Continue".
 */
export async function clickContinue(page: Page): Promise<void> {
  await page.getByRole("button", { name: /continue/i }).first().click();
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
      const answer = await browserChoose(
        page,
        `Item block ${i + 1} of ${count} (OCR cost: ${rawCost || "(blank)"}) — no automatic amount match. Which row does this correspond to?`,
        remaining.map((r) => ({ label: `ID ${r.data["ID"]}: "${r.data["Item"]}" — $${r.data["Amount"] || "?"}`, value: r.data["ID"] }))
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
    // (a category requires either Vendor or Provider, never both, and Service Date only for some).
    // The provider button itself is always in the DOM once a category is picked (confirmed via a
    // real screenshot) — but its *value* resets back to empty as part of StepUp settling into the
    // new category, so setting it too early gets clobbered. Give that a moment to finish first.
    await page.waitForTimeout(1000);
    const hasDirectVendorField = (await page.locator(VENDOR_NAME).count()) > 0;
    if (hasDirectVendorField && matchedRow.data["Vendor"]) {
      await overwriteIfDifferent(page.locator(VENDOR_NAME).last(), matchedRow.data["Vendor"], "Vendor");
    } else if ((await page.locator(providerButton(i)).count()) > 0) {
      const providerName = matchedRow.data["Service Provider"] || matchedRow.data["Vendor"];
      if (providerName) await selectVendorOrProvider(page, providerName, i);
    }
    if (matchedRow.data["Service Date"]) {
      await page.locator(SERVICE_DATE).first().waitFor({ state: "attached", timeout: 5000 }).catch(() => {});
      if ((await page.locator(SERVICE_DATE).count()) > 0) {
        await overwriteDateIfDifferent(page.locator(SERVICE_DATE).last(), matchedRow.data["Service Date"]);
      }
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
 * Opens the "Who did you pay?" dropdown and selects the option matching `name`. Tries an exact
 * match first, then falls back to a substring match — but only when it's unambiguous (exactly
 * one hit) — since Excel's Vendor value is sometimes a shorter/looser form of StepUp's actual
 * listed name (e.g. Excel's "Apple" vs StepUp's "Apple Store"; an exact-only match silently fails
 * on cases like this). If still nothing usable, clicks "Provider not Listed" instead — which
 * reveals #vendorName as a manual-entry fallback — and types `name` into that.
 */
async function selectVendorOrProvider(page: Page, name: string, index: number): Promise<void> {
  await page.locator(providerButton(index)).click();
  const dropdown = page.locator(providerContainer(index)).locator("ul.dropdown-menu");

  const exactOption = dropdown.getByText(name, { exact: true });
  if (await exactOption.isVisible().catch(() => false)) {
    await exactOption.click();
    return;
  }

  const partialMatches = dropdown.getByText(name, { exact: false });
  const partialCount = await partialMatches.count();
  if (partialCount === 1) {
    const matchedText = await partialMatches.first().textContent();
    console.log(`  "${name}" matched "${matchedText?.trim()}" in the provider list (partial match).`);
    await partialMatches.first().click();
    return;
  }

  console.log(
    `  "${name}" not found (or ambiguous — ${partialCount} partial match(es)) in the provider list — falling back to manual Vendor Name entry.`
  );
  await dropdown.getByText(PROVIDER_NOT_LISTED_TEXT, { exact: true }).click();
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

/**
 * Reads the Reimbursement ID off the post-submit confirmation screen. Call only after you've
 * submitted. Retries for a bit rather than reading once: arriving at the confirmation URL
 * doesn't mean the real ID has rendered into the heading yet — confirmed in practice, a too-early
 * read caught a "#0" placeholder/loading state and wrote that straight into the spreadsheet as if
 * it were real. "0" is treated the same as no match at all — never a genuine reimbursement ID.
 */
export async function readReimbursementId(page: Page, timeoutMs = 15000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastHeading: string | null = null;
  while (Date.now() < deadline) {
    lastHeading = await page.getByText(CONFIRMATION_PATTERN).textContent().catch(() => null);
    const match = lastHeading?.match(CONFIRMATION_PATTERN);
    if (match && match[1] !== "0") {
      return match[1];
    }
    await page.waitForTimeout(300);
  }
  throw new Error(
    `Couldn't find a real (non-zero) Reimbursement # on the confirmation screen within ${timeoutMs}ms. Last heading text: "${lastHeading}"`
  );
}
