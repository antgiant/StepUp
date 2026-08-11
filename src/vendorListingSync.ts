import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";

const CACHE_FILE = path.resolve(process.cwd(), ".cache", "vendor-listing-cache.json");
const URL_PATTERN = /providerapi-prod\.stepupforstudents\.org\/api\/businesssummary\/getbusinesssummarydropdown/i;

export interface VendorEntry {
  id: string;
  businessProfileId: string;
  name: string;
}

async function loadCache(): Promise<Record<string, VendorEntry>> {
  try {
    return JSON.parse(await readFile(CACHE_FILE, "utf-8"));
  } catch {
    return {};
  }
}

async function saveCache(cache: Record<string, VendorEntry>): Promise<void> {
  await mkdir(path.dirname(CACHE_FILE), { recursive: true });
  await writeFile(CACHE_FILE, JSON.stringify(cache), "utf-8");
}

/**
 * Passively accumulates known vendor/provider names from the "Who did you pay?" dropdown's own
 * API responses (`getbusinesssummarydropdown`) whenever they naturally load during real
 * navigation — the same technique as statusSync/categorySync. Coverage grows across sessions as
 * different pages/searches happen to fire; there's no "get everything in one call" shortcut here
 * since this endpoint is a paginated keyword search, not an ID-batch lookup.
 */
export function attachVendorListingListener(page: Page): void {
  page.on("response", async (response) => {
    if (!URL_PATTERN.test(response.url())) return;
    try {
      const body = (await response.json()) as {
        Results?: Array<{ Id: string; BusinessProfileId: string; DBAName: string }>;
      };
      if (!body.Results || body.Results.length === 0) return;

      const cache = await loadCache();
      for (const r of body.Results) {
        cache[r.Id] = { id: r.Id, businessProfileId: r.BusinessProfileId, name: r.DBAName };
      }
      await saveCache(cache);
      console.log(`\n[vendor listing] Now know ${Object.keys(cache).length} vendor(s)/provider(s) total (from ${body.Results.length} in this response).`);
    } catch (err) {
      console.log(`\n[vendor listing] Failed to process response: ${(err as Error).message}`);
    }
  });
}

/** Reads back the accumulated set of known vendor/provider display names. */
export async function getKnownVendorNames(): Promise<Set<string>> {
  const cache = await loadCache();
  return new Set(Object.values(cache).map((v) => v.name));
}
