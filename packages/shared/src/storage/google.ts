import { trackActivity } from "../graph/client.js";
import {
  StorageError,
  bodyBytes,
  bodySize,
  type AppFolder,
  type FileBody,
  type FolderEntry,
  type StorageAuth,
  type StorageEntry,
  type StorageErrorKind,
  type StorageProvider,
  type StoredFile,
  type WriteOptions,
} from "./types.js";

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const FOLDER = "application/vnd.google-apps.folder";
const SHORTCUT = "application/vnd.google-apps.shortcut";
const FIELDS = "id,name,mimeType,size,version,md5Checksum,modifiedTime,createdTime,webViewLink,parents,trashed,shortcutDetails(targetId,targetMimeType)";

/** The one "drive" a Google provider has; shared drives are reached by item id and need no separate id here. */
export const GOOGLE_DRIVE = "google";
/** Drive's alias for an app's private, hidden folder. */
const APP_DATA = "appDataFolder";
/** Files up to this size go in one multipart request; larger ones use a resumable session. */
export const GOOGLE_SIMPLE_UPLOAD_LIMIT = 5 * 1024 * 1024;
/** Resumable chunks must be multiples of 256 KiB (except the last). */
export const GOOGLE_UPLOAD_CHUNK = 256 * 1024 * 16;

/** Sign-in for Google Drive: the usual account operations plus an access token. Each host supplies its own. */
export interface GoogleDriveAuth extends StorageAuth {
  /** `refresh` asks for a new token even if the cached one looks valid (after a 401). */
  getToken(refresh?: boolean): Promise<string>;
}

export interface GoogleDriveOptions {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Retries after the first attempt, for 429/5xx, rate-limit 403s and network failures. */
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

interface DriveFile {
  id: string;
  name: string;
  mimeType?: string;
  size?: string;
  version?: string;
  md5Checksum?: string;
  modifiedTime?: string;
  createdTime?: string;
  webViewLink?: string;
  parents?: string[];
  trashed?: boolean;
  shortcutDetails?: { targetId?: string; targetMimeType?: string };
}

/** A failed Google Drive request, as a `StorageError` (with the HTTP status for diagnostics). */
export class GoogleDriveError extends StorageError {
  constructor(readonly status: number, kind: StorageErrorKind, message: string) {
    super(kind, message);
  }
}

const RATE_LIMIT = /rateLimitExceeded|userRateLimitExceeded|sharingRateLimitExceeded/;

function kindOf(status: number, body: string): StorageErrorKind {
  if (status === 404) return "not-found";
  if (status === 409) return "exists";
  if (status === 412) return "changed";
  if (status === 401 || status === 403) return "forbidden";
  if (status === 400) return "invalid";
  void body;
  return "other";
}

/** Escapes a value for use inside single quotes in a Drive `q` query. */
const quote = (s: string): string => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

const isFolderish = (f: DriveFile): boolean => f.mimeType === FOLDER || (f.mimeType === SHORTCUT && f.shortcutDetails?.targetMimeType === FOLDER);

/** A shortcut stands for its target everywhere in this provider, so a shortcut to a folder opens that folder. */
const resolved = (f: DriveFile): DriveFile => (f.mimeType === SHORTCUT && f.shortcutDetails?.targetId ? { ...f, id: f.shortcutDetails.targetId, mimeType: f.shortcutDetails.targetMimeType ?? f.mimeType } : f);

/**
 * The token that stands for "this content". Drive's `version` also moves for changes nobody made (indexing, thumbnails,
 * sharing), which would read as someone else editing our log, so the content hash is preferred where Drive has one.
 */
const tagOf = (f: DriveFile): string | undefined => f.md5Checksum ?? f.version;

const toEntry = (raw: DriveFile): StorageEntry => {
  const f = resolved(raw);
  return {
    id: f.id,
    name: raw.name,
    isFolder: f.mimeType === FOLDER,
    ...(f.size !== undefined ? { size: Number(f.size) } : {}),
    ...(tagOf(f) ? { eTag: tagOf(f) } : {}),
    ...(raw.webViewLink ? { webUrl: raw.webViewLink } : {}),
    ...(raw.modifiedTime ? { modified: raw.modifiedTime } : {}),
  };
};

/** The oldest first, so every client agrees which of two same-named items is "the" one. */
const oldestFirst = (a: DriveFile, b: DriveFile): number => (a.createdTime ?? "").localeCompare(b.createdTime ?? "") || a.id.localeCompare(b.id);

/**
 * Files in the person's Google Drive. Drive differs from OneDrive in ways this class covers up:
 * - names are not unique in a folder, so "create only" and "find" pick the oldest and a losing creator backs out;
 * - there is no conditional write, so `ifMatch` compares Drive's `version` just before writing;
 * - items are addressed by id alone, so the `driveId` is the constant `GOOGLE_DRIVE`.
 */
export class GoogleDriveProvider implements StorageProvider {
  readonly kind = "google" as const;
  readonly label = "Google Drive";
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  /** Ids of files this client has written, by `parentId/name`, for when Drive's listing has not caught up yet. */
  private readonly written = new Map<string, string>();

