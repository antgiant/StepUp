import { getAccessToken } from "./auth.js";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

export class GraphError extends Error {
  constructor(public status: number, public body: string, method: string, url: string) {
    super(`Graph API ${method} ${url} failed with ${status}: ${body}`);
  }
}

/** Low-level authenticated fetch against Microsoft Graph. `path` is relative to the v1.0 root, e.g. "/drives/{id}/items/{id}". */
export async function graphFetch(
  path: string,
  init: RequestInit & { rawBody?: boolean } = {}
): Promise<Response> {
  const token = await getAccessToken();
  const url = path.startsWith("http") ? path : `${GRAPH_BASE}${path}`;
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (!init.rawBody && init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(url, { ...init, headers });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new GraphError(response.status, body, init.method ?? "GET", url);
  }
  return response;
}

export async function graphJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await graphFetch(path, init);
  return (await response.json()) as T;
}
