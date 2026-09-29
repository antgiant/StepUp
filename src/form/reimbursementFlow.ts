import type { Locator, Page } from "playwright";
import { parseCategoryLevels, type Table1Row } from "../reimbursements.js";
import { browserChoose, browserContinue, browserInfo, clearBanner } from "./browserPrompt.js";

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
// Located by the field's own "Who did you pay?" label rather than a fixed child position — an
// earlier version used `nth-child(12)`, which live-diagnosed to be fragile: each category-cascade
// level (Category/Type/Description) adds its own preceding field div only once selected, so an
// item block whose category selection hadn't fully finished yet had one fewer preceding field and
// this shifted to nth-child(11) instead, silently making providerButton() match nothing and
// skipping vendor selection entirely with no error. The label text is stable regardless of how
// many category levels are currently rendered.
const providerField = (index: number) =>
  `#collapseOne____item_${index + 1} .reimbursement-item-field:has-text("Who did you pay?")`;
const providerContainer = (index: number) => `${providerField(index)} .dropdown`;
const providerButton = (index: number) => `${providerContainer(index)} > button > div`;
// Each item block's accordion header shows "Item N : {OCR-detected name}" — confirmed against
// the live DOM for 3 real blocks (nth-child 2, 4, 6 — i.e. 2*(index+1), one slot per header +
// one per body). OCR often detects the item's name reliably even when it can't read the dollar
// amount (shows $0.00), so this is used as a fallback match signal when amount-matching alone
// can't disambiguate multiple same-priced candidates.
const ITEM_HEADING_PREFIX =
  "#Content__Wrapper > section > div > div.container-card > div > form > div > div:nth-child";
const itemHeading = (index: number) =>
  `${ITEM_HEADING_PREFIX}(${2 * (index + 1)}) > div.d-flex.p-3.accordion-header.flex-row > div.d-flex.flex-column.accordion-left-content > h3`;
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
// A genuine server-side failure to read the document at all — distinct from NOT_DETECTED_HEADING
// (which means it DID read the document but found no items on it). Confirmed live: "Oops!
// Something went wrong on our end. It looks like we were not able to read your document. You can
// retry or continue to the next step to manually enter the details..." alongside its own RETRY
// button, separate from the item-detection UI entirely.
const READ_ERROR_HEADING = /something went wrong on our end/i;
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
 * positioned: a no-op if you're already on the student picker; the fast `requestAnotherReimbursement()`
 * path if you're still sitting on the previous group's post-submit confirmation page (deliberately
 * left there rather than navigated away from the moment it appeared — see the call site in
 * main.ts); otherwise falls back to the slower Dashboard/Reimbursements-list path.
 */
