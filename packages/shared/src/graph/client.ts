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
export async function graphFetch(
  path: string,
  init: RequestInit & { rawBody?: boolean } = {}
): Promise<Response> {
  if (!tokenProvider) throw new Error("No Graph token provider registered — call setTokenProvider() first.");
  const url = path.startsWith("http") ? path : `${GRAPH_BASE}${path}`;
  const method = init.method ?? "GET";
  let refreshed = false;

  for (let attempt = 0; ; attempt++) {
    const token = await tokenProvider();
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    if (!init.rawBody && init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");

    let response: Response | undefined;
    try {
      response = await config.fetch(url, { ...init, headers });
    } catch (err) {
      if (attempt >= config.maxRetries) throw err;
      await config.sleep(retryDelayMs(undefined, attempt));
      continue;
    }

    if (response.ok) return response;
    if (response.status === 401 && !refreshed) {
      refreshed = true;
      continue;
    }
    if (RETRYABLE.has(response.status) && attempt < config.maxRetries) {
      await config.sleep(retryDelayMs(response, attempt));
      continue;
    }
    const body = await response.text().catch(() => "");
    throw new GraphError(response.status, body, method, url);
  }
}

export async function graphJson<T>(path: string, init: RequestInit & { rawBody?: boolean } = {}): Promise<T> {
  const response = await graphFetch(path, init);
  return (await response.json()) as T;
}
