/** One call StepUp's own page made, as seen from inside the page. */
export interface Observed {
  via: "fetch" | "xhr";
  method: string;
  url: string;
  requestBody?: string;
  status: number;
  responseText?: string;
  ms: number;
}

/** The parts of the page's global object that are wrapped. */
export interface Observable {
  fetch: typeof fetch;
  XMLHttpRequest?: { prototype: XMLHttpRequest };
  setTimeout?: typeof setTimeout;
}

/**
 * Watches the page's own requests (fetch and XMLHttpRequest) without changing what they do: the response is read from a
 * clone and handed to `onObserved`; the page gets exactly what it would have. Returns the page's original `fetch` (for the
 * agent's own calls, which must not be observed) and a function that takes the wrappers off again.
 */
export function observeTraffic(g: Observable, onObserved: (o: Observed) => void): { origFetch: typeof fetch; dispose: () => void } {
  const original = g.fetch;
  const origFetch = original.bind(g as unknown as typeof globalThis);
  const emit = (o: Observed): void => {
    try {
      onObserved(o);
    } catch {
      /* an observer must never be able to break the page */
    }
  };
  const wrapped = async function (this: unknown, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const t0 = Date.now();
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    const method = (init?.method ?? (typeof input === "object" && "method" in input ? input.method : undefined) ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? init.body : undefined;
    const res = await origFetch(input as RequestInfo, init);
    res.clone().text().then((text) => emit({ via: "fetch", method, url, requestBody: body, status: res.status, responseText: text, ms: Date.now() - t0 })).catch(() => undefined);
    return res;
  } as typeof fetch;
  g.fetch = wrapped;

  const proto = g.XMLHttpRequest?.prototype;
  const open = proto?.open;
  const send = proto?.send;
  if (proto && open && send) {
    type Tagged = XMLHttpRequest & { __su?: { m: string; u: string } };
    proto.open = function (this: Tagged, method: string, url: string | URL, ...rest: unknown[]) {
      this.__su = { m: String(method).toUpperCase(), u: String(url) };
      return (open as (...a: unknown[]) => void).call(this, method, url, ...rest);
    } as typeof proto.open;
    proto.send = function (this: Tagged, body?: Document | XMLHttpRequestBodyInit | null) {
      const t0 = Date.now();
      this.addEventListener("loadend", () => {
        const tag = this.__su;
        if (!tag) return;
        let text: string | undefined;
        try {
          text = this.responseType === "" || this.responseType === "text" ? this.responseText : undefined;
        } catch {
          /* not readable */
        }
        emit({ via: "xhr", method: tag.m, url: tag.u, requestBody: typeof body === "string" ? body : undefined, status: this.status, responseText: text, ms: Date.now() - t0 });
      });
      return send.call(this, body);
    } as typeof proto.send;
  }

  return {
    origFetch,
    dispose: () => {
      if (g.fetch === wrapped) g.fetch = original;
      if (proto && open && send) {
        proto.open = open;
        proto.send = send;
      }
    },
  };
}
