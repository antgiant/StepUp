import { BrowserProvider, GoogleDriveProvider, OneDriveProvider, indexedDbNodeStorage, type StorageProvider } from "@step-up/shared/web";
import { microsoftAuth } from "./auth.js";
import { googleAuth, googleConfigured } from "./googleAuth.js";

/**
 * Where the person chose to keep their data: OneDrive (sign in with Microsoft), Google Drive, or "Local only" (inside
 * this browser). The choice is made on the first screen and remembered; switching it reloads the page, so the rest of the
 * app simply uses the one `storage` and never branches on which it is. Choosing a storage also chooses its sign-in
 * (`storage.auth`).
 */
const MODE_KEY = "stepup.mode";

/** Only the non-default choices are remembered: Microsoft is what you get when nothing is chosen, and its sign-in is its own memory. */
export type StorageChoice = "local" | "google";

export function chosenStorage(): StorageChoice | undefined {
  try {
    const v = localStorage.getItem(MODE_KEY);
    return v === "local" || (v === "google" && googleConfigured) ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Remembers the choice (`undefined` forgets it, so the first screen asks again) without leaving the page. */
export function rememberStorage(choice: StorageChoice | undefined): void {
  try {
    if (choice) localStorage.setItem(MODE_KEY, choice);
    else localStorage.removeItem(MODE_KEY);
  } catch {
    /* storage unavailable: the choice lasts only until the page is reloaded */
  }
}

/** Remembers the choice and starts over with that storage. */
export function switchStorage(choice: StorageChoice | undefined): void {
  rememberStorage(choice);
  location.reload();
}

async function openLocal(): Promise<StorageProvider> {
  // Ask the browser not to evict this data when space runs low (it may still decline).
  void navigator.storage?.persist?.().catch(() => undefined);
  return BrowserProvider.open(indexedDbNodeStorage("stepup-local"));
}

const choice = chosenStorage();
export const storage: StorageProvider = choice === "local" ? await openLocal() : choice === "google" ? new GoogleDriveProvider(googleAuth) : new OneDriveProvider(microsoftAuth);
