import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";

const STEPUP_URL = "https://apply.stepupforstudents.org/";

/** Dedicated Chrome profile for this automation only — separate from your everyday browsing.
 *  Persists across runs (gitignored, stays local). */
const PROFILE_DIR = path.resolve(process.cwd(), ".chrome-profile");

/**
 * Launches a headed session against your real, installed Chrome (not Playwright's bundled
 * Chromium) using a persistent profile. This is unrelated to StepUp's own login: StepUp's
 * session handling is unreliable (even back-navigation can log you out), so you still log into
 * StepUp itself manually every run — only the browser profile persists.
 */
export async function launchStepUpSession(): Promise<{
  context: BrowserContext;
  page: Page;
}> {
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: "chrome",
    headless: false,
    viewport: null,
  });
  const page = context.pages()[0] ?? (await context.newPage());
  // Playwright's unset default is 30s for every action/navigation — far too short once a human
  // is in the loop (login with MFA, slow page loads, etc.). The truly interactive prompts
  // (browserPrompt.ts, waitForLogin) already pass an explicit timeout: 0 (fully unbounded) for
  // the parts that wait on you specifically; this covers everything else (clicks, fills, goto)
  // that would otherwise still inherit the 30s default and kill the browser on a slow moment.
  page.setDefaultTimeout(10 * 60 * 1000);
  page.setDefaultNavigationTimeout(10 * 60 * 1000);
  await page.goto(STEPUP_URL);
  return { context, page };
}