export async function ensureOnNewReimbursementForm(page: Page): Promise<void> {
  if (REIMBURSEMENT_STEP_PATTERNS.studentSelection.test(page.url())) return;
  if (REIMBURSEMENT_STEP_PATTERNS.confirmation.test(page.url())) {
    await requestAnotherReimbursement(page);
    return;
  }
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

export type ItemScanOutcome = "detected" | "notDetected" | "readError";

/**
 * Checks how StepUp's OCR scan of the uploaded receipt came out. Arriving at this screen's URL
 * only means StepUp has *started* reading the document — it shows its own loading state ("One
 * moment while we read your document... This could take up to 60 seconds") before rendering any
 * outcome, confirmed against a real screenshot. So this waits for that loading state to clear
 * first (covers every outcome, and resolves immediately if scanning already finished by the time
 * we check), then does a quick follow-up check for the two known failure headings — a naive short
 * timeout on a heading alone would catch the DOM mid-scan and wrongly conclude success (confirmed
 * in practice) — checked concurrently so covering both doesn't double the worst-case wait.
 *
 * "notDetected" ("we weren't able to detect items or services on this document") means StepUp
 * read the document fine but found nothing on it — the existing, already-handled case. "readError"
 * ("Oops! Something went wrong on our end... not able to read your document") is a different,
 * newer failure mode confirmed live: a genuine server-side failure to read the document at all,
 * with its own separate "Retry" UI. The caller (main.ts) treats these differently: the latter
 * warrants asking you to actually look at the document before assuming it's fine to fall back to
 * manual entry — an unreadable document could just as easily mean the file itself is broken.
 */
export async function checkItemScan(page: Page, scanTimeoutMs = 90000): Promise<ItemScanOutcome> {
  await browserInfo(page, "Waiting for StepUp's AI to finish scanning the document for items (can take up to a minute)...");
  await page
    .getByText(SCANNING_HEADING)
    .waitFor({ state: "hidden", timeout: scanTimeoutMs })
    .catch(() => {});
  const [notDetected, readError] = await Promise.all([
    page
      .getByText(NOT_DETECTED_HEADING)
      .waitFor({ state: "visible", timeout: 5000 })
      .then(() => true)
      .catch(() => false),
    page
      .getByText(READ_ERROR_HEADING)
      .waitFor({ state: "visible", timeout: 5000 })
      .then(() => true)
      .catch(() => false),
  ]);
  await clearBanner(page);
  if (readError) return "readError";
  return notDetected ? "notDetected" : "detected";
}

/**
 * Clicks a "Continue" button by visible text/role. UNVERIFIED against the live DOM — unlike
 * Pre-Auth, this flow's buttons don't have stable IDs, so this uses a role/text locator instead
 * of a selector; adjust the matcher if StepUp's actual button text differs from a plain "Continue".
 */
export async function clickContinue(page: Page): Promise<void> {
  await page.getByRole("button", { name: /continue/i }).first().click();
}

// Item/Service Selection screen (AI-detected items shown as checkboxes to confirm before moving
// on to Item/Service Details). Real structure, confirmed via a live outerHTML dump:
// div.right-container > div.line-items > div.grid (one grid per row: "Select All" first, then
// one per detected item, each with an <input id="item_0" ...> + sibling .form-check-label). Every
// item checkbox actually shares the literal id "item_0" (StepUp's own markup, not ours) — harmless
// for us since we index by position within this container, not by id, and input[id^="item_"] still
// correctly matches all of them while excluding the "Select All" checkbox (id="select-all").
// An earlier version of this selector (`... div.right-container > div > div:nth-child(2)`) went
// one level too deep and landed on the FIRST item's own row instead of the shared list container —
// that's why checkbox/label counts always read exactly 1 no matter how long we waited: it wasn't a
// timing issue or a StepUp-side rendering race at all, just scoped to a single row the whole time.
const ITEM_SELECTION_LIST = "div.right-container > div.line-items";

/**
 * Mirrors fillItemDetails()'s OCR-name matching one step earlier: tries to auto-check the box for
 * each detected item by matching its label text against the candidate rows' Item names, checking
 * only unambiguous (exactly one match) hits and leaving anything else unchecked for manual
 * review. Returns true only if every detected checkbox found a confident match *and* every
 * candidate row got matched to one — i.e. it's safe to auto-continue without you looking at it.
 * Short-circuits first: if the checkbox count exactly equals the candidate row count, all boxes are
 * checked and it returns true without any name matching.
 * Doesn't assume the checkbox count equals candidateRows.length — the AI can under- or over-detect
 * items relative to our row count, and both cases just fall through to manual review via the
 * remaining.length check at the end rather than being special-cased up front.
 */
export async function autoCheckDetectedItems(page: Page, candidateRows: Table1Row[]): Promise<boolean> {
  const list = page.locator(ITEM_SELECTION_LIST);
  const checkboxes = list.locator('input[id^="item_"]');
  const labels = list.locator(".form-check-label");

  const checkboxCount = await checkboxes.count();
  const labelCount = await labels.count();
  if (checkboxCount === 0) return false;

  // Counts line up exactly: trust it and check everything without name-matching. A wrong pairing
  // gets caught and fixable on the next (Item/Service Details) screen, so it isn't worth stopping for.
  if (checkboxCount === candidateRows.length) {
    for (let i = 0; i < checkboxCount; i++) await checkboxes.nth(i).check({ timeout: 5000 });
    console.log(`  ${checkboxCount} checkbox(es) match ${candidateRows.length} candidate row(s) — checked all and continuing.`);
    return true;
  }

  if (checkboxCount !== labelCount) {
    console.log(`  Found ${checkboxCount} checkbox(es) but ${labelCount} label(s) — mismatch, leaving all unchecked for manual review.`);
    return false;
  }

  const remaining = [...candidateRows];
  let allChecked = true;

  for (let i = 0; i < checkboxCount; i++) {
    const label = (await labels.nth(i).textContent({ timeout: 5000 }).catch(() => null))?.trim() ?? "";
    if (!label) {
      console.log(`  Item ${i + 1}: couldn't read its label — leaving unchecked for manual review.`);
      allChecked = false;
      continue;
    }

    const matches = remaining.filter((r) => (r.data["Item"] || "").trim().toLowerCase() === label.toLowerCase());
    if (matches.length === 1) {
      await checkboxes.nth(i).check({ timeout: 5000 });
      remaining.splice(remaining.indexOf(matches[0]), 1);
      console.log(`  Checked "${label}" — matched row ID ${matches[0].data["ID"]}.`);
    } else {
      console.log(
        `  "${label}" — ${matches.length === 0 ? "no" : "ambiguous"} match against remaining candidate rows, leaving unchecked for manual review.`
      );
      allChecked = false;
    }
  }

  return allChecked && remaining.length === 0;
}

interface FillResult {
  matchedRows: Table1Row[];
  unmatchedBlockIndexes: number[];
}

/**
 * Polls #vendorName and this item block's own providerButton() until whichever one is real for
 * this category holds steady for a beat, rather than trusting a single read — see the call site's
 * comment for the live-diagnosed failure this replaces. #vendorName itself is intentionally left
 * unscoped/`.last()`-indexed for now (matching its pre-existing use in selectVendorOrProvider's
 * own "Provider not Listed" fallback) since no real run has exercised a genuinely vendor-field
 * category since the per-item-block duplication pattern was found elsewhere on this page — if a
 * future run misfires on the wrong item block's #vendorName, scope it the same way providerButton
 * was just fixed (a real "Vendor Name" field label to search within the item block by).
 */
async function waitForVendorFieldType(page: Page, index: number, timeoutMs = 10000): Promise<"vendor" | "provider" | "none"> {
  const deadline = Date.now() + timeoutMs;
  let lastType: "vendor" | "provider" | "none" = "none";
  let stableSince = Date.now();
  while (Date.now() < deadline) {
    const hasProvider = (await page.locator(providerButton(index)).count()) > 0;
    const hasVendor = !hasProvider && (await page.locator(VENDOR_NAME).count()) > 0;
    const currentType: "vendor" | "provider" | "none" = hasProvider ? "provider" : hasVendor ? "vendor" : "none";
    if (currentType !== lastType) {
      lastType = currentType;
      stableSince = Date.now();
    } else if (currentType !== "none" && Date.now() - stableSince > 800) {
      return currentType;
    }
    await page.waitForTimeout(300);
  }
  return lastType;
}

/**
 * Fills in one already-matched item block's fields: Category/Type/Description, Benefit Message,
 * Item/Service URL, Vendor or Provider (whichever this category settles on), Service Date,
 * Invoice #, Cost per Item, Quantity, Tax/Shipping, and Purchase Date — overwriting whatever
 * StepUp pre-filled with the Excel value (warning first) per your call that Excel is the source
 * of truth. Shared by both fillItemDetails() (OCR-based matching) and fillItemDetailsSequentially()
 * (no OCR to match against at all) — matching a block to a row is the only part that differs
 * between the two.
 */
async function fillBlockFields(
  page: Page,
  index: number,
  row: Table1Row,
  allRows: Table1Row[],
  hooks: CategoryFixHooks = noopCategoryFixHooks
): Promise<void> {
  if (row.data["Category"]) {
    await fillCategory(page, index, row.data["Category"], row, allRows, hooks);
  }
  if (row.data["Benefit Message"]) {
    await page.locator(EDUCATIONAL_BENEFIT).nth(index).fill(row.data["Benefit Message"]);
  }
  if (row.data["Item/Service URL"]) {
    await page.locator(ITEM_SERVICE_URL).nth(index).fill(row.data["Item/Service URL"]);
  }

  // Vendor Name / Service Date / Provider are conditional on the category just picked above
  // (a category requires either Vendor or Provider, never both, and Service Date only for some).
  // Live-diagnosed: a blind fixed wait + one-shot #vendorName check isn't safe — on a real run,
  // #vendorName briefly existed (as some kind of transient/default state right after picking the
  // category) for an item block whose category ultimately settled on requiring Provider instead,
  // and got permanently mistaken for the real field, silently leaving that item without any
  // vendor/provider at all once #vendorName was later removed by StepUp itself. Poll both
  // possibilities until whichever one is real holds steady for a beat, instead of trusting a
  // single read at an arbitrary point in StepUp's own settling process.
  const vendorFieldType = await waitForVendorFieldType(page, index);
  if (vendorFieldType === "vendor" && row.data["Vendor"]) {
    await overwriteIfDifferent(page.locator(VENDOR_NAME).last(), row.data["Vendor"], "Vendor");
  } else if (vendorFieldType === "provider") {
    const providerName = row.data["Service Provider"] || row.data["Vendor"];
    if (providerName) await selectVendorOrProvider(page, providerName, index);
  }
  if (row.data["Service Date"]) {
    await page.locator(SERVICE_DATE).first().waitFor({ state: "attached", timeout: 5000 }).catch(() => {});
    if ((await page.locator(SERVICE_DATE).count()) > 0) {
      await overwriteDateIfDifferent(page.locator(SERVICE_DATE).last(), row.data["Service Date"]);
    }
  }
  await overwriteIfDifferent(page.locator(INVOICE_NUMBER).nth(index), row.data["Invoice #"], "Invoice #");
  await overwriteIfDifferent(page.locator(COST_PER_ITEM).nth(index), formatMoney(row.data["Amount"]), "Cost per Item", true);
  await overwriteIfDifferent(page.locator(QUANTITY).nth(index), row.data["Quantity"], "Quantity");
  await overwriteIfDifferent(
    page.locator(ADDITIONAL_COSTS).nth(index),
    formatMoney(row.data["Tax, Shipping, etc."]),
    "Tax/Shipping",
    true
  );
  await overwriteDateIfDifferent(page.locator(PURCHASE_DATE).nth(index), row.data["Date"]);
}

const ADD_ITEM_BUTTON_TEXT = "Add an Item";

/**
 * Walks each "Item N" detail block on the Item/Service Details screen, matches it to one of
 * `candidateRows` by comparing the OCR-filled Cost per Item against each row's Amount (asking
 * you to confirm or correct via the terminal when it's genuinely ambiguous), then fills its
 * fields via fillBlockFields(). If StepUp hands us fewer blocks than there are candidate rows —
 * whether because AI detection failed entirely (one blank default block) or only partially
 * detected some items — clicks "Add an Item" ourselves to create more as needed rather than
 * asking you to pre-create them up front (a non-blocking banner asking you to do that used to let
 * this function start processing before you'd added anything).
 *
 * `noOcrData`, when true (pass this after itemDetectionFailed() returns true), skips straight to
 * matching each block to the next remaining row in order instead of ever asking you to disambiguate:
 * with zero OCR data on every block, there's no real signal to prompt about — StepUp gave you no
 * indication which row is which, so the natural, only-sensible assignment is the same one a human
 * filling this in by hand would use, top to bottom. Without this flag, a 2+ row group with no
 * detection would still hit a real prompt per block for no useful reason.
 *
 * `allRows`, if given, is the full set of rows for the whole run (not just this group) — used
 * purely so a Category dropdown mismatch (see fillCategory()) can offer to apply its fix to other
 * rows elsewhere in the run that share the exact same Category value, instead of just this one.
 * Defaults to `candidateRows` when omitted, so a mismatch still resolves fine — it just won't know
 * about any sibling rows outside this one group.
 */
export async function fillItemDetails(
  page: Page,
  candidateRows: Table1Row[],
  noOcrData = false,
  allRows: Table1Row[] = candidateRows,
  hooks: CategoryFixHooks = noopCategoryFixHooks
): Promise<FillResult> {
  let count = await page.locator(CATEGORY_BUTTON).count();
  console.log(`\nFound ${count} item detail block(s) on this screen.`);

  const remaining = [...candidateRows];
  const matchedRows: Table1Row[] = [];
  const unmatchedBlockIndexes: number[] = [];

  for (let i = 0; i < count || remaining.length > 0; i++) {
    if (i >= count) {
      console.log(`\nNeed another item block for the remaining candidate row(s) — clicking "Add an Item"...`);
      await browserInfo(page, "Waiting for StepUp to add a new item block...");
      await page.getByRole("button", { name: ADD_ITEM_BUTTON_TEXT, exact: true }).click();
      const deadline = Date.now() + 15000;
      while ((await page.locator(CATEGORY_BUTTON).count()) <= i && Date.now() < deadline) {
        await page.waitForTimeout(300);
      }
      count = await page.locator(CATEGORY_BUTTON).count();
      await clearBanner(page);
      if (count <= i) {
        throw new Error(`Clicked "Add an Item" for block ${i + 1} but it never appeared within 15000ms.`);
      }
    }

    const rawCost = await page.locator(COST_PER_ITEM).nth(i).inputValue().catch(() => "");
    const ocrCost = Number.parseFloat(rawCost.replace(/[^0-9.]/g, ""));

    // OCR often reads the item's name reliably even when it can't read the amount (e.g. "$0.00")
    // — heading text is "Item N : {name}"; take everything after the first " : ".
    const rawHeading = await page.locator(itemHeading(i)).textContent().catch(() => null);
    const ocrName = rawHeading?.split(/:\s*/).slice(1).join(":").trim() || undefined;

    console.log(
      `\n--- Item block ${i + 1} of ${count} (OCR cost: ${rawCost || "(blank)"}, OCR name: ${ocrName || "(blank)"}) ---`
    );
    if (remaining.length === 0) {
      console.log("No unmatched candidate rows left for this group — leaving this block for you to handle manually.");
      unmatchedBlockIndexes.push(i);
      continue;
    }

    const autoMatchIndex = remaining.findIndex(
      (r) => Number.isFinite(ocrCost) && Math.abs(Number.parseFloat(r.data["Amount"] || "NaN") - ocrCost) < 0.01
    );
    // Only trust a name match when it's unambiguous (exactly one candidate), same caution as the
    // vendor-dropdown substring fallback — a name that happens to match two rows isn't a real signal.
    const nameMatches = ocrName
      ? remaining.filter((r) => (r.data["Item"] || "").trim().toLowerCase() === ocrName.toLowerCase())
      : [];

    console.log("Remaining candidate row(s) for this group:");
    remaining.forEach((r) => console.log(`  ID ${r.data["ID"]}: "${r.data["Item"]}" — $${formatMoney(r.data["Amount"]) || "?"}`));

    let matchedRow: Table1Row;
    if (autoMatchIndex !== -1) {
      matchedRow = remaining[autoMatchIndex];
      console.log(`  Matched to row ID ${matchedRow.data["ID"]} ("${matchedRow.data["Item"]}") by amount.`);
    } else if (nameMatches.length === 1) {
      matchedRow = nameMatches[0];
      console.log(`  Matched to row ID ${matchedRow.data["ID"]} ("${matchedRow.data["Item"]}") by OCR-detected name.`);
    } else if (remaining.length === 1) {
      matchedRow = remaining[0];
      console.log(`  Only one candidate row left — matched to ID ${matchedRow.data["ID"]} ("${matchedRow.data["Item"]}").`);
    } else if (noOcrData) {
      matchedRow = remaining[0];
      console.log(`  No OCR data to match against — assigning by row order: ID ${matchedRow.data["ID"]} ("${matchedRow.data["Item"]}").`);
    } else {
      const answer = await browserChoose(
        page,
        `Item block ${i + 1} of ${count} (OCR cost: ${rawCost || "(blank)"}, OCR name: "${ocrName || "(blank)"}") — no automatic match. Which row does this correspond to?`,
        remaining.map((r) => ({ label: `ID ${r.data["ID"]}: "${r.data["Item"]}" — $${formatMoney(r.data["Amount"]) || "?"}`, value: r.data["ID"] }))
      );
      matchedRow = findRowById(remaining, answer.trim());
    }

    remaining.splice(remaining.indexOf(matchedRow), 1);
    matchedRows.push(matchedRow);
    await fillBlockFields(page, i, matchedRow, allRows, hooks);
  }

  return { matchedRows, unmatchedBlockIndexes };
}

/** Scrolls so the first "Item 1" block's heading is at the top of the view (the page may scroll inside an inner container, so window.scrollTo isn't enough); falls back to the window top if it isn't found. */
export async function scrollToFirstItem(page: Page): Promise<void> {
  const heading = page.locator(itemHeading(0));
  if ((await heading.count()) > 0) {
    await heading.evaluate((el) => {
      (el as HTMLElement).style.scrollMarginTop = "90px";
      el.scrollIntoView({ block: "start" });
    }).catch(() => {});
  } else {
    await page.evaluate("window.scrollTo(0, 0)").catch(() => {});
  }
}

function findRowById(rows: Table1Row[], id: string): Table1Row {
  const row = rows.find((r) => r.data["ID"] === id);
  if (!row) throw new Error(`No remaining candidate row with ID "${id}".`);
  return row;
}

/** Rounds a dollar value from Excel to two decimal places (e.g. "12.345" -> "12.35"); leaves blanks and non-numbers untouched. */
export function formatMoney(value: string | undefined): string | undefined {
  if (!value) return value;
  const n = Number.parseFloat(String(value).replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? (Math.round((n + Number.EPSILON) * 100) / 100).toFixed(2) : value;
}

async function overwriteIfDifferent(
  locator: ReturnType<Page["locator"]>,
  excelValue: string | undefined,
  label: string,
  numeric = false
): Promise<void> {
  if (!excelValue) return;
  const current = await locator.inputValue().catch(() => "");
  if (current.trim() === excelValue.trim()) return;
  // "12.5" and "12.50" are the same money value, so don't flag/overwrite over formatting alone.
  if (numeric && Math.abs(Number.parseFloat(current.replace(/[^0-9.\-]/g, "")) - Number.parseFloat(excelValue)) < 0.005) return;
  console.log(`  ${label} mismatch: StepUp has "${current}", Excel has "${excelValue}" — overwriting with Excel's value.`);
  await locator.fill(excelValue);
}

/** Graph returns date cells as raw Excel serial numbers (e.g. "45888"), not formatted strings —
 *  days since the Excel epoch of 1899-12-30. Converts that to a real Date; falls through to
 *  normal Date parsing for anything that isn't a bare integer (already-ISO strings, etc.). */
export function parseExcelDate(value: string): Date {
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
 * Clicks `locator` by dispatching a raw DOM `.click()` inside the browser (via Locator.evaluate())
 * instead of Playwright's own coordinate-based click. Live-diagnosed as necessary for StepUp's
 * dropdown option lists specifically: they can render via `position: fixed` and open *upward* with
 * their own internal scroll, so a real, genuinely-clickable, exact-matching option can simultaneously
 * (a) never satisfy Playwright's actionability/stability polling (observed live: a hang lasting
 * 10+ minutes, with the list's internal scroll position visibly bouncing between two values,
 * never converging) and, once that's bypassed with `force: true`, (b) still be physically outside
 * the actual browser window's visible bounds ("Element is outside of the viewport") even after
 * being scrolled into the *list's own* view. A raw DOM click needs neither stability nor on-screen
 * coordinates, sidestepping both — confirmed live: this exact sequence, tried on the exact element
 * Playwright was stuck on, succeeded instantly and StepUp's own UI updated correctly.
 */
async function rawClick(locator: Locator): Promise<void> {
  await locator.evaluate((el) => (el as HTMLElement).click());
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
    await rawClick(exactOption);
    return;
  }

  const partialMatches = dropdown.getByText(name, { exact: false });
  const partialCount = await partialMatches.count();
  if (partialCount === 1) {
    const matchedText = await partialMatches.first().textContent();
    console.log(`  "${name}" matched "${matchedText?.trim()}" in the provider list (partial match).`);
    await rawClick(partialMatches.first());
    return;
  }

  console.log(
    `  "${name}" not found (or ambiguous — ${partialCount} partial match(es)) in the provider list — falling back to manual Vendor Name entry.`
  );
  await rawClick(dropdown.getByText(PROVIDER_NOT_LISTED_TEXT, { exact: true }));
  await page.locator(VENDOR_NAME).last().fill(name);
}

/**
 * Opens a dropdown button and clicks a visible-text option, then verifies the button's own
 * displayed text actually changed to reflect it. Live-diagnosed (connected a read-only inspector
 * to a real stuck run rather than guessing): each item block keeps its own copy of the same
 * category/type/description option list in the DOM even while collapsed/closed, so an unscoped
 * page.getByText() search can resolve to a *different*, invisible item block's copy of the same
 * option text — Playwright then waits (using our 10-minute default) for that invisible element to
 * become clickable, which it never will, hanging indefinitely. Confirmed live: only one dropdown
 * is ever open at a time (Bootstrap's own behavior — opening one auto-closes any other), so
 * scoping the option search to `.dropdown-menu.show` reliably targets the real, visible one.
 *
 * `waitForDependent`, if given, covers a second live-diagnosed failure mode: a real run's category
 * selection correctly updated the button's own text but StepUp's cascade to render the next
 * level's field (e.g. #categoryType) silently never fired for one particular item block — the
 * field only appeared once the category was reselected by hand, a genuine mouse interaction.
 * Requiring the dependent field to actually show up before declaring success (and retrying the
 * whole click sequence, same as a button-text mismatch, if it doesn't) means a missed cascade gets
 * a real retry here instead of leaving the next step to hang forever waiting on a field that was
 * never coming. `minCount` (not just "does at least one exist") matters just as much as the
 * selector itself: earlier item blocks that already finished their own cascade leave their own
 * copy of the same field (e.g. #categoryType) sitting in the DOM, so a bare existence check is a
 * false positive for any later item block whose own cascade actually silently failed — confirmed
 * live (item 3 of 3 "passed" this check purely because items 1 and 2's own #categoryDetail already
 * existed, while item 3's never appeared at all). Item blocks are processed in the same top-to-
 * bottom order they sit in the DOM, so by the time item block `index` is being processed, exactly
 * `index` earlier copies of the field should already exist — `index + 1` is what confirms *this*
 * block's own copy has genuinely landed, not just some earlier block's.
 *
 * The option click dispatches a raw DOM `.click()` via `Locator.evaluate()` instead of Playwright's
 * own coordinate-based click. Live-diagnosed in two rounds: first a genuine hang (10+ minutes, not
 * a timeout) where the target option's exact text existed and was visibly on screen but
 * Playwright's own actionability/stability polling never settled (observable live: the dropdown's
 * internal scroll position kept flipping between two values in a loop, never converging) — a raw
 * `element.click()` on that same element via page.evaluate() succeeded instantly and StepUp's own
 * UI updated correctly, proving the element genuinely was clickable. Switching to `{ force: true }`
 * fixed that hang but immediately hit a second, more specific failure: "Element is outside of the
 * viewport" — this dropdown renders via `position: fixed` and opens *upward* with its own internal
 * scroll (that's what was bouncing), so the target can be scrolled into the *list's own* view while
 * still being physically outside the actual browser window, which even `force: true` can't click
 * since Playwright still needs real on-screen coordinates. A raw DOM `.click()` needs neither
 * stability nor visible coordinates, sidestepping both failure modes at once — confirmed as the
 * right fix by the same manual test that found the first problem.
 */
async function clickDropdownOptionAndVerify(
  page: Page,
  button: Locator,
  optionText: string,
  opts: { maxAttempts?: number; waitForDependent?: { selector: string; minCount: number } } = {}
): Promise<void> {
  const maxAttempts = opts.maxAttempts ?? 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await button.click();
    const openMenu = page.locator(".dropdown-menu.show");
    await rawClick(openMenu.getByText(optionText, { exact: true }).last());

    const currentText = (await button.textContent().catch(() => null))?.trim() ?? "";
    let ok = currentText.includes(optionText);
    if (ok && opts.waitForDependent) {
      const { selector, minCount } = opts.waitForDependent;
      const deadline = Date.now() + 8000;
      let count = await page.locator(selector).count();
      while (count < minCount && Date.now() < deadline) {
        await page.waitForTimeout(300);
        count = await page.locator(selector).count();
      }
      ok = count >= minCount;
    }

    if (ok) return;
    if (attempt < maxAttempts) {
      console.log(`  Dropdown selection "${optionText}" didn't fully register (attempt ${attempt}/${maxAttempts}) — retrying...`);
      await page.waitForTimeout(500);
    }
  }
  throw new Error(`Couldn't select "${optionText}" from the dropdown after ${maxAttempts} attempt(s).`);
}

