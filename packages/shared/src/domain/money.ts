export const DEFAULT_TAX_RATE = 0.07;

/** Parses a dollar string/number ("12.34", 12.34, "$1,234.50") into integer cents; undefined if not numeric. */
export function toCents(value: string | number | null | undefined): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const n = typeof value === "number" ? value : Number(String(value).replace(/[$,\s]/g, ""));
  if (!Number.isFinite(n)) return undefined;
  return Math.round(n * 100);
}

export function formatCents(cents: number | undefined): string {
  if (cents === undefined) return "";
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100).toLocaleString("en-US")}.${String(abs % 100).padStart(2, "0")}`;
}

/** Estimated tax/shipping for an amount; an estimate only — real receipt values should replace it. */
export function estimateTaxCents(amountCents: number, rate: number = DEFAULT_TAX_RATE): number {
  return Math.round(amountCents * rate);
}
