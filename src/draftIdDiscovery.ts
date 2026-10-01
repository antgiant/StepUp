import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";

const API_HOST_PATTERN = /reimbursementapi-prod\.stepupforstudents\.org/i;
const SEARCH_PATTERN = /\/search/i;
const LOG_FILE = path.resolve(process.cwd(), ".cache", "draft-id-discovery.log");

async function record(line: string): Promise<void> {
  console.log(`[id discovery] ${line}`);
  await mkdir(path.dirname(LOG_FILE), { recursive: true });
  await appendFile(LOG_FILE, `${new Date().toISOString()} ${line}\n`, "utf-8");
}

/**
 * Temporary, read-only discovery aid: we don't yet know where StepUp exposes a draft's
 * Reimbursement # before Submit. This logs (console + .cache/draft-id-discovery.log) every
 * non-search reimbursement API call with any "...Reimbursement...Id" values found in its JSON
 * response, so one real submission shows where the number first appears. Only the ID-looking
 * fields are logged, never full response bodies.
 */
export function attachDraftIdDiscovery(page: Page): void {
  page.on("response", async (response) => {
    const url = response.url();
    if (!API_HOST_PATTERN.test(url) || SEARCH_PATTERN.test(url)) return;
    const shortUrl = url.replace(/^https?:\/\/[^/]+/, "");
    let found = "";
    try {
      const text = await response.text();
      const matches = [...text.matchAll(/"([A-Za-z_]*[Rr]eimbursement[A-Za-z_]*(?:Id|ID|Number|Num))"\s*:\s*"?([\w-]+)"?/g)];
      found = matches.map((m) => `${m[1]}=${m[2]}`).join(", ");
    } catch {
      // Non-text/empty body (redirects, etc.) — still worth logging that the call happened.
    }
    await record(`${response.request().method()} ${response.status()} ${shortUrl}${found ? ` -> ${found}` : ""}`);
  });
}

/** Logs any "Reimbursement #123"-style text visible on the current page, tagged with the wizard step it was seen on. */
export async function scanPageForReimbursementId(page: Page, step: string): Promise<void> {
  const text = await page.evaluate("document.body.innerText").catch(() => "");
  const matches = [...String(text).matchAll(/reimbursement\s*(?:#|id|number)?\s*:?\s*#?\s*(\d{3,})/gi)];
  const uuid = page.url().match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0];
  await record(
    `step=${step} urlGuid=${uuid ?? "(none)"} pageText=${matches.length ? matches.map((m) => m[0].trim()).join(" | ") : "(no Reimbursement # text found)"}`
  );
}
