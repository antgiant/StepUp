import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";

const CACHE_FILE = path.resolve(process.cwd(), ".cache", "vendor-listing-cache.json");
const URL_PATTERN = /providerapi-prod\.stepupforstudents\.org\/api\/businesssummary\/getbusinesssummarydropdown/i;

export interface VendorEntry {
  id: string;
  businessProfileId: string;
  name: string;
  /** The categories (StepUp ids from the category tree) this provider was offered for: the list in "Who did you pay?" depends on the category chosen. */
  categoryIds?: string[];
}

const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const CATEGORY_CACHE = path.resolve(process.cwd(), ".cache", "category-tree-cache.json");

/** Ids in the category tree that appear in the request that fetched a provider list: that is the category the list was for. */
async function categoriesOfRequest(requestText: string): Promise<string[]> {
  const mentioned = new Set((requestText.match(GUID) ?? []).map((g) => g.toLowerCase()));
  if (mentioned.size === 0) return [];
  try {
    const tree = JSON.parse(await readFile(CATEGORY_CACHE, "utf-8")) as Record<string, unknown>;
    const known = new Set<string>();
    for (const level of ["categories", "types", "details"]) for (const id of Object.keys((tree[level] as Record<string, unknown>) ?? {})) known.add(id.toLowerCase());
    return [...mentioned].filter((id) => known.has(id));
  } catch {
    return [];
  }
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
      const request = response.request();
      const categoryIds = await categoriesOfRequest(`${request.url()}\n${request.postData() ?? ""}`);
      if (categoryIds.length === 0) console.log("\n[vendor listing] Could not tell which category this provider list was for; the names are kept without one.");
      for (const r of body.Results) {
        const had = cache[r.Id]?.categoryIds ?? [];
        cache[r.Id] = { id: r.Id, businessProfileId: r.BusinessProfileId, name: r.DBAName, categoryIds: [...new Set([...had, ...categoryIds])] };
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
