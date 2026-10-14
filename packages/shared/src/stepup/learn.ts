import type { ReferenceNode } from "../reference/categories.js";
import type { StorageProvider } from "../storage/types.js";
import type { StepUpReimbursement } from "./archive.js";

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
  /** StepUp's own rules for the node. `null` = StepUp left it to the level above (types and details usually do); absent = not seen. */
  requiresServiceDate?: boolean | null;
  requiresVendor?: boolean | null;
  requiresServiceProvider?: boolean | null;
  requiresDocumentation?: boolean | null;
  requiresAdditionalInfo?: boolean | null;
  isTaxable?: boolean | null;
}

const flag = (v: unknown): boolean | null | undefined => (typeof v === "boolean" ? v : v === null ? null : undefined);

/** The rule flags StepUp reports on a node, in either of its two spellings (`RequiresVendor` / `requiresVendor`). */
function ruleFlags(x: Record<string, unknown>): Partial<CachedNode> {
  const pick = (a: string, b: string) => flag(x[a] !== undefined ? x[a] : x[b]);
  const out: Partial<CachedNode> = {};
  const sets: Array<[keyof CachedNode, boolean | null | undefined]> = [
    ["requiresServiceDate", pick("RequiresServiceDate", "requiresServiceDate")],
    ["requiresVendor", pick("RequiresVendor", "requiresVendor")],
    ["requiresServiceProvider", pick("RequiresServiceProvider", "requiresServiceProvider")],
    ["requiresDocumentation", pick("RequiresDocumentation", "requiresDocumentation")],
    ["requiresAdditionalInfo", pick("RequiresAdditionalInfo", "requiresAdditionalInfo")],
    ["isTaxable", pick("IsTaxable", "isTaxable")],
  ];
  for (const [k, v] of sets) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
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
  /** The provider list behind "Who did you pay?". Older: `getbusinesssummarydropdown`; seen in 2026-10: `vendors/search`. */
  studentScholarship: /personapi-prod\.stepupforstudents\.org\/api\/guardian\/[0-9a-f-]{36}\/studentScholarship\/?(?:funded)?(?:[?#]|$)/i,
  balances: /infrastructureapi-prod\.stepupforstudents\.org\/api\/balancecheck\/bulk\/details/i,
  vendorDropdown: /providerapi-prod\.stepupforstudents\.org\/api\/(?:businesssummary\/getbusinesssummarydropdown|vendors\/search)/i,
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
      ...ruleFlags(c as unknown as Record<string, unknown>),
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
    cache.types[t.id] = { name: t.name, isActive: t.isActive, isDeleted: t.isDeleted, childIds: t.details, partnerIds: (t.approvedPrograms ?? []).map((p) => p.partnerId), ...ruleFlags(t as unknown as Record<string, unknown>) };
  }
  notePartners(cache, items);
  return items.length;
}

/** Details from `detailsbyids`. */
export function mergeDetails(cache: CategoryCache, data: unknown): number {
  if (!Array.isArray(data)) return 0;
  const items = data as ByIdsItem[];
  for (const d of items) {
    cache.details[d.id] = { name: d.name, isActive: d.isActive, isDeleted: d.isDeleted, partnerIds: (d.approvedPrograms ?? []).map((p) => p.partnerId), ...ruleFlags(d as unknown as Record<string, unknown>) };
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

/** A shared-tree node plus what StepUp itself says about needing a service date (`null`/absent: it did not say). */
export type ObservedNode = ReferenceNode & { stepUpRequiresServiceDate?: boolean | null };

/** The observed tree as shared-tree nodes (what the web app's reference and the ledger's category edits are made of). */
export function nodesFromCategoryCache(cache: CategoryCache): ObservedNode[] {
  const parentOf = new Map<string, string>();
  for (const level of [cache.categories, cache.types]) {
    for (const [id, node] of Object.entries(level)) for (const child of node.childIds ?? []) parentOf.set(child, id);
  }
  const scholarships = (n: CachedNode) => [...new Set((n.partnerIds ?? []).map((id) => scholarshipDisplayName(cache.partnerCodes[id] ?? id)))].sort();
  const make = (id: string, n: CachedNode): ObservedNode => ({
    id,
    ...(parentOf.has(id) ? { parentId: parentOf.get(id)! } : {}),
    name: n.name,
    isActive: n.isActive && !n.isDeleted,
    eligibleScholarships: scholarships(n),
    requiresServiceDate: false,
    ...(n.requiresServiceDate !== undefined ? { stepUpRequiresServiceDate: n.requiresServiceDate } : {}),
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

/**
 * Adds a provider list response to what is known (names are only added; categories are accumulated). Returns the entries
 * that are new or changed. Handles both responses StepUp has used: the older `{ Id, BusinessProfileId, DBAName }` and the
 * newer `{ Id, Name, DBAName, ... }` (the display name is the DBA name when there is one).
 */
export function mergeVendors(cache: Record<string, VendorEntry>, body: unknown, categoryIds: string[]): VendorEntry[] {
  const results = (body as { Results?: Array<{ Id?: string; BusinessProfileId?: string; DBAName?: string | null; Name?: string | null }> } | null)?.Results;
  if (!Array.isArray(results)) return [];
  const touched: VendorEntry[] = [];
  for (const r of results) {
    const name = (r?.DBAName || r?.Name || "").trim();
    if (!r?.Id || !name) continue;
    const had = cache[r.Id];
    const merged = [...new Set([...(had?.categoryIds ?? []), ...categoryIds])];
    const next: VendorEntry = { id: r.Id, businessProfileId: r.BusinessProfileId ?? had?.businessProfileId ?? "", name, categoryIds: merged };
    if (!had || had.name !== next.name || (had.categoryIds ?? []).length !== merged.length) touched.push(next);
    cache[r.Id] = next;
  }
  return touched;
}

// ---- the students StepUp knows, and what it says each has to spend

/** A student as StepUp lists them. Only what the app needs: no birth date, school or other personal fields are kept. */
export interface StepUpStudent {
  /** StepUp's number for the student; balances are keyed by it. */
  sequenceNumber: number;
  /** StepUp's id for the student (what a reimbursement's `studentId` holds). */
  id: string;
  firstName: string;
  lastName: string;
  middleName?: string;
  isActive?: boolean;
  /** Names of the scholarships/programs it lists for the student, when it names them. */
  programs: string[];
}

/** One program's money for one student, in cents, as StepUp reports it. */
export interface StepUpBalance {
  program: string;
  programType?: number;
  fundingCents: number;
  spendingCents: number;
  reservedCents: number;
  availableCents: number;
  adjustmentsCents: number;
}

const toCents = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 100) : 0);
const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** The students in a `studentScholarship` response (an array), without anything private beyond names and ids. */
export function parseStudents(body: unknown): StepUpStudent[] {
  if (!Array.isArray(body)) return [];
  const out: StepUpStudent[] = [];
  for (const raw of body as Array<Record<string, unknown>>) {
    const seq = raw?.["sequenceNumber"];
    const id = text(raw?.["id"]);
    const first = text(raw?.["firstName"]);
    const last = text(raw?.["lastName"]);
    if (typeof seq !== "number" || !id || !first || !last) continue;
    const programs = new Set<string>();
    for (const list of [raw["scholarships"], raw["renewalPrograms"]]) {
      if (!Array.isArray(list)) continue;
      for (const p of list as Array<Record<string, unknown>>) {
        const name = p && typeof p === "object" ? text(p["name"]) ?? text(p["scholarshipName"]) ?? text(p["programName"]) ?? text(p["programAlias"]) ?? text(p["program"]) : undefined;
        if (name) programs.add(name);
      }
    }
    out.push({ sequenceNumber: seq, id, firstName: first, lastName: last, ...(text(raw["middleName"]) ? { middleName: text(raw["middleName"])! } : {}), ...(typeof raw["isActive"] === "boolean" ? { isActive: raw["isActive"] } : {}), programs: [...programs].sort() });
  }
  return out;
}

/** `balancecheck/bulk/details`: `{ "<student sequence number>": [{ ProgramAlias, Funding, Spending, Reserved, Available, Adjustments }] }`. */
export function parseBalances(body: unknown): Record<string, StepUpBalance[]> {
  const out: Record<string, StepUpBalance[]> = {};
  if (!body || typeof body !== "object" || Array.isArray(body)) return out;
  for (const [seq, list] of Object.entries(body as Record<string, unknown>)) {
    if (!/^\d+$/.test(seq) || !Array.isArray(list)) continue;
    const rows: StepUpBalance[] = [];
    for (const r of list as Array<Record<string, unknown>>) {
      if (!r || typeof r !== "object" || typeof r["Funding"] !== "number") continue;
      rows.push({
        program: text(r["ProgramAlias"]) ?? "",
        ...(typeof r["ProgramType"] === "number" ? { programType: r["ProgramType"] } : {}),
        fundingCents: toCents(r["Funding"]),
        spendingCents: toCents(r["Spending"]),
        reservedCents: toCents(r["Reserved"]),
        availableCents: toCents(r["Available"]),
        adjustmentsCents: toCents(r["Adjustments"]),
      });
    }
    if (rows.length) out[seq] = rows;
  }
  return out;
}

/** Students as the app receives them from the page (already parsed there): anything that is not shaped right is dropped. */
export function sanitizeStudents(v: unknown): StepUpStudent[] {
  if (!Array.isArray(v)) return [];
  const out: StepUpStudent[] = [];
  for (const s of v as Array<Record<string, unknown>>) {
    if (!s || typeof s["sequenceNumber"] !== "number" || !text(s["id"]) || !text(s["firstName"]) || !text(s["lastName"])) continue;
    out.push({
      sequenceNumber: s["sequenceNumber"] as number,
      id: text(s["id"])!,
      firstName: text(s["firstName"])!,
      lastName: text(s["lastName"])!,
      ...(text(s["middleName"]) ? { middleName: text(s["middleName"])! } : {}),
      ...(typeof s["isActive"] === "boolean" ? { isActive: s["isActive"] } : {}),
      programs: Array.isArray(s["programs"]) ? (s["programs"] as unknown[]).filter((p): p is string => typeof p === "string") : [],
    });
  }
  return out;
}

/** Balances as the app receives them from the page (already in cents). */
export function sanitizeBalances(v: unknown): Record<string, StepUpBalance[]> {
  const out: Record<string, StepUpBalance[]> = {};
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? Math.round(x) : 0);
  for (const [seq, list] of Object.entries(v as Record<string, unknown>)) {
    if (!/^\d+$/.test(seq) || !Array.isArray(list)) continue;
    const rows = (list as Array<Record<string, unknown>>).filter((r) => r && typeof r === "object").map((r): StepUpBalance => ({
      program: typeof r["program"] === "string" ? r["program"] : "",
      ...(typeof r["programType"] === "number" ? { programType: r["programType"] } : {}),
      fundingCents: n(r["fundingCents"]),
      spendingCents: n(r["spendingCents"]),
      reservedCents: n(r["reservedCents"]),
      availableCents: n(r["availableCents"]),
      adjustmentsCents: n(r["adjustmentsCents"]),
    }));
    if (rows.length) out[seq] = rows;
  }
  return out;
}

/** What the workspace keeps about the person's students and balances (`student-balances.json`). */
export interface StepUpPeople {
  students: StepUpStudent[];
  /** Keyed by the student's sequence number. */
  balances: Record<string, StepUpBalance[]>;
  studentsAt?: string;
  balancesAt?: string;
}
export const emptyPeople = (): StepUpPeople => ({ students: [], balances: {} });

/** The names a student could be known by in the ledger, most specific first (lower case, single spaces). */
export function studentNameCandidates(s: Pick<StepUpStudent, "firstName" | "lastName" | "middleName">): string[] {
  const norm = (t: string) => t.toLowerCase().replace(/\s+/g, " ").trim();
  return [...new Set([
    norm(`${s.firstName} ${s.middleName ?? ""} ${s.lastName}`),
    norm(`${s.firstName} ${s.lastName}`),
    norm(`${s.lastName}, ${s.firstName}`),
    norm(s.firstName),
  ])];
}

/** Which ledger child (by id) is each StepUp student, by name; students with no match are left out. */
export function matchStudentsToChildren(students: readonly StepUpStudent[], children: ReadonlyArray<{ id: string; name?: string }>): Map<number, string> {
  const byName = new Map<string, string>();
  for (const c of children) if (c.name) byName.set(c.name.toLowerCase().replace(/\s+/g, " ").trim(), c.id);
  const out = new Map<number, string>();
  for (const s of students) {
    for (const cand of studentNameCandidates(s)) {
      const id = byName.get(cand);
      if (id) {
        out.set(s.sequenceNumber, id);
        break;
      }
    }
  }
  return out;
}

/** The name a new ledger child would get for a StepUp student (the same words StepUp's reimbursements use for them). */
export const studentDisplayName = (s: Pick<StepUpStudent, "firstName" | "lastName">): string => `${s.firstName} ${s.lastName}`;

// ---- drafts

/** Reimbursements StepUp holds that were never submitted (and not cancelled): worth finishing or abandoning. */
export function stepUpDrafts(reimbursements: readonly StepUpReimbursement[]): StepUpReimbursement[] {
  return reimbursements
    .filter((r) => !/cancel/i.test(r.status) && (/draft|incomplete|unsubmitted/i.test(r.status) || !r.submittedAt))
    .sort((a, b) => b.number - a.number);
}

// ---- where the web app keeps what was learned

/** A folder in the workspace root, beside the year folders; the maintainer tools read the same files. */
export const LEARNED_DIR = "_stepup-cache";
export const CATEGORY_CACHE_FILE = "category-tree-cache.json";
export const VENDOR_CACHE_FILE = "vendor-listing-cache.json";
export const PEOPLE_CACHE_FILE = "student-balances.json";

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
