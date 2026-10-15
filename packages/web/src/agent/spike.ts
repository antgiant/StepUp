import { mapForm, type FormEl, type FormMap, type FormRoot, type WizardStep } from "./form.js";
import { recognise } from "./signatures.js";

/**
 * The spike tests: one deliberate action on the page the person has open, with a read-back, to learn whether StepUp's
 * controls accept input from a script. Run only on request from a person's click in the app, only while spike tools are
 * switched on, and only on the fixed controls listed here. No test ever presses Continue, Back, Submit or Delete, or
 * anything else that moves the form on: the only things clicked are a dropdown's own toggle and an entry in its list.
 */

export type TextTarget = "quantity" | "cost" | "additionalCosts" | "invoiceNumber" | "benefit" | "url" | "vendorName" | "providerName" | "serviceProviderName" | "itemAmount";
export type DateTarget = "purchaseDate" | "serviceDate";
export type PickTarget = "student" | "category" | "categoryType" | "categoryDetail" | "provider" | "payee" | "individualProvider";
export type FileTarget = "receipt" | "additional";
export type EntryMethod = "events" | "typed";

export type SpikeTest =
  | { kind: "text"; target: TextTarget; index: number; value: string; method: EntryMethod }
  | { kind: "date"; target: DateTarget; index: number; value: string; method: EntryMethod }
  | { kind: "pick"; target: PickTarget; index: number; option: string }
  | { kind: "file"; target: FileTarget; name: string; mime: string; bytes: ArrayBuffer };

export interface SpikeResult {
  /** A short name for what was tried, for the person's list of results. */
  test: string;
  ok: boolean;
  lines: string[];
}

/** The page, as far as the spikes touch it. The real one is in main.ts; tests supply a fake. */
export interface PageOps {
  count(selector: string): number;
  value(selector: string, index: number): string | undefined;
  setValue(selector: string, index: number, value: string, method: EntryMethod): void;
  setFiles(selector: string, index: number, file: { name: string; mime: string; bytes: ArrayBuffer }): void;
  /** The item's running total as the page shows it ("$12.00 total"): StepUp recomputes it from what it has accepted. */
  itemTotal?(index: number): string | undefined;
  /** Opens the dropdown for a target (its own toggle button only). False when it is not on the page. */
  openPicker(target: PickTarget, index: number): boolean;
  /** The toggle's visible words now (what is chosen): compared, never reported. */
  pickerText(target: PickTarget, index: number): string | undefined;
  /** The words of the entries in the open list. */
  menuTexts(): string[];
  /** Clicks one entry of the open list, by its exact words. */
  clickMenuItem(text: string): boolean;
}

interface Env {
  ops: PageOps;
  root: FormRoot;
  url: string;
  sleep(ms: number): Promise<void>;
  /** How many of StepUp's own saves (a PUT of the reimbursement) have been seen so far. */
  saves(): number;
  /** Whether an element is on screen; hidden headings do not count as what the page says. */
  visible?(el: FormEl): boolean;
}

const mapOf = (env: Env): FormMap => mapForm(env.root, env.url, env.visible ? { visible: env.visible } : {});

const TEXT: Record<TextTarget, { selector: string; step: WizardStep }> = {
  quantity: { selector: '[placeholder="Enter Quantity"]', step: "itemDetails" },
  cost: { selector: '[placeholder="Enter Cost per Item"]', step: "itemDetails" },
  additionalCosts: { selector: '[placeholder="Enter Additional Costs"]', step: "itemDetails" },
  invoiceNumber: { selector: "#invoiceNumber", step: "itemDetails" },
  benefit: { selector: "#educationalBenefit", step: "itemDetails" },
  url: { selector: "#itemServiceUrl", step: "itemDetails" },
  vendorName: { selector: "#vendorName", step: "itemDetails" },
  providerName: { selector: "#otherServiceProviderName", step: "itemDetails" },
  serviceProviderName: { selector: "#otherIndividualProvider", step: "itemDetails" },
  itemAmount: { selector: '[placeholder="$0.00"]', step: "itemSelection" },
};
const DATE: Record<DateTarget, { selector: string }> = { purchaseDate: { selector: "#purchaseDate" }, serviceDate: { selector: "#serviceDate" } };
const PICK: Record<PickTarget, { step: WizardStep }> = {
  student: { step: "studentSelection" },
  category: { step: "itemDetails" },
  categoryType: { step: "itemDetails" },
  categoryDetail: { step: "itemDetails" },
  provider: { step: "itemDetails" },
  payee: { step: "itemDetails" },
  individualProvider: { step: "itemDetails" },
};
const FILE: Record<FileTarget, { step: WizardStep }> = { receipt: { step: "upload" }, additional: { step: "additionalDocuments" } };
const FILE_INPUT = "#inputDrop__";
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const ACCEPTED = /\.(png|jpe?g|pdf)$/i;

