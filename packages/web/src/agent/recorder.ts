import type { Observed } from "./observe.js";
import type { RecordingReport } from "./protocol.js";

/** An object key that is really an identifier (a student's sequence number, a guid): masked in shapes. */
const idKey = (k: string): boolean => /^\d{5,}$/.test(k) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(k);

/** A value's shape: field names and types, never the values themselves, so a report is safe to share. */
export function shapeOf(v: unknown, depth = 0): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return v.length ? `[${v.length}x${shapeOf(v[0], depth + 1)}]` : "[]";
  if (typeof v === "object") {
    if (depth > 4) return "{...}";
    const named: string[] = [];
    const ids: unknown[] = [];
    for (const k of Object.keys(v as object).sort()) {
      const val = (v as Record<string, unknown>)[k];
      if (idKey(k)) ids.push(val);
      else named.push(`${k}:${shapeOf(val, depth + 1)}`);
    }
    // Keys that are identifiers are counted, not named; the first one's value stands for them all.
    if (ids.length) named.push(`{id${ids.length > 1 ? `x${ids.length}` : ""}}:${shapeOf(ids[0], depth + 1)}`);
    return "{" + named.join(",") + "}";
  }
  return typeof v;
}

/** The same call with ids and numbers masked, so repeats of one endpoint count together. */
export function normalizeUrl(u: string, base = "https://x.invalid/"): string {
  try {
    const x = new URL(u, base);
    // Storage addresses carry file names and signatures: only the kind of call is kept.
    if (/\.blob\.core\.windows\.net$/i.test(x.host)) return `*.blob.core.windows.net/{path}${x.search ? `?${[...x.searchParams.keys()].sort().join("&")}` : ""}`;
    const path = x.pathname.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "{guid}").replace(/\/\d+/g, "/{n}");
    const q = [...x.searchParams.keys()].filter((k) => k !== "v").sort().join("&");
    return `${x.host.replace(/\.stepupforstudents\.org$/, "")}${path}${q ? `?${q}` : ""}`;
  } catch {
    return u;
  }
}

/**
 * Field names whose values are settings or statuses, not personal data. The recorder keeps their first value so a filing
 * request can be built with the right words (what a new draft's status is called, what a flag is set to).
 */
const SAMPLE_KEYS = new Set([
  "externalstatus", "internalstatus", "displayexternalstatus", "displayinternalstatus", "programtype", "partitionversion",
  "skipvalidation", "shouldupload", "filetype", "isnew", "ocrformatted", "hasduplicate", "resubmitted", "hasappealeditems",
  "appealed", "isduplicate", "reassigned", "schoolyear", "programname", "sortorder", "pagesize", "currentpage",
  "applydefaultfilters", "includeglobalsearchtotal", "skipcount", "excludedstatuses", "requestsourcetype", "status",
  "commenttype", "commentrecordtype", "internalonly", "sourceentityname", "reasoncode", "callertype", "doctype", "wasread",
  "wasdeleted", "contactreason",
]);

const ID_LIKE = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{5,})$/i;
const MAX_INDEXED = 100_000;
const MAX_JSON_CHARS = 3_000_000;

/**
 * Where did the ids in a request come from? Responses are indexed in memory by id value -> the call and field they were seen
 * in; a request's ids are then reported as the field they came from (or "not seen in any response", i.e. made up by the
 * page). Only field paths are ever reported, never the ids, so this is safe to share.
 */
class Provenance {
  private seen = new Map<string, string>();

  private walk(v: unknown, path: string, visit: (value: string, path: string) => void, limit: number, depth = 0): void {
    if (depth > 10 || v === null) return;
    if (typeof v === "string") {
      if (ID_LIKE.test(v)) visit(v.toLowerCase(), path || "(body)");
    } else if (typeof v === "number") {
      if (Number.isInteger(v) && Math.abs(v) >= 10000) visit(String(v), path || "(body)");
    } else if (Array.isArray(v)) {
      for (const x of v.slice(0, limit)) this.walk(x, `${path}[]`, visit, limit, depth + 1);
    } else if (typeof v === "object") {
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        const numericKey = /^\d{5,}$/.test(k);
        if (numericKey) visit(k, `${path}.{id}`);
        this.walk(val, numericKey ? `${path}.{id}` : `${path}.${k}`, visit, limit, depth + 1);
      }
    }
  }

  index(source: string, json: unknown): void {
    this.walk(json, "", (value, path) => {
      if (this.seen.size < MAX_INDEXED && !this.seen.has(value)) this.seen.set(value, `${source} :: ${path.replace(/^\./, "")}`);
    }, 100);
  }

  trace(json: unknown): Record<string, string> {
    const out: Record<string, string> = {};
    this.walk(json, "", (value, path) => {
      const p = path.replace(/^\./, "");
      if (!(p in out)) out[p] = this.seen.get(value) ?? "(not seen in any response)";
    }, 5);
    return out;
  }
}

