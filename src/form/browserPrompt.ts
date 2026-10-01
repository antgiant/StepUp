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
 * Browser-side JS source (not a real function reference — tsx/esbuild injects a `__name(...)`
 * helper around compiled functions that doesn't exist once code ships into the browser, so every
 * script in this file is shipped as a plain string rather than a real function reference) shared
 * by every banner below. Turns `header` into a drag handle that repositions `banner` (switching
 * it from its initial right/bottom anchoring to explicit left/top, clamped to the viewport) and
 * adds a minimize toggle that collapses `content` down to just the header — so a banner sitting
 * over something you need can be moved or tucked away without losing the in-progress prompt
 * underneath it.
 */
const DRAG_MINIMIZE_JS = `
  // .style.prop = value resets that property's priority to non-important, silently dropping any
  // !important set on it earlier (e.g. in a cssText block) — so every later style update in this
  // file goes through this instead, to stay immune to the page's own !important rules for good.
  function stepupImportant(el, prop, value) {
    el.style.setProperty(prop, value, "important");
  }

  function stepupMakeDraggable(banner, header, content) {
    // Remembered on window, not localStorage: it should stick around for as long as this browser
    // tab/session lives (surviving the SPA's own client-side route changes, and every future
    // banner shown on this page, and every future "npm start" reconnect — the browser server
    // process is long-lived and outlives any one npm run), but reset on an actual full page
    // reload/navigation rather than persist forever on disk.
    if (window.__stepupBannerPos) {
      stepupImportant(banner, "left", window.__stepupBannerPos.left);
      stepupImportant(banner, "top", window.__stepupBannerPos.top);
      stepupImportant(banner, "right", "auto");
      stepupImportant(banner, "bottom", "auto");
    }

    header.style.cursor = "move";
    header.style.userSelect = "none";
    header.style.touchAction = "none";
    let dragging = false, moved = false, offsetX = 0, offsetY = 0;
    header.addEventListener("pointerdown", (e) => {
      if (e.target.closest("[data-stepup-minimize]")) return;
      dragging = true;
      moved = false;
      const rect = banner.getBoundingClientRect();
      stepupImportant(banner, "left", rect.left + "px");
      stepupImportant(banner, "top", rect.top + "px");
      stepupImportant(banner, "right", "auto");
      stepupImportant(banner, "bottom", "auto");
      offsetX = e.clientX - rect.left;
      offsetY = e.clientY - rect.top;
      header.setPointerCapture(e.pointerId);
    });
    header.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      moved = true;
      const maxLeft = Math.max(0, window.innerWidth - banner.offsetWidth);
      const maxTop = Math.max(0, window.innerHeight - banner.offsetHeight);
      stepupImportant(banner, "left", Math.min(Math.max(0, e.clientX - offsetX), maxLeft) + "px");
      stepupImportant(banner, "top", Math.min(Math.max(0, e.clientY - offsetY), maxTop) + "px");
    });
    const stopDrag = () => {
      dragging = false;
      if (moved) {
        window.__stepupBannerPos = { left: banner.style.left, top: banner.style.top };
      }
    };
    header.addEventListener("pointerup", stopDrag);
    header.addEventListener("pointercancel", stopDrag);

    const originalWidth = banner.style.width;
    const minBtn = document.createElement("button");
    minBtn.type = "button";
    minBtn.setAttribute("data-stepup-minimize", "1");
    minBtn.textContent = "\\u2212";
    minBtn.title = "Minimize";
    minBtn.style.cssText =
      "flex:0 0 auto !important;width:22px !important;height:22px !important;min-width:0 !important;" +
      "max-width:22px !important;box-sizing:border-box !important;display:inline-flex !important;" +
      "align-items:center !important;justify-content:center !important;border:none !important;" +
      "border-radius:4px !important;background:rgba(255,255,255,.15) !important;color:#fff !important;" +
      "font:16px/1 sans-serif !important;cursor:pointer !important;padding:0 !important;";
    minBtn.addEventListener("mouseenter", () => { stepupImportant(minBtn, "background", "rgba(255,255,255,.28)"); });
    minBtn.addEventListener("mouseleave", () => { stepupImportant(minBtn, "background", "rgba(255,255,255,.15)"); });
    minBtn.addEventListener("click", () => {
      const minimizing = content.style.display !== "none";
      content.style.display = minimizing ? "none" : "";
      minBtn.textContent = minimizing ? "\\u25a1" : "\\u2212";
      minBtn.title = minimizing ? "Restore" : "Minimize";
      stepupImportant(banner, "width", minimizing ? "auto" : originalWidth);
    });
    header.appendChild(minBtn);

    // A drag that ends without moving the pointer is just a click passing through the header —
    // don't let it also toggle minimize via a stray click on the button underneath the cursor.
    header.addEventListener("click", (e) => {
      if (moved && e.target !== minBtn) e.stopPropagation();
    }, true);
  }
`;

