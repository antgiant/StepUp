import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import {
  appendTableRows,
  getTableHeaderRow,
  getTableRows,
  updateTableRowByIndex,
  type DriveItemRef,
} from "./graph/onedrive.js";

const TABLE5 = "Table5";
const THROTTLE_MS = 24 * 60 * 60 * 1000;
const CACHE_FILE = path.resolve(process.cwd(), ".cache", "category-tree-cache.json");
const SEARCH_PATTERN = /reimbursementapi-prod\.stepupforstudents\.org\/api\/categories\/search/i;
const TYPES_PATTERN = /reimbursementapi-prod\.stepupforstudents\.org\/api\/categories\/typesbyids/i;
const DETAILS_PATTERN = /reimbursementapi-prod\.stepupforstudents\.org\/api\/categories\/detailsbyids/i;
const CHUNK_SIZE = 50;
const DELAY_BETWEEN_CHUNKS_MS = 400;

/**
 * StepUp's internal scholarship program codes (e.g. "fesua"), mapped to the human label used
 * elsewhere in the spreadsheet (Table2's "Scholarship" column). Seeded with the one we've
 * directly confirmed (via real Pre-Auth API data: PartnerId "24" / code "fesua" == "FES-UA");
 * any other code encountered falls back to its own raw uppercased form rather than guessing.
 */
const KNOWN_SCHOLARSHIP_NAMES: Record<string, string> = {
  fesua: "FES-UA",
};

function scholarshipDisplayName(code: string): string {
  return KNOWN_SCHOLARSHIP_NAMES[code.toLowerCase()] ?? code.toUpperCase();
}

/** Loosely compares a Table2-style label ("FES-UA") against a resolved display name, ignoring punctuation/case. */
export function scholarshipNamesMatch(a: string, b: string): boolean {
  const normalize = (s: string) => s.replace(/[^a-z0-9]/gi, "").toUpperCase();
  return normalize(a) === normalize(b);
}

export interface CachedNode {
  name: string;
  isActive: boolean;
  isDeleted: boolean;
  /** IDs of this node's children (Types for a Category, Details for a Type), if known. */
  childIds?: string[];
  /** StepUp's PartnerId codes (e.g. "24") this node is approved for, if known. */
  partnerIds?: string[];
}

export interface Cache {
  lastSyncAt: number;
  categories: Record<string, CachedNode>;
  types: Record<string, CachedNode>;
  details: Record<string, CachedNode>;
  /** PartnerId -> StepUp's internal program code text (e.g. "24" -> "fesua"), learned opportunistically. */
  partnerCodes: Record<string, string>;
}