  constructor(readonly auth: GoogleDriveAuth, options: GoogleDriveOptions = {}) {
    this.fetchFn = options.fetch ?? ((...args) => fetch(...args));
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.maxRetries = options.maxRetries ?? 5;
    this.baseDelayMs = options.baseDelayMs ?? 500;
    this.maxDelayMs = options.maxDelayMs ?? 30_000;
  }

  private backoff(attempt: number, res?: Response): number {
    const retryAfter = Number(res?.headers.get("Retry-After"));
    if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter * 1000, this.maxDelayMs);
    const exp = Math.min(this.baseDelayMs * 2 ** attempt, this.maxDelayMs);
    return Math.round(exp / 2 + Math.random() * (exp / 2));
  }

  /** An authenticated request with retries; failures become `StorageError`s. `label` is shown while it runs. */
  private request(url: string, init: RequestInit = {}, label = "Talking to Google Drive…"): Promise<Response> {
    const method = init.method ?? "GET";
    return trackActivity(label, async (update) => {
      let refreshed = false;
      let forceRefresh = false;
      for (let attempt = 0; ; attempt++) {
        const token = await this.auth.getToken(forceRefresh);
        forceRefresh = false;
        const headers = new Headers(init.headers);
        headers.set("Authorization", `Bearer ${token}`);
        let res: Response;
        try {
          res = await this.fetchFn(url, { ...init, headers });
        } catch (err) {
          if (attempt >= this.maxRetries) throw err;
          await this.sleep(this.backoff(attempt));
          continue;
        }
        if (res.ok) return res;
        if (res.status === 401 && !refreshed) {
          refreshed = true;
          forceRefresh = true;
          continue;
        }
        const text = await res.text().catch(() => "");
        const retryable = res.status === 429 || res.status >= 500 || (res.status === 403 && RATE_LIMIT.test(text));
        if (retryable && attempt < this.maxRetries) {
          const wait = this.backoff(attempt, res);
          update(`${label} Google Drive is busy; retrying in ${Math.max(1, Math.round(wait / 1000))}s…`);
          await this.sleep(wait);
          update(label);
          continue;
        }
        let message = text;
        try {
          message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? text;
        } catch {
          /* not JSON: keep the raw text */
        }
        throw new GoogleDriveError(res.status, kindOf(res.status, text), `Google Drive ${method} ${url.replace(/\?.*/, "")} failed with ${res.status}: ${message}`);
      }
    });
  }

  private async json<T>(url: string, init: RequestInit = {}, label?: string): Promise<T> {
    return (await (await this.request(url, init, label)).json()) as T;
  }

  private fileUrl(id: string, extra: Record<string, string> = {}): string {
    const p = new URLSearchParams({ fields: FIELDS, supportsAllDrives: "true", ...extra });
    return `${API}/files/${encodeURIComponent(id)}?${p}`;
  }

