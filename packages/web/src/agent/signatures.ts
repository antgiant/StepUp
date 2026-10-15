import type { FormMap, MappedControl, WizardStep } from "./form.js";

/**
 * What each wizard step of StepUp's reimbursement form is expected to hold, written from recorded form maps (October 2026).
 * `recognise` compares a map of the page with it and answers with problems, never a guess: a control that is not on the
 * list is "unexpected", a required one that is absent is "missing", and the caller (the filling code) does nothing on a
 * step that has a problem. Pure: it only reads a map.
 */

export interface Recognition {
  step?: WizardStep;
  /** Which version of the step the page shows (for example `detected`, `notDetected`, `scanning` on item selection). */
  variant: string;
  /** The page says it is working (a scan, an upload): nothing to judge yet, wait. */
  busy: boolean;
  /** Everything that is not as expected; empty means the step is recognised exactly. */
  problems: string[];
}

interface Rule {
  name: string;
  match(c: MappedControl): boolean;
  required?: boolean;
}

const eq = (a: string | undefined, b: string): boolean => a === b;
const text = (re: RegExp) => (c: MappedControl): boolean => c.kind === "button" && re.test(c.text ?? "");
const byId = (kind: string, id: string) => (c: MappedControl): boolean => c.kind === kind && eq(c.id, id);
const byIdRe = (kind: string, re: RegExp) => (c: MappedControl): boolean => c.kind === kind && re.test(c.id ?? "");
const byLabel = (kind: string, re: RegExp) => (c: MappedControl): boolean => c.kind === kind && re.test(c.label ?? "");
const byPlaceholder = (re: RegExp) => (c: MappedControl): boolean => re.test(c.placeholder ?? "");

const STEPPER = /^(student selection|receipt\/invoice upload|item\/service selection|item\/service details|additional documents|summary)$/i;

/** The page's own furniture that is on every step: menus, the step indicator, number spinners, header and footer links. */
const isChrome = (c: MappedControl): boolean =>
  (c.kind === "dropdown" && (c.id === "notificationDropDown" || c.id === "profileDropdown")) ||
  (c.kind === "button" && STEPPER.test(c.text ?? "")) ||
  (c.kind === "button" && (c.build?.classes ?? []).some((k) => k === "textual-stepper-button" || k === "rz-numeric-button")) ||
  (c.kind === "link" && !c.id && !c.text);

const SCANNING = /one moment while we read your document/i;
const NOT_DETECTED = /not able to detect items or services/i;
const READ_ERROR = /something went wrong on our end/i;
const DETECTED = /item\(s\) and\/or service\(s\) detected/i;
const LOADING = /^loading\.{3}$/i;

