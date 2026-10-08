/**
 * StepUp changes its site without notice. The automation reads a few of StepUp's own API responses; these checks say, in
 * words, when a response no longer looks the way the code expects, so the run stops with "StepUp changed" instead of
 * quietly writing wrong data. Only fields the code actually uses are checked; extra fields are fine.
 */
export type StepUpShape = "reimbursements-search" | "categories-search" | "draft";

type Check = (v: unknown, path: string, out: string[]) => void;

const kind = (v: unknown): string => (v === null ? "null" : Array.isArray(v) ? "a list" : typeof v === "object" ? "an object" : typeof v);
const text: Check = (v, p, out) => { if (typeof v !== "string") out.push(`${p}: expected text, got ${kind(v)}`); };
const bool: Check = (v, p, out) => { if (typeof v !== "boolean") out.push(`${p}: expected true/false, got ${kind(v)}`); };
const num: Check = (v, p, out) => { if (typeof v !== "number" || !Number.isFinite(v)) out.push(`${p}: expected a number, got ${kind(v)}`); };
const optional = (c: Check): Check => (v, p, out) => { if (v !== undefined && v !== null) c(v, p, out); };
const list = (item: Check, sample = 3): Check => (v, p, out) => {
  if (!Array.isArray(v)) return void out.push(`${p}: expected a list, got ${kind(v)}`);
  v.slice(0, sample).forEach((x, i) => item(x, `${p}[${i}]`, out));
};
const object = (fields: Record<string, Check>): Check => (v, p, out) => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return void out.push(`${p}: expected an object, got ${kind(v)}`);
  for (const [k, c] of Object.entries(fields)) c((v as Record<string, unknown>)[k], `${p}.${k}`, out);
};

const SHAPES: Record<StepUpShape, Check> = {
  "reimbursements-search": object({
    Results: list(object({ LineItems: list(object({ LineItemNumber: text, ExternalStatus: text, Appealed: bool, ItemAmount: num })) })),
  }),
  "categories-search": object({
    Results: list(object({ Id: text, Name: text, Types: list(text), IsActive: bool, IsDeleted: bool })),
  }),
  draft: object({ sequenceNumber: optional((v, p, out) => { if (typeof v !== "number" && typeof v !== "string") out.push(`${p}: expected a number, got ${kind(v)}`); }), externalStatus: optional(text), submitDate: optional(text), lineItems: optional(list(object({}))), additionalDocuments: optional(list(object({}))) }),
};

/** Problems with a response (empty = looks right). */
export function checkStepUpShape(shape: StepUpShape, body: unknown): string[] {
  const out: string[] = [];
  SHAPES[shape](body, "response", out);
  return out;
}
