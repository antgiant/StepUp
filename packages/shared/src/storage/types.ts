/**
 * Where the app keeps its files. Everything above this layer (the ledger, the workspace, the lock, uploads) talks to a
 * `StorageProvider`, so OneDrive, a plain folder on this computer, and (later) Google Drive are interchangeable.
 *
 * Addressing: an item is `(driveId, itemId)`. `driveId` names the space an item lives in (a OneDrive drive, a Google
 * shared drive, or "local" for a folder on this computer) and `itemId` is the provider's own id for it. Both are opaque:
 * persist them, never parse them.
 */

/** Something in a folder: a file or a sub-folder. */
export interface StorageEntry {
  id: string;
  name: string;
  isFolder: boolean;
  size?: number;
  /** Opaque version token that changes whenever the content does (OneDrive's ETag). Pass it back as `ifMatch`. */
  eTag?: string;
  /** A link a person can open in a browser, when the provider has one. */
  webUrl?: string;
  /** Last modified, ISO 8601. */
  modified?: string;
}

/** What a write returns: the file as stored. */
export interface StoredFile {
  id: string;
  name: string;
  eTag?: string;
  size?: number;
  webUrl?: string;
}

export type FileBody = string | Uint8Array | Blob;

export interface WriteOptions {
  /** Replace only if the file's current `eTag` still matches (optimistic concurrency); otherwise `StorageError("changed")`. */
  ifMatch?: string;
  /** Fail with `StorageError("exists")` instead of overwriting when a file with this name is already there. */
  createOnly?: boolean;
}

/** A folder a person can pick: enough to address it anywhere, including one shared with them. */
export interface FolderEntry {
  driveId: string;
  itemId: string;
  name: string;
}

/** Why a storage call failed, in terms every provider can produce. */
export type StorageErrorKind =
  /** No such file or folder. */
  | "not-found"
  /** `createOnly` (or a folder create) found the name already taken. */
  | "exists"
  /** `ifMatch` / a conditional delete found the item changed since it was read. */
  | "changed"
  /** The file is in use elsewhere (open in Excel) and cannot be written now. */
  | "locked"
  /** The signed-in person may not do this. */
  | "forbidden"
  /** The provider did not accept the request itself (a malformed id or name). */
  | "invalid"
  | "other";

export class StorageError extends Error {
  constructor(readonly kind: StorageErrorKind, message: string) {
    super(message);
  }
}

/** True when `err` is a `StorageError` of one of the given kinds (any kind when none are given). */
export function isStorageError(err: unknown, ...kinds: StorageErrorKind[]): err is StorageError {
  return err instanceof StorageError && (kinds.length === 0 || kinds.includes(err.kind));
}

/** Who is signed in to a provider. `id` is stable for the account (use it to key caches); `name` is for showing. */
export interface StorageAccount {
  id: string;
  name: string;
}

/**
 * How a person gets into a provider. It belongs to the provider (`StorageProvider.auth`), so choosing where files live
 * also chooses how to sign in: Microsoft sign-in for OneDrive, nothing at all for a folder on this device.
 */
export interface StorageAuth {
  /** Finishes a sign-in redirect that just happened and restores a remembered session. Undefined when nobody is signed in. */
  restore(): Promise<StorageAccount | undefined>;
  /** Starts signing in. May navigate away from the page. */
  signIn(): Promise<void>;
  /** Signs out. May navigate away from the page. */
  signOut(): Promise<void>;
  /** True when an earlier sign-in can be resumed without asking which account. */
  canAutoSignIn(): boolean;
  /** Signs in again as the remembered account. */
  autoSignIn(): Promise<void>;
}

/** Auth for storage that needs no sign-in: the one account is always signed in. */
export function noSignIn(account: StorageAccount): StorageAuth {
  return {
    restore: async () => account,
    signIn: async () => undefined,
    signOut: async () => undefined,
    canAutoSignIn: () => false,
    autoSignIn: async () => undefined,
  };
}

