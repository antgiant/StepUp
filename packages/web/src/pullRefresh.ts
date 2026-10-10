/**
 * Pull down from the top of the page to reload the whole app, for the installed (standalone) app, which has no browser
 * reload button. It is the same reload in a ledger year and in an Excel year; unsaved edits are kept on this device
 * (the outbox) and picked up again after the reload.
 */
const THRESHOLD = 90;

const installed = () => window.matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;

/** True when something scrollable between the touch and the page has been scrolled, so the drag is meant for it. */
function scrolledInside(el: Element | null): boolean {
  for (let n: Element | null = el; n && n !== document.body; n = n.parentElement) if (n.scrollTop > 0) return true;
  return false;
}

export function enablePullToRefresh(): void {
  if (!installed()) return;
  const bar = document.createElement("div");
  bar.className = "pull-refresh";
  bar.setAttribute("aria-hidden", "true");
  document.body.append(bar);
  let startY: number | undefined;
  let pull = 0;
  const reset = () => {
    startY = undefined;
    pull = 0;
    bar.style.transform = "";
    bar.classList.remove("ready");
  };
  document.addEventListener("touchstart", (e) => {
    const t = e.touches[0];
    const typing = document.activeElement instanceof HTMLElement && /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName);
    startY = e.touches.length === 1 && t && window.scrollY <= 0 && !typing && !scrolledInside(e.target as Element) ? t.clientY : undefined;
  }, { passive: true });
  document.addEventListener("touchmove", (e) => {
    const t = e.touches[0];
    if (startY === undefined || !t) return;
    pull = Math.max(0, t.clientY - startY);
    if (window.scrollY > 0) return reset();
    bar.style.transform = `translateY(${Math.min(pull, THRESHOLD * 1.5) / 2}px)`;
    bar.classList.toggle("ready", pull >= THRESHOLD);
  }, { passive: true });
  document.addEventListener("touchend", () => {
    if (startY !== undefined && pull >= THRESHOLD) {
      bar.classList.add("busy");
      bar.textContent = "Refreshing…";
      location.reload();
      return;
    }
    reset();
  }, { passive: true });
  document.addEventListener("touchcancel", reset, { passive: true });
}
