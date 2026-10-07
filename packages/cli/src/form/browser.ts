import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

const STEPUP_URL = "https://apply.stepupforstudents.org/";

/** Dedicated Chrome profile for this automation only — separate from your everyday browsing.
 *  Persists across runs (gitignored, stays local). */
const PROFILE_DIR = path.resolve(process.cwd(), ".chrome-profile");

// Only used by launchStepUpBrowserServer()/connectToStepUpSession() — a fixed local port so the
// two processes can find each other. Not exposed outside localhost by Chrome's own CDP server.
const CDP_PORT = 9333;
const CDP_URL = `http://127.0.0.1:${CDP_PORT}`;

const TSX_BIN = path.resolve(process.cwd(), "node_modules", ".bin", "tsx");
const BROWSER_SERVER_SCRIPT = path.resolve(process.cwd(), "src", "browserServer.ts");
const BROWSER_SERVER_LOG = path.resolve(process.cwd(), "browser-server.log");
const CONNECT_RETRY_INTERVAL_MS = 500;
const AUTO_LAUNCH_TIMEOUT_MS = 60000;

async function tryConnect(): Promise<Browser | null> {
  try {
    return await chromium.connectOverCDP(CDP_URL);
  } catch {
    return null;
  }
}

/**
 * Spawns browserServer.ts as a fully detached background process — `detached: true` + `.unref()`
 * means it survives this process exiting, which is the entire point (see connectToStepUpSession()).
 * Its own console output goes to browser-server.log (gitignored) instead of this process's
 * terminal, since there's nothing left listening to its stdout once it outlives us.
 */
function spawnBrowserServer(): void {
  const log = openSync(BROWSER_SERVER_LOG, "a");
  const child = spawn(TSX_BIN, [BROWSER_SERVER_SCRIPT], {
    cwd: process.cwd(),
    detached: true,
    stdio: ["ignore", log, log],
  });
  child.unref();
}

function applyDefaultTimeouts(page: Page): void {
  // Playwright's unset default is 30s for every action/navigation — far too short once a human
  // is in the loop (login with MFA, slow page loads, etc.). The truly interactive prompts
  // (browserPrompt.ts, waitForLogin) already pass an explicit timeout: 0 (fully unbounded) for
  // the parts that wait on you specifically; this covers everything else (clicks, fills, goto)
  // that would otherwise still inherit the 30s default and kill the browser on a slow moment.
  page.setDefaultTimeout(10 * 60 * 1000);
  page.setDefaultNavigationTimeout(10 * 60 * 1000);
}

/**
 * Launches a headed session against your real, installed Chrome (not Playwright's bundled
 * Chromium) using a persistent profile. This is unrelated to StepUp's own login: StepUp's
 * session handling is unreliable (even back-navigation can log you out), so you still log into
 * StepUp itself manually every run — only the browser profile persists.
 *
 * This is the standalone, single-process form (used by one-off scripts like inspectPages.ts) —
 * the browser's lifetime is tied to this process. For the main automation, see
 * launchStepUpBrowserServer() / connectToStepUpSession() instead, which decouple the two so
 * restarting the automation script doesn't reopen Chrome or lose your login.
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
  applyDefaultTimeouts(page);
  await page.goto(STEPUP_URL);
  return { context, page };
}

/**
 * Launches Chrome with a local CDP debug port and leaves it running — meant to be called once by
 * the standalone browserServer.ts process and left open for a whole work session. Other processes
 * (main.ts) connect to it via connectToStepUpSession() instead of launching their own, so
 * restarting them (e.g. after a code fix) reconnects to the same already-logged-in browser/tab
 * rather than reopening Chrome and forcing you to log in again every time.
 */
export async function launchStepUpBrowserServer(): Promise<{
  context: BrowserContext;
  page: Page;
}> {
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: "chrome",
    headless: false,
    viewport: null,
    args: [`--remote-debugging-port=${CDP_PORT}`],
  });
  const page = context.pages()[0] ?? (await context.newPage());
  applyDefaultTimeouts(page);
  await page.goto(STEPUP_URL);
  return { context, page };
}

/**
 * Connects to an already-running browser server (launchStepUpBrowserServer(), normally started
 * via `npm run browser`) instead of launching a new browser — so restarting whatever calls this
 * (e.g. after a code fix) reconnects to the same already-logged-in browser/tab rather than
 * reopening Chrome and forcing you to log in again. If no server is running yet, this starts one
 * itself as a detached background process (survives this process exiting, by design — see
 * spawnBrowserServer()) and waits for it to come up, so you don't have to remember to run
 * `npm run browser` separately first. Picks whichever open tab is already on StepUp rather than
 * navigating anything once connected — reconnecting should never disturb an in-progress session.
 */
export async function connectToStepUpSession(): Promise<{
  browser: Browser;
  context: BrowserContext;
  page: Page;
}> {
  let browser = await tryConnect();
  const justSpawned = !browser;
  if (justSpawned) {
    console.log("No browser server running — starting one now (it'll keep running after this exits)...");
    spawnBrowserServer();
  }

  // A single retry loop covers both waits: the CDP port coming up, and (only when we just spawned
  // it ourselves) browserServer.ts's own initial page.goto() finishing. Deliberately never call
  // page.goto() from here — doing so concurrently with browserServer.ts's own in-flight navigation
  // of that same fresh page raced in practice ("Target page, context or browser has been closed"),
  // since two separate CDP client connections independently navigating the same target during its
  // very first about:blank -> real-URL transition isn't safe. Just wait for that navigation to
  // land instead of racing it.
  const deadline = Date.now() + AUTO_LAUNCH_TIMEOUT_MS;
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  while (Date.now() < deadline) {
    if (!browser) browser = await tryConnect();
    context = browser?.contexts()[0];
    if (context) {
      page = context.pages().find((p) => p.url().includes("stepupforstudents.org"));
      if (!page && !justSpawned) page = context.pages()[0] ?? (await context.newPage());
    }
    if (page) break;
    await new Promise((r) => setTimeout(r, CONNECT_RETRY_INTERVAL_MS));
  }
  if (!browser || !context || !page) {
    throw new Error(
      `Couldn't connect to the browser server at ${CDP_URL} within ${AUTO_LAUNCH_TIMEOUT_MS / 1000}s. ` +
        `Check ${BROWSER_SERVER_LOG} for what went wrong, or start it manually with "npm run browser".`
    );
  }

  applyDefaultTimeouts(page);
  return { browser, context, page };
}