const NUMERIC: ReadonlySet<string> = new Set(["quantity", "cost", "additionalCosts", "itemAmount"]);
/** Whether the field shows what was set. StepUp formats money ("5" becomes "$5.00"), so numbers are compared as numbers. */
function sameValue(target: string, kind: "text" | "date", set: string, shown: string): boolean {
  if (kind === "text" && NUMERIC.has(target)) {
    const n = (v: string): number => Number.parseFloat(v.replace(/[^0-9.\-]/g, ""));
    return Number.isFinite(n(set)) && Math.abs(n(set) - n(shown)) < 0.005;
  }
  return shown === set;
}

const ids = (env: Env): string[] =>
  mapOf(env).controls.map((c) => c.id ?? c.placeholder ?? c.label ?? c.kind).filter((v, i, a) => a.indexOf(v) === i);

/** Why the page is not ready for a test, or undefined when it is. */
function notReady(env: Env, wantStep: WizardStep): string | undefined {
  const r = recognise(mapOf(env));
  if (r.step !== wantStep) return `This test is for the ${wantStep} step; the page is ${r.step ?? "not a step of the form"}.`;
  if (r.busy) return "The page says it is still working. Wait for it to finish.";
  if (r.variant === "confirmDelete") return "StepUp is asking whether to delete an item. Answer that first.";
  return undefined;
}

export async function runSpike(test: SpikeTest, env: Env): Promise<SpikeResult> {
  switch (test.kind) {
    case "text":
    case "date":
      return enter(test, env);
    case "pick":
      return pick(test, env);
    case "file":
      return attach(test, env);
  }
}

async function enter(test: Extract<SpikeTest, { kind: "text" | "date" }>, env: Env): Promise<SpikeResult> {
  const where = test.kind === "text" ? TEXT[test.target] : { ...DATE[test.target], step: "itemDetails" as WizardStep };
  const name = `${test.kind} ${test.target} #${test.index + 1} (${test.method})`;
  if (!where) return { test: name, ok: false, lines: ["Not a control this test knows."] };
  const why = notReady(env, where.step);
  if (why) return { test: name, ok: false, lines: [why] };
  if (env.ops.count(where.selector) <= test.index) return { test: name, ok: false, lines: [`The page has ${env.ops.count(where.selector)} of these; asked for number ${test.index + 1}.`] };
  const before = env.ops.value(where.selector, test.index) ?? "";
  const totalBefore = env.ops.itemTotal?.(test.index);
  const saves = env.saves();
  env.ops.setValue(where.selector, test.index, test.value, test.method);
  const lines = [`Before: "${before}". Set to "${test.value}" by ${test.method === "typed" ? "typing it in a character at a time" : "setting it and sending input, change and blur"}.`];
  let after = "";
  for (let i = 0; i < 6; i++) {
    await env.sleep(500);
    after = env.ops.value(where.selector, test.index) ?? "";
  }
  const kept = sameValue(test.target, test.kind, test.value, after);
  lines.push(`After 3 s: "${after}". ${kept ? "The field shows it." : "The field does NOT show what was set."}`);
  const totalAfter = env.ops.itemTotal?.(test.index);
  if (totalBefore !== undefined || totalAfter !== undefined) {
    const moved = totalBefore !== totalAfter;
    lines.push(`The item's total on the page: ${totalBefore ?? "not shown"} before, ${totalAfter ?? "not shown"} after.${moved ? " StepUp recomputed it, so it has taken the value." : " It did not change (it will not if the field is not part of the sum)."}`);
  }
  // StepUp saves at step changes, so a missing save here is normal; it is reported, not judged.
  lines.push(env.saves() > saves ? "StepUp also made a save request after this." : "StepUp made no save request (it saves at step changes).");
  return { test: name, ok: kept, lines };
}

