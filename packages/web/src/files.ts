/** Hex SHA-256 of a file's bytes (used to spot the same receipt added twice). Empty string if hashing is unavailable. */
export async function sha256Hex(blob: Blob): Promise<string> {
  try {
    const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return "";
  }
}

const MAX_EDGE = 2400;

/**
 * Phone photos are often several MB. Shrinks big photos to a still-readable JPEG before uploading; anything that
 * is not a large decodable image (PDFs, small images, formats the browser cannot draw) is returned unchanged.
 */
export async function prepareUpload(file: File): Promise<{ name: string; body: Blob }> {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size < 1_000_000) return { name: file.name, body: file };
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
    if (!blob || blob.size >= file.size) return { name: file.name, body: file };
    return { name: file.name.replace(/\.\w+$/, "") + ".jpg", body: blob };
  } catch {
    return { name: file.name, body: file };
  }
}

/** Camera captures arrive with a generic name ("image.jpg"); give them a dated one. */
export function photoName(file: File, now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${p(now.getMonth() + 1)} ${p(now.getDate())} ${now.getFullYear()} ${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `Photo ${stamp}${/\.\w+$/.exec(file.name)?.[0] ?? ".jpg"}`;
}

export type PreviewKind = "image" | "pdf" | "email" | "other";

export function previewKind(filename: string, mime: string): PreviewKind {
  if (/^image\/(jpeg|png|gif|webp|bmp)$/.test(mime) || /\.(jpe?g|png|gif|webp|bmp)$/i.test(filename)) return "image";
  if (mime === "application/pdf" || /\.pdf$/i.test(filename)) return "pdf";
  if (mime === "message/rfc822" || /\.eml$/i.test(filename)) return "email";
  return "other";
}
