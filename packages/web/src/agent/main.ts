import { StepUpAgent, type AgentHost, type AgentState } from "./agent.js";
import { observeTraffic } from "./observe.js";
import { normalizeUrl } from "./recorder.js";
import type { PageOps, PickTarget } from "./spike.js";

/**
 * The script the bookmark loads (`stepup-bookmarklet.js`). Clicking the bookmark again loads the latest copy: the old agent
 * is replaced, keeping what it had learned.
 */
interface Installed {
  agent: StepUpAgent;
  dispose(): void;
}
declare global {
  interface Window {
    __stepUpHelper?: Installed;
  }
}

/**
 * What the spike tests may do to StepUp's page, in the browser. Values are set through the element's own setter and the
 * events a keyboard or a paste would raise; a dropdown is opened by its own toggle and an entry in its open list is
 * clicked (as the command line always did). Nothing here presses Continue, Back, Submit or Delete: the spike logic
 * (spike.ts) never asks for those, and the selectors below could not find them.
 */
const PICK_TOGGLE: Partial<Record<PickTarget, string>> = {
  student: "#Student__Select",
  category: "#category",
  categoryType: "#categoryType",
  categoryDetail: "#categoryDetail",
  provider: "#provider",
  individualProvider: "#individualProvider",
};
const nth = (sel: string, i: number): Element | undefined => document.querySelectorAll(sel)[i];
function pickToggle(target: PickTarget, index: number): HTMLElement | undefined {
  const fixed = PICK_TOGGLE[target];
  if (fixed) return nth(fixed, index) as HTMLElement | undefined;
  // "Who did you pay?" for a vendor has no id: it is the dropdown inside the field with that label.
  const fields = Array.from(document.querySelectorAll(".reimbursement-item-field")).filter((f) => /^\s*Who did you pay/i.test(f.querySelector("label")?.textContent ?? ""));
  return fields[index]?.querySelector<HTMLElement>(".dropdown > button") ?? undefined;
}
const openMenuLeaves = (): HTMLElement[] =>
  Array.from(document.querySelectorAll<HTMLElement>(".dropdown-menu.show *")).filter((e) => e.children.length === 0 && (e.textContent ?? "").trim() !== "");

const pageOps: PageOps = {
  count: (sel) => document.querySelectorAll(sel).length,
  value: (sel, i) => (nth(sel, i) as HTMLInputElement | undefined)?.value,
  setValue: (sel, i, value, method) => {
    const el = nth(sel, i) as HTMLInputElement | HTMLTextAreaElement | undefined;
    if (!el) return;
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const set = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (!set) return;
    el.focus();
    if (method === "typed") {
      set.call(el, "");
      el.dispatchEvent(new Event("input", { bubbles: true }));
      let typed = "";
      for (const ch of value) {
        el.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true }));
        typed += ch;
        set.call(el, typed);
        el.dispatchEvent(new InputEvent("input", { bubbles: true, data: ch, inputType: "insertText" }));
        el.dispatchEvent(new KeyboardEvent("keyup", { key: ch, bubbles: true }));
      }
    } else {
      set.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.blur(); // StepUp commits a typed value on blur (found by the command line)
  },
  itemTotal: (i) => {
    const block = document.querySelectorAll(".accordion-item.accordion-card-container")[i];
    if (!block) return undefined;
    for (const e of Array.from(block.querySelectorAll<HTMLElement>("*"))) {
      const t = (e.textContent ?? "").replace(/\s+/g, " ").trim();
      if (/^\$[\d,]+(\.\d{1,2})? total$/i.test(t)) return t;
    }
    return undefined;
  },
  setFiles: (sel, i, file) => {
    const el = nth(sel, i) as HTMLInputElement | undefined;
    if (!el) return;
    const dt = new DataTransfer();
    dt.items.add(new File([file.bytes], file.name, { type: file.mime }));
    el.files = dt.files;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  },
  openPicker: (target, i) => {
    const t = pickToggle(target, i);
    if (!t) return false;
    t.click();
    return true;
  },
  pickerText: (target, i) => pickToggle(target, i)?.textContent?.trim(),
  menuTexts: () => openMenuLeaves().map((e) => (e.textContent ?? "").trim()).filter((t, i, a) => a.indexOf(t) === i),
  clickMenuItem: (text) => {
    const hits = openMenuLeaves().filter((e) => (e.textContent ?? "").trim() === text);
    const last = hits[hits.length - 1];
    if (!last) return false;
    last.click(); // a plain DOM click: the list can sit outside the window, where a pointer click cannot reach
    return true;
  },
};

