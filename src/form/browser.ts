import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

const STEPUP_URL = "https://apply.stepupforstudents.org/";

/**
 * Launches a fresh, headed, non-persistent browser session for the StepUp site.
 * StepUp's own session handling is unreliable (even back-navigation can log you
 * out), so we deliberately do NOT reuse a persistent profile for it — every run
 * starts clean and you log in manually.
 */
export async function launchStepUpSession(): Promise<{
  browser: Browser;
  context: BrowserContext;
  page: Page;
}> {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(STEPUP_URL);
  return { browser, context, page };
}
