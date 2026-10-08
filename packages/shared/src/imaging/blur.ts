/**
 * How sharp a greyscale image is: the variance of its Laplacian (the sum of the second differences around each pixel).
 * Sharp text has strong edges, so a high value; a blurred or flat photo has a low one. `gray` is row-major, one byte per pixel.
 * Compare images at a similar size (the web app shrinks to about 800 px wide first).
 */
export function sharpness(gray: ArrayLike<number>, width: number, height: number): number {
  if (width < 3 || height < 3) return 0;
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const lap = 4 * gray[i]! - gray[i - 1]! - gray[i + 1]! - gray[i - width]! - gray[i + width]!;
      sum += lap;
      sumSq += lap * lap;
      n++;
    }
  }
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

/** Below this, at ~800 px wide, a receipt photo is too soft to read reliably (tuned on text-like test images; adjust if it cries wolf). */
export const BLURRY_BELOW = 60;

export const isBlurry = (score: number): boolean => score < BLURRY_BELOW;

/** Luminance of RGBA pixel data (as from a canvas), one byte per pixel. */
export function toGray(rgba: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(rgba.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = Math.round(0.299 * rgba[i * 4]! + 0.587 * rgba[i * 4 + 1]! + 0.114 * rgba[i * 4 + 2]!);
  return out;
}
