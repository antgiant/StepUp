import type { Page } from "playwright";

let promptCounter = 0;
// Forces every showPrompt() call to run strictly one at a time, regardless of what triggers
// them or from where — two of our own prompts must never be visible simultaneously.
let promptQueue: Promise<unknown> = Promise.resolve();

export interface PromptOption {
  label: string;
  value: string;
  /**
   * If set, this option ALSO gets a lightweight "Use this" button injected into this page's own
   * header (e.g. a document preview tab opened for this specific candidate), so it can be chosen
   * directly from there without switching back to the main page.
   */
  page?: Page;
}

/**
 * Shows `message` with one button per option in a top-layer popover, and blocks until one is
 * clicked — an in-browser replacement for terminal `readline` prompts, so you don't have to
 * alt-tab between the browser and CLI for every step of a submission.
 *
 * Uses the Popover API (`popover="manual"` + `showPopover()`) rather than a plain
 * `position: fixed` div or a `<dialog>`/`showModal()`:
 *  - A plain fixed-position element is positioned relative to the nearest ancestor with a CSS
 *    `transform` (extremely common in real SPAs, even just for GPU-accelerated animations)
 *    rather than the true viewport if one exists anywhere up the tree — silently rendering it
 *    off-screen or behind other content with no error at all.
 *  - `<dialog>` + `showModal()` fixes that (guaranteed top-layer rendering, immune to ancestor
 *    CSS) but is a true browser-native modal that blocks interaction with the *entire rest of
 *    the page* — which breaks prompts that need you to still click around in StepUp itself
 *    (e.g. "click Continue yourself in StepUp", "handle any Dashboard modal first") while ours
 *    is showing.
 *  - A manual popover gets the same top-layer rendering guarantee as `<dialog>` (immune to
 *    ancestor transforms/stacking contexts) without blocking anything else on the page.
 *
 * Resolution is via `page.exposeFunction()` — a real Node-callable binding button click handlers
 * invoke directly — rather than the earlier approach of setting a `window` global and polling
 * for it with `waitForFunction()`. The polling approach turned out unreliable in practice on the
 * real site (prompts sometimes resolved instantly with no actual click, letting the automation
 * race ahead through real form steps unattended); a direct event-driven callback removes that
 * whole mechanism rather than trying to patch it further. The same binding is exposed on every
 * page an option is tied to (e.g. document preview tabs), so any of them can resolve the prompt.
 *
 * The browser-side click handler is still passed to Playwright as a source string, not a
 * function reference: tsx/esbuild injects a `__name(...)` helper around compiled functions,
 * which breaks once that code ships into the browser (no such helper exists there). Dynamic
 * values are embedded via JSON.stringify rather than Playwright's arg-passing, which only works
 * with real function references. `exposeFunction`'s own callback runs in Node, not the browser,
 * so it's an ordinary TypeScript function with no such restriction.
 */
