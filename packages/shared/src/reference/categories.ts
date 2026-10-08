import type { CategoryEdit } from "../domain/types.js";
import type { Ledger } from "../events/ledger.js";
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

/** Baseline entries with the year's edits applied: edited fields win, and an edit with a new id and a name adds an entry. */
export function applyEdits(base: ReferenceNode[], edits: Record<string, CategoryEdit> = {}): ReferenceNode[] {
  const out = new Map(base.map((n) => [n.id, n]));
  for (const e of Object.values(edits)) {
    const old = out.get(e.id);
    if (!old && !e.name?.trim()) continue; // an edit of something we do not know and cannot name: ignore
    out.set(e.id, {
      id: e.id,
      ...((e.parentId ?? old?.parentId) !== undefined ? { parentId: e.parentId ?? old!.parentId! } : {}),
      name: e.name?.trim() || old!.name,
      isActive: e.isActive ?? old?.isActive ?? true,
      eligibleScholarships: e.eligibleScholarships ?? old?.eligibleScholarships ?? [],
      requiresServiceDate: e.requiresServiceDate ?? old?.requiresServiceDate ?? false,
    });
  }
  return [...out.values()];
}

/** The effective view: the baseline tree plus this year's edits (`ledger.state.categories`). */
export function resolveReference(ref: CategoryReference, edits?: Record<string, CategoryEdit>): ResolvedReference {
  const nodes = applyEdits(ref.categories, edits);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const children = new Map<string, ReferenceNode[]>();
  for (const n of nodes) if (n.parentId) children.set(n.parentId, [...(children.get(n.parentId) ?? []), n]);

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
  for (const n of nodes) {
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

/**
 * Records, in this year's ledger, that a category exists / needs a Service Date. Levels that already exist are reused;
 * missing ones are added under the previous level with a `user-cat-…` id. Returns the leaf's id. Re-resolve afterwards.
 */
export function addOrFixCategory(ledger: Ledger, current: ResolvedReference, path: string[], requiresServiceDate: boolean): string {
  const levels = path.map((l) => l.trim()).filter(Boolean);
  if (levels.length === 0) throw new Error("Enter the category, e.g. Testing and Assessments - Other");
  let parent: string | undefined;
  for (const [i, name] of levels.entries()) {
    const label = levels.slice(0, i + 1).join(" - ");
    let id = current.idForLabel(label);
    if (!id) {
      id = `user-cat-${hashString(label.toLowerCase())}`;
      ledger.set("category", id, { name, isActive: true, ...(parent ? { parentId: parent } : {}) }, { label: "category.added" });
    }
    parent = id;
  }
  ledger.set("category", parent!, { requiresServiceDate }, { label: "category.serviceDateSet" });
  return parent!;
}

/** The year's edits as a minimal, schema-checked file anyone can send to the maintainers ("share with everyone"). Contains no private data. */
export function exportCategoryEdits(edits: Record<string, CategoryEdit>): { schemaVersion: number; kind: "category-edits"; edits: CategoryEdit[] } {
  const allowed = (e: CategoryEdit): CategoryEdit => ({
    id: e.id,
    ...(e.parentId !== undefined ? { parentId: e.parentId } : {}),
    ...(e.name !== undefined ? { name: e.name } : {}),
    ...(e.isActive !== undefined ? { isActive: e.isActive } : {}),
    ...(e.eligibleScholarships !== undefined ? { eligibleScholarships: e.eligibleScholarships } : {}),
    ...(e.requiresServiceDate !== undefined ? { requiresServiceDate: e.requiresServiceDate } : {}),
  });
  return { schemaVersion: REFERENCE_SCHEMA_VERSION, kind: "category-edits", edits: Object.values(edits).map(allowed).sort((a, b) => a.id.localeCompare(b.id)) };
}

/** Folds an exported edits file into baseline entries (maintainer path: `npm run reference:promote`). Throws on a malformed file. */
export function promoteEdits(base: ReferenceNode[], file: unknown): ReferenceNode[] {
  const f = file as { schemaVersion?: unknown; kind?: unknown; edits?: unknown };
  if (!f || f.schemaVersion !== REFERENCE_SCHEMA_VERSION || f.kind !== "category-edits" || !Array.isArray(f.edits)) throw new Error("Not a category-edits file");
  const allowed = new Set(["id", "parentId", "name", "isActive", "eligibleScholarships", "requiresServiceDate"]);
  const edits: Record<string, CategoryEdit> = {};
  for (const raw of f.edits as Array<Record<string, unknown>>) {
    for (const k of Object.keys(raw)) if (!allowed.has(k)) throw new Error(`Unknown field "${k}" in an edit`);
    if (typeof raw["id"] !== "string") throw new Error("An edit has no id");
    edits[raw["id"]] = raw as unknown as CategoryEdit;
  }
  const merged = applyEdits(base, edits).sort((a, b) => a.id.localeCompare(b.id));
  const problems = validateCategoryReference({ schemaVersion: REFERENCE_SCHEMA_VERSION, version: 1, hash: referenceHash(merged), categories: merged });
  if (problems.length) throw new Error(`Edits would make the tree invalid:\n${problems.join("\n")}`);
  return merged;
}