const CATEGORY_LEVEL_LABELS = ["Category", "Type", "Description"];

/**
 * Lets a resolved Category mismatch (see fillCategory()) get persisted outside this file without
 * this file taking on any Graph API concerns itself — the caller (main.ts) wires these up to
 * actually write to Table1/Table5, this file just calls them at the moment of resolution.
 */
export interface CategoryFixHooks {
  /** Fires once per resolved mismatch, immediately — persists the rename into Table5. */
  onRenamed: (oldPath: string, newPath: string) => Promise<void>;
  /** Fires once per batch of Table1 rows whose Category cell needs correcting to `newValue`. */
  onRowsFixed: (rows: Table1Row[], newValue: string) => Promise<void>;
}

const noopCategoryFixHooks: CategoryFixHooks = {
  onRenamed: async () => {},
  onRowsFixed: async () => {},
};

/**
 * Once a Category dropdown mismatch has been resolved for a given raw Excel "Category" string
 * (see fillCategory()), the working level texts are remembered here for the rest of this process's
 * lifetime — keyed by the exact raw string, so any other row/block sharing that identical value
 * (elsewhere in the same run) skips straight past the mismatch-handling below instead of hitting
 * (and re-prompting for) the same dead end again. Deliberately in-memory only, not persisted to
 * disk: it's a same-run convenience, not a record of what StepUp's real categories are (that's
 * categorySync.ts's job).
 */
