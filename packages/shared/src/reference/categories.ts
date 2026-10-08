import type { CategoryInfo } from "../rules/readiness.js";
import { canonical, hashString } from "../util/hash.js";

/**
 * Shared reference data (plan §3.8): StepUp's category tree, identical for everyone and published with the site.
 * Strict allow-list shape — nothing private can end up in it. Entries are keyed by StepUp's own ids.
 */
export const REFERENCE_SCHEMA_VERSION = 1;

export interface ReferenceNode {
  id: string;
  /** Category -> Type -> Detail nesting; absent for a top-level Category. */
  parentId?: string;
  name: string;
  isActive: boolean;
  /** Scholarship labels (e.g. "FES-UA"); empty means "not known yet", never "not eligible". */
  eligibleScholarships: string[];
  requiresServiceDate: boolean;
}

export interface CategoryReference {
  schemaVersion: number;
  /** Increases whenever the content changes. */
  version: number;
  /** Content hash of `categories`; lets a client tell whether it holds the latest. */
  hash: string;
  categories: ReferenceNode[];
}

export const referenceHash = (categories: ReferenceNode[]) => hashString(canonical(categories));

const NODE_KEYS = new Set(["id", "parentId", "name", "isActive", "eligibleScholarships", "requiresServiceDate"]);
const FILE_KEYS = new Set(["schemaVersion", "version", "hash", "categories"]);

/** Everything wrong with a reference file (empty list = valid). Unknown fields are errors so private data can't ride along. */
export function validateCategoryReference(data: unknown): string[] {
  const errors: string[] = [];
  if (!data || typeof data !== "object" || Array.isArray(data)) return ["Not an object"];
  const file = data as Record<string, unknown>;
  for (const k of Object.keys(file)) if (!FILE_KEYS.has(k)) errors.push(`Unknown field "${k}"`);
  if (file["schemaVersion"] !== REFERENCE_SCHEMA_VERSION) errors.push(`schemaVersion must be ${REFERENCE_SCHEMA_VERSION}`);
  if (!Number.isInteger(file["version"]) || (file["version"] as number) < 1) errors.push("version must be a positive integer");
  if (!Array.isArray(file["categories"])) return [...errors, "categories must be an array"];

  const nodes = file["categories"] as unknown[];
  const ids = new Set<string>();
  for (const [i, raw] of nodes.entries()) {
    const at = `categories[${i}]`;
    if (!raw || typeof raw !== "object") {
      errors.push(`${at} is not an object`);
      continue;
    }
    const n = raw as Record<string, unknown>;
    for (const k of Object.keys(n)) if (!NODE_KEYS.has(k)) errors.push(`${at}: unknown field "${k}"`);
    if (typeof n["id"] !== "string" || !n["id"]) errors.push(`${at}: id must be a non-empty string`);
    else if (ids.has(n["id"])) errors.push(`${at}: duplicate id ${n["id"]}`);
    else ids.add(n["id"]);
    if (typeof n["name"] !== "string" || !(n["name"] as string).trim()) errors.push(`${at}: name must be a non-empty string`);
    if (n["parentId"] !== undefined && typeof n["parentId"] !== "string") errors.push(`${at}: parentId must be a string`);
    if (typeof n["isActive"] !== "boolean") errors.push(`${at}: isActive must be true/false`);
    if (typeof n["requiresServiceDate"] !== "boolean") errors.push(`${at}: requiresServiceDate must be true/false`);
    if (!Array.isArray(n["eligibleScholarships"]) || n["eligibleScholarships"].some((s) => typeof s !== "string")) errors.push(`${at}: eligibleScholarships must be a list of text`);
  }
  const byId = new Map((nodes as ReferenceNode[]).filter((n) => n && typeof n.id === "string").map((n) => [n.id, n]));
  for (const n of byId.values()) {
    if (n.parentId !== undefined && !byId.has(n.parentId)) errors.push(`${n.id}: parent ${n.parentId} does not exist`);
    const seen = new Set<string>();
    for (let cur: ReferenceNode | undefined = n; cur; cur = cur.parentId ? byId.get(cur.parentId) : undefined) {
      if (seen.has(cur.id)) {
        errors.push(`${n.id}: parents form a loop`);
        break;
      }
      seen.add(cur.id);
    }
  }
  if (errors.length === 0 && file["hash"] !== referenceHash(file["categories"] as ReferenceNode[])) errors.push("hash does not match the categories (re-run reference:build)");
  return errors;
}

/** Id older imports gave a category before StepUp ids were known; kept resolvable so those items still validate. */
export const categoryIdForPath = (path: string[]): string => `legacy-cat-${path.join(" ").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;

export interface CategoryChoice {
  id: string;
  /** "Category - Type - Detail". */
  label: string;
  path: string[];
}

export interface ResolvedReference {
  /** For `RulesContext`: undefined when the id is not in the tree. */
  category(id: string): CategoryInfo | undefined;
  /** What a person can pick: active entries with no active children, sorted by label. */
  choices: CategoryChoice[];
  /** The id for a label a person typed or picked, if it names a known entry (case-insensitive). */
  idForLabel(label: string): string | undefined;
}

/** The effective view of the reference data. (Per-year overlay operations will be folded in here too.) */
export function resolveReference(ref: CategoryReference): ResolvedReference {
  const byId = new Map(ref.categories.map((n) => [n.id, n]));
  const children = new Map<string, ReferenceNode[]>();
  for (const n of ref.categories) if (n.parentId) children.set(n.parentId, [...(children.get(n.parentId) ?? []), n]);

  const chain = (n: ReferenceNode): ReferenceNode[] => {
    const out: ReferenceNode[] = [];
    for (let cur: ReferenceNode | undefined = n; cur; cur = cur.parentId ? byId.get(cur.parentId) : undefined) out.unshift(cur);
    return out;
  };
  const infoOf = (n: ReferenceNode): CategoryInfo => {
    const nodes = chain(n);
    return {
      id: n.id,
      path: nodes.map((x) => x.name),
      requiresServiceDate: nodes.some((x) => x.requiresServiceDate),
      // StepUp attaches eligibility to the deepest level; an empty list there means "not known yet", so use the nearest known.
      eligibleScholarships: [...nodes].reverse().find((x) => x.eligibleScholarships.length > 0)?.eligibleScholarships ?? [],
      isActive: nodes.every((x) => x.isActive),
    };
  };

  const infos = new Map<string, CategoryInfo>();
  const labels = new Map<string, string>();
  const choices: CategoryChoice[] = [];
  for (const n of ref.categories) {
    const info = infoOf(n);
    infos.set(n.id, info);
    infos.set(categoryIdForPath(info.path), info);
    const label = info.path.join(" - ");
    labels.set(label.toLowerCase(), n.id);
    if (info.isActive && !(children.get(n.id) ?? []).some((c) => c.isActive)) choices.push({ id: n.id, label, path: info.path });
  }
  choices.sort((a, b) => a.label.localeCompare(b.label));
  return { category: (id) => infos.get(id), choices, idForLabel: (label) => labels.get(label.trim().toLowerCase()) };
}