/** The first value of each sampled field anywhere in a JSON value (short strings, numbers, booleans, null only). */
export function samplesOf(v: unknown, into: Record<string, string | number | boolean | null> = {}, depth = 0): Record<string, string | number | boolean | null> {
  if (depth > 6 || v === null || typeof v !== "object") return into;
  if (Array.isArray(v)) {
    for (const x of v.slice(0, 3)) samplesOf(x, into, depth + 1);
    return into;
  }
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    const key = k.toLowerCase();
    if (SAMPLE_KEYS.has(key) && !(k in into)) {
      if (val === null || typeof val === "boolean" || typeof val === "number") into[k] = val;
      else if (typeof val === "string" && val.length <= 40) into[k] = val;
      else if (Array.isArray(val) && val.length <= 5 && val.every((x) => typeof x === "string" && x.length <= 24)) into[k] = (val as string[]).join(",");
    } else if (val && typeof val === "object") samplesOf(val, into, depth + 1);
  }
  return into;
}

/** A placeholder date (year 0001) is a setting; a real date is not recorded. */
const placeholderDate = (v: unknown): boolean => typeof v === "string" && /^0001-/.test(v);

const OURS = /stepupforstudents\.org|\.blob\.core\.windows\.net/;
const NOISE = /monitor\.azure|applicationinsights/;

/** Records which of StepUp's endpoints the page calls, with the shapes of requests and responses, while switched on. */
export class Recorder {
  on = false;
  startedAt?: string;
  private calls = new Map<string, RecordingReport["calls"][string]>();
  private pages: string[] = [];
  private loads: RecordingReport["loads"] = [];
  private provenance = new Provenance();

  /**
   * A recorder holding what a report says: how a newer copy of the agent carries a recording over. The data is carried,
   * never the old object, so the newer code is what keeps recording.
   */
  static restore(report: Partial<RecordingReport> | undefined): Recorder {
    const r = new Recorder();
    if (!report) return r;
    r.on = Boolean(report.on);
    r.startedAt = report.startedAt;
    r.loads = [...(report.loads ?? [])];
    r.pages = [...(report.pages ?? [])];
    for (const [k, v] of Object.entries(report.calls ?? {})) r.calls.set(k, v);
    return r;
  }

  /** Index a response of ours (the agent's own calls are not observed) so later requests can be traced to it. */
  noteOwnResponse(method: string, url: string, json: unknown): void {
    this.provenance.index(`${method} ${normalizeUrl(url)}`, json);
  }

  start(now: string, page: string): void {
    this.on = true;
    this.startedAt = now;
    this.loads.push({ at: now.slice(11, 19), page });
  }
  stop(): void {
    this.on = false;
  }
  page(path: string): void {
    if (this.on) this.pages.push(path);
  }
  note(o: Observed): void {
    if (!OURS.test(o.url) || NOISE.test(o.url)) return;
    const key = `${o.method} ${normalizeUrl(o.url)}`;
    // Responses are always indexed (cheaply, in memory), so a later request can be traced to where its ids came from.
    let resJson: unknown;
    if (o.responseText && o.responseText.length <= MAX_JSON_CHARS) {
      try {
        resJson = JSON.parse(o.responseText);
        this.provenance.index(key, resJson);
      } catch {
        /* not JSON */
      }
    }
    if (!this.on) return;
    const e = this.calls.get(key) ?? { n: 0, via: [], status: [] };
    e.n++;
    if (!e.via.includes(o.via)) e.via.push(o.via);
    if (!e.status.includes(o.status)) e.status.push(o.status);
    e.ms = o.ms;
    for (const h of o.requestHeaders ?? []) {
      e.headers ??= [];
      if (!e.headers.includes(h)) e.headers.push(h);
    }
    if (o.requestBytes !== undefined) e.bytes = o.requestBytes;
    if (o.requestBody && e.req === undefined) {
      try {
        const j = JSON.parse(o.requestBody) as unknown;
        e.req = shapeOf(j);
        e.origins = { ...this.provenance.trace(j), ...(e.origins ?? {}) };
        e.samples = { ...samplesOf(j), ...(e.samples ?? {}) };
        const sd = (j as { submitDate?: unknown } | null)?.submitDate;
        if (placeholderDate(sd)) e.samples["submitDate"] = sd as string;
      } catch {
        e.req = "non-json";
      }
    }
    if (o.responseText && e.res === undefined) {
      try {
        const j = resJson !== undefined ? resJson : (JSON.parse(o.responseText) as unknown);
        e.res = shapeOf(Array.isArray(j) ? j.slice(0, 1) : j);
        e.samples = { ...samplesOf(j), ...(e.samples ?? {}) };
        e.kb = Math.round(o.responseText.length / 1024);
      } catch {
        e.res = "non-json";
      }
    }
    this.calls.set(key, e);
  }
  /**
   * Storage uploads are made by code that holds its own reference to `fetch`, so the wrappers never see them. The browser's
   * own resource timeline does: only that a transfer to a storage host happened, how it was started and its size (the
   * address is reduced to the kind of call).
   */
  resource(url: string, initiator: string, bytes: number): void {
    if (!this.on || !/\.blob\.core\.windows\.net/i.test(url)) return;
    const key = `RESOURCE ${normalizeUrl(url)}`;
    const e = this.calls.get(key) ?? { n: 0, via: [], status: [] };
    e.n++;
    if (!e.via.includes(initiator)) e.via.push(initiator);
    e.bytes = bytes;
    this.calls.set(key, e);
  }
  report(): RecordingReport {
    return { on: this.on, startedAt: this.startedAt, loads: this.loads, pages: [...new Set(this.pages)], calls: Object.fromEntries(this.calls) };
  }
}
