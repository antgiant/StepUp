import type { CategoryEdit } from "../domain/types.js";
import type { Ledger } from "../events/ledger.js";
import { applyEdits, type CategoryReference, type ReferenceNode } from "./categories.js";

const sameList = (a: string[], b: string[]) => a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);

/**
 * What StepUp's own category list (observed by the CLI) says that the shared tree plus this year's edits does not yet:
 * entries it has never heard of, renames, activity changes, parent changes, and eligibility lists that are now known.
 * Only the differing fields are returned. It never touches `requiresServiceDate` (StepUp doesn't tell us that) and never
 * clears a known eligibility list because the observation had none.
 */
export function categorySyncEdits(base: ReferenceNode[], edits: Record<string, CategoryEdit>, observed: ReferenceNode[]): CategoryEdit[] {
  const effective = new Map(applyEdits(base, edits).map((n) => [n.id, n]));
  const out: CategoryEdit[] = [];
  for (const o of observed) {
    const cur = effective.get(o.id);
    if (!cur) {
      out.push({ id: o.id, ...(o.parentId ? { parentId: o.parentId } : {}), name: o.name, isActive: o.isActive, eligibleScholarships: o.eligibleScholarships });
      continue;
    }
    const diff: CategoryEdit = { id: o.id };
    if (o.name !== cur.name) diff.name = o.name;
    if (o.isActive !== cur.isActive) diff.isActive = o.isActive;
    if (o.parentId !== undefined && o.parentId !== cur.parentId) diff.parentId = o.parentId;
    if (o.eligibleScholarships.length > 0 && !sameList(o.eligibleScholarships, cur.eligibleScholarships)) diff.eligibleScholarships = o.eligibleScholarships;
    if (Object.keys(diff).length > 1) out.push(diff);
  }
  return out;
}

/** Records StepUp's observed categories in the year's ledger as edits. Safe to repeat: a second run finds nothing new. */
export function applyObservedCategories(ledger: Ledger, base: CategoryReference, observed: ReferenceNode[]): { added: number; updated: number } {
  let added = 0;
  let updated = 0;
  const known = new Set(applyEdits(base.categories, ledger.state.categories).map((n) => n.id));
  for (const { id, ...fields } of categorySyncEdits(base.categories, ledger.state.categories, observed)) {
    ledger.set("category", id, fields as never, { label: "category.observed" });
    if (known.has(id)) updated++;
    else added++;
  }
  return { added, updated };
}