async function showPromptNow(page: Page, message: string, options: PromptOption[]): Promise<string> {
  const fnName = `__stepupResolve${promptCounter++}`;

  let resolveClick!: (value: string) => void;
  const clicked = new Promise<string>((resolve) => {
    resolveClick = resolve;
  });

  const optionPages = options.map((o) => o.page).filter((p): p is Page => Boolean(p));
  const involvedPages = [page, ...optionPages].filter((p, i, arr) => arr.indexOf(p) === i);
  for (const target of involvedPages) {
    await target.exposeFunction(fnName, (value: string) => resolveClick(value));
  }

  // Strip `page` (not serializable) before shipping the option list into the main banner script.
  const plainOptions = options.map((o) => ({ label: o.label, value: o.value }));

  await page.evaluate(`(() => {
    const fnName = ${JSON.stringify(fnName)};
    const message = ${JSON.stringify(message)};
    const options = ${JSON.stringify(plainOptions)};

    // Defensive cleanup: never allow a stray leftover popover to stick around.
    document.querySelectorAll("[data-stepup-prompt]").forEach((el) => el.remove());

    const banner = document.createElement("div");
    banner.setAttribute("popover", "manual");
    banner.setAttribute("data-stepup-prompt", "1");
    banner.style.cssText =
      "position:fixed;left:0;right:0;bottom:0;margin:0;border:none;padding:14px 18px;" +
      "max-width:none;width:100%;box-sizing:border-box;background:#1a2b4c;color:#fff;" +
      "font:14px/1.5 -apple-system,BlinkMacSystemFont,sans-serif;" +
      "box-shadow:0 -2px 10px rgba(0,0,0,.35);display:flex;flex-wrap:wrap;align-items:center;gap:12px;";

    const text = document.createElement("div");
    text.style.cssText = "flex:1 1 320px;white-space:pre-wrap;";
    text.textContent = message;
    banner.appendChild(text);

    const buttonRow = document.createElement("div");
    buttonRow.style.cssText = "display:flex;gap:8px;flex-wrap:wrap;";
    for (const opt of options) {
      const btn = document.createElement("button");
      btn.textContent = opt.label;
      btn.type = "button";
      btn.style.cssText =
        "padding:9px 16px;border:none;border-radius:4px;background:#3576d3;color:#fff;" +
        "font-size:14px;font-weight:600;cursor:pointer;";
      btn.addEventListener("mouseenter", () => { btn.style.background = "#2a5cab"; });
      btn.addEventListener("mouseleave", () => { btn.style.background = "#3576d3"; });
      btn.addEventListener("click", () => {
        window[fnName](opt.value);
      });
      buttonRow.appendChild(btn);
    }
    banner.appendChild(buttonRow);
    document.body.appendChild(banner);
    banner.showPopover();
  })()`);

  // Inject a lightweight "Use this" button into each option's own page (e.g. a preview tab),
  // appended into that page's own header if it marks one with [data-stepup-header].
  for (const opt of options) {
    if (!opt.page) continue;
    await opt.page.evaluate(`(() => {
      const fnName = ${JSON.stringify(fnName)};
      const value = ${JSON.stringify(opt.value)};

      document.querySelectorAll("[data-stepup-accept]").forEach((el) => el.remove());

      const btn = document.createElement("button");
      btn.textContent = "Use this document";
      btn.type = "button";
      btn.setAttribute("data-stepup-accept", "1");
      btn.style.cssText =
        "padding:8px 14px;border:none;border-radius:4px;background:#3576d3;color:#fff;" +
        "font-size:14px;font-weight:600;cursor:pointer;flex:0 0 auto;";
      btn.addEventListener("mouseenter", () => { btn.style.background = "#2a5cab"; });
      btn.addEventListener("mouseleave", () => { btn.style.background = "#3576d3"; });
      btn.addEventListener("click", () => {
        btn.disabled = true;
        btn.textContent = "Selected";
        window[fnName](value);
      });

      const header = document.querySelector("[data-stepup-header]");
      if (header) {
        header.appendChild(btn);
      } else {
        btn.style.cssText += "position:fixed;top:10px;right:10px;z-index:2147483647;";
        document.body.appendChild(btn);
      }
    })()`);
  }

  const value = await clicked;

  // Always clean up the main page's banner, regardless of which page's button actually resolved
  // this — a preview tab's own "Use this document" button never touches the main page's DOM.
  await page
    .evaluate(`document.querySelectorAll("[data-stepup-prompt]").forEach((el) => el.remove())`)
    .catch(() => {});

  return value;
}

function showPrompt(page: Page, message: string, options: PromptOption[]): Promise<string> {
  const run = () => showPromptNow(page, message, options);
  const result = promptQueue.then(run, run);
  promptQueue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

/** Shows `message` with a single "Continue" button; resolves once clicked. Does NOT block the rest of the page. */
export async function browserContinue(page: Page, message: string): Promise<void> {
  await showPrompt(page, message, [{ label: "Continue", value: "" }]);
}

/** Shows `message` with one button per option; resolves with the clicked option's `value`. Does NOT block the rest of the page. */
export async function browserChoose(page: Page, message: string, options: PromptOption[]): Promise<string> {
  return showPrompt(page, message, options);
}

/**
 * Shows `message` as a buttonless informational banner — for steps where you're expected to act
 * directly in StepUp itself (e.g. click its own Continue button) rather than click anything in
 * our UI. Doesn't block or wait for anything; the caller is expected to follow up with its own
 * wait (e.g. `waitForStep()`), and since the banner lives in the page's own DOM, it disappears on
 * its own the moment that real navigation happens — no separate cleanup needed.
 */
export async function browserInfo(page: Page, message: string): Promise<void> {
  await page.evaluate(`(() => {
    const message = ${JSON.stringify(message)};

    document.querySelectorAll("[data-stepup-prompt]").forEach((el) => el.remove());

    const banner = document.createElement("div");
    banner.setAttribute("popover", "manual");
    banner.setAttribute("data-stepup-prompt", "1");
    banner.style.cssText =
      "position:fixed;left:0;right:0;bottom:0;margin:0;border:none;padding:14px 18px;" +
      "max-width:none;width:100%;box-sizing:border-box;background:#1a2b4c;color:#fff;" +
      "font:14px/1.5 -apple-system,BlinkMacSystemFont,sans-serif;" +
      "box-shadow:0 -2px 10px rgba(0,0,0,.35);white-space:pre-wrap;";
    banner.textContent = message;
    document.body.appendChild(banner);
    banner.showPopover();
  })()`);
}