const categoryOverrides = new Map<string, string[]>();

/**
 * Waits (briefly, not Playwright's 10-minute default) for at least one option matching `text` to
 * exist in `openMenu`, to absorb ordinary rendering lag without mistaking a slow-to-render-but-real
 * option for a genuinely missing one. Returns the match count once it stops being 0, or once
 * `timeoutMs` elapses — whichever first.
 */
async function waitForOptionCount(openMenu: Locator, text: string, exact: boolean, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let count = await openMenu.getByText(text, { exact }).count();
  while (count === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    count = await openMenu.getByText(text, { exact }).count();
  }
  return count;
}

async function waitForFieldCount(page: Page, selector: string, minCount: number, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let count = await page.locator(selector).count();
  while (count < minCount && Date.now() < deadline) {
    await page.waitForTimeout(300);
    count = await page.locator(selector).count();
  }
  return count >= minCount;
}

/**
 * Clicks `optionText` in the dropdown menu that's already open (from the caller's own probing) and
 * verifies the button's displayed text updated to reflect it, retrying (reopening the dropdown) a
 * few times if it didn't — same raw-DOM-click/verify/waitForDependent technique as the original
 * clickDropdownOptionAndVerify() above, just split out so the caller can probe the open menu's
 * actual contents first instead of trusting `optionText` blindly. Doesn't click the button on the
 * first attempt (unlike clickDropdownOptionAndVerify) because the caller already opened it to
 * inspect its options — clicking a Bootstrap dropdown toggle a second time closes it instead of
 * being a harmless no-op, which would otherwise strand the very next line waiting on a menu that
 * just disappeared.
 */
