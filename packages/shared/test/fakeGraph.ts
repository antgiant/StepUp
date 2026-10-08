/** Minimal in-memory Microsoft Graph (OneDrive files only), enough to exercise the shared client/store code. */
interface Node {
  id: string;
  name: string;
  parent: string | null;
  isFolder: boolean;
  content: Uint8Array<ArrayBufferLike>;
  version: number;
}

export class FakeGraph {
  nodes = new Map<string, Node>();
  requests: Array<{ method: string; url: string }> = [];
  /** Queue of status codes to return (once each) before behaving normally, for retry tests. */
  failNext: Array<{ status: number; retryAfter?: number }> = [];
  private nextId = 1;
  private sessions = new Map<string, { parent: string; name: string; chunks: Uint8Array[]; total: number }>();
  readonly rootId: string;

  constructor() {
    this.rootId = this.add(null, "root", true).id;
  }

  add(parent: string | null, name: string, isFolder: boolean, content: Uint8Array<ArrayBufferLike> = new Uint8Array()): Node {
    const node: Node = { id: `n${this.nextId++}`, name, parent, isFolder, content, version: 1 };
    this.nodes.set(node.id, node);
    return node;
  }

  child(parent: string, name: string): Node | undefined {
    return [...this.nodes.values()].find((n) => n.parent === parent && n.name === name);
  }

  text(id: string): string {
    return new TextDecoder().decode(this.nodes.get(id)!.content);
  }

  private json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }

  private meta(n: Node) {
    return { id: n.id, name: n.name, eTag: `"${n.id}-${n.version}"`, size: n.content.byteLength, webUrl: `https://fake/${n.id}`, parentReference: { id: n.parent }, ...(n.isFolder ? { folder: {} } : {}) };
  }

  fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = String(input);
    const method = (init.method ?? "GET").toUpperCase();
    this.requests.push({ method, url });
    const fail = this.failNext.shift();
    if (fail) return new Response("fail", { status: fail.status, headers: fail.retryAfter ? { "Retry-After": String(fail.retryAfter) } : {} });

    const headers = new Headers(init.headers);
    const body = init.body;
    const bytes = async (): Promise<Uint8Array> =>
      typeof body === "string" ? new TextEncoder().encode(body) : body instanceof Uint8Array ? body : new Uint8Array();

    if (url.startsWith("https://upload.fake/")) {
      const s = this.sessions.get(url)!;
      const chunk = await bytes();
      s.chunks.push(chunk);
      const have = s.chunks.reduce((n, c) => n + c.byteLength, 0);
      if (have < s.total) return new Response("{}", { status: 202 });
      const all = new Uint8Array(have);
      let o = 0;
      for (const c of s.chunks) (all.set(c, o), (o += c.byteLength));
      const node = this.upsert(s.parent, s.name, all as Uint8Array);
      return this.json(this.meta(node), 201);
    }

    const path = url.replace("https://graph.microsoft.com/v1.0", "");
    let m: RegExpExecArray | null;

    if ((m = /^\/drives\/[^/]+\/items\/([^/:]+):\/([^:?]+):\/content(\?.*)?$/.exec(path)) && method === "PUT") {
      const parent = m[1]!;
      const name = decodeURIComponent(m[2]!);
      const existing = this.child(parent, name);
      const conflict = /conflictBehavior=(\w+)/.exec(m[3] ?? "")?.[1];
      if (existing && conflict === "fail") return this.json({ error: "nameAlreadyExists" }, 409);
      const ifMatch = headers.get("If-Match");
      if (ifMatch && existing && ifMatch !== `"${existing.id}-${existing.version}"`) return this.json({ error: "preconditionFailed" }, 412);
      if (ifMatch && !existing) return this.json({ error: "preconditionFailed" }, 412);
      return this.json(this.meta(this.upsert(parent, name, await bytes())), existing ? 200 : 201);
    }
    if ((m = /^\/drives\/[^/]+\/items\/([^/:]+):\/([^:?]+):\/createUploadSession$/.exec(path)) && method === "POST") {
      const uploadUrl = `https://upload.fake/${this.nextId++}`;
      const size = Number(headers.get("x-total") ?? 0);
      this.sessions.set(uploadUrl, { parent: m[1]!, name: decodeURIComponent(m[2]!), chunks: [], total: size });
      return this.json({ uploadUrl });
    }
    if ((m = /^\/drives\/[^/]+\/items\/([^/:]+):\/([^:?]+)(\?.*)?$/.exec(path)) && method === "GET") {
      const n = this.child(m[1]!, decodeURIComponent(m[2]!));
      return n ? this.json(this.meta(n)) : this.json({ error: "itemNotFound" }, 404);
    }
    if ((m = /^\/drives\/[^/]+\/items\/([^/]+)\/children(\?.*)?$/.exec(path))) {
      if (method === "POST") {
        const spec = JSON.parse(String(body)) as { name: string };
        if (this.child(m[1]!, spec.name)) return this.json({ error: "nameAlreadyExists" }, 409);
        return this.json(this.meta(this.add(m[1]!, spec.name, true)), 201);
      }
      return this.json({ value: [...this.nodes.values()].filter((n) => n.parent === m![1]).map((n) => this.meta(n)) });
    }
    if ((m = /^\/drives\/[^/]+\/items\/([^/?]+)\/content$/.exec(path))) {
      const n = this.nodes.get(m[1]!);
      return n ? new Response(n.content as BodyInit) : this.json({}, 404);
    }
    if ((m = /^\/drives\/[^/]+\/items\/([^/?]+)(\?.*)?$/.exec(path)) && method === "DELETE") {
      const n = this.nodes.get(m[1]!);
      if (!n) return this.json({ error: "itemNotFound" }, 404);
      const ifMatch = headers.get("If-Match");
      if (ifMatch && ifMatch !== `"${n.id}-${n.version}"`) return this.json({ error: "preconditionFailed" }, 412);
      this.nodes.delete(n.id);
      return new Response(null, { status: 204 });
    }
    if ((m = /^\/drives\/[^/]+\/items\/([^/?]+)(\?.*)?$/.exec(path))) {
      const n = this.nodes.get(m[1]!);
      return n ? this.json(this.meta(n)) : this.json({}, 404);
    }
    return this.json({ error: `unhandled ${method} ${path}` }, 500);
  };

  private upsert(parent: string, name: string, content: Uint8Array<ArrayBufferLike>): Node {
    const existing = this.child(parent, name);
    if (existing) {
      existing.content = content;
      existing.version += 1;
      return existing;
    }
    return this.add(parent, name, false, content);
  }
}