(function install(): void {
  const src = (document.currentScript as HTMLScriptElement | null)?.src;
  if (!src) {
    alert("Step Up Helper: start this from its bookmark.");
    return;
  }
  const appHome = new URL("./", src).href;

  let box: HTMLDivElement | null = null;
  let hide: ReturnType<typeof setTimeout> | undefined;
  const say = (text: string, keep?: boolean): void => {
    if (!box) {
      box = document.createElement("div");
      box.style.cssText = "position:fixed;z-index:2147483647;top:12px;left:50%;transform:translateX(-50%);max-width:80vw;padding:10px 16px;background:#1a2b4c;color:#fff;font:15px system-ui;border-radius:8px;box-shadow:0 4px 16px #0006";
      document.body.appendChild(box);
    }
    box.textContent = `Step Up Helper: ${text}`;
    clearTimeout(hide);
    if (!keep) {
      hide = setTimeout(() => {
        box?.remove();
        box = null;
      }, 9000);
    }
  };

  const previous = window.__stepUpHelper;
  let carried: AgentState | undefined;
  if (previous) {
    carried = previous.agent.state();
    previous.dispose();
  }

  let agent: StepUpAgent | undefined;
  const observers = observeTraffic(window as unknown as Parameters<typeof observeTraffic>[0], (o) => agent?.observed(o));
  const host: AgentHost = {
    storage: window.sessionStorage,
    fetch: observers.origFetch,
    open: (url, name) => window.open(url, name),
    addMessageListener: (fn) => {
      const h = (e: MessageEvent) => fn({ origin: e.origin, source: e.source, data: e.data });
      window.addEventListener("message", h);
      return () => window.removeEventListener("message", h);
    },
    say,
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    every: (ms, fn) => {
      const id = setInterval(fn, ms);
      return () => clearInterval(id);
    },
    appHome,
    currentPage: () => normalizeUrl(location.href),
    readPage: () => document,
    isVisible: (el) => {
      const e = el as HTMLElement;
      try {
        return e.getClientRects().length > 0 && getComputedStyle(e).visibility !== "hidden";
      } catch {
        return true;
      }
    },
    pageOps,
    currentUrl: () => location.href,
    pseudoText: (el, which) => {
      try {
        const c = getComputedStyle(el as Element, which).content;
        return !c || c === "none" || c === "normal" ? undefined : c.replace(/^["']|["']$/g, "");
      } catch {
        return undefined;
      }
    },
  };
  agent = new StepUpAgent(host, carried);

  // Single-page navigation does not reload the page; note where the person goes while recording.
  const origPush = history.pushState;
  const origReplace = history.replaceState;
  const wrap = (fn: typeof history.pushState) =>
    function (this: History, ...a: Parameters<typeof history.pushState>) {
      const r = fn.apply(this, a);
      agent?.recorder.page(normalizeUrl(location.href));
      return r;
    };
  history.pushState = wrap(origPush);
  history.replaceState = wrap(origReplace);

  // Uploads to storage do not go through the wrapped fetch; the resource timeline still shows that they happened.
  let timing: PerformanceObserver | undefined;
  try {
    timing = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        const r = e as PerformanceResourceTiming;
        agent?.recorder.resource(r.name, r.initiatorType, r.encodedBodySize || r.transferSize || 0);
      }
    });
    timing.observe({ type: "resource", buffered: false });
  } catch {
    /* not available: uploads are simply not listed */
  }

  // A reload or a closed tab takes the agent with it: say so while there is still a window to say it to.
  const bye = (): void => agent?.goodbye();
  window.addEventListener("pagehide", bye);

  window.__stepUpHelper = {
    agent,
    dispose: () => {
      window.removeEventListener("pagehide", bye);
      observers.dispose();
      timing?.disconnect();
      history.pushState = origPush;
      history.replaceState = origReplace;
      agent?.dispose();
      agent = undefined;
      box?.remove();
    },
  };
  void agent.start();
})();