async function clickOpenOptionAndVerify(
  page: Page,
  button: Locator,
  optionText: string,
  waitForDependent?: { selector: string; minCount: number },
  maxAttempts = 3
): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) await button.click();
    const openMenu = page.locator(".dropdown-menu.show");
    await rawClick(openMenu.getByText(optionText, { exact: true }).last());

    const currentText = (await button.textContent().catch(() => null))?.trim() ?? "";
    let ok = currentText.includes(optionText);
    if (ok && waitForDependent) {
      ok = await waitForFieldCount(page, waitForDependent.selector, waitForDependent.minCount);
    }
    if (ok) return;
    if (attempt < maxAttempts) {
      console.log(`  Dropdown selection "${optionText}" didn't fully register (attempt ${attempt}/${maxAttempts}) — retrying...`);
      await page.waitForTimeout(500);
    }
  }
  throw new Error(`Couldn't select "${optionText}" from the dropdown after ${maxAttempts} attempt(s).`);
}

/**
 * Pauses so you can pick the right option yourself directly in StepUp's own dropdown — it's
 * already open, and our banner doesn't block the page (see browserPrompt.ts), so this works
 * without closing it first — then confirms via a banner button once you're done, rather than
 * letting Playwright hang against its 10-minute default timeout searching for option text that
 * genuinely isn't there. Compares the button's displayed text before/after to catch "I picked it"
 * being clicked without anything actually having been picked, and asks again instead of silently
 * carrying on with a stale/wrong value.
 */
