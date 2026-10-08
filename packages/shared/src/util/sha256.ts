/** Hex SHA-256 of some bytes, in the browser and in Node (both have Web Crypto). */
export async function sha256OfBytes(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
