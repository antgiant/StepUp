import { describe, expect, it } from "vitest";
import { isBlurry, sharpness, toGray } from "../src/index.js";

const W = 200;
const H = 120;

/** Black text-like stripes on white: lots of hard edges. */
function sharp(): Uint8Array {
  const g = new Uint8Array(W * H).fill(255);
  for (let y = 10; y < H - 10; y += 8) for (let x = 10; x < W - 10; x++) if ((Math.floor(x / 3) + Math.floor(y / 8)) % 2 === 0) for (let k = 0; k < 4; k++) g[(y + k) * W + x] = 0;
  return g;
}

/** A box blur applied n times: the same picture, softened. */
function blur(src: Uint8Array, passes: number): Uint8Array {
  let cur = Uint8Array.from(src);
  for (let p = 0; p < passes; p++) {
    const next = Uint8Array.from(cur);
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      let s = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += cur[(y + dy) * W + x + dx]!;
      next[y * W + x] = Math.round(s / 9);
    }
    cur = next;
  }
  return cur;
}

describe("sharpness", () => {
  it("a sharp text-like image scores far higher than the same image blurred", () => {
    const a = sharpness(sharp(), W, H);
    const b = sharpness(blur(sharp(), 3), W, H);
    const c = sharpness(blur(sharp(), 8), W, H);
    expect(a).toBeGreaterThan(b);
    expect(b).toBeGreaterThan(c);
    expect(isBlurry(a)).toBe(false);
    expect(isBlurry(c)).toBe(true);
  });

  it("a flat image (lens cap, white wall) counts as blurry", () => {
    expect(isBlurry(sharpness(new Uint8Array(W * H).fill(200), W, H))).toBe(true);
  });

  it("tiny images do not crash", () => {
    expect(sharpness(new Uint8Array(4), 2, 2)).toBe(0);
  });
});

describe("toGray", () => {
  it("converts RGBA to luminance", () => {
    expect(Array.from(toGray([255, 255, 255, 255, 0, 0, 0, 255, 255, 0, 0, 255]))).toEqual([255, 0, 76]);
  });
});