async function pick(test: Extract<SpikeTest, { kind: "pick" }>, env: Env): Promise<SpikeResult> {
  const name = `pick ${test.target} #${test.index + 1}`;
  const why = notReady(env, PICK[test.target].step);
  if (why) return { test: name, ok: false, lines: [why] };
  const beforeIds = ids(env);
  const saves = env.saves();
  if (!env.ops.openPicker(test.target, test.index)) return { test: name, ok: false, lines: ["That dropdown is not on the page."] };
  await env.sleep(400);
  const options = env.ops.menuTexts();
  const lines = [`The list opened with ${options.length} entr${options.length === 1 ? "y" : "ies"}.`];
  if (!options.includes(test.option)) {
    const near = options.filter((o) => o.toLowerCase().includes(test.option.toLowerCase())).length;
    lines.push(`No entry reads exactly "${test.option}" (${near} contain it). Nothing was chosen.`);
    return { test: name, ok: false, lines };
  }
  const clicked = env.ops.clickMenuItem(test.option);
  await env.sleep(1500);
  const shown = env.ops.pickerText(test.target, test.index) ?? "";
  const took = clicked && shown.includes(test.option);
  lines.push(took ? "The dropdown now shows the choice." : "The dropdown does NOT show the choice.");
  const afterIds = ids(env);
  const appeared = afterIds.filter((i) => !beforeIds.includes(i));
  const gone = beforeIds.filter((i) => !afterIds.includes(i));
  if (appeared.length) lines.push(`Appeared: ${appeared.join(", ")}.`);
  if (gone.length) lines.push(`Disappeared: ${gone.join(", ")}.`);
  const saved = env.saves() > saves;
  lines.push(saved ? "StepUp saved the form after this." : "StepUp made no save request after this.");
  return { test: name, ok: took, lines };
}

async function attach(test: Extract<SpikeTest, { kind: "file" }>, env: Env): Promise<SpikeResult> {
  const name = `file ${test.target}`;
  const why = notReady(env, FILE[test.target].step);
  if (why) return { test: name, ok: false, lines: [why] };
  if (!ACCEPTED.test(test.name)) return { test: name, ok: false, lines: ["StepUp takes PNG, JPG, JPEG or PDF only."] };
  if (test.bytes.byteLength > MAX_FILE_BYTES) return { test: name, ok: false, lines: ["StepUp takes files up to 5MB."] };
  if (env.ops.count(FILE_INPUT) === 0) return { test: name, ok: false, lines: ["The file input is not on the page."] };
  const had = documentsShown(env);
  const saves = env.saves();
  env.ops.setFiles(FILE_INPUT, 0, { name: test.name, mime: test.mime, bytes: test.bytes });
  const lines = [`Handed the file to the page's own file control (${Math.round(test.bytes.byteLength / 1024)} KB).`];
  const started = Date.now();
  let shown = had;
  for (let i = 0; i < 120; i++) {
    await env.sleep(500);
    shown = documentsShown(env);
    if (shown > had) break;
  }
  const took = shown > had;
  lines.push(took ? `A file row appeared (${shown} shown, was ${had}).` : "No file row appeared within 60 s.");
  void started;
  const saved = env.saves() > saves;
  lines.push(saved ? "StepUp saved the form after this." : "StepUp made no save request after this.");
  return { test: name, ok: took, lines };
}

/** How many attached files the page shows: the name row on upload, or the document links on additional documents. */
function documentsShown(env: Env): number {
  const m = mapOf(env);
  const named = m.controls.filter((c) => c.id === "fileName" || /^display_Document_/.test(c.id ?? "")).reduce((n, c) => n + (c.count ?? 1), 0);
  return named;
}
