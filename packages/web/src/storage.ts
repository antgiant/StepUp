import { BrowserProvider, OneDriveProvider, indexedDbNodeStorage, type StorageProvider } from "@step-up/shared/web";
import { microsoftAuth } from "./auth.js";

/**
 * Where the person chose to keep their data: OneDrive (sign in with Microsoft) or "Local only" (inside this browser).
 * The choice is made on the first screen and remembered; switching it reloads the page, so the rest of the app simply
 * uses the one `storage` and never branches on which it is. Choosing a storage also chooses its sign-in (`storage.auth`).
 */
const MODE_KEY = "stepup.mode";

/** Only "local" is remembered: Microsoft is what you get when nothing is chosen, and signing in is its own memory. */
export type StorageChoice = "local";

export function chosenStorage(): StorageChoice | undefined {
  try {
    return localStorage.getItem(MODE_KEY) === "local" ? "local" : undefined;
  } catch {
    return undefined;
  }
}

/** Remembers the choice (`undefined` forgets it, so the first screen asks again) and starts over with that storage. */
export function switchStorage(choice: StorageChoice | undefined): void {
  try {
    if (choice) localStorage.setItem(MODE_KEY, choice);
    else localStorage.removeItem(MODE_KEY);
  } catch {
    /* storage unavailable: the choice lasts only until the page is reloaded */
  }
  location.reload();
}

async function openLocal(): Promise<StorageProvider> {
  // Ask the browser not to evict this data when space runs low (it may still decline).
  void navigator.storage?.persist?.().catch(() => undefined);
  return BrowserProvider.open(indexedDbNodeStorage("stepup-local"));
}

export const storage: StorageProvider = chosenStorage() === "local" ? await openLocal() : new OneDriveProvider(microsoftAuth);