function rulesFor(step: WizardStep, headings: string[]): { variant: string; busy: boolean; rules: Rule[] } {
  const has = (re: RegExp): boolean => headings.some((h) => re.test(h));
  const busy = has(LOADING);
  switch (step) {
    case "studentSelection":
      return {
        variant: "default",
        busy,
        rules: [
          { name: "student picker", match: byId("dropdown", "Student__Select"), required: true },
          // Not verified on a recorded v6 map: the last button, expected to be a Continue.
          { name: "Continue", match: text(/^continue/i) },
        ],
      };
    case "upload":
      return {
        variant: "upload",
        busy,
        rules: [
          // Before a file: the file input and BROWSE. After: its name row and a delete button instead.
          { name: "file input", match: byId("file", "inputDrop__") },
          { name: "BROWSE", match: text(/^browse$/i) },
          { name: "file name", match: byId("text", "fileName") },
          { name: "remove file", match: byId("button", "fileDeleteButton") },
          { name: "BACK", match: text(/^back$/i), required: true },
          { name: "Continue", match: text(/^continue/i) },
          { name: "file row button", match: (c) => c.kind === "button" && !c.id && !c.text },
          { name: "quick view", match: text(/^quick view$/i) },
        ],
      };
    case "itemSelection": {
      const variant = has(SCANNING) ? "scanning" : has(NOT_DETECTED) ? "notDetected" : has(READ_ERROR) ? "readError" : has(DETECTED) ? "detected" : "unknown";
      const common: Rule[] = [{ name: "BACK", match: text(/^back$/i) }, { name: "Continue", match: text(/^continue/i) }];
      if (variant === "scanning") return { variant, busy: true, rules: [] };
      if (variant === "notDetected") return { variant, busy, rules: [...common, { name: "upload a different document", match: text(/^upload a different document$/i) }] };
      if (variant === "readError") return { variant, busy, rules: [...common, { name: "retry", match: text(/^retry$/i) }, { name: "upload a different document", match: text(/^upload a different document$/i) }] };
      if (variant === "detected") {
        return {
          variant,
          busy,
          rules: [
            ...common,
            { name: "select all", match: byId("checkbox", "select-all"), required: true },
            { name: "item checkbox", match: byIdRe("checkbox", /^item_\d+$/), required: true },
            { name: "receipt viewer", match: text(/^(zoom_out|zoom_in|open_in_new)$/i) },
            // Shown once an item is ticked: its name and amount.
            { name: "item name", match: (c) => c.kind === "text" && !c.placeholder && !c.id },
            { name: "item amount", match: byPlaceholder(/^\$0\.00$/) },
          ],
        };
      }
      return { variant, busy, rules: [] };
    }
    case "itemDetails":
      return {
        variant: "default",
        busy,
        rules: [
          { name: "purchase date", match: byId("date", "purchaseDate"), required: true },
          { name: "category", match: byId("dropdown", "category"), required: true },
          { name: "quantity", match: byPlaceholder(/^Enter Quantity$/i), required: true },
          { name: "cost per item", match: byPlaceholder(/^Enter Cost per Item$/i), required: true },
          { name: "additional costs", match: byPlaceholder(/^Enter Additional Costs$/i), required: true },
          { name: "invoice number", match: byId("text", "invoiceNumber") },
          { name: "category type", match: byId("dropdown", "categoryType") },
          { name: "category description", match: byId("dropdown", "categoryDetail") },
          { name: "service date", match: byId("date", "serviceDate") },
          { name: "who did you pay (listed)", match: byId("dropdown", "provider") },
          { name: "who did you pay (vendor)", match: byLabel("dropdown", /^Who did you pay\?/i) },
          { name: "vendor name", match: byId("text", "vendorName") },
          { name: "provider name", match: byId("text", "otherServiceProviderName") },
          { name: "benefit message", match: byId("textarea", "educationalBenefit") },
          { name: "item URL", match: byId("text", "itemServiceUrl") },
          { name: "view details", match: text(/^view details/i) },
          { name: "delete item", match: text(/^delete$/i) },
          { name: "add an item", match: text(/^add an item$/i), required: true },
          { name: "BACK", match: text(/^back$/i), required: true },
          { name: "Continue", match: text(/^continue.*additional documents/i), required: true },
        ],
      };
    case "additionalDocuments":
      return {
        variant: "default",
        busy,
        rules: [
          { name: "file input", match: byId("file", "inputDrop__"), required: true },
          { name: "BROWSE", match: text(/^browse$/i), required: true },
          { name: "attached document name", match: byIdRe("link", /^display_Document_/) },
          { name: "remove attached document", match: byIdRe("link", /^delete_Document_/) },
          { name: "BACK", match: text(/^back$/i), required: true },
          { name: "Continue", match: text(/^continue.*summary/i), required: true },
        ],
      };
    case "summary":
      return {
        variant: "default",
        busy,
        rules: [
          { name: "edit an item", match: byIdRe("button", /^editButton_\d+$/) },
          { name: "BACK", match: byId("button", "backButton"), required: true },
          { name: "Submit for approval", match: text(/^submit for approval$/i), required: true },
        ],
      };
    case "confirmation":
      return { variant: "default", busy, rules: [{ name: "request another", match: text(/request another reimbursement/i) }] };
  }
}