async function resolveCategoryMismatchManually(
  page: Page,
  button: Locator,
  beforeText: string,
  desiredText: string,
  levelLabel: string,
  row: Table1Row
): Promise<string> {
  const rowSummary = `ID ${row.data["ID"] ?? "?"} ("${row.data["Item"] ?? ""}")`;
  const PICKED = "picked";
  const SKIP = "skip";
  let message =
    `${rowSummary}: couldn't find "${desiredText}" (or an unambiguous partial match) in the ${levelLabel} dropdown. ` +
    `It's open now — click the correct option yourself in StepUp, then click "I picked it" below.`;

  while (true) {
    const choice = await browserChoose(page, message, [
      { label: "I picked it — continue", value: PICKED },
      { label: "Skip this row (leave for manual entry later)", value: SKIP },
    ]);
    if (choice === SKIP) {
      throw new Error(`Skipped — couldn't match ${levelLabel} "${desiredText}" for ${rowSummary}, and you chose to skip it.`);
    }
    const currentText = (await button.textContent().catch(() => null))?.trim() ?? "";
    if (currentText && currentText !== beforeText) return currentText;
    message =
      `${rowSummary}: the ${levelLabel} selection doesn't look like it changed yet (still shows "${currentText || "(blank)"}"). ` +
      `Pick an option in the dropdown (reopen it if it closed), then click "I picked it" again.`;
  }
}

