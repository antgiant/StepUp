import "dotenv/config";
import { launchStepUpBrowserServer } from "./form/browser.js";

const CLOSE_FN = "__stepupCloseBrowserServer";

// Injected via both addInitScript() (for every future navigation/new document) and evaluate()
// (for whatever page is already loaded before addInitScript was registered) — string form, not a
// function reference, since tsx/esbuild injects a __name(...) helper around compiled functions
// that doesn't exist once the code ships into the browser (same restriction as browserPrompt.ts).
//
// attach() cleans up any extra `[data-stepup-close-server]` elements it finds instead of just
// bailing out the moment one exists: `Page.addScriptToEvaluateOnNewDocument` (what addInitScript()
// uses under the hood) is registered browser-side, not client-side, and Chrome keeps re-running it
// on every future document indefinitely — even after the process that registered it is long gone.
// Restarting browserServer.ts mid-session (e.g. to pick up a code change) without the open tab
// ever doing a full page reload leaves an earlier version of this script still registered
// alongside the current one; both then fire on the next real navigation, and a plain "does one
// already exist?" guard can't stop a genuine duplicate from a second, independent injection. This
// makes the page self-heal back down to exactly one instance regardless of how many stacked
// registrations are still running.
//
// Rendered via the Popover API (popover="manual" + showPopover()), not a plain position:fixed
// element: a plain fixed element is positioned (and, if the ancestor also has a scale transform,
// visually sized) relative to the nearest ancestor with a CSS transform rather than the true
// viewport, if StepUp's own DOM has one anywhere up the tree — which is exactly why this button
// used to show up anywhere from a correct top-right corner to full-screen-sized to sitting on top
// of StepUp's own chat-bubble widget. The Popover API guarantees true-viewport top-layer
// rendering immune to that. It's also draggable (via its own pointer handlers below) as a
// belt-and-suspenders fix in case something on the page still ends up under it.
//
// Every layout-affecting property below carries `!important`: StepUp's own CSS (e.g. its login
// form's button styling) can turn a plain <button> into `display:block` with no explicit width,
// which for a `position:fixed` element some rules resolve against the full viewport instead of
// shrink-to-fit content — stretching it into a full-width banner. The Popover API only guarantees
// top-layer *positioning*, not immunity from the page's own stylesheet rules matching `button`, so
// without `!important` here an author rule (especially one that's itself `!important`) can still
// win the cascade over a plain inline style.
const BUTTON_SCRIPT = `(() => {
  // context.addInitScript() (what delivers this) injects into every frame on the page, not just
  // the top-level document — confirmed live: StepUp embeds a Userflow (userflow.com) resource-center
  // widget in a small same-origin-policy-exempt iframe, and without this guard, this script ran
  // inside that iframe too, creating a second button positioned fixed relative to THAT iframe's own
  // tiny viewport — which, being a popover, escapes the iframe's normal clipping and renders at
  // its full real-world size floating near wherever that iframe happens to sit on the page (in
  // practice, right on top of Userflow's own launcher icon, looking exactly like a stray duplicate
  // button). Bailing out entirely for any non-top-level frame is the fix.
  if (window.top !== window.self) return;

  const attach = () => {
    const existing = document.querySelectorAll("[data-stepup-close-server]");
    if (existing.length > 0) {
      existing.forEach((el, i) => { if (i > 0) el.remove(); });
      return;
    }
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "\\u23FB All done \\u2014 close browser";
    btn.setAttribute("data-stepup-close-server", "1");
    btn.setAttribute("popover", "manual");
    // .style.left = ... (etc.) resets that property's priority to non-important, silently
    // dropping the !important protection set below the moment the button is repositioned — so
    // every later reposition (remembered position, drag) goes through this instead.
    const setPos = (prop, value) => btn.style.setProperty(prop, value, "important");
    btn.style.cssText =
      "position:fixed !important;top:10px !important;left:10px !important;right:auto !important;bottom:auto !important;" +
      "margin:0 !important;padding:10px 16px !important;display:inline-block !important;" +
      "width:auto !important;min-width:0 !important;max-width:max-content !important;height:auto !important;" +
      "box-sizing:border-box !important;white-space:nowrap !important;float:none !important;" +
      "border:none !important;border-radius:4px !important;background:#b3261e !important;color:#fff !important;" +
      "font:14px/1.2 -apple-system,BlinkMacSystemFont,sans-serif !important;font-weight:600 !important;" +
      "cursor:move !important;touch-action:none !important;box-shadow:0 2px 8px rgba(0,0,0,.35) !important;";
    // setProperty(..., "important") rather than the .style.background = ... shorthand setter:
    // the latter resets that property's priority to non-important, which would quietly drop the
    // !important protection above the moment you first hover the button.
    btn.addEventListener("mouseenter", () => { btn.style.setProperty("background", "#8f1e18", "important"); });
    btn.addEventListener("mouseleave", () => { btn.style.setProperty("background", "#b3261e", "important"); });

    // Shared by drag and by the remembered-position restore below, so a position can never end up
    // partially (or fully) off-screen regardless of how the window has been resized since it was
    // last set — clamps against the *current* viewport, not whatever it was when the value was
    // recorded.
    const clampToViewport = (left, top) => ({
      left: Math.min(Math.max(0, left), Math.max(0, window.innerWidth - btn.offsetWidth)),
      top: Math.min(Math.max(0, top), Math.max(0, window.innerHeight - btn.offsetHeight)),
    });

    let dragging = false, moved = false, offsetX = 0, offsetY = 0;
    btn.addEventListener("pointerdown", (e) => {
      dragging = true;
      moved = false;
      const rect = btn.getBoundingClientRect();
      setPos("left", rect.left + "px");
      setPos("top", rect.top + "px");
      setPos("right", "auto");
      setPos("bottom", "auto");
      offsetX = e.clientX - rect.left;
      offsetY = e.clientY - rect.top;
      btn.setPointerCapture(e.pointerId);
    });
    btn.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      moved = true;
      const clamped = clampToViewport(e.clientX - offsetX, e.clientY - offsetY);
      setPos("left", clamped.left + "px");
      setPos("top", clamped.top + "px");
    });
    const stopDrag = () => {
      dragging = false;
      if (moved) {
        window.__stepupCloseBtnPos = { left: btn.style.left, top: btn.style.top };
      }
    };
    btn.addEventListener("pointerup", stopDrag);
    btn.addEventListener("pointercancel", stopDrag);

    btn.addEventListener("click", (e) => {
      if (moved) { e.preventDefault(); e.stopPropagation(); return; }
      btn.disabled = true;
      btn.textContent = "Closing\\u2026";
      window.${CLOSE_FN}();
    });
    if (document.body) {
      document.body.appendChild(btn);
      btn.showPopover();

      // Remembered on window, not localStorage: sticks around for as long as this browser
      // tab/session lives — including every future "npm start" reconnect, since the browser server
      // process is long-lived and outlives any one npm run — but resets on an actual full page
      // reload/navigation rather than persist forever on disk. Restored (and re-clamped) only now,
      // after the button is actually in the DOM: offsetWidth/offsetHeight are 0 before that, which
      // would make the clamp a no-op.
      if (window.__stepupCloseBtnPos) {
        const saved = window.__stepupCloseBtnPos;
        const clamped = clampToViewport(parseFloat(saved.left) || 0, parseFloat(saved.top) || 0);
        setPos("left", clamped.left + "px");
        setPos("top", clamped.top + "px");
        setPos("right", "auto");
        setPos("bottom", "auto");
      }
    }
  };
  if (document.body) attach();
  else document.addEventListener("DOMContentLoaded", attach);
})()`;

