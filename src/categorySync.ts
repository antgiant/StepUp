import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { appendTableRows, getTableHeaderRow, getTableRows, type DriveItemRef } from "./graph/onedrive.js";

const TABLE5 = "Table5";
const THROTTLE_MS = 24 * 60 * 60 * 1000;
const CACHE_FILE = path.resolve(process.cwd(), ".cache", "category-tree-cache.json");
const SEARCH_PATTERN = /reimbursementapi-prod\.stepupforstudents\.org\/api\/categories\/search/i;
const TYPES_PATTERN = /reimbursementapi-prod\.stepupforstudents\.org\/api\/categories\/typesbyids/i;
const DETAILS_PATTERN = /reimbursementapi-prod\.stepupforstudents\.org\/api\/categories\/detailsbyids/i;
const CHUNK_SIZE = 50;
const DELAY_BETWEEN_CHUNKS_MS = 400;

export interface CachedNode {
  name: string;
  isActive: boolean;
  isDeleted: boolean;
  /** IDs of this node's children (Types for a Category, Details for a Type), if known. */
  childIds?: string[];
}

export interface Cache {
  lastSyncAt: number;
  categories: Record<string, CachedNode>;
  types: Record<string, CachedNode>;
  details: Record<string, CachedNode>;
}

function emptyCache(): Cache {
  return { lastSyncAt: 0, categories: {}, types: {}, details: {} };
}

async function loadCache(): Promise<Cache> {
  try {
    return { ...emptyCache(), ...JSON.parse(await readFile(CACHE_FILE, "utf-8")) };
  } catch {
    return emptyCache();
  }
}

