/** One call StepUp's own page made, as seen from inside the page. */
export interface Observed {
  via: "fetch" | "xhr";
  method: string;
  url: string;
  requestBody?: string;
  /** Size of the request body in bytes when known (large bodies, such as an uploaded receipt, are not read). */
  requestBytes?: number;
  /** Names of the request's headers (never their values). */
  requestHeaders?: string[];
  status: number;
  responseText?: string;
  ms: number;
}

/** Bodies larger than this are measured, not read (a receipt upload is not worth decoding). */
const BODY_READ_LIMIT = 1_000_000;

/** What can be learned from a request body of any kind StepUp's page sends (Blazor sends bytes, not strings). */
export async function bodyInfo(body: unknown): Promise<{ text?: string; bytes?: number }> {
  if (body === null || body === undefined) return {};
  if (typeof body === "string") return { text: body, bytes: body.length };
  if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) return { text: body.toString() };
  if (ArrayBuffer.isView(body)) {
    const v = body as ArrayBufferView;
    return v.byteLength > BODY_READ_LIMIT ? { bytes: v.byteLength } : { text: new TextDecoder().decode(v), bytes: v.byteLength };
  }
  if (body instanceof ArrayBuffer) {
    return body.byteLength > BODY_READ_LIMIT ? { bytes: body.byteLength } : { text: new TextDecoder().decode(body), bytes: body.byteLength };
  }
  if (typeof Blob !== "undefined" && body instanceof Blob) {
    return body.size > BODY_READ_LIMIT ? { bytes: body.size } : { text: await body.text(), bytes: body.size };
  }
  if (typeof FormData !== "undefined" && body instanceof FormData) {
    return { text: JSON.stringify(Object.fromEntries([...body.keys()].map((k) => [k, "form-field"]))) };
  }
  return {};
}

/** The names (lower case) of a request's headers, whatever form they were given in. */
export function headerNames(h: unknown): string[] {
  if (!h) return [];
  try {
    if (typeof Headers !== "undefined" && h instanceof Headers) return [...h.keys()].map((k) => k.toLowerCase());
    if (Array.isArray(h)) return h.map((p) => String((p as unknown[])[0]).toLowerCase());
    if (typeof h === "object") return Object.keys(h as object).map((k) => k.toLowerCase());
  } catch {
    /* unreadable */
  }
  return [];
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
    const isRequest = typeof Request !== "undefined" && input instanceof Request;
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    const method = (init?.method ?? (isRequest ? (input as Request).method : undefined) ?? "GET").toUpperCase();
    const headers = headerNames(init?.headers ?? (isRequest ? (input as Request).headers : undefined));
    // Read the body in the background: the page's request must not wait for this.
    let reading: Promise<{ text?: string; bytes?: number }>;
    if (init?.body !== undefined && init.body !== null) reading = bodyInfo(init.body);
    else if (isRequest && method !== "GET" && method !== "HEAD") reading = (input as Request).clone().arrayBuffer().then((b) => bodyInfo(b)).catch(() => ({}));
    else reading = Promise.resolve({});
    const res = await origFetch(input as RequestInfo, init);
    void Promise.all([res.clone().text(), reading])
      .then(([text, req]) => emit({ via: "fetch", method, url, requestBody: req.text, requestBytes: req.bytes, requestHeaders: headers, status: res.status, responseText: text, ms: Date.now() - t0 }))
      .catch(() => undefined);
    return res;
  } as typeof fetch;
  g.fetch = wrapped;

  const proto = g.XMLHttpRequest?.prototype;
  const open = proto?.open;
  const send = proto?.send;
  const setHeaderOriginal = proto?.setRequestHeader;
  if (proto && open && send) {
    type Tagged = XMLHttpRequest & { __su?: { m: string; u: string; h: string[] } };
    proto.open = function (this: Tagged, method: string, url: string | URL, ...rest: unknown[]) {
      this.__su = { m: String(method).toUpperCase(), u: String(url), h: [] };
      return (open as (...a: unknown[]) => void).call(this, method, url, ...rest);
    } as typeof proto.open;
    const setHeader = proto.setRequestHeader;
    proto.setRequestHeader = function (this: Tagged, name: string, value: string) {
      this.__su?.h.push(String(name).toLowerCase());
      return setHeader.call(this, name, value);
    };
    proto.send = function (this: Tagged, body?: Document | XMLHttpRequestBodyInit | null) {
      const t0 = Date.now();
      const reading = bodyInfo(body);
      this.addEventListener("loadend", () => {
        const tag = this.__su;
        if (!tag) return;
        let text: string | undefined;
        try {
          text = this.responseType === "" || this.responseType === "text" ? this.responseText : undefined;
        } catch {
          /* not readable */
        }
        void reading.then((req) => emit({ via: "xhr", method: tag.m, url: tag.u, requestBody: req.text, requestBytes: req.bytes, requestHeaders: tag.h, status: this.status, responseText: text, ms: Date.now() - t0 }));
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
        if (setHeaderOriginal) proto.setRequestHeader = setHeaderOriginal;
      }
    },
  };
}
