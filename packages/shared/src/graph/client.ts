const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

export type TokenProvider = () => Promise<string>;

let tokenProvider: TokenProvider | undefined;

/** Each host (Node CLI via MSAL device-code, browser PWA via MSAL.js) supplies its own way of getting a Graph token. */
export function setTokenProvider(provider: TokenProvider): void {
  tokenProvider = provider;
}

export interface GraphConfig {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  /** Retries after the first attempt, for 429/5xx and network failures. */
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

const defaultConfig = (): GraphConfig => ({
  fetch: (...args) => fetch(...args),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  maxRetries: 5,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
});

let config: GraphConfig = defaultConfig();

/** Override pieces of the transport (tests inject a fake fetch and instant sleep). Call with no argument to reset. */
export function configureGraph(overrides?: Partial<GraphConfig>): void {
  config = { ...defaultConfig(), ...(overrides ?? {}) };
}

export function currentGraphConfig(): GraphConfig {
  return config;
}

/** Something the app is waiting on from OneDrive/Microsoft, described for people ("Downloading receipt.pdf"). */
export type ActivityEvent =
  | { type: "start"; id: number; label: string }
  | { type: "update"; id: number; label: string }
  | { type: "end"; id: number };

let observer: ((event: ActivityEvent) => void) | undefined;
let nextActivityId = 1;

/** The UI registers here to show what is in flight (one observer; pass undefined to stop). */
export function observeActivity(fn: ((event: ActivityEvent) => void) | undefined): void {
  observer = fn;
}

/** Reports `work` as an activity for its duration. `update` changes the label (retries, upload progress). */
export async function trackActivity<T>(label: string, work: (update: (label: string) => void) => Promise<T>): Promise<T> {
  const id = nextActivityId++;
  observer?.({ type: "start", id, label });
  try {
    return await work((next) => observer?.({ type: "update", id, label: next }));
  } finally {
    observer?.({ type: "end", id });
  }
}

const decode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** Plain-language description of a Graph request, from its method and URL (and body for folder creation). */
export function describeRequest(method: string, url: string, body?: unknown): string {
  const path = url.replace(/^https:\/\/graph\.microsoft\.com\/v1\.0/, "");
  const named = /:\/([^:?]+)(?::|\?|$)/.exec(path)?.[1];
  const name = named ? decode(named) : undefined;
  if (path.includes("/workbook/")) return method === "GET" ? "Reading the Excel workbook…" : "Updating the Excel workbook…";
  if (path.includes("/invite")) return "Sending the invitation…";
  if (path.startsWith("/shares/")) return "Opening the shared link…";
  if (path.includes("sharedWithMe")) return "Finding folders shared with you…";
  if (path.includes("/special/approot")) return method === "GET" ? "Loading your saved settings…" : "Saving your settings…";
  if (path.startsWith("/me/drive/root")) return "Opening your OneDrive…";
  if (path.includes("/createUploadSession")) return `Uploading ${name ?? "a file"}…`;
  if (method === "PUT" && path.includes("/content")) {
    if (name?.endsWith(".jsonl")) return "Saving your changes to OneDrive…";
    return `Uploading ${name ?? "a file"}…`;
  }
  if (method === "GET" && path.includes("/content")) return "Downloading a file…";
  if (method === "POST" && path.endsWith("/children")) {
    let folder: string | undefined;
    try {
      folder = typeof body === "string" ? (JSON.parse(body) as { name?: string }).name : undefined;
    } catch { /* label falls back to the generic text */ }
    return folder ? `Creating the folder ${folder}…` : "Creating a folder…";
  }
  if (method === "GET" && /\/children(\?|$)/.test(path)) return "Reading the folder's contents…";
  if (method === "GET" && name) return `Looking for ${name}…`;
  if (method === "GET" && path.includes("$select=eTag")) return "Checking the file's version…";
  if (method === "GET") return "Reading from OneDrive…";
  return "Saving to OneDrive…";
}

let skewMs: number | undefined;

/** Records what OneDrive says the time is (a file's modified time right after we wrote it) to compare with this device's clock. */
export function noteServerTime(iso: string | undefined, receivedAt = Date.now()): void {
  const t = iso ? Date.parse(iso) : NaN;
  if (Number.isFinite(t)) skewMs = t - receivedAt;
}

/** How far this device's clock is behind (+) or ahead (-) of OneDrive's, from the last write; undefined until one has been made. */
export const serverClockSkewMs = (): number | undefined => skewMs;

/** True when the clocks differ enough to scramble the order of edits made on different devices. */
export const clockLooksWrong = (maxMs = 2 * 60_000): boolean => skewMs !== undefined && Math.abs(skewMs) > maxMs;

export class GraphError extends Error {
  constructor(public status: number, public body: string, method: string, url: string) {
    super(`Graph API ${method} ${url} failed with ${status}: ${body}`);
  }
}

const RETRYABLE = new Set([429, 502, 503, 504]);

function retryDelayMs(response: Response | undefined, attempt: number): number {
  const retryAfter = Number(response?.headers.get("Retry-After"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter * 1000, config.maxDelayMs);
  const exp = Math.min(config.baseDelayMs * 2 ** attempt, config.maxDelayMs);
  return Math.round(exp / 2 + Math.random() * (exp / 2));
}

/**
 * Low-level authenticated fetch against Microsoft Graph. `path` is relative to the v1.0 root, e.g. "/drives/{id}/items/{id}".
 * Retries 429/502/503/504 and network errors with backoff (honouring Retry-After), and refreshes the token once on 401.
 * A request body must be re-sendable (string/Blob/ArrayBuffer/Uint8Array), not a one-shot stream.
 */
export function graphFetch(path: string, init: GraphInit = {}): Promise<Response> {
  const url = path.startsWith("http") ? path : `${GRAPH_BASE}${path}`;
  const { label: given, ...rest } = init;
  const label = given ?? describeRequest(rest.method ?? "GET", url, rest.body);
  return trackActivity(label, (update) => graphFetchTracked(url, rest, label, update));
}

/** `label` overrides the automatic description when the caller knows more (e.g. the file name being downloaded). */
export type GraphInit = RequestInit & { rawBody?: boolean; label?: string };

async function graphFetchTracked(
  url: string,
  init: RequestInit & { rawBody?: boolean },
  label: string,
  update: (label: string) => void
): Promise<Response> {
  if (!tokenProvider) throw new Error("No Graph token provider registered — call setTokenProvider() first.");
  const method = init.method ?? "GET";
  let refreshed = false;
  const waitThenResume = async (ms: number, why: string) => {
    update(`${why} Retrying in ${Math.max(1, Math.round(ms / 1000))}s…`);
    await config.sleep(ms);
    update(label);
  };

  for (let attempt = 0; ; attempt++) {
    update("Checking your Microsoft sign-in…");
    const token = await tokenProvider();
    update(label);
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    if (!init.rawBody && init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");

    let response: Response | undefined;
    try {
      response = await config.fetch(url, { ...init, headers });
    } catch (err) {
      if (attempt >= config.maxRetries) throw err;
      await waitThenResume(retryDelayMs(undefined, attempt), "Connection problem.");
      continue;
    }

    if (response.ok) return response;
    if (response.status === 401 && !refreshed) {
      refreshed = true;
      continue;
    }
    if (RETRYABLE.has(response.status) && attempt < config.maxRetries) {
      await waitThenResume(retryDelayMs(response, attempt), response.status === 429 ? "OneDrive asked us to slow down." : "OneDrive is busy.");
      continue;
    }
    const body = await response.text().catch(() => "");
    throw new GraphError(response.status, body, method, url);
  }
}

export async function graphJson<T>(path: string, init: GraphInit = {}): Promise<T> {
  const response = await graphFetch(path, init);
  return (await response.json()) as T;
}