/**
 * Opens `button`'s dropdown and resolves `desiredText` against whatever options are actually
 * there: an exact match (the common case) is clicked immediately; failing that, an unambiguous
 * partial match (same "only trust it if there's exactly one hit" caution as selectVendorOrProvider's
 * own substring fallback) is used instead; failing that too — a genuine mismatch between the Excel
 * Category column and StepUp's real dropdown options — hands off to
 * resolveCategoryMismatchManually() rather than letting Playwright's default 10-minute action
 * timeout make this look like the whole process has hung.
 */
async function selectCategoryLevel(
  page: Page,
  button: Locator,
  desiredText: string,
  levelLabel: string,
  row: Table1Row,
  waitForDependent?: { selector: string; minCount: number }
): Promise<{ text: string; wasRepaired: boolean }> {
  const beforeText = (await button.textContent().catch(() => null))?.trim() ?? "";
  await button.click();
  const openMenu = page.locator(".dropdown-menu.show");
  await openMenu.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});

  const exactCount = await waitForOptionCount(openMenu, desiredText, true, 3000);
  if (exactCount > 0) {
    await clickOpenOptionAndVerify(page, button, desiredText, waitForDependent);
    return { text: desiredText, wasRepaired: false };
  }

  const partialMatches = openMenu.getByText(desiredText, { exact: false });
  const partialCount = await partialMatches.count();
  if (partialCount === 1) {
    const matchedText = (await partialMatches.first().textContent())?.trim() || desiredText;
    console.log(`  ${levelLabel} "${desiredText}" not found exactly in the dropdown — using partial match "${matchedText}".`);
    await clickOpenOptionAndVerify(page, button, matchedText, waitForDependent);
    return { text: matchedText, wasRepaired: true };
  }

  console.log(
    `  ${levelLabel} "${desiredText}" not found in the dropdown (${partialCount === 0 ? "no" : `${partialCount} ambiguous`} partial match(es)) — pausing for you to pick it manually.`
  );
  const manualText = await resolveCategoryMismatchManually(page, button, beforeText, desiredText, levelLabel, row);
  if (waitForDependent) await waitForFieldCount(page, waitForDependent.selector, waitForDependent.minCount);
  return { text: manualText, wasRepaired: true };
}

/**
 * After a Category mismatch gets fixed (auto partial-match or manual) for `row`, checks whether
 * any other row in `allRows` has the exact same raw Category string — a mismatch is usually
 * StepUp-side (a renamed/removed category) rather than a one-off typo, so it's likely to hit every
 * other row that used the same value. If any are found, offers to remember this fix for them too
 * (via `categoryOverrides`) so they sail through instead of stopping to ask again.
 */
