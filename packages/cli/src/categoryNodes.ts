import type { ReferenceNode } from "@step-up/shared";
import { scholarshipDisplayName, type Cache, type CachedNode } from "./categorySync.js";

/** StepUp's category -> type -> detail tree, as observed in `.cache/category-tree-cache.json`, as shared-tree nodes. */
export function nodesFromCache(cache: Cache): ReferenceNode[] {
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