function stepupHeaderBar(): string {
  return (
    'const header = document.createElement("div");' +
    'header.setAttribute("data-stepup-header-bar", "1");' +
    'header.style.cssText = "display:flex;align-items:center;gap:8px;padding:8px 10px;flex:0 0 auto;' +
    'background:rgba(255,255,255,.08);border-radius:10px 10px 0 0;";' +
    'const grip = document.createElement("span");' +
    'grip.textContent = "\\u22ee\\u22ee StepUp";' +
    'grip.style.cssText = "opacity:.6;font-size:11px;letter-spacing:.03em;flex:1 1 auto;";' +
    'header.appendChild(grip);' +
    'banner.appendChild(header);'
  );
}

/**
 * Browser-side JS source (see the note above DRAG_MINIMIZE_JS for why these ship as plain
 * strings), also shared by every banner. `showPromptNow`/`browserInfo`/`browserInfoHtml` create a
 * fresh banner from scratch each time — that banner has no idea whether the Node-side "npm start"
 * process that put it up is still alive, so if that process crashes, is killed, or the terminal it
 * runs in is closed while a banner is showing, the banner just sits there looking exactly as live
 * as ever: same buttons, same hover states, nothing tells you it can no longer resolve anything
 * (its click handlers call into a Node binding that will now never respond).
 *
 * Fixed with a heartbeat: `startConnectionHeartbeat()` (below) stamps `window.__stepupHeartbeat`
 * from Node every few seconds for as long as the process is alive. This watchdog — started once
 * per page, independent of any one banner's lifetime — polls that timestamp and, the moment it
 * goes stale, marks whatever banner is currently showing: dims it, disables its buttons, and adds
 * a notice explaining the connection was lost and to restart "npm start".
 *
 * Deliberately one-way, never un-marking a banner if a heartbeat resumes later: a banner's buttons
 * call into a `page.exposeFunction()` binding owned by the specific process that showed it, and a
 * dead process's binding stays dead — a fresh "npm start" reconnecting and resuming heartbeats
 * doesn't make *that* binding answerable again, it just means some process is alive again, which
 * says nothing about this particular banner. Making the old banner look clickable again would
 * recreate the exact "looks live, isn't" problem this exists to fix. The only real recovery is a
 * genuinely new banner from the new process, which replaces the stale one outright the moment it's
 * shown (every banner-creating function here starts by removing whatever `[data-stepup-prompt]`
 * is already there).
 */
