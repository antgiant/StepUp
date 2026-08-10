import path from "node:path";
import type { Page } from "playwright";
import { downloadItem, findBestMatch, type DriveItemRef, type FolderChild } from "../graph/onedrive.js";
import type { FieldMapping, PageMapping } from "./fieldMap.js";
import { waitForEnter } from "./pause.js";

interface FillResult {
  selector: string;
  status: "filled" | "skipped-no-data" | "skipped-ambiguous-file" | "skipped-no-file" | "error";
  detail?: string;
}

/**
 * Fills every mapped field on the current page from applicant data / fixed values / matched
 * reference files. Never clicks Next or Submit — review and navigation stay in your hands.
 * Field VALUES are never printed; only which selectors were filled or skipped.
 */
export async function fillPage(
  page: Page,
  pageConfig: PageMapping,
  applicantData: Record<string, string>,
  folderRef: DriveItemRef,
  folderChildren: FolderChild[],
  dataDir: string
): Promise<FillResult[]> {
  console.log(`\n--- Filling page: "${pageConfig.name}" (${pageConfig.fields.length} mapped field(s)) ---`);
  const results: FillResult[] = [];

  for (const field of pageConfig.fields) {
    try {
      const result = await fillOne(page, field, applicantData, folderRef, folderChildren, dataDir);
      results.push(result);
    } catch (err) {
      results.push({ selector: field.selector, status: "error", detail: (err as Error).message });
    }
  }

  console.log("\nFill summary:");
  for (const r of results) {
    console.log(`  ${statusIcon(r.status)} ${r.selector}${r.detail ? ` — ${r.detail}` : ""}`);
  }
  const problems = results.filter((r) => r.status !== "filled");
  if (problems.length > 0) {
    console.log(`\n${problems.length} field(s) need your manual attention on this page.`);
  }

  return results;
}

function statusIcon(status: FillResult["status"]): string {
  switch (status) {
    case "filled":
      return "[x]";
    default:
      return "[ ]";
  }
}

async function fillOne(
  page: Page,
  field: FieldMapping,
  applicantData: Record<string, string>,
  folderRef: DriveItemRef,
  folderChildren: FolderChild[],
  dataDir: string
): Promise<FillResult> {
  if (field.source === "file") {
    const matches = findBestMatch(folderChildren, field.fileQuery);
    if (matches.length === 0) {
      return { selector: field.selector, status: "skipped-no-file", detail: `no file matched "${field.fileQuery}"` };
    }
    if (matches.length > 1) {
      const list = matches.map((m) => m.name).join(", ");
      return {
        selector: field.selector,
        status: "skipped-ambiguous-file",
        detail: `multiple files matched "${field.fileQuery}": ${list} — upload manually`,
      };
    }
    const match = matches[0];
    const localPath = path.join(dataDir, match.name);
    await downloadItem(folderRef.driveId, match.id, localPath);
    await page.locator(field.selector).setInputFiles(localPath);
    return { selector: field.selector, status: "filled", detail: match.name };
  }

  const rawValue = field.source === "column" ? applicantData[field.column] : field.value;
  if (field.source === "column" && (rawValue === undefined || rawValue === "")) {
    return { selector: field.selector, status: "skipped-no-data", detail: `no value for column "${field.column}"` };
  }

  const locator = page.locator(field.selector);
  const type = field.type ?? "text";
  switch (type) {
    case "select":
      await locator.selectOption({ label: String(rawValue) }).catch(() => locator.selectOption(String(rawValue)));
      break;
    case "checkbox":
      if (rawValue) await locator.check();
      else await locator.uncheck();
      break;
    case "radio":
      await locator.check();
      break;
    default:
      await locator.fill(String(rawValue));
  }
  return { selector: field.selector, status: "filled" };
}

/** Convenience wrapper: fills a page, then blocks until you confirm you've reviewed it in the browser. */
export async function fillPageAndConfirm(
  page: Page,
  pageConfig: PageMapping,
  applicantData: Record<string, string>,
  folderRef: DriveItemRef,
  folderChildren: FolderChild[],
  dataDir: string
): Promise<void> {
  await fillPage(page, pageConfig, applicantData, folderRef, folderChildren, dataDir);
  await waitForEnter(
    `Review "${pageConfig.name}" in the browser, fill in anything marked [ ] above yourself, then click Next/Continue yourself. Press Enter here once you've moved on.`
  );
}