async function saveCache(cache: Cache): Promise<void> {
  await mkdir(path.dirname(CACHE_FILE), { recursive: true });
  await writeFile(CACHE_FILE, JSON.stringify(cache), "utf-8");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

/** Builds every reconstructable "Category - Type - Detail" path from whatever's been observed so far. */
export function buildPathsFromCache(cache: Cache): string[] {
  const paths: string[] = [];
  for (const category of Object.values(cache.categories)) {
    if (!category.isActive || category.isDeleted) continue;
    const typeIds = category.childIds ?? [];
    const activeTypes = typeIds.map((id) => cache.types[id]).filter((t): t is CachedNode => Boolean(t?.isActive && !t.isDeleted));

    if (typeIds.length === 0) {
      paths.push(category.name);
      continue;
    }
    for (const type of activeTypes) {
      const detailIds = type.childIds ?? [];
      const activeDetails = detailIds
        .map((id) => cache.details[id])
        .filter((d): d is CachedNode => Boolean(d?.isActive && !d.isDeleted));
      if (detailIds.length === 0) {
        paths.push(`${category.name} - ${type.name}`);
        continue;
      }
      for (const detail of activeDetails) {
        paths.push(`${category.name} - ${type.name} - ${detail.name}`);
      }
    }
  }
  return [...new Set(paths)];
}

/** Adds any category paths missing from Table5. Never deletes — just reports what's no longer found upstream. */
async function syncCategoriesTable(excelRef: DriveItemRef, freshPaths: string[]): Promise<{ added: string[] }> {
  const rows = await getTableRows(excelRef, TABLE5);
  const existing = new Set(rows.map((r) => String(r[0] ?? "").trim()).filter(Boolean));
  const toAdd = freshPaths.filter((p) => !existing.has(p));
  if (toAdd.length > 0) {
    await appendTableRows(excelRef, TABLE5, toAdd.map((p) => [p]));
  }
  return { added: toAdd };
}

async function reportAndSync(excelRef: DriveItemRef, cache: Cache, label: string): Promise<void> {
  const paths = buildPathsFromCache(cache);
  const { added } = await syncCategoriesTable(excelRef, paths);
  console.log(
    `\n[category sync] (${label}) ${paths.length} path(s) from ${Object.keys(cache.categories).length} categories / ` +
      `${Object.keys(cache.types).length} types / ${Object.keys(cache.details).length} details. Added ${added.length} new one(s) to Table5.`
  );
  if (added.length > 0) added.forEach((p) => console.log(`  + ${p}`));
}

/**
 * Attaches everything needed to keep Table5 (Categories) current:
 *  - The `search` response already returns the complete top-level category list in one call, so
 *    it's just captured passively whenever it naturally loads.
 *  - `typesbyids`/`detailsbyids` only return whatever narrow set of IDs the real UI happened to
 *    ask for (e.g. one category's types after you click it) — and we can't call these endpoints
 *    ourselves from scratch, since they need an auth token only the page's own JS has. So instead,
 *    once per 24h, the first time either fires naturally (from your manual clicks, or from our own
 *    fillCategory() automation during a real submission), we intercept it and use route.fetch() to
 *    fire an *additional* out-of-band request asking for every ID we know about so far — reusing
 *    that request's real auth — chunked and lightly throttled between chunks. The original request
 *    is always left completely untouched (route.continue()), so the page's own UI never sees
 *    anything different; we're just piggybacking extra data collection onto a click that was
 *    going to happen anyway.
 */
export function attachCategoryTreeListener(page: Page, excelRef: DriveItemRef): void {
  let dueThisSessionPromise: Promise<boolean> | undefined;
  const isDueThisSession = () => {
    if (!dueThisSessionPromise) {
      dueThisSessionPromise = loadCache().then((cache) => Date.now() - cache.lastSyncAt >= THROTTLE_MS);
    }
    return dueThisSessionPromise;
  };

  page.on("response", async (response) => {
    if (!SEARCH_PATTERN.test(response.url())) return;
    try {
      const cache = await loadCache();
      const body = (await response.json()) as {
        Results: Array<{ Id: string; Name: string; Types: string[]; IsActive: boolean; IsDeleted: boolean }>;
      };
      for (const c of body.Results) {
        cache.categories[c.Id] = { name: c.Name, isActive: c.IsActive, isDeleted: c.IsDeleted, childIds: c.Types };
      }
      await saveCache(cache);
    } catch (err) {
      console.log(`\n[category sync] Failed to process categories/search: ${(err as Error).message}`);
    }
  });

  page.route(TYPES_PATTERN, async (route) => {
    try {
      if (!(await isDueThisSession())) {
        await route.continue();
        return;
      }
      const cache = await loadCache();
      const originalIds = JSON.parse(route.request().postData() ?? "[]") as string[];
      const allKnownTypeIds = [...new Set(Object.values(cache.categories).flatMap((c) => c.childIds ?? []))];
      const idsToFetch = [...new Set([...allKnownTypeIds, ...originalIds])];

      for (const batch of chunk(idsToFetch, CHUNK_SIZE)) {
        const response = await route.fetch({ postData: JSON.stringify(batch) });
        if (response.ok()) {
          const data = (await response.json()) as Array<{
            id: string;
            name: string;
            details?: string[];
            isActive: boolean;
            isDeleted: boolean;
          }>;
          for (const t of data) {
            cache.types[t.id] = { name: t.name, isActive: t.isActive, isDeleted: t.isDeleted, childIds: t.details };
          }
        }
        await sleep(DELAY_BETWEEN_CHUNKS_MS);
      }

      cache.lastSyncAt = Date.now();
      await saveCache(cache);
      await reportAndSync(excelRef, cache, "types expanded");
    } catch (err) {
      console.log(`\n[category sync] typesbyids expansion failed: ${(err as Error).message}`);
    } finally {
      await route.continue();
    }
  });

  page.route(DETAILS_PATTERN, async (route) => {
    try {
      if (!(await isDueThisSession())) {
        await route.continue();
        return;
      }
      const cache = await loadCache();
      const originalIds = JSON.parse(route.request().postData() ?? "[]") as string[];
      const allKnownDetailIds = [...new Set(Object.values(cache.types).flatMap((t) => t.childIds ?? []))];
      const idsToFetch = [...new Set([...allKnownDetailIds, ...originalIds])];

      for (const batch of chunk(idsToFetch, CHUNK_SIZE)) {
        const response = await route.fetch({ postData: JSON.stringify(batch) });
        if (response.ok()) {
          const data = (await response.json()) as Array<{ id: string; name: string; isActive: boolean; isDeleted: boolean }>;
          for (const d of data) {
            cache.details[d.id] = { name: d.name, isActive: d.isActive, isDeleted: d.isDeleted };
          }
        }
        await sleep(DELAY_BETWEEN_CHUNKS_MS);
      }

      cache.lastSyncAt = Date.now();
      await saveCache(cache);
      await reportAndSync(excelRef, cache, "details expanded");
    } catch (err) {
      console.log(`\n[category sync] detailsbyids expansion failed: ${(err as Error).message}`);
    } finally {
      await route.continue();
    }
  });
}