const CONNECTION_WATCHDOG_JS = `
  function stepupStartConnectionWatchdog() {
    if (window.__stepupWatchdogStarted) return;
    window.__stepupWatchdogStarted = true;
    window.__stepupHeartbeat = Date.now();
    const STALE_MS = 12000;
    setInterval(() => {
      if (Date.now() - window.__stepupHeartbeat <= STALE_MS) return;
      document.querySelectorAll("[data-stepup-prompt]").forEach((banner) => {
        if (banner.getAttribute("data-stepup-stale") === "1") return;
        banner.setAttribute("data-stepup-stale", "1");
        stepupImportant(banner, "opacity", "0.7");
        stepupImportant(banner, "filter", "grayscale(.5)");

        const content = banner.querySelector("[data-stepup-content]");
        if (content) {
          content.querySelectorAll("button").forEach((btn) => { btn.disabled = true; });
        }

        const notice = document.createElement("div");
        notice.setAttribute("data-stepup-stale-notice", "1");
        notice.style.cssText =
          "background:#7a1f1f;color:#fff;padding:8px 10px;font-size:12.5px;font-weight:600;flex:0 0 auto;";
        notice.textContent =
          "\\u26a0 Connection to \\"npm start\\" lost \\u2014 this can no longer be answered here. Restart it to continue.";
        const header = banner.querySelector("[data-stepup-header-bar]");
        if (header) header.insertAdjacentElement("afterend", notice);
        else banner.insertBefore(notice, banner.firstChild);
      });
    }, 1000);
  }
`;

const HEARTBEAT_INTERVAL_MS = 4000;

/**
 * Starts the Node-side half of the connection watchdog above: stamps `window.__stepupHeartbeat`
 * in `page` every few seconds for as long as this process is alive, so the browser-side watchdog
 * can tell a live "npm start" apart from one that died while a banner was still showing. Call once
 * per session, right after connecting — the interval is `unref()`d so it never keeps the process
 * alive on its own (nothing to stop explicitly: it simply stops firing once the process exits, and
 * an abrupt kill is exactly the case this exists to make visible in the browser).
 */
