import { GraphError } from "../graph/client.js";
import { findChild, readTextFile, writeFile } from "../graph/files.js";
import { REFERENCE_SCHEMA_VERSION, referenceHash, validateCategoryReference, type CategoryReference, type ReferenceNode } from "./categories.js";

/**
 * Each year keeps a frozen copy of the shared category list (plan §3.8), so the year is self-sufficient, reads offline,
 * and a later change to the published list can never quietly alter an old year. Updating it is an explicit, per-year step.
 */
export const SNAPSHOT_FILE = "reference.snapshot.json";

/** The year's frozen category list, if it has one (and it is valid). */
export async function readYearSnapshot(driveId: string, ledgerFolderId: string): Promise<CategoryReference | undefined> {
  const file = await findChild(driveId, ledgerFolderId, SNAPSHOT_FILE);
  if (!file) return undefined;
  try {
    const data: unknown = JSON.parse((await readTextFile(driveId, file.id)).text);
    return validateCategoryReference(data).length === 0 ? (data as CategoryReference) : undefined;
  } catch {
    return undefined;
  }
}

/** Freezes a copy for the year. Never overwrites an existing snapshot (create-only), so two devices starting at once agree. */
export async function writeYearSnapshot(driveId: string, ledgerFolderId: string, ref: CategoryReference, replace = false): Promise<void> {
  try {
    await writeFile(driveId, ledgerFolderId, SNAPSHOT_FILE, JSON.stringify(ref), replace ? {} : { createOnly: true });
  } catch (err) {
    if (!replace && err instanceof GraphError && err.status === 409) return; // someone else just made it
    throw err;
  }
}

export interface ReferenceDiff {
  added: ReferenceNode[];
  /** Entries in both whose name, parent, activity, eligibility or Service Date flag differ. */
  changed: Array<{ id: string; name: string; what: string[] }>;
  /** In the snapshot but no longer published. */
  removed: ReferenceNode[];
  /** The published list is a newer version than the snapshot. */
  newer: boolean;
}

const same = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join("\u0000") === [...b].sort().join("\u0000");

export function diffReference(snapshot: CategoryReference, latest: CategoryReference): ReferenceDiff {
  const have = new Map(snapshot.categories.map((n) => [n.id, n]));
  const upstream = new Map(latest.categories.map((n) => [n.id, n]));
  const changed: ReferenceDiff["changed"] = [];
  for (const n of latest.categories) {
    const old = have.get(n.id);
    if (!old) continue;
    const what: string[] = [];
    if (old.name !== n.name) what.push("name");
    if ((old.parentId ?? "") !== (n.parentId ?? "")) what.push("parent");
    if (old.isActive !== n.isActive) what.push(n.isActive ? "reactivated" : "deactivated");
    if (!same(old.eligibleScholarships, n.eligibleScholarships)) what.push("eligibility");
    if (old.requiresServiceDate !== n.requiresServiceDate) what.push("service date");
    if (what.length) changed.push({ id: n.id, name: n.name, what });
  }
  return {
    added: latest.categories.filter((n) => !have.has(n.id)),
    changed,
    removed: snapshot.categories.filter((n) => !upstream.has(n.id)),
    newer: latest.version > snapshot.version,
  };
}

/**
 * The snapshot brought up to date, non-destructively: everything in the published list, plus anything the snapshot had that
 * the published list no longer does, kept but marked inactive (an item that already uses it should still resolve). Ids are
 * never reused, so existing items keep their category.
 */
export function mergeReference(snapshot: CategoryReference, latest: CategoryReference): CategoryReference {
  const upstream = new Set(latest.categories.map((n) => n.id));
  const kept = snapshot.categories.filter((n) => !upstream.has(n.id)).map((n) => ({ ...n, isActive: false }));
  const categories = [...latest.categories, ...kept].sort((a, b) => a.id.localeCompare(b.id));
  return { schemaVersion: REFERENCE_SCHEMA_VERSION, version: latest.version, hash: referenceHash(categories), categories };
}
