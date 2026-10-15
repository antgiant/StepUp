/**
 * Reading StepUp's reimbursement form (read-only): which wizard step the page is on, and a map of the controls on it.
 * The map is names and types only, never what is typed or chosen, so it is safe to share and is what step signatures are
 * made from. Nothing here changes the page.
 */

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/** The wizard's steps, numbered in the URL (recorded from the site; the command line used the same patterns). */
export const STEP_PATTERNS = {
  studentSelection: new RegExp(`/SubmitReimbursement(?:/${UUID})?/?(?:[?#]|$)`, "i"),
  upload: new RegExp(`/SubmitReimbursement/${UUID}/1(?:[/?#]|$)`, "i"),
  itemSelection: new RegExp(`/SubmitReimbursement/${UUID}/2(?:[/?#]|$)`, "i"),
  itemDetails: new RegExp(`/SubmitReimbursement/${UUID}/3(?:[/?#]|$)`, "i"),
  additionalDocuments: new RegExp(`/SubmitReimbursement/${UUID}/4(?:[/?#]|$)`, "i"),
  summary: new RegExp(`/SubmitReimbursement/${UUID}/5(?:[/?#]|$)`, "i"),
  confirmation: /\/SubmitReimbursement\/Confirmation\//i,
} as const;
export type WizardStep = keyof typeof STEP_PATTERNS;

/** Which wizard step a URL is, or undefined when it is not part of the reimbursement wizard. */
export function detectStep(url: string): WizardStep | undefined {
  return (Object.keys(STEP_PATTERNS) as WizardStep[]).find((s) => STEP_PATTERNS[s].test(url));
}

/** Just enough of an element for the map; a real DOM element satisfies it, tests supply plain objects. */
export interface FormEl {
  tagName: string;
  textContent: string | null;
  value?: string;
  checked?: boolean;
  disabled?: boolean;
  getAttribute(name: string): string | null;
  closest(selector: string): FormEl | null;
  querySelectorAll(selector: string): ArrayLike<FormEl>;
}
export interface FormRoot {
  querySelectorAll(selector: string): ArrayLike<FormEl>;
}

export interface MappedControl {
  /** input type, or `select`, `textarea`, `button`, `dropdown` (a button that opens a list). */
  kind: string;
  id?: string;
  name?: string;
  placeholder?: string;
  /** The field's visible label (static words). Never a chosen or typed value. */
  label?: string;
  /** Button words, kept only for the few buttons whose words are the wizard's own (Continue, Back, Add an Item, …). */
  text?: string;
  /** The item block (`item_N`) the control sits in, when it is inside one. */
  block?: string;
  required?: boolean;
  disabled?: boolean;
  /** Whether it holds something right now; the something is never read out. */
  hasValue?: boolean;
  /** How many choices a dropdown lists (their words are not kept: they can be names). */
  options?: number;
  /** The same control repeated this many times (item blocks repeat ids). */
  count?: number;
}

export interface FormMap {
  step?: WizardStep;
  /** The page's path with ids replaced, e.g. `/SubmitReimbursement/<id>/3`. */
  path: string;
  controls: MappedControl[];
  headings: string[];
  /** Words of notices on the page (e.g. the scan's states), only those matching the known list. */
  notices: string[];
}

const CONTROLS = "input, select, textarea, button, [role='button'], [role='combobox'], [role='checkbox'], [role='switch']";
const BUTTON_WORDS = /^(continue|back|next|previous|submit.*|add an item|add item|delete|delete item|retry|cancel|save.*|upload.*|browse.*|select all|request another reimbursement)$/i;
const NOTICE_WORDS = /(one moment while we read your document|not able to detect items or services|something went wrong on our end|reimbursement request for reimbursement #)/i;
const clean = (s: string | null | undefined, max = 60): string | undefined => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t ? t.slice(0, max) : undefined;
};
/** "Item 1 : Some product name" keeps only "Item 1": what follows the colon is read from the receipt. */
const wordsOnly = (s: string | undefined): string | undefined => (s === undefined ? s : s.split(/\s:\s|:\s/)[0]?.trim() || undefined);

function labelOf(el: FormEl): string | undefined {
  const aria = clean(el.getAttribute("aria-label"));
  if (aria) return aria;
  const field = el.closest(".reimbursement-item-field, .form-group, .form-check, .mb-3");
  const label = field?.querySelectorAll("label")[0];
  return wordsOnly(clean(label?.textContent));
}

export function mapForm(root: FormRoot, url: string): FormMap {
  const step = detectStep(url);
  const path = url.replace(/^https?:\/\/[^/]+/i, "").replace(/[?#].*$/, "").replace(new RegExp(UUID, "ig"), "<id>");
  const seen = new Map<string, MappedControl>();
  for (const el of Array.from(root.querySelectorAll(CONTROLS))) {
    const tag = el.tagName.toLowerCase();
    const inDropdown = Boolean(el.closest(".dropdown-menu"));
    if (inDropdown) continue; // the list's own entries are choices, not controls
    const toggles = tag === "button" && (/dropdown-toggle/.test(el.getAttribute("class") ?? "") || el.getAttribute("aria-haspopup") !== null || Boolean(el.closest(".dropdown")));
    const kind = toggles ? "dropdown" : tag === "input" ? (el.getAttribute("type") ?? "text").toLowerCase() : tag;
    const c: MappedControl = { kind };
    const id = clean(el.getAttribute("id"), 80);
    if (id) c.id = id;
    const name = clean(el.getAttribute("name"), 80);
    if (name) c.name = name;
    const placeholder = clean(el.getAttribute("placeholder"));
    if (placeholder) c.placeholder = placeholder;
    const label = labelOf(el);
    if (label) c.label = label;
    if (tag === "button" && !toggles) {
      const text = clean(el.textContent);
      if (text && BUTTON_WORDS.test(text)) c.text = text;
    }
    const block = el.closest("[id^='collapseOne____item_']")?.getAttribute("id");
    if (block) c.block = block;
    if (el.getAttribute("required") !== null || el.getAttribute("aria-required") === "true") c.required = true;
    if (el.disabled || el.getAttribute("disabled") !== null) c.disabled = true;
    if (tag === "input" || tag === "textarea" || tag === "select") c.hasValue = kind === "checkbox" || kind === "radio" ? Boolean(el.checked) : (el.value ?? "").length > 0;
    if (toggles) c.options = el.closest(".dropdown")?.querySelectorAll("li, .dropdown-item").length ?? 0;
    // Repeats of the same control in other item blocks collapse into one line with a count (the block id is left out of the key).
    const key = JSON.stringify([c.kind, c.id, c.name, c.placeholder, c.label, c.text, c.required, c.disabled, c.hasValue, c.options]);
    const had = seen.get(key);
    if (had) had.count = (had.count ?? 1) + 1;
    else seen.set(key, c);
  }
  const headings = Array.from(root.querySelectorAll("h1, h2, h3, h4"))
    .map((h) => wordsOnly(clean(h.textContent)))
    .filter((t): t is string => Boolean(t))
    .filter((t, i, all) => all.indexOf(t) === i)
    .slice(0, 40);
  const notices = Array.from(root.querySelectorAll("p, div, span"))
    .map((e) => clean(e.textContent, 200))
    .filter((t): t is string => Boolean(t) && NOTICE_WORDS.test(t!) && t!.length < 200)
    .map((t) => t.replace(/reimbursement #\d+/i, "reimbursement #<number>"))
    .filter((t, i, all) => all.indexOf(t) === i)
    .slice(0, 6);
  return { ...(step ? { step } : {}), path, controls: [...seen.values()], headings, notices };
}