/** The describe-a-control words used in a problem line. Never includes a value: a map holds none. */
const describe = (c: MappedControl): string => [c.kind, c.id, c.label ?? c.placeholder ?? c.text].filter(Boolean).join(" ");

/** Compares a map of the page with what its wizard step should hold. */
export function recognise(map: FormMap): Recognition {
  const step = map.step;
  if (!step) return { variant: "none", busy: false, problems: ["This is not a page of the reimbursement form."] };
  const { variant, busy, rules } = rulesFor(step, map.headings);
  if (variant === "unknown") return { step, variant, busy, problems: ["This step's page is not one StepUp's form was seen to show here."] };
  if (busy) return { step, variant, busy: true, problems: [] };

  const problems: string[] = [];
  const hit = new Set<Rule>();
  for (const c of map.controls) {
    if (isChrome(c)) continue;
    const rule = rules.find((r) => r.match(c));
    if (rule) hit.add(rule);
    else problems.push(`unexpected: ${describe(c)}`);
  }
  for (const r of rules) if (r.required && !hit.has(r)) problems.push(`missing: ${r.name}`);

  if (step === "itemDetails") problems.push(...payeeProblems(map));
  if (step === "additionalDocuments") problems.push(...documentProblems(map));
  if (step === "upload") problems.push(...uploadProblems(map));
  return { step, variant, busy: false, problems };
}

const count = (map: FormMap, match: (c: MappedControl) => boolean): number => map.controls.filter(match).reduce((n, c) => n + (c.count ?? 1), 0);

/** Exactly one way of saying who was paid: a vendor, a listed provider, or a provider typed in. Anything else is a doubt. */
function payeeProblems(map: FormMap): string[] {
  const provider = count(map, byId("dropdown", "provider"));
  const vendor = count(map, byId("text", "vendorName"));
  const other = count(map, byId("text", "otherServiceProviderName"));
  const generic = count(map, byLabel("dropdown", /^Who did you pay\?/i));
  if (provider + generic === 0) return ["missing: who did you pay"];
  if (provider > 0 && vendor > 0) return ["unexpected: a provider list and a vendor name are both showing"];
  if (other > 0 && provider === 0) return ["unexpected: a provider name field without the provider list"];
  return [];
}

/** Every attached document has both its name row and its delete link. */
function documentProblems(map: FormMap): string[] {
  const shown = count(map, byIdRe("link", /^display_Document_/));
  const removable = count(map, byIdRe("link", /^delete_Document_/));
  return shown === removable ? [] : [`unexpected: ${shown} attached document(s) shown but ${removable} with a delete link`];
}

/** Either a file input waiting for a file, or the file's row: not both and not neither. */
function uploadProblems(map: FormMap): string[] {
  const waiting = count(map, byId("file", "inputDrop__")) > 0;
  const attached = count(map, byId("text", "fileName")) > 0;
  if (waiting === attached) return [waiting ? "unexpected: a file input and an attached file's name are both showing" : "missing: the file input or the attached file's name"];
  return [];
}

/** Whether a control's words are those of the final submit button: the one thing the agent never presses. */
export const isSubmitWords = (words: string | undefined): boolean => /^\s*submit\b/i.test(words ?? "");

/** The Summary page's total as a number, read from the heading that follows "Total". Undefined when it is not there. */
export function summaryTotal(map: FormMap): number | undefined {
  const i = map.headings.findIndex((h) => /^total$/i.test(h));
  const amount = i >= 0 ? map.headings[i + 1] : undefined;
  const n = amount ? Number.parseFloat(amount.replace(/[^0-9.\-]/g, "")) : NaN;
  return Number.isFinite(n) ? n : undefined;
}