  /** All pages of a `files.list` query. */
  private async query(q: string, parentId?: string, label?: string): Promise<DriveFile[]> {
    const out: DriveFile[] = [];
    let pageToken: string | undefined;
    do {
      const p = new URLSearchParams({ q, fields: `nextPageToken,files(${FIELDS})`, pageSize: "1000", supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
      if (parentId === APP_DATA) p.set("spaces", APP_DATA);
      if (pageToken) p.set("pageToken", pageToken);
      const page = await this.json<{ files?: DriveFile[]; nextPageToken?: string }>(`${API}/files?${p}`, {}, label);
      out.push(...(page.files ?? []));
      pageToken = page.nextPageToken;
    } while (pageToken);
    return out;
  }

  private children(parentId: string, extra = "", label?: string): Promise<DriveFile[]> {
    return this.query(`'${quote(parentId)}' in parents and trashed = false${extra}`, parentId, label ?? "Reading the folder's contents…");
  }

  async list(_driveId: string, folderId: string): Promise<StorageEntry[]> {
    return (await this.children(folderId)).map(toEntry);
  }

  private async findRaw(parentId: string, name: string): Promise<DriveFile | undefined> {
    const matches = await this.children(parentId, ` and name = '${quote(name)}'`, `Looking for ${name}…`);
    return matches.sort(oldestFirst)[0];
  }

  async find(_driveId: string, parentId: string, name: string): Promise<StorageEntry | undefined> {
    const f = await this.findRaw(parentId, name);
    return f ? toEntry(f) : undefined;
  }

  /** One item's details. Drive still serves bin items by id; here they count as gone, as they do on OneDrive. */
  private async getLive(itemId: string): Promise<DriveFile> {
    const f = await this.json<DriveFile>(this.fileUrl(itemId));
    if (f.trashed) throw new StorageError("not-found", `"${f.name}" is in the bin`);
    return f;
  }

  async stat(_driveId: string, itemId: string): Promise<StorageEntry> {
    return toEntry(await this.getLive(itemId));
  }

  async parentOf(_driveId: string, itemId: string): Promise<string> {
    const f = await this.getLive(itemId);
    const parent = f.parents?.[0];
    if (!parent) throw new Error("Item has no parent folder");
    return parent;
  }

  async readText(_driveId: string, itemId: string): Promise<{ text: string; eTag?: string }> {
    const [meta, res] = await Promise.all([
      this.getLive(itemId),
      this.request(`${API}/files/${encodeURIComponent(itemId)}?alt=media&supportsAllDrives=true`, {}, "Downloading a file…"),
    ]);
    return { text: await res.text(), ...(tagOf(meta) ? { eTag: tagOf(meta) } : {}) };
  }

  async download(_driveId: string, itemId: string, label?: string): Promise<Blob> {
    const res = await this.request(`${API}/files/${encodeURIComponent(itemId)}?alt=media&supportsAllDrives=true`, {}, label ?? "Downloading a file…");
    return res.blob();
  }

  async ensureFolder(_driveId: string, parentId: string, name: string): Promise<string> {
    const existing = await this.findRaw(parentId, name);
    if (existing) {
      if (!isFolderish(existing)) throw new Error(`"${name}" exists but is not a folder`);
      return resolved(existing).id;
    }
    const made = await this.json<DriveFile>(
      `${API}/files?${new URLSearchParams({ fields: FIELDS, supportsAllDrives: "true" })}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, mimeType: FOLDER, parents: [parentId] }) },
      `Creating the folder ${name}…`
    );
    // Two clients may have created it at once; everyone settles on the oldest and the loser removes its copy.
    const all = (await this.children(parentId, ` and name = '${quote(name)}' and mimeType = '${FOLDER}'`)).sort(oldestFirst);
    const winner = all[0];
    if (winner && winner.id !== made.id) {
      await this.request(this.fileUrl(made.id), { method: "DELETE" }).catch(() => undefined);
      return winner.id;
    }
    return made.id;
  }

  private multipart(metadata: object, body: Uint8Array, mime: string): { type: string; blob: Blob } {
    const boundary = `stepup${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    const head = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`;
    return { type: `multipart/related; boundary=${boundary}`, blob: new Blob([head, body as BlobPart, `\r\n--${boundary}--`]) };
  }

  async write(_driveId: string, parentId: string, name: string, body: FileBody, options: WriteOptions = {}): Promise<StoredFile> {
    const key = `${parentId}/${name}`;
    let existing = await this.findRaw(parentId, name);
    if (!existing) {
      // Drive's search index lags behind writes, so a file we just made can be missing from the listing. Ask for it by id.
      const known = this.written.get(key);
      if (known) existing = await this.getLive(known).catch(() => undefined);
    }
    if (existing && options.createOnly) throw new StorageError("exists", `"${name}" already exists`);
    if (options.ifMatch) {
      // Listings can also be stale, so the comparison uses a direct (consistent) read of the file.
      const live = existing ? await this.getLive(existing.id).catch(() => undefined) : undefined;
      if (!live || tagOf(live) !== options.ifMatch) throw new StorageError("changed", `"${name}" changed since it was read`);
    }

    const mime = body instanceof Blob && body.type ? body.type : typeof body === "string" ? "text/plain; charset=utf-8" : "application/octet-stream";
    const metadata = existing ? {} : { name, parents: [parentId] };
    const size = bodySize(body);
    const label = `Uploading ${name}…`;
    const fields = `fields=${encodeURIComponent(FIELDS)}&supportsAllDrives=true`;
    const method = existing ? "PATCH" : "POST";
    const target = existing ? `/files/${encodeURIComponent(existing.id)}` : "/files";

    let stored: DriveFile;
    if (size <= GOOGLE_SIMPLE_UPLOAD_LIMIT) {
      const mp = this.multipart(metadata, await bodyBytes(body), mime);
      stored = await this.json<DriveFile>(`${UPLOAD}${target}?uploadType=multipart&${fields}`, { method, headers: { "Content-Type": mp.type }, body: mp.blob }, label);
    } else {
      stored = await this.resumable(`${UPLOAD}${target}?uploadType=resumable&${fields}`, method, metadata, await bodyBytes(body), mime, name);
    }

    if (!existing && options.createOnly) {
      // Drive allows duplicate names, so "create only" is settled afterwards: the oldest same-named file wins.
      const all = (await this.children(parentId, ` and name = '${quote(name)}'`)).sort(oldestFirst);
      if (all[0] && all[0].id !== stored.id) {
        await this.request(this.fileUrl(stored.id), { method: "DELETE" }).catch(() => undefined);
        throw new StorageError("exists", `"${name}" already exists`);
      }
    }
    this.written.set(key, stored.id);
    return { id: stored.id, name: stored.name, ...(tagOf(stored) ? { eTag: tagOf(stored) } : {}), ...(stored.size !== undefined ? { size: Number(stored.size) } : {}), ...(stored.webViewLink ? { webUrl: stored.webViewLink } : {}) };
  }

  private async resumable(url: string, method: string, metadata: object, bytes: Uint8Array, mime: string, name: string): Promise<DriveFile> {
    const init = await this.request(
      url,
      { method, headers: { "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Type": mime, "X-Upload-Content-Length": String(bytes.byteLength) }, body: JSON.stringify(metadata) },
      `Uploading ${name}…`
    );
    const session = init.headers.get("Location");
    if (!session) throw new Error(`Google Drive did not start an upload for "${name}"`);
    let last: DriveFile | undefined;
    await trackActivity(`Uploading ${name}…`, async (update) => {
      for (let start = 0; start < bytes.byteLength; start += GOOGLE_UPLOAD_CHUNK) {
        const end = Math.min(start + GOOGLE_UPLOAD_CHUNK, bytes.byteLength);
        update(`Uploading ${name} — ${Math.round((start / bytes.byteLength) * 100)}%`);
        const res = await this.putChunk(session, bytes.subarray(start, end), start, end - 1, bytes.byteLength);
        if (res) last = res;
      }
    });
    if (!last) throw new Error(`Upload of "${name}" finished without returning the file`);
    return last;
  }

  /** Sends one chunk to the pre-authorized session URL. 308 means "send more"; 200/201 carries the finished file. */
  private async putChunk(url: string, chunk: Uint8Array, first: number, last: number, total: number): Promise<DriveFile | undefined> {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchFn(url, { method: "PUT", headers: { "Content-Range": `bytes ${first}-${last}/${total}` }, body: chunk as BodyInit });
      } catch (err) {
        if (attempt >= this.maxRetries) throw err;
        await this.sleep(this.backoff(attempt));
        continue;
      }
      if (res.status === 308) return undefined;
      if (res.ok) return (await res.json()) as DriveFile;
      if ((res.status === 429 || res.status >= 500) && attempt < this.maxRetries) {
        await this.sleep(this.backoff(attempt, res));
        continue;
      }
      throw new GoogleDriveError(res.status, kindOf(res.status, ""), `Upload chunk failed with ${res.status}: ${await res.text().catch(() => "")}`);
    }
  }

  async rename(_driveId: string, itemId: string, name: string): Promise<string> {
    const self = await this.getLive(itemId);
    const parent = self.parents?.[0];
    if (parent) {
      const taken = await this.findRaw(parent, name);
      if (taken && taken.id !== itemId) throw new StorageError("exists", `"${name}" already exists`);
    }
    await this.json(this.fileUrl(itemId), { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) }, `Renaming to ${name}…`);
    return itemId; // Drive ids survive a rename
  }

  async remove(_driveId: string, itemId: string, ifMatch?: string): Promise<void> {
    if (ifMatch) {
      const current = await this.getLive(itemId);
      if (tagOf(current) !== ifMatch) throw new StorageError("changed", `"${current.name}" changed since it was read`);
    }
    // To the bin, like OneDrive's delete, so a mistake can be undone.
    await this.json(this.fileUrl(itemId), { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ trashed: true }) });
  }

  async appFolder(): Promise<AppFolder | undefined> {
    try {
      await this.json(`${API}/files/${APP_DATA}?fields=id`);
      return { driveId: GOOGLE_DRIVE, id: APP_DATA };
    } catch (err) {
      if (err instanceof StorageError && (err.kind === "not-found" || err.kind === "forbidden")) return undefined;
      throw err;
    }
  }

  async home(): Promise<FolderEntry> {
    return { driveId: GOOGLE_DRIVE, itemId: "root", name: "My Drive" };
  }

  async sharedWithMe(): Promise<FolderEntry[]> {
    const items = await this.query(`sharedWithMe = true and trashed = false and mimeType = '${FOLDER}'`, undefined, "Finding folders shared with you…");
    return items.map((f) => ({ driveId: GOOGLE_DRIVE, itemId: f.id, name: f.name })).sort((a, b) => a.name.localeCompare(b.name));
  }

  async subfolders(folder: FolderEntry): Promise<FolderEntry[]> {
    return (await this.children(folder.itemId))
      .filter(isFolderish)
      .map((f) => ({ driveId: GOOGLE_DRIVE, itemId: resolved(f).id, name: f.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async folderFromLink(link: string): Promise<FolderEntry> {
    const text = link.trim();
    const id = /\/folders\/([\w-]+)/.exec(text)?.[1] ?? /[?&]id=([\w-]+)/.exec(text)?.[1] ?? /\/d\/([\w-]+)/.exec(text)?.[1] ?? (/^[\w-]{20,}$/.test(text) ? text : undefined);
    if (!id) throw new Error("That does not look like a Google Drive folder link.");
    const f = resolved(await this.json<DriveFile>(this.fileUrl(id), {}, "Opening the shared link…"));
    if (f.mimeType !== FOLDER) throw new Error("That link is to a file. Share a folder link instead.");
    return { driveId: GOOGLE_DRIVE, itemId: f.id, name: f.name };
  }

  async invite(folder: FolderEntry, email: string, message?: string): Promise<void> {
    const address = email.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) throw new Error("Enter a valid email address.");
    const p = new URLSearchParams({ sendNotificationEmail: "true", supportsAllDrives: "true", ...(message ? { emailMessage: message } : {}) });
    await this.json(`${API}/files/${encodeURIComponent(folder.itemId)}/permissions?${p}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "user", role: "writer", emailAddress: address }),
    }, "Sending the invitation…");
  }
}
