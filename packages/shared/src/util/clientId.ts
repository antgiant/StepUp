/** A fresh, filename-safe id for one install/device, e.g. `cli-3fa9c2d1`. Generated once per install and persisted by the host. */
export function newClientId(prefix: string): string {
  const bytes = new Uint8Array(4);
  globalThis.crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${prefix}-${hex}`;
}
