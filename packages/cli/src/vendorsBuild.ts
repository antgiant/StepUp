/**
 * Maintainer tool: merges the providers StepUp's "Who did you pay?" list has shown the filing tool
 * (.cache/vendor-listing-cache.json, grown a little on every filing run) into packages/web/public/reference/vendors.json.
 * That list depends on the category chosen, so providers are stored per category id, and the web app offers a provider
 * only for a category it was seen under. Providers whose category could not be told are left out rather than guessed.
 * Names are only added, never dropped; only display names and category ids are written. Review the diff, then commit.
 *   npm run reference:vendors
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const OUT = path.resolve(process.cwd(), "packages/web/public/reference/vendors.json");
const CACHE = path.resolve(process.cwd(), ".cache/vendor-listing-cache.json");

async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf-8")) as T;
  } catch {
    return undefined;
  }
}

const cache = await readJson<Record<string, { name: string; categoryIds?: string[] }>>(CACHE);
if (!cache) throw new Error(`No ${CACHE}: run the filing tool first so it can learn provider names.`);
const byCategory: Record<string, Set<string>> = {};
for (const [id, names] of Object.entries((await readJson<{ byCategory?: Record<string, string[]> }>(OUT))?.byCategory ?? {})) byCategory[id] = new Set(names);
let unplaced = 0;
for (const v of Object.values(cache)) {
  if (!v.name?.trim()) continue;
  if (!v.categoryIds?.length) {
    unplaced++;
    continue;
  }
  for (const c of v.categoryIds) (byCategory[c] ??= new Set()).add(v.name.trim());
}
const sorted = Object.fromEntries(Object.keys(byCategory).sort().map((c) => [c, [...byCategory[c]!].sort((a, b) => a.localeCompare(b))]));
await writeFile(OUT, JSON.stringify({ byCategory: sorted }, null, 1) + "\n", "utf-8");
console.log(`Providers for ${Object.keys(sorted).length} categor(ies) written to ${path.relative(process.cwd(), OUT)}. ${unplaced} provider(s) had no known category and were left out.`);