function emptyCache(): Cache {
  return { lastSyncAt: 0, categories: {}, types: {}, details: {}, partnerCodes: {} };
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

export interface CategoryPathEntry {
  path: string;
  /** Human-readable scholarship names (e.g. "FES-UA") this path is eligible for, if known. */
  scholarships: string[];
}

/**
 * Builds every reconstructable "Category - Type - Detail" path from whatever's been observed so
 * far, each tagged with the scholarship(s) it's eligible for — resolved from the *deepest*
 * available node in that path (Detail if present, else Type, else the Category itself), since
 * that's the level StepUp actually attaches `approvedPrograms` to for a fully-specified path.
 */
export function buildPathEntriesFromCache(cache: Cache): CategoryPathEntry[] {
  const resolve = (partnerIds: string[] | undefined): string[] =>
    [...new Set((partnerIds ?? []).map((id) => scholarshipDisplayName(cache.partnerCodes[id] ?? id)))].sort();

  const merged = new Map<string, Set<string>>();
  const addEntry = (path: string, scholarships: string[]) => {
    const set = merged.get(path) ?? new Set<string>();
    scholarships.forEach((s) => set.add(s));
    merged.set(path, set);
  };

  for (const category of Object.values(cache.categories)) {
    if (!category.isActive || category.isDeleted) continue;
    const typeIds = category.childIds ?? [];
    const activeTypes = typeIds.map((id) => cache.types[id]).filter((t): t is CachedNode => Boolean(t?.isActive && !t.isDeleted));

    if (typeIds.length === 0) {
      addEntry(category.name, resolve(category.partnerIds));
      continue;
    }
    for (const type of activeTypes) {
      const detailIds = type.childIds ?? [];
      const activeDetails = detailIds
        .map((id) => cache.details[id])
        .filter((d): d is CachedNode => Boolean(d?.isActive && !d.isDeleted));
      if (detailIds.length === 0) {
        addEntry(`${category.name} - ${type.name}`, resolve(type.partnerIds));
        continue;
      }
      for (const detail of activeDetails) {
        addEntry(`${category.name} - ${type.name} - ${detail.name}`, resolve(detail.partnerIds));
      }
    }
  }
  return [...merged.entries()].map(([path, scholarships]) => ({ path, scholarships: [...scholarships].sort() }));
}

/**
 * Adds any category paths missing from Table5, and backfills "Eligible Scholarships" on existing
 * rows whose value is now known but wasn't previously recorded. Never deletes or overwrites a
 * non-blank eligibility value — just reports what's no longer found upstream.
 */
async function syncCategoriesTable(
  excelRef: DriveItemRef,
  entries: CategoryPathEntry[]
): Promise<{ added: string[]; updated: string[] }> {
  const headers = await getTableHeaderRow(excelRef, TABLE5);
  const rows = await getTableRows(excelRef, TABLE5);
  const eligibleIdx = headers.indexOf("Eligible Scholarships");

  const existingByPath = new Map<string, { rowIndex: number; values: unknown[] }>();
  rows.forEach((values, rowIndex) => {
    const p = String(values[0] ?? "").trim();
    if (p) existingByPath.set(p, { rowIndex, values });
  });

  const toAdd: CategoryPathEntry[] = [];
  const toUpdate: Array<{ rowIndex: number; values: unknown[]; path: string; scholarships: string }> = [];

  for (const entry of entries) {
    const scholarships = entry.scholarships.join(", ");
    const existing = existingByPath.get(entry.path);
    if (!existing) {
      toAdd.push(entry);
      continue;
    }
    if (eligibleIdx === -1 || !scholarships) continue;
    const current = String(existing.values[eligibleIdx] ?? "").trim();
    if (!current && scholarships) {
      toUpdate.push({ rowIndex: existing.rowIndex, values: existing.values, path: entry.path, scholarships });
    }
  }

  if (toAdd.length > 0) {
    await appendTableRows(excelRef, TABLE5, toAdd.map((e) => [e.path, e.scholarships.join(", ")]));
  }
  for (const u of toUpdate) {
    await updateTableRowByIndex(excelRef, TABLE5, u.rowIndex, u.values, headers, {
      "Eligible Scholarships": u.scholarships,
    });
  }

  return { added: toAdd.map((e) => e.path), updated: toUpdate.map((u) => u.path) };
}

async function reportAndSync(excelRef: DriveItemRef, cache: Cache, label: string): Promise<void> {
  const entries = buildPathEntriesFromCache(cache);
  const { added, updated } = await syncCategoriesTable(excelRef, entries);
  console.log(
    `\n[category sync] (${label}) ${entries.length} path(s) from ${Object.keys(cache.categories).length} categories / ` +
      `${Object.keys(cache.types).length} types / ${Object.keys(cache.details).length} details. ` +
      `Added ${added.length} new, backfilled eligibility on ${updated.length} existing row(s).`
  );
  if (added.length > 0) added.forEach((p) => console.log(`  + ${p}`));
  if (updated.length > 0) updated.forEach((p) => console.log(`  ~ ${p}`));
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
        Results: Array<{
          Id: string;
          Name: string;
          Types: string[];
          IsActive: boolean;
          IsDeleted: boolean;
          ApprovedPrograms?: Array<{ PartnerId: string }>;
        }>;
      };
      for (const c of body.Results) {
        cache.categories[c.Id] = {
          name: c.Name,
          isActive: c.IsActive,
          isDeleted: c.IsDeleted,
          childIds: c.Types,
          partnerIds: (c.ApprovedPrograms ?? []).map((p) => String(p.PartnerId)),
        };
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
            approvedPrograms?: Array<{ partnerId: string; programType: string }>;
          }>;
          for (const t of data) {
            cache.types[t.id] = {
              name: t.name,
              isActive: t.isActive,
              isDeleted: t.isDeleted,
              childIds: t.details,
              partnerIds: (t.approvedPrograms ?? []).map((p) => p.partnerId),
            };
            for (const p of t.approvedPrograms ?? []) {
              if (p.partnerId && p.programType) cache.partnerCodes[p.partnerId] = p.programType;
            }
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
          const data = (await response.json()) as Array<{
            id: string;
            name: string;
            isActive: boolean;
            isDeleted: boolean;
            approvedPrograms?: Array<{ partnerId: string; programType: string }>;
          }>;
          for (const d of data) {
            cache.details[d.id] = {
              name: d.name,
              isActive: d.isActive,
              isDeleted: d.isDeleted,
              partnerIds: (d.approvedPrograms ?? []).map((p) => p.partnerId),
            };
            for (const p of d.approvedPrograms ?? []) {
              if (p.partnerId && p.programType) cache.partnerCodes[p.partnerId] = p.programType;
            }
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
