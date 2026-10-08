/**
 * Maintainer tool for the shared category reference (plan §3.8).
 *   npm run reference:build     merges StepUp's category tree from .cache/category-tree-cache.json into
 *                               packages/web/public/reference/categories.json (adds/updates; never drops an entry or
 *                               overwrites requiresServiceDate), bumps `version` only when the content changed.
 *   npm run reference:promote -- <file>  merges a category-edits file exported from the web app (same rules).
 *   npm run reference:validate  checks the committed file against the strict schema.
 * Review the diff, then commit. Only public taxonomy data (names, StepUp ids, scholarship labels) is written.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  REFERENCE_SCHEMA_VERSION,
  referenceHash,
  promoteEdits,
  validateCategoryReference,
  type CategoryReference,
  type ReferenceNode,
} from "@step-up/shared";
import { scholarshipDisplayName, type Cache, type CachedNode } from "./categorySync.js";

/** Top-level categories whose whole subtree needs a Service Date on every item (set by the maintainers, not learned from StepUp). */
const SERVICE_DATE_ROOTS = new Set(["Testing and Assessments"]);

const OUT = path.resolve(process.cwd(), "packages/web/public/reference/categories.json");
const CACHE = path.resolve(process.cwd(), ".cache/category-tree-cache.json");

async function readExisting(): Promise<CategoryReference | undefined> {
  try {
    return JSON.parse(await readFile(OUT, "utf-8")) as CategoryReference;
  } catch {
    return undefined;
  }
}

function nodesFromCache(cache: Cache): ReferenceNode[] {
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

async function build(): Promise<void> {
  const cache = JSON.parse(await readFile(CACHE, "utf-8")) as Cache;
  const existing = await readExisting();
  const merged = new Map((existing?.categories ?? []).map((n) => [n.id, n]));
  for (const fresh of nodesFromCache(cache)) {
    const old = merged.get(fresh.id);
    merged.set(fresh.id, { ...fresh, requiresServiceDate: old?.requiresServiceDate ?? false });
  }
  for (const n of merged.values()) if (!n.parentId && SERVICE_DATE_ROOTS.has(n.name)) merged.set(n.id, { ...n, requiresServiceDate: true });
  await write([...merged.values()], existing);
}

async function write(nodes: ReferenceNode[], existing: CategoryReference | undefined): Promise<void> {
  const categories = nodes.sort((a, b) => a.id.localeCompare(b.id));
  const hash = referenceHash(categories);
  const next: CategoryReference = {
    schemaVersion: REFERENCE_SCHEMA_VERSION,
    version: existing ? (existing.hash === hash ? existing.version : existing.version + 1) : 1,
    hash,
    categories,
  };
  const errors = validateCategoryReference(next);
  if (errors.length) throw new Error(`Built file is invalid:\n${errors.join("\n")}`);
  await writeFile(OUT, JSON.stringify(next, null, 1) + "\n", "utf-8");
  console.log(`${categories.length} entries, version ${next.version}${existing?.hash === hash ? " (unchanged)" : ""} -> ${path.relative(process.cwd(), OUT)}`);
}

/** Merges a "category-edits" file exported from the web app into the baseline, for review before committing. */
async function promote(file: string | undefined): Promise<void> {
  if (!file) throw new Error("Usage: npm run reference:promote -- <category-edits.json>");
  const existing = await readExisting();
  if (!existing) throw new Error("No baseline yet; run reference:build first.");
  await write(promoteEdits(existing.categories, JSON.parse(await readFile(file, "utf-8"))), existing);
}

async function validate(): Promise<void> {
  const errors = validateCategoryReference(await readExisting());
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exit(1);
  }
  console.log("categories.json is valid.");
}

await (process.argv[2] === "validate" ? validate() : process.argv[2] === "promote" ? promote(process.argv[3]) : build());
