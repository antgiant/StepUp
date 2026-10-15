import { StepUpAgent, type AgentHost, type AgentState } from "./agent.js";
import { observeTraffic } from "./observe.js";
import { normalizeUrl } from "./recorder.js";

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
    currentUrl: () => location.href,
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
