import { validateCategoryReference, type CategoryReference } from "@step-up/shared/web";

/**
 * The published category tree (same for everyone). If it cannot be loaded or fails validation we return undefined and
 * the app accepts any category, as before, rather than blocking entry.
 */
export async function loadBaseline(): Promise<CategoryReference | undefined> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}reference/categories.json`);
    if (!res.ok) return undefined;
    const data: unknown = await res.json();
    return validateCategoryReference(data).length === 0 ? (data as CategoryReference) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Providers StepUp has offered, by category id (see `npm run reference:vendors`). The "Who did you pay?" list depends on
 * the category, so a provider is only ever suggested for a category it was seen under. Optional: with no file the
 * suggestions come only from what was entered before for that category, and typing any name still works.
 */
export async function loadProviders(): Promise<Record<string, string[]>> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}reference/vendors.json`);
    if (!res.ok) return {};
    const data = (await res.json()) as { byCategory?: Record<string, unknown> };
    const out: Record<string, string[]> = {};
    for (const [id, names] of Object.entries(data.byCategory ?? {})) if (Array.isArray(names)) out[id] = names.filter((n): n is string => typeof n === "string");
    return out;
  } catch {
    return {};
  }
}
