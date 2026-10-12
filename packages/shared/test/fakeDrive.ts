import { noSignIn, type GoogleDriveAuth } from "../src/index.js";

/** Sign-in for tests: always signed in, with a fixed token. */
export const testGoogleAuth: GoogleDriveAuth = { ...noSignIn({ id: "g", name: "g@example.com" }), getToken: async () => "token" };

/** Stands in for Drive's md5Checksum: any stable function of the bytes will do. */
const contentHash = (b: Uint8Array): string => {
  let h = 2166136261;
  for (const x of b) h = Math.imul(h ^ x, 16777619) >>> 0;
  return `${h.toString(16)}-${b.byteLength}`;
};

interface Node {
  id: string;
  name: string;
  parents: string[];
  mimeType: string;
  content: Uint8Array;
  version: number;
  created: number;
  trashed: boolean;
  sharedWithMe?: boolean;
  shortcut?: { targetId: string; targetMimeType: string };
}

const FOLDER = "application/vnd.google-apps.folder";

/** A small in-memory Google Drive v3 (files, multipart + resumable upload, permissions), enough to exercise the provider. */
export class FakeDrive {
  nodes = new Map<string, Node>();
  requests: Array<{ method: string; url: string }> = [];
  permissions: Array<{ fileId: string; body: unknown; query: Record<string, string> }> = [];
  /** Statuses to return once each before behaving normally (retry tests). */
  failNext: Array<{ status: number; body?: string }> = [];
  /** Forces list paging at this many items per page. */
  pageSize = 0;
  private counter = 1;
  private sessions = new Map<string, { id?: string; meta: { name?: string; parents?: string[] }; mime: string; total: number; chunks: Uint8Array[] }>();

  constructor() {
    this.nodes.set("root", { id: "root", name: "My Drive", parents: [], mimeType: FOLDER, content: new Uint8Array(), version: 1, created: 0, trashed: false });
    this.nodes.set("appDataFolder", { id: "appDataFolder", name: "appData", parents: [], mimeType: FOLDER, content: new Uint8Array(), version: 1, created: 0, trashed: false });
  }

  add(name: string, parents: string[], mimeType = "application/octet-stream", content: Uint8Array = new Uint8Array()): Node {
    const n: Node = { id: `f${this.counter}`, name, parents, mimeType, content, version: 1, created: this.counter++, trashed: false };
    this.nodes.set(n.id, n);
    return n;
  }

  text(id: string): string {
    return new TextDecoder().decode(this.nodes.get(id)!.content);
  }

  private meta(n: Node) {
    return {
      id: n.id,
      name: n.name,
      mimeType: n.mimeType,
      ...(n.mimeType === FOLDER || n.shortcut ? {} : { size: String(n.content.byteLength) }),
      ...(n.mimeType === FOLDER || n.shortcut ? {} : { md5Checksum: contentHash(n.content) }),
      version: String(n.version),
      modifiedTime: new Date(1_700_000_000_000 + n.version * 1000).toISOString(),
      createdTime: new Date(1_700_000_000_000 + n.created * 1000).toISOString(),
      webViewLink: `https://drive.fake/${n.id}`,
      parents: n.parents,
      trashed: n.trashed,
      ...(n.shortcut ? { shortcutDetails: { targetId: n.shortcut.targetId, targetMimeType: n.shortcut.targetMimeType } } : {}),
    };
  }