async function main() {
  console.log("Launching the browser server — leave this running for the whole work session.");
  const { context, page } = await launchStepUpBrowserServer();

  let resolveShutdown!: () => void;
  const shutdown = new Promise<void>((resolve) => {
    resolveShutdown = resolve;
  });

  // Context-wide: applies to every current AND future page/tab (e.g. document preview tabs
  // main.ts opens), so the close button works from anywhere.
  await context.exposeFunction(CLOSE_FN, () => resolveShutdown());
  // Registers for every future navigation/new document — but not the one already loaded above,
  // which needs its own one-time injection right after.
  await context.addInitScript(BUTTON_SCRIPT);
  for (const p of context.pages()) {
    await p.evaluate(BUTTON_SCRIPT).catch(() => {});
  }

  // Covers the case where you close the Chrome window directly instead of clicking our button.
  context.on("close", () => resolveShutdown());

  console.log("\nBrowser is up. Log into StepUp in that window.");
  console.log('Run "npm start" in another terminal whenever you\'re ready — restarting it later will reconnect here, not reopen Chrome.');
  console.log('When you\'re fully done for the session, click the red "All done — close browser" button (top-left of the page).');

  await shutdown;
  console.log("\nClosing the browser...");
  await context.close().catch(() => {});
  process.exit(0);
}

main().catch((err) => {
  console.error("Browser server failed:", err);
  process.exit(1);
});
