import type { ReferenceNode } from "../reference/categories.js";
import type { StorageProvider } from "../storage/types.js";

/**
 * What can be learned about StepUp from its own API responses as a person uses its site: the category -> type -> detail
 * tree and the providers offered in "Who did you pay?". Pure and environment-agnostic: the command line (Playwright), the
 * bookmarklet agent (in StepUp's page) and the web app (which keeps the result) all use these functions.
 */

export interface CachedNode {
  name: string;
  isActive: boolean;
  isDeleted: boolean;
  /** IDs of this node's children (Types for a Category, Details for a Type), if known. */
  childIds?: string[];
  /** StepUp's PartnerId codes (e.g. "24") this node is approved for, if known. */
  partnerIds?: string[];
}

export interface CategoryCache {
  /** When the types and details were last expanded (milliseconds since 1970); 0 = never. */
  lastSyncAt: number;
  categories: Record<string, CachedNode>;
  types: Record<string, CachedNode>;
  details: Record<string, CachedNode>;
  /** PartnerId -> StepUp's internal program code text (e.g. "24" -> "fesua"), learned opportunistically. */
  partnerCodes: Record<string, string>;
}

export const emptyCategoryCache = (): CategoryCache => ({ lastSyncAt: 0, categories: {}, types: {}, details: {}, partnerCodes: {} });

/** The full cache from whatever was saved (a partial or older file is filled in; nonsense gives an empty cache). */
export function categoryCacheFrom(saved: unknown): CategoryCache {
  const base = emptyCategoryCache();
  if (!saved || typeof saved !== "object") return base;
  const s = saved as Partial<CategoryCache>;
  return {
    lastSyncAt: typeof s.lastSyncAt === "number" ? s.lastSyncAt : 0,
    categories: { ...(s.categories ?? {}) },
    types: { ...(s.types ?? {}) },
    details: { ...(s.details ?? {}) },
    partnerCodes: { ...(s.partnerCodes ?? {}) },
  };
}

/** StepUp's internal program codes mapped to the label used elsewhere. Only the ones seen in real data; others show uppercased. */
const KNOWN_SCHOLARSHIP_NAMES: Record<string, string> = { fesua: "FES-UA" };
export const scholarshipDisplayName = (code: string): string => KNOWN_SCHOLARSHIP_NAMES[code.toLowerCase()] ?? code.toUpperCase();

/** StepUp's endpoints this learns from (matched against a request's full URL). */
export const STEPUP_PATTERNS = {
  reimbursementsSearch: /reimbursementapi-prod\.stepupforstudents\.org\/api\/reimbursements\/V2\/search/i,
  categoriesSearch: /reimbursementapi-prod\.stepupforstudents\.org\/api\/categories\/search/i,
  categoryTypes: /reimbursementapi-prod\.stepupforstudents\.org\/api\/categories\/typesbyids/i,
  categoryDetails: /reimbursementapi-prod\.stepupforstudents\.org\/api\/categories\/detailsbyids/i,
  vendorDropdown: /providerapi-prod\.stepupforstudents\.org\/api\/businesssummary\/getbusinesssummarydropdown/i,
} as const;

interface CategorySearchBody {
  Results: Array<{ Id: string; Name: string; Types: string[]; IsActive: boolean; IsDeleted: boolean; ApprovedPrograms?: Array<{ PartnerId: string }> }>;
}
interface ByIdsItem {
  id: string;
  name: string;
  details?: string[];
  isActive: boolean;
  isDeleted: boolean;
  approvedPrograms?: Array<{ partnerId: string; programType: string }>;
}

/** Top-level categories from `categories/search` (it returns the whole list in one response). Returns how many were read. */
export function mergeCategorySearch(cache: CategoryCache, body: unknown): number {
  const results = (body as Partial<CategorySearchBody> | null)?.Results;
  if (!Array.isArray(results)) return 0;
  for (const c of results) {
    cache.categories[c.Id] = {
      name: c.Name,
      isActive: c.IsActive,
      isDeleted: c.IsDeleted,
      childIds: c.Types,
      partnerIds: (c.ApprovedPrograms ?? []).map((p) => String(p.PartnerId)),
    };
  }
  return results.length;
}

function notePartners(cache: CategoryCache, items: ByIdsItem[]): void {
  for (const x of items) for (const p of x.approvedPrograms ?? []) if (p.partnerId && p.programType) cache.partnerCodes[p.partnerId] = p.programType;
}

/** Types from `typesbyids` (an array of items for the ids asked about). */
export function mergeTypes(cache: CategoryCache, data: unknown): number {
  if (!Array.isArray(data)) return 0;
  const items = data as ByIdsItem[];
  for (const t of items) {
    cache.types[t.id] = { name: t.name, isActive: t.isActive, isDeleted: t.isDeleted, childIds: t.details, partnerIds: (t.approvedPrograms ?? []).map((p) => p.partnerId) };
  }
  notePartners(cache, items);
  return items.length;
}

/** Details from `detailsbyids`. */
export function mergeDetails(cache: CategoryCache, data: unknown): number {
  if (!Array.isArray(data)) return 0;
  const items = data as ByIdsItem[];
  for (const d of items) {
    cache.details[d.id] = { name: d.name, isActive: d.isActive, isDeleted: d.isDeleted, partnerIds: (d.approvedPrograms ?? []).map((p) => p.partnerId) };
  }
  notePartners(cache, items);
  return items.length;
}

