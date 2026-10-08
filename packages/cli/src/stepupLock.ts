import os from "node:os";
import { LockHeldError, LockLostError, SessionLock, parentOf, resolveShareLink } from "@step-up/shared";
import { getClientId } from "./clientId.js";
import { getSignedInName } from "./graph/auth.js";
import "./graph/client.js"; // registers the Node token provider

const HEARTBEAT_MS = 60_000;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name} (see .env.example).`);
  return value;
}

export interface HeldLock {
  /** Gives the lock back. Safe to call more than once. */
  release(): Promise<void>;
}

/**
 * StepUp does not cope with two people on one account, so before anything drives it the CLI takes a lock file in the
 * shared workspace folder (the parent of the year folders), kept alive by a heartbeat and removed on exit or Ctrl+C.
 * `--force-unlock` takes it over from someone who seems to hold it. Throws (with who and since when) if it is held.
 */
export async function acquireStepUpLock(): Promise<HeldLock> {
  const current = await resolveShareLink(requireEnv("ONEDRIVE_FILES_FOLDER_URL"));
  const rootId = await parentOf(current.driveId, current.itemId);
  const holder = { actor: await getSignedInName(), clientId: await getClientId(), machine: os.hostname() };
  const force = process.argv.includes("--force-unlock");

  let lock: SessionLock;
  try {
    lock = await SessionLock.acquire(current.driveId, rootId, holder, { force });
  } catch (err) {
    if (err instanceof LockHeldError) throw new Error(`StepUp is already in use.\n${err.message}`);
    throw err;
  }
  if (force) console.log("Took over the StepUp session lock (--force-unlock).");
  console.log(`StepUp session lock taken (${holder.actor} on ${holder.machine}).`);

  let released = false;
  const timer = setInterval(() => {
    lock.heartbeat().catch((err) => {
      if (err instanceof LockLostError) {
        console.error(`\n${err.message}`);
        clearInterval(timer);
      } else {
        console.warn(`(Could not refresh the StepUp lock: ${(err as Error).message}. Will try again.)`);
      }
    });
  }, HEARTBEAT_MS);
  timer.unref();

  const release = async () => {
    if (released) return;
    released = true;
    clearInterval(timer);
    await lock.release().catch((err) => console.warn(`(Could not remove the StepUp lock: ${(err as Error).message}. It will time out by itself in a few minutes.)`));
  };
  // Ctrl+C / terminal closed: give the lock back before leaving, so the other person is not locked out for the time-out.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(signal, () => void release().finally(() => process.exit(130)));
  }
  return { release };
}
