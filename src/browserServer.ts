import "dotenv/config";
import { launchStepUpBrowserServer } from "./form/browser.js";

const CLOSE_FN = "__stepupCloseBrowserServer";

// Injected via both addInitScript() (for every future navigation/new document) and evaluate()
// (for whatever page is already loaded before addInitScript was registered) — string form, not a
// function reference, since tsx/esbuild injects a __name(...) helper around compiled functions
// that doesn't exist once the code ships into the browser (same restriction as browserPrompt.ts).
const BUTTON_SCRIPT = `(() => {
  const attach = () => {
    if (document.querySelector("[data-stepup-close-server]")) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "\\u23FB All done \\u2014 close browser";
    btn.setAttribute("data-stepup-close-server", "1");
    btn.style.cssText =
      "position:fixed;top:10px;right:10px;z-index:2147483647;padding:10px 16px;" +
      "border:none;border-radius:4px;background:#b3261e;color:#fff;" +
      "font:14px/1.2 -apple-system,BlinkMacSystemFont,sans-serif;font-weight:600;" +
      "cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.35);";
    btn.addEventListener("mouseenter", () => { btn.style.background = "#8f1e18"; });
    btn.addEventListener("mouseleave", () => { btn.style.background = "#b3261e"; });
    btn.addEventListener("click", () => {
      btn.disabled = true;
      btn.textContent = "Closing\\u2026";
      window.${CLOSE_FN}();
    });
    if (document.body) document.body.appendChild(btn);
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
  console.log('When you\'re fully done for the session, click the red "All done — close browser" button (top-right of the page).');

  await shutdown;
  console.log("\nClosing the browser...");
  await context.close().catch(() => {});
  process.exit(0);
}

main().catch((err) => {
  console.error("Browser server failed:", err);
  process.exit(1);
});
