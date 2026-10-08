import { GraphError } from "../graph/client.js";
import { deleteItem, findChild, readTextFile, writeFile } from "../graph/files.js";

/** StepUp does not cope with two people (or two sessions) on one account, so only one CLI may drive it at a time. */
export const LOCK_FILE = "stepup-session.lock.json";

export interface LockHolder {
  /** Who is using it (their Microsoft account). */
  actor: string;
  /** Which install. */
  clientId: string;
  machine: string;
}

interface LockFile {
  holder: LockHolder;
  startedAt: string;
  heartbeatAt: string;
  ttlMs: number;
}

export interface LockOptions {
  /** How long without a heartbeat before the lock counts as abandoned (a crashed or sleeping CLI). Default 5 minutes. */
  ttlMs?: number;
  /** Take the lock even though someone appears to hold it (they will find out at their next heartbeat). */
  force?: boolean;
  now?: () => number;
}

/** Someone else holds the lock and has been seen recently. */
export class LockHeldError extends Error {
  constructor(readonly holder: LockHolder, readonly startedAt: string, readonly heartbeatAt: string, readonly idleMs: number) {
    super(
      `${holder.actor} is using StepUp from ${holder.machine} (started ${startedAt.replace("T", " ").slice(0, 16)}, last seen ${Math.max(0, Math.round(idleMs / 1000))} s ago). ` +
        `StepUp does not like two users at once. Ask them to finish, wait for it to time out, or re-run with --force-unlock if you are sure it is a leftover.`
    );
  }
}

/** Our heartbeat found the lock changed under us (someone forced it, or we were asleep too long). */
export class LockLostError extends Error {
  constructor() {
    super("The StepUp session lock was taken over by someone else. Stop filing now and check with them before continuing.");
  }
}

const parse = (text: string): LockFile | undefined => {
  try {
    const f = JSON.parse(text) as LockFile;
    return f?.holder && typeof f.heartbeatAt === "string" ? f : undefined;
  } catch {
    return undefined;
  }
};

/**
 * A lock file in the shared workspace folder. Taking it is a create-only upload, so two people starting at once cannot
 * both succeed; a lock whose heartbeat stopped is taken over with an ETag-checked replace. Advisory: the human is still
 * the real safeguard, this just stops an accidental second session.
 */
export class SessionLock {
  private constructor(
    private readonly driveId: string,
    private readonly rootId: string,
    private readonly holder: LockHolder,
    private readonly startedAt: string,
    private readonly ttlMs: number,
    private readonly now: () => number,
    private itemId: string,
    private eTag: string | undefined
  ) {}

  static async acquire(driveId: string, rootId: string, holder: LockHolder, options: LockOptions = {}): Promise<SessionLock> {
    const now = options.now ?? Date.now;
    const ttlMs = options.ttlMs ?? 5 * 60_000;
    const startedAt = new Date(now()).toISOString();
    const body = (): string => JSON.stringify({ holder, startedAt, heartbeatAt: new Date(now()).toISOString(), ttlMs } satisfies LockFile);

    try {
      const made = await writeFile(driveId, rootId, LOCK_FILE, body(), { createOnly: true });
      return new SessionLock(driveId, rootId, holder, startedAt, ttlMs, now, made.id, made.eTag);
    } catch (err) {
      if (!(err instanceof GraphError && err.status === 409)) throw err;
    }

    const existing = await findChild(driveId, rootId, LOCK_FILE);
    if (!existing) return SessionLock.acquire(driveId, rootId, holder, options); // released in between: try again
    const { text, eTag } = await readTextFile(driveId, existing.id);
    const current = parse(text);
    const idleMs = current ? now() - Date.parse(current.heartbeatAt) : Infinity;
    const ours = current?.holder.clientId === holder.clientId;
    const stale = !current || idleMs > (current.ttlMs ?? ttlMs);
    if (current && !stale && !ours && !options.force) throw new LockHeldError(current.holder, current.startedAt, current.heartbeatAt, idleMs);

    try {
      const taken = await writeFile(driveId, rootId, LOCK_FILE, body(), { ifMatch: eTag });
      return new SessionLock(driveId, rootId, holder, startedAt, ttlMs, now, taken.id, taken.eTag);
    } catch (err) {
      if (err instanceof GraphError && (err.status === 412 || err.status === 409) && current) throw new LockHeldError(current.holder, current.startedAt, current.heartbeatAt, idleMs);
      throw err;
    }
  }

  /** Shows we are still here. Throws `LockLostError` if the lock is no longer ours. */
  async heartbeat(): Promise<void> {
    try {
      const next = await writeFile(this.driveId, this.rootId, LOCK_FILE, JSON.stringify({ holder: this.holder, startedAt: this.startedAt, heartbeatAt: new Date(this.now()).toISOString(), ttlMs: this.ttlMs } satisfies LockFile), { ifMatch: this.eTag });
      this.eTag = next.eTag;
      this.itemId = next.id;
    } catch (err) {
      if (err instanceof GraphError && (err.status === 412 || err.status === 409)) throw new LockLostError();
      throw err;
    }
  }

  /** Lets go, but only if the lock is still ours. */
  async release(): Promise<void> {
    try {
      await deleteItem(this.driveId, this.itemId, this.eTag);
    } catch (err) {
      if (err instanceof GraphError && [404, 412].includes(err.status)) return; // already gone, or no longer ours
      throw err;
    }
  }
}