/** Type ids worth asking for: every one a known category lists, plus whatever the page itself asked about. */
export const typeIdsToExpand = (cache: CategoryCache, requested: string[] = []): string[] =>
  [...new Set([...Object.values(cache.categories).flatMap((c) => c.childIds ?? []), ...requested])];

/** Detail ids worth asking for: every one a known type lists, plus whatever the page itself asked about. */
export const detailIdsToExpand = (cache: CategoryCache, requested: string[] = []): string[] =>
  [...new Set([...Object.values(cache.types).flatMap((t) => t.childIds ?? []), ...requested])];

/** Whether the once-a-day expansion of types and details is due. */
export const expansionDue = (cache: CategoryCache, now: number, everyMs = 24 * 60 * 60 * 1000): boolean => now - cache.lastSyncAt >= everyMs;

export function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** The observed tree as shared-tree nodes (what the web app's reference and the ledger's category edits are made of). */
export function nodesFromCategoryCache(cache: CategoryCache): ReferenceNode[] {
  const parentOf = new Map<string, string>();
  for (const level of [cache.categories, cache.types]) {
    for (const [id, node] of Object.entries(level)) for (const child of node.childIds ?? []) parentOf.set(child, id);
  }
  const scholarships = (n: CachedNode) => [...new Set((n.partnerIds ?? []).map((id) => scholarshipDisplayName(cache.partnerCodes[id] ?? id)))].sort();
  const make = (id: string, n: CachedNode): ReferenceNode => ({
    id,
    ...(parentOf.has(id) ? { parentId: parentOf.get(id)! } : {}),
    name: n.name,
    isActive: n.isActive && !n.isDeleted,
    eligibleScholarships: scholarships(n),
    requiresServiceDate: false,
  });
  return [cache.categories, cache.types, cache.details].flatMap((level) => Object.entries(level).map(([id, n]) => make(id, n)));
}

/** Folds what was learned in one place into what is already known (newer wins per node), e.g. the page's and the workspace's. */
export function mergeCategoryCaches(into: CategoryCache, from: CategoryCache): CategoryCache {
  return {
    lastSyncAt: Math.max(into.lastSyncAt, from.lastSyncAt),
    categories: { ...into.categories, ...from.categories },
    types: { ...into.types, ...from.types },
    details: { ...into.details, ...from.details },
    partnerCodes: { ...into.partnerCodes, ...from.partnerCodes },
  };
}

// ---- providers ("Who did you pay?")

export interface VendorEntry {
  id: string;
  businessProfileId: string;
  name: string;
  /** The categories (StepUp ids from the category tree) this provider was offered for: the list depends on the category chosen. */
  categoryIds?: string[];
}

const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Ids in the category tree that appear in the request that fetched a provider list: that is the category the list was for. */
export function categoriesOfRequest(requestText: string, cache: CategoryCache): string[] {
  const mentioned = new Set((requestText.match(GUID) ?? []).map((g) => g.toLowerCase()));
  if (mentioned.size === 0) return [];
  const known = new Set<string>();
  for (const level of [cache.categories, cache.types, cache.details]) for (const id of Object.keys(level)) known.add(id.toLowerCase());
  return [...mentioned].filter((id) => known.has(id));
}

/** Adds a provider list response to what is known (names are only added; categories are accumulated). Returns the entries that are new or changed. */
export function mergeVendors(cache: Record<string, VendorEntry>, body: unknown, categoryIds: string[]): VendorEntry[] {
  const results = (body as { Results?: Array<{ Id: string; BusinessProfileId: string; DBAName: string }> } | null)?.Results;
  if (!Array.isArray(results)) return [];
  const touched: VendorEntry[] = [];
  for (const r of results) {
    if (!r?.Id || !r.DBAName) continue;
    const had = cache[r.Id];
    const merged = [...new Set([...(had?.categoryIds ?? []), ...categoryIds])];
    const next: VendorEntry = { id: r.Id, businessProfileId: r.BusinessProfileId, name: r.DBAName, categoryIds: merged };
    if (!had || had.name !== next.name || (had.categoryIds ?? []).length !== merged.length) touched.push(next);
    cache[r.Id] = next;
  }
  return touched;
}

// ---- where the web app keeps what was learned

/** A folder in the workspace root, beside the year folders; the maintainer tools read the same files. */
export const LEARNED_DIR = "_stepup-cache";
export const CATEGORY_CACHE_FILE = "category-tree-cache.json";
export const VENDOR_CACHE_FILE = "vendor-listing-cache.json";

export async function readLearned<T>(storage: StorageProvider, driveId: string, rootId: string, file: string): Promise<T | undefined> {
  const dir = await storage.find(driveId, rootId, LEARNED_DIR);
  const f = dir ? await storage.find(driveId, dir.id, file) : undefined;
  if (!f) return undefined;
  try {
    return JSON.parse(await (await storage.download(driveId, f.id)).text()) as T;
  } catch {
    return undefined;
  }
}

export async function writeLearned(storage: StorageProvider, driveId: string, rootId: string, file: string, value: unknown): Promise<void> {
  const dir = await storage.ensureFolder(driveId, rootId, LEARNED_DIR);
  await storage.write(driveId, dir, file, JSON.stringify(value));
}