  private json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }

  private err(status: number, reason = "error"): Response {
    return this.json({ error: { code: status, message: reason, errors: [{ reason }] } }, status);
  }

  /** Evaluates the subset of the Drive `q` language the provider uses. */
  private matches(n: Node, q: string): boolean {
    const clause = /'((?:\\.|[^'\\])*)' in parents|name = '((?:\\.|[^'\\])*)'|trashed = (true|false)|mimeType = '([^']*)'|sharedWithMe = true/g;
    const unescape = (s: string) => s.replace(/\\(.)/g, "$1");
    let m: RegExpExecArray | null;
    while ((m = clause.exec(q))) {
      if (m[1] !== undefined && !n.parents.includes(unescape(m[1]))) return false;
      if (m[2] !== undefined && n.name !== unescape(m[2])) return false;
      if (m[3] !== undefined && n.trashed !== (m[3] === "true")) return false;
      if (m[4] !== undefined && n.mimeType !== m[4]) return false;
      if (m[0] === "sharedWithMe = true" && !n.sharedWithMe) return false;
    }
    return true;
  }

  private static binary(bytes: Uint8Array): string {
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
    return s;
  }

  private async bodyBytes(body: unknown): Promise<Uint8Array> {
    if (typeof body === "string") return new TextEncoder().encode(body);
    if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
    if (body instanceof Uint8Array) return body;
    return new Uint8Array();
  }

  private async parseMultipart(contentType: string, body: unknown): Promise<{ meta: { name?: string; parents?: string[] }; data: Uint8Array; mime: string }> {
    const boundary = /boundary=(.+)$/.exec(contentType)![1]!;
    const bytes = await this.bodyBytes(body);
    const bin = FakeDrive.binary(bytes);
    const marker = `--${boundary}`;
    const first = bin.indexOf(marker);
    const second = bin.indexOf(marker, first + marker.length);
    const end = bin.indexOf(`\r\n${marker}--`);
    const part1 = bin.slice(first + marker.length, second);
    const jsonStart = first + marker.length + part1.indexOf("\r\n\r\n") + 4;
    // The metadata is UTF-8 text; the offsets found in the binary string are byte offsets.
    const json = new TextDecoder().decode(bytes.slice(jsonStart, second)).replace(/\r\n$/, "");
    const part2Head = bin.slice(second + marker.length);
    const headerEnd = part2Head.indexOf("\r\n\r\n");
    const mime = /Content-Type: ([^\r\n]+)/.exec(part2Head.slice(0, headerEnd))?.[1] ?? "application/octet-stream";
    const dataStart = second + marker.length + headerEnd + 4;
    return { meta: JSON.parse(json || "{}"), data: bytes.slice(dataStart, end), mime };
  }

  fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const method = (init.method ?? "GET").toUpperCase();
    this.requests.push({ method, url: url.pathname + url.search });
    const fail = this.failNext.shift();
    if (fail) return new Response(fail.body ?? "fail", { status: fail.status });
    const headers = new Headers(init.headers);
    const q = Object.fromEntries(url.searchParams.entries());
    let m: RegExpExecArray | null;

    if (url.host === "upload.fakedrive") {
      const s = this.sessions.get(url.href);
      if (!s) return this.err(404, "notFound");
      s.chunks.push(await this.bodyBytes(init.body));
      const have = s.chunks.reduce((n, c) => n + c.byteLength, 0);
      if (have < s.total) return new Response(null, { status: 308, headers: { Range: `bytes=0-${have - 1}` } });
      const all = new Uint8Array(have);
      let o = 0;
      for (const c of s.chunks) (all.set(c, o), (o += c.byteLength));
      return this.json(this.meta(this.store(s.id, s.meta, all, s.mime)), s.id ? 200 : 201);
    }

    const path = url.pathname;
    if ((m = /^\/upload\/drive\/v3\/files(?:\/([^/]+))?$/.exec(path))) {
      const id = m[1] ? decodeURIComponent(m[1]) : undefined;
      if (id && !this.nodes.has(id)) return this.err(404, "notFound");
      if (q["uploadType"] === "multipart") {
        const parsed = await this.parseMultipart(headers.get("Content-Type") ?? "", init.body);
        return this.json(this.meta(this.store(id, parsed.meta, parsed.data, parsed.mime)), id ? 200 : 200);
      }
      if (q["uploadType"] === "resumable") {
        const session = `https://upload.fakedrive/s${this.counter++}`;
        this.sessions.set(session, { id, meta: JSON.parse(String(init.body ?? "{}")), mime: headers.get("X-Upload-Content-Type") ?? "application/octet-stream", total: Number(headers.get("X-Upload-Content-Length") ?? 0), chunks: [] });
        return new Response("{}", { status: 200, headers: { Location: session } });
      }
    }

    if (!path.startsWith("/drive/v3/files")) return this.err(500, `unhandled ${method} ${path}`);

    if (path === "/drive/v3/files" && method === "GET") {
      const all = [...this.nodes.values()].filter((n) => n.id !== "root" && n.id !== "appDataFolder" && this.matches(n, q["q"] ?? ""));
      const space = q["spaces"] === "appDataFolder";
      const inSpace = all.filter((n) => (space ? n.parents.includes("appDataFolder") : true));
      const start = Number(q["pageToken"] ?? 0);
      const size = this.pageSize || inSpace.length || 1;
      const page = inSpace.slice(start, start + size);
      const next = start + size < inSpace.length ? String(start + size) : undefined;
      return this.json({ files: page.map((n) => this.meta(n)), ...(next ? { nextPageToken: next } : {}) });
    }
    if (path === "/drive/v3/files" && method === "POST") {
      const spec = JSON.parse(String(init.body)) as { name: string; mimeType?: string; parents?: string[] };
      return this.json(this.meta(this.add(spec.name, spec.parents ?? ["root"], spec.mimeType ?? "application/octet-stream")));
    }
    if ((m = /^\/drive\/v3\/files\/([^/]+)\/permissions$/.exec(path)) && method === "POST") {
      this.permissions.push({ fileId: decodeURIComponent(m[1]!), body: JSON.parse(String(init.body)), query: q });
      return this.json({ id: "perm" });
    }
    if ((m = /^\/drive\/v3\/files\/([^/]+)$/.exec(path))) {
      const id = decodeURIComponent(m[1]!);
      const n = this.nodes.get(id);
      if (!n) return this.err(404, "notFound");
      if (method === "GET") return q["alt"] === "media" ? new Response(n.content as BodyInit) : this.json(this.meta(n));
      if (method === "PATCH") {
        const spec = JSON.parse(String(init.body)) as { name?: string; trashed?: boolean };
        if (spec.name !== undefined) n.name = spec.name;
        if (spec.trashed !== undefined) n.trashed = spec.trashed;
        const remove = q["removeParents"]?.split(",") ?? [];
        if (q["addParents"] || remove.length) n.parents = [...n.parents.filter((p) => !remove.includes(p)), ...(q["addParents"]?.split(",") ?? [])];
        n.version += 1;
        return this.json(this.meta(n));
      }
      if (method === "DELETE") {
        this.nodes.delete(id);
        return new Response(null, { status: 204 });
      }
    }
    return this.err(500, `unhandled ${method} ${path}`);
  };

  private store(id: string | undefined, meta: { name?: string; parents?: string[] }, data: Uint8Array, mime: string): Node {
    if (id) {
      const n = this.nodes.get(id)!;
      n.content = data;
      n.version += 1;
      if (meta.name) n.name = meta.name;
      return n;
    }
    return this.add(meta.name ?? "untitled", meta.parents ?? ["root"], mime, data);
  }
}
