import type { Observed } from "./observe.js";
import type { RecordingReport } from "./protocol.js";

/** A value's shape: field names and types, never the values themselves, so a report is safe to share. */
export function shapeOf(v: unknown, depth = 0): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return v.length ? `[${v.length}x${shapeOf(v[0], depth + 1)}]` : "[]";
  if (typeof v === "object") {
    if (depth > 2) return "{...}";
    return "{" + Object.keys(v as object).sort().map((k) => `${k}:${shapeOf((v as Record<string, unknown>)[k], depth + 1)}`).join(",") + "}";
  }
  return typeof v;
}

/** The same call with ids and numbers masked, so repeats of one endpoint count together. */
export function normalizeUrl(u: string, base = "https://x.invalid/"): string {
  try {
    const x = new URL(u, base);
    const path = x.pathname.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "{guid}").replace(/\/\d+/g, "/{n}");
    const q = [...x.searchParams.keys()].filter((k) => k !== "v").sort().join("&");
    return `${x.host.replace(/\.stepupforstudents\.org$/, "")}${path}${q ? `?${q}` : ""}`;
  } catch {
    return u;
  }
}

const OURS = /stepupforstudents\.org/;
const NOISE = /monitor\.azure|applicationinsights/;

/** Records which of StepUp's endpoints the page calls, with the shapes of requests and responses, while switched on. */
export class Recorder {
  on = false;
  startedAt?: string;
  private calls = new Map<string, RecordingReport["calls"][string]>();
  private pages: string[] = [];
  private loads: RecordingReport["loads"] = [];

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
    if (!this.on || !OURS.test(o.url) || NOISE.test(o.url)) return;
    const key = `${o.method} ${normalizeUrl(o.url)}`;
    const e = this.calls.get(key) ?? { n: 0, via: [], status: [] };
    e.n++;
    if (!e.via.includes(o.via)) e.via.push(o.via);
    if (!e.status.includes(o.status)) e.status.push(o.status);
    e.ms = o.ms;
    if (o.requestBody && e.req === undefined) {
      try {
        e.req = shapeOf(JSON.parse(o.requestBody));
      } catch {
        e.req = "non-json";
      }
    }
    if (o.responseText && e.res === undefined) {
      try {
        const j = JSON.parse(o.responseText) as unknown;
        e.res = shapeOf(Array.isArray(j) ? j.slice(0, 1) : j);
        e.kb = Math.round(o.responseText.length / 1024);
      } catch {
        e.res = "non-json";
      }
    }
    this.calls.set(key, e);
  }
  report(): RecordingReport {
    return { on: this.on, startedAt: this.startedAt, loads: this.loads, pages: [...new Set(this.pages)], calls: Object.fromEntries(this.calls) };
  }
}
