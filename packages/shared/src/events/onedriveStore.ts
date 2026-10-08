import { GraphError, graphJson } from "../graph/client.js";
import { readTextFile, writeFile } from "../graph/files.js";
import type { EventStore } from "./store.js";
import type { LedgerEvent } from "./types.js";

const SAFE_CLIENT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
/** Roll to a new segment file once a log passes this size so each upload stays small. */
const DEFAULT_SEGMENT_BYTES = 256 * 1024;

interface ChildrenPage {
  value: Array<{ id: string; name: string; eTag?: string; folder?: unknown }>;
  "@odata.nextLink"?: string;
}

interface OwnSegment {
  index: number;
  id?: string;
  eTag?: string;
  lines: string[];
  ids: Set<string>;
  bytes: number;
}

/** One log file as last read: its ETag and parsed events. Persist these between visits so only changed files are downloaded. */
export interface CachedLog {
  id: string;
  eTag?: string;
  events: LedgerEvent[];
}

export interface OneDriveEventStoreOptions {
  segmentBytes?: number;
}

/**
 * Event logs in a OneDrive folder: `<clientId>.jsonl`, then `<clientId>.1.jsonl`, ... Only this client ever writes its
 * own segments (uploaded whole with `If-Match`); reads list the folder and fetch only segments whose ETag changed.
 */
export class OneDriveEventStore implements EventStore {
  private own?: OwnSegment;
  private readonly cache = new Map<string, { eTag?: string; events: LedgerEvent[] }>();
  private readonly segmentBytes: number;

  constructor(
    private readonly driveId: string,
    private readonly eventsFolderId: string,
    readonly clientId: string,
    options: OneDriveEventStoreOptions = {}
  ) {
    if (!SAFE_CLIENT_ID.test(clientId)) throw new Error(`Unsafe clientId "${clientId}"`);
    this.segmentBytes = options.segmentBytes ?? DEFAULT_SEGMENT_BYTES;
  }

  /** Loads logs remembered from an earlier visit. They are trusted only until `readAll` compares ETags with the folder listing. */
  seedCache(logs: CachedLog[]): void {
    for (const l of logs) this.cache.set(l.id, { eTag: l.eTag, events: l.events });
  }

  /** What is known right now, ready to persist. */
  exportCache(): CachedLog[] {
    return [...this.cache.entries()].map(([id, c]) => ({ id, eTag: c.eTag, events: c.events }));
  }

  /** Every event in the cache, with no network (instant first paint; `readAll` brings it up to date). */
  cachedEvents(): LedgerEvent[] {
    return [...this.cache.values()].flatMap((c) => c.events);
  }

  /** Lists the folder once, then downloads (in parallel) only the logs whose ETag differs from the cache. */
  async readAll(): Promise<LedgerEvent[]> {
    const files = await this.listLogs();
    await Promise.all(
      files
        .filter((f) => this.cache.get(f.id)?.eTag !== f.eTag || !this.cache.has(f.id))
        .map(async (f) => {
          const { text, eTag } = await readTextFile(this.driveId, f.id);
          this.cache.set(f.id, { eTag: eTag ?? f.eTag, events: parseLines(text) });
        })
    );
    const seen = new Set(files.map((f) => f.id));
    for (const id of [...this.cache.keys()]) if (!seen.has(id)) this.cache.delete(id);
    return files.flatMap((f) => this.cache.get(f.id)?.events ?? []);
  }

  async appendOwn(events: LedgerEvent[]): Promise<void> {
    const seg = await this.loadOwn();
    const fresh = events.filter((e) => !seg.ids.has(e.id));
    if (fresh.length === 0) return;
    let target = seg;
    if (target.bytes >= this.segmentBytes) {
      target = { index: target.index + 1, lines: [], ids: new Set(), bytes: 0 };
      this.own = target;
    }
    const added = fresh.map((e) => JSON.stringify(e));
    const nextLines = [...target.lines, ...added];
    const body = nextLines.join("\n") + "\n";
    try {
      const stored = await writeFile(this.driveId, this.eventsFolderId, this.segmentName(target.index), body, {
        ifMatch: target.eTag,
        createOnly: !target.eTag,
      });
      target.id = stored.id;
      target.eTag = stored.eTag;
      // We just wrote this file, so we know its contents: never download our own log again.
      this.cache.set(stored.id, { eTag: stored.eTag, events: parseLines(body) });
    } catch (err) {
      if (err instanceof GraphError && (err.status === 412 || err.status === 409)) {
        this.own = undefined;
        throw new Error(
          `The event log for client "${this.clientId}" was changed by someone else. Each device/install must use its own clientId ` +
            `(was .cache copied between machines?). Original error: ${err.message}`
        );
      }
      throw err;
    }
    target.lines = nextLines;
    for (const e of fresh) target.ids.add(e.id);
    target.bytes = new TextEncoder().encode(body).byteLength;
  }

  private segmentName(index: number): string {
    return index === 0 ? `${this.clientId}.jsonl` : `${this.clientId}.${index}.jsonl`;
  }

  private async loadOwn(): Promise<OwnSegment> {
    if (this.own) return this.own;
    const files = await this.listLogs();
    const mine = new RegExp(`^${this.clientId.replace(/[-]/g, "\\-")}(?:\\.(\\d+))?\\.jsonl$`);
    let best: { index: number; id: string; eTag?: string } | undefined;
    for (const f of files) {
      const m = mine.exec(f.name);
      if (!m) continue;
      const index = m[1] ? Number(m[1]) : 0;
      if (!best || index > best.index) best = { index, id: f.id, eTag: f.eTag };
    }
    if (!best) {
      this.own = { index: 0, lines: [], ids: new Set(), bytes: 0 };
      return this.own;
    }
    const known = this.cache.get(best.id);
    if (known && known.eTag === best.eTag) {
      const text = known.events.map((e) => JSON.stringify(e)).join("\n") + (known.events.length ? "\n" : "");
      this.own = {
        index: best.index,
        id: best.id,
        eTag: best.eTag,
        lines: known.events.map((e) => JSON.stringify(e)),
        ids: new Set(known.events.map((e) => e.id)),
        bytes: new TextEncoder().encode(text).byteLength,
      };
      return this.own;
    }
    const { text, eTag } = await readTextFile(this.driveId, best.id);
    const lines = text.split("\n").filter((l) => l.trim());
    this.own = {
      index: best.index,
      id: best.id,
      eTag: eTag ?? best.eTag,
      lines,
      ids: new Set(parseLines(text).map((e) => e.id)),
      bytes: new TextEncoder().encode(text).byteLength,
    };
    return this.own;
  }

  private async listLogs(): Promise<Array<{ id: string; name: string; eTag?: string }>> {
    const out: Array<{ id: string; name: string; eTag?: string }> = [];
    let url: string | undefined = `/drives/${this.driveId}/items/${this.eventsFolderId}/children?$select=id,name,eTag,folder&$top=200`;
    while (url) {
      const page: ChildrenPage = await graphJson<ChildrenPage>(url);
      for (const c of page.value) if (!c.folder && c.name.endsWith(".jsonl")) out.push({ id: c.id, name: c.name, eTag: c.eTag });
      url = page["@odata.nextLink"];
    }
    return out;
  }
}

/** Tolerates a torn or corrupt line (skips it) rather than failing the whole read. */
export function parseLines(text: string): LedgerEvent[] {
  const events: LedgerEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as LedgerEvent;
      if (e && typeof e.id === "string" && typeof e.hlc === "string") events.push(e);
    } catch {
      // ignore malformed line
    }
  }
  return events;
}