export function startConnectionHeartbeat(page: Page): void {
  const ping = () => {
    page.evaluate(`window.__stepupHeartbeat = ${Date.now()}`).catch(() => {});
  };
  ping();
  setInterval(ping, HEARTBEAT_INTERVAL_MS).unref();
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
    ${DRAG_MINIMIZE_JS}
    ${CONNECTION_WATCHDOG_JS}

    const fnName = ${JSON.stringify(fnName)};
    const message = ${JSON.stringify(message)};
    const options = ${JSON.stringify(plainOptions)};

    // Defensive cleanup: never allow a stray leftover popover to stick around.
    document.querySelectorAll("[data-stepup-prompt]").forEach((el) => el.remove());

    const banner = document.createElement("div");
    banner.setAttribute("popover", "manual");
    banner.setAttribute("data-stepup-prompt", "1");
    banner.style.cssText =
      "position:fixed !important;top:16px !important;right:16px !important;bottom:auto !important;left:auto !important;" +
      "margin:0 !important;border:none !important;border-radius:10px !important;padding:0 !important;" +
      "width:min(560px,calc(100vw - 32px)) !important;max-height:70vh !important;box-sizing:border-box !important;" +
      "background:#1a2b4c;color:#fff;font:14px/1.5 -apple-system,BlinkMacSystemFont,sans-serif;" +
      "box-shadow:0 4px 20px rgba(0,0,0,.4);display:flex !important;flex-direction:column !important;overflow:hidden !important;";

    ${stepupHeaderBar()}

    const content = document.createElement("div");
    content.setAttribute("data-stepup-content", "1");
    content.style.cssText =
      "padding:14px 18px;overflow-y:auto;min-height:0;flex:1 1 auto;box-sizing:border-box;" +
      "display:flex;flex-wrap:wrap;align-items:center;gap:12px;";
    banner.appendChild(content);

    const text = document.createElement("div");
    text.style.cssText = "flex:1 1 320px;white-space:pre-wrap;";
    text.textContent = message;
    content.appendChild(text);

    const buttonRow = document.createElement("div");
    buttonRow.style.cssText = "display:flex;gap:8px;flex-wrap:wrap;";
    for (const opt of options) {
      const btn = document.createElement("button");
      btn.textContent = opt.label;
      btn.type = "button";
      btn.style.cssText =
        "display:inline-block !important;width:auto !important;max-width:max-content !important;" +
        "box-sizing:border-box !important;white-space:nowrap !important;float:none !important;" +
        "padding:9px 16px !important;border:none !important;border-radius:4px !important;" +
        "background:#3576d3 !important;color:#fff !important;font-size:14px !important;font-weight:600 !important;cursor:pointer !important;";
      btn.addEventListener("mouseenter", () => { btn.style.setProperty("background", "#2a5cab", "important"); });
      btn.addEventListener("mouseleave", () => { btn.style.setProperty("background", "#3576d3", "important"); });
      btn.addEventListener("click", () => {
        window[fnName](opt.value);
      });
      buttonRow.appendChild(btn);
    }
    content.appendChild(buttonRow);
    document.body.appendChild(banner);
    banner.showPopover();
    stepupMakeDraggable(banner, header, content);
    stepupStartConnectionWatchdog();
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
        "display:inline-block !important;width:auto !important;max-width:max-content !important;" +
        "box-sizing:border-box !important;white-space:nowrap !important;float:none !important;flex:0 0 auto !important;" +
        "padding:8px 14px !important;border:none !important;border-radius:4px !important;" +
        "background:#3576d3 !important;color:#fff !important;font-size:14px !important;font-weight:600 !important;cursor:pointer !important;";
      btn.addEventListener("mouseenter", () => { btn.style.setProperty("background", "#2a5cab", "important"); });
      btn.addEventListener("mouseleave", () => { btn.style.setProperty("background", "#3576d3", "important"); });
      btn.addEventListener("click", () => {
        btn.disabled = true;
        btn.textContent = "Selected";
        window[fnName](value);
      });

      const header = document.querySelector("[data-stepup-header]");
      if (header) {
        header.appendChild(btn);
      } else {
        btn.style.setProperty("position", "fixed", "important");
        btn.style.setProperty("top", "10px", "important");
        btn.style.setProperty("right", "10px", "important");
        btn.style.setProperty("z-index", "2147483647", "important");
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
    ${DRAG_MINIMIZE_JS}
    ${CONNECTION_WATCHDOG_JS}

    const message = ${JSON.stringify(message)};

    document.querySelectorAll("[data-stepup-prompt]").forEach((el) => el.remove());

    const banner = document.createElement("div");
    banner.setAttribute("popover", "manual");
    banner.setAttribute("data-stepup-prompt", "1");
    banner.style.cssText =
      "position:fixed !important;top:16px !important;right:16px !important;bottom:auto !important;left:auto !important;" +
      "margin:0 !important;border:none !important;border-radius:10px !important;padding:0 !important;" +
      "width:min(560px,calc(100vw - 32px)) !important;max-height:70vh !important;box-sizing:border-box !important;" +
      "background:#1a2b4c;color:#fff;font:14px/1.5 -apple-system,BlinkMacSystemFont,sans-serif;" +
      "box-shadow:0 4px 20px rgba(0,0,0,.4);display:flex !important;flex-direction:column !important;overflow:hidden !important;";

    ${stepupHeaderBar()}

    const content = document.createElement("div");
    content.setAttribute("data-stepup-content", "1");
    content.style.cssText = "padding:14px 18px;overflow-y:auto;min-height:0;flex:1 1 auto;box-sizing:border-box;white-space:pre-wrap;";
    content.textContent = message;
    banner.appendChild(content);

    document.body.appendChild(banner);
    banner.showPopover();
    stepupMakeDraggable(banner, header, content);
    stepupStartConnectionWatchdog();
  })()`);
}

/**
 * Like browserInfo(), but `html` is rendered as real markup (caller is responsible for escaping
 * any dynamic text — see escapeHtml() in main.ts) inside a height-capped, internally-scrollable
 * container, instead of one flat block of preformatted text. Meant for structured, multi-item
 * summaries (e.g. the post-fill review banner) that can otherwise grow tall enough to cover most
 * of the page once there are several items each with several fields — capping the height and
 * scrolling *inside* the banner keeps the real StepUp page underneath visible and reachable
 * instead of being hidden behind it.
 */
export async function browserInfoHtml(page: Page, html: string): Promise<void> {
  await page.evaluate(`(() => {
    ${DRAG_MINIMIZE_JS}
    ${CONNECTION_WATCHDOG_JS}

    const html = ${JSON.stringify(html)};

    document.querySelectorAll("[data-stepup-prompt]").forEach((el) => el.remove());

    const banner = document.createElement("div");
    banner.setAttribute("popover", "manual");
    banner.setAttribute("data-stepup-prompt", "1");
    banner.style.cssText =
      "position:fixed !important;top:16px !important;right:16px !important;bottom:auto !important;left:auto !important;" +
      "margin:0 !important;border:none !important;border-radius:10px !important;padding:0 !important;" +
      "width:min(560px,calc(100vw - 32px)) !important;max-height:60vh !important;box-sizing:border-box !important;" +
      "background:#1a2b4c;color:#fff;font:14px/1.5 -apple-system,BlinkMacSystemFont,sans-serif;" +
      "box-shadow:0 4px 20px rgba(0,0,0,.4);display:flex !important;flex-direction:column !important;overflow:hidden !important;";

    ${stepupHeaderBar()}

    const content = document.createElement("div");
    content.setAttribute("data-stepup-content", "1");
    content.style.cssText = "padding:14px 18px;overflow-y:auto;min-height:0;flex:1 1 auto;box-sizing:border-box;";
    content.innerHTML = html;
    banner.appendChild(content);

    document.body.appendChild(banner);
    banner.showPopover();
    stepupMakeDraggable(banner, header, content);
    stepupStartConnectionWatchdog();
  })()`);
}

let resyncCounter = 0;

/**
 * Adds a button labeled `label` to the banner that's currently showing (call right after
 * browserInfo()/browserInfoHtml(); does nothing visible if there's no banner). `clicked` resolves
 * the first time it's pressed — race it against a page navigation to offer "redo this step" while
 * waiting for you to move on by yourself. Never blocks on its own.
 */
export async function addResyncButton(page: Page, label: string): Promise<{ clicked: Promise<void> }> {
  const fnName = `__stepupResync${resyncCounter++}`;
  let resolveClick!: () => void;
  const clicked = new Promise<void>((resolve) => {
    resolveClick = resolve;
  });
  await page.exposeFunction(fnName, () => resolveClick());
  await page.evaluate(`(() => {
    const content = document.querySelector("[data-stepup-prompt] [data-stepup-content]");
    if (!content) return;
    const fnName = ${JSON.stringify(fnName)};
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = ${JSON.stringify(label)};
    btn.style.cssText =
      "display:inline-block !important;width:auto !important;max-width:max-content !important;" +
      "box-sizing:border-box !important;white-space:nowrap !important;float:none !important;" +
      "padding:9px 16px !important;border:none !important;border-radius:4px !important;" +
      "background:#3576d3 !important;color:#fff !important;font-size:14px !important;font-weight:600 !important;cursor:pointer !important;";
    btn.addEventListener("mouseenter", () => { btn.style.setProperty("background", "#2a5cab", "important"); });
    btn.addEventListener("mouseleave", () => { btn.style.setProperty("background", "#3576d3", "important"); });
    btn.addEventListener("click", () => {
      btn.disabled = true;
      btn.textContent = "Working...";
      window[fnName]();
    });
    const row = document.createElement("div");
    row.style.cssText = "margin-top:10px;";
    row.appendChild(btn);
    content.appendChild(row);
  })()`);
  return { clicked };
}

/**
 * Removes whatever banner is currently showing (from browserInfo/browserContinue/browserChoose),
 * without putting up a replacement. For a status message shown during an automated wait that has
 * no natural next banner to replace it (e.g. it isn't followed by a page navigation, which doesn't
 * clear it on its own — a client-side SPA route change doesn't wipe elements appended directly to
 * document.body the way a full page load would) — call this once the wait is over so a "waiting
 * for X" message doesn't linger and mislead you about what's actually happening once X is done.
 */
export async function clearBanner(page: Page): Promise<void> {
  await page.evaluate(`document.querySelectorAll("[data-stepup-prompt]").forEach((el) => el.remove())`).catch(() => {});
}