async function offerToFixOtherRows(
  page: Page,
  categoryValue: string,
  resolvedLevels: string[],
  row: Table1Row,
  allRows: Table1Row[],
  hooks: CategoryFixHooks
): Promise<void> {
  const others = allRows.filter((r) => r !== row && (r.data["Category"] ?? "").trim() === categoryValue.trim());
  if (others.length === 0) return;

  const idList = others.map((r) => `ID ${r.data["ID"] ?? "?"} ("${r.data["Item"] ?? ""}")`).join(", ");
  const choice = await browserChoose(
    page,
    `Fixed Category "${categoryValue}" -> "${resolvedLevels.join(" - ")}". ${others.length} other item(s) in this run use the exact same Category value: ${idList}. Apply this same fix automatically when they come up, instead of asking again?`,
    [
      { label: `Yes, apply to all ${others.length}`, value: "yes" },
      { label: "No, ask me again for each one", value: "no" },
    ]
  );
  if (choice === "yes") {
    categoryOverrides.set(categoryValue, resolvedLevels);
    console.log(`  Will auto-apply this fix to ${others.length} other row(s) with Category "${categoryValue}".`);
    await hooks.onRowsFixed(others, resolvedLevels.join(" - "));
  }
}

/**
 * Selects each cascading level parsed from the Excel "Category" column (e.g. "Bob - Smith - Widget")
 * across StepUp's three separate dropdown buttons: Category (#category, exists per item block from
 * the start) -> Type (#categoryType) -> Description (#categoryDetail) — the latter two only appear
 * in the DOM once their parent level has been picked, so they're targeted with .last() rather than
 * .nth(index).
 *
 * Graceful degradation for a level whose Excel text doesn't match any real dropdown option (the
 * spreadsheet drifting out of sync with StepUp's own category list is a real, recurring failure
 * mode — previously this hung for up to Playwright's 10-minute default timeout, indistinguishable
 * from the whole process having frozen): try an unambiguous partial-string match first, then fall
 * back to pausing for you to pick it manually — see selectCategoryLevel(). Once fixed, offers to
 * apply the same fix to every other row elsewhere in this run with the identical raw Category value
 * (see offerToFixOtherRows()) — a mismatch is almost always StepUp-side, so it tends to hit every
 * row that shares that value, not just this one. A value already resolved this way (or already
 * confirmed correct via the exact-match fast path) is cached in `categoryOverrides` and reused
 * directly for the rest of this process's lifetime.
 */
async function fillCategory(
  page: Page,
  index: number,
  categoryValue: string,
  row: Table1Row,
  allRows: Table1Row[],
  hooks: CategoryFixHooks = noopCategoryFixHooks
): Promise<void> {
  const rawLevels = parseCategoryLevels(categoryValue);
  if (rawLevels.length === 0) return;

  const cachedLevels = categoryOverrides.get(categoryValue);
  const levelsToSelect = cachedLevels ?? rawLevels;
  const resolvedLevels: string[] = [];
  let repaired = false;

  for (let i = 0; i < levelsToSelect.length; i++) {
    const button =
      i === 0 ? page.locator(CATEGORY_BUTTON).nth(index) : page.locator(i === 1 ? CATEGORY_TYPE_BUTTON : CATEGORY_DETAIL_BUTTON).last();
    const hasNext = i < levelsToSelect.length - 1;
    const waitForDependent = hasNext
      ? { selector: i === 0 ? CATEGORY_TYPE_BUTTON : CATEGORY_DETAIL_BUTTON, minCount: index + 1 }
      : undefined;

    if (cachedLevels) {
      // Already confirmed to be real, clickable options earlier in this run — go straight to
      // clicking them (dropdown starts closed here, so the original click-fresh-each-attempt
      // helper is safe to reuse) rather than re-running the exact/partial-match search.
      await clickDropdownOptionAndVerify(page, button, levelsToSelect[i], { waitForDependent });
      resolvedLevels.push(levelsToSelect[i]);
      continue;
    }

    const result = await selectCategoryLevel(page, button, levelsToSelect[i], CATEGORY_LEVEL_LABELS[i] ?? `Level ${i + 1}`, row, waitForDependent);
    resolvedLevels.push(result.text);
    if (result.wasRepaired) repaired = true;
  }

  if (repaired) {
    const newCategoryValue = resolvedLevels.join(" - ");
    await hooks.onRenamed(categoryValue, newCategoryValue);
    await hooks.onRowsFixed([row], newCategoryValue);
    await offerToFixOtherRows(page, categoryValue, resolvedLevels, row, allRows, hooks);
  }
}

/**
 * Reads the Reimbursement ID off the post-submit confirmation screen. Call only after you've
 * submitted. Retries for a bit rather than reading once: arriving at the confirmation URL
 * doesn't mean the real ID has rendered into the heading yet — confirmed in practice, a too-early
 * read caught a "#0" placeholder/loading state and wrote that straight into the spreadsheet as if
 * it were real. "0" is treated the same as no match at all — never a genuine reimbursement ID.
 */
export async function readReimbursementId(page: Page, timeoutMs = 15000): Promise<string> {
  await browserInfo(page, "Waiting for StepUp to generate your Reimbursement ID...");
  try {
    return await readReimbursementIdOnce(page, timeoutMs);
  } finally {
    await clearBanner(page);
  }
}

async function readReimbursementIdOnce(page: Page, timeoutMs: number): Promise<string> {
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
