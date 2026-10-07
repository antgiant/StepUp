/** Random, filename-safe entity id such as `item-3fa9c2d1e07b`. Generated client-side; collisions are not a practical concern at this scale. */
export function newId(prefix: string): string {
  const bytes = new Uint8Array(6);
  globalThis.crypto.getRandomValues(bytes);
  return `${prefix}-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