/** The folder a provider keeps private settings in (not the person's files). */
export type AppFolder = { driveId: string; id: string };

export interface StorageProvider {
  /** "browser" is storage inside this browser (IndexedDB); "local-folder" is a folder on this computer (command line). */
  readonly kind: "onedrive" | "browser" | "local-folder" | "memory";
  /** What to call it when talking to a person ("OneDrive", "this device"). */
  readonly label: string;
  /** How to sign in to it. */
  readonly auth: StorageAuth;

  // ---- reading the tree
  /** Every entry directly inside a folder (all pages). */
  list(driveId: string, folderId: string): Promise<StorageEntry[]>;
  /** A direct child by name; undefined when there is none. */
  find(driveId: string, parentId: string, name: string): Promise<StorageEntry | undefined>;
  /** One item's own details. */
  stat(driveId: string, itemId: string): Promise<StorageEntry>;
  /** The folder an item sits in. Throws when it has none (a root). */
  parentOf(driveId: string, itemId: string): Promise<string>;

  // ---- reading content
  readText(driveId: string, itemId: string): Promise<{ text: string; eTag?: string }>;
  /** A file's bytes. `label` describes the wait for progress displays. */
  download(driveId: string, itemId: string, label?: string): Promise<Blob>;

  // ---- changing things
  /** The id of the named child folder, creating it if needed (safe if two clients race to create it). */
  ensureFolder(driveId: string, parentId: string, name: string): Promise<string>;
  /** Creates or replaces `name` inside the folder. */
  write(driveId: string, parentId: string, name: string, body: FileBody, options?: WriteOptions): Promise<StoredFile>;
  /** Renames in place. Returns the item's id afterwards (providers that address by path may change it). `StorageError("exists")` if the name is taken. */
  rename(driveId: string, itemId: string, name: string): Promise<string>;
  /** Deletes (to the recycle bin where there is one). With `ifMatch`, only if the version still matches. */
  remove(driveId: string, itemId: string, ifMatch?: string): Promise<void>;

  // ---- places a person can choose from
  /** Private space for this app's own settings (such as which folder is in use), or undefined when there is none. */
  appFolder(): Promise<AppFolder | undefined>;
  /** The top of the person's own files. */
  home(): Promise<FolderEntry>;
  /** Folders other people have shared with the person (empty where sharing does not exist). */
  sharedWithMe(): Promise<FolderEntry[]>;
  /** Sub-folders only, following shortcuts to folders on other drives. */
  subfolders(folder: FolderEntry): Promise<FolderEntry[]>;
  /** Resolves a sharing link to a folder. Present only where links exist. */
  folderFromLink?(link: string): Promise<FolderEntry>;
  /** Invites a person by email to edit a folder. Present only where sharing exists. */
  invite?(folder: FolderEntry, email: string, message?: string): Promise<void>;
}

/** Folder names every provider must accept; rejecting the rest is the same everywhere so a folder made here opens anywhere. */
export function validateFolderName(name: string): string {
  const clean = name.trim();
  if (!clean || /[\\/:*?"<>|]/.test(clean)) throw new Error('Folder names cannot be empty or contain \\ / : * ? " < > |');
  return clean;
}

export const bodySize = (body: FileBody): number =>
  typeof body === "string" ? new TextEncoder().encode(body).byteLength : body instanceof Blob ? body.size : body.byteLength;

export async function bodyBytes(body: FileBody): Promise<Uint8Array> {
  if (typeof body === "string") return new TextEncoder().encode(body);
  return body instanceof Blob ? new Uint8Array(await body.arrayBuffer()) : body;
}

/** Creates (or returns the existing) subfolder of `parent`, with a name every provider accepts. */
export async function createSubfolder(storage: StorageProvider, parent: FolderEntry, name: string): Promise<FolderEntry> {
  const clean = validateFolderName(name);
  return { driveId: parent.driveId, itemId: await storage.ensureFolder(parent.driveId, parent.itemId, clean), name: clean };
}
