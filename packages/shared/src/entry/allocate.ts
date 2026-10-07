/**
 * Splits `total` cents across `weights` proportionally so the parts always sum to exactly `total`
 * (largest-remainder rounding; ties go to the earlier entry). Zero total weight splits evenly.
 */
export function allocateProportionally(total: number, weights: number[]): number[] {
  if (weights.length === 0) return [];
  const sum = weights.reduce((a, b) => a + b, 0);
  const w = sum > 0 ? weights : weights.map(() => 1);
  const wSum = sum > 0 ? sum : weights.length;
  const exact = w.map((x) => (total * x) / wSum);
  const parts = exact.map(Math.floor);
  let left = total - parts.reduce((a, b) => a + b, 0);
  const order = exact.map((e, i) => ({ i, frac: e - Math.floor(e) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    parts[i]! += 1;
    left -= 1;
  }
  return parts;
}
