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
