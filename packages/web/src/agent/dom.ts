import type { FormEl } from "./form.js";
import { mapForm } from "./form.js";
import type { FileData, FilingOps, PickTarget, PressTarget } from "./engine.js";
import type { EntryMethod, PageOps } from "./spike.js";

/**
 * What the spike tests and the filing engine do to StepUp's page, in the browser. Everything that touches the DOM lives
 * here and is deliberately thin; the decisions are in engine.ts and fill.ts, which are tested without a browser.
 *
 * Buttons: only the few named in `PressTarget` can be pressed, found by their own words, and a button whose words begin
 * with "Submit" is never pressed (the guard below also holds it against a person's click while the engine is not sure).
 */

const BLOCK = ".accordion-item.accordion-card-container";
const FILE_INPUT = "#inputDrop__";

const visible = (e: Element): boolean => {
  try {
    const h = e as HTMLElement;
    return h.getClientRects().length > 0 && getComputedStyle(h).visibility !== "hidden";
  } catch {
    return true;
  }
};
export const isVisible = (el: unknown): boolean => visible(el as Element);

export function pseudoText(el: unknown, which: "::before" | "::after"): string | undefined {
  try {
    const c = getComputedStyle(el as Element, which).content;
    return !c || c === "none" || c === "normal" ? undefined : c.replace(/^["']|["']$/g, "");
  } catch {
    return undefined;
  }
}

/** The container of item block `i` (0 is the first): StepUp numbers them from 1 in their ids. */
const block = (i: number): Element | undefined => document.querySelector(`#collapseOne____item_${i + 1}`) ?? document.querySelectorAll(BLOCK)[i] ?? undefined;
/** A selector inside a block, or (when there are no blocks on the page) anywhere, taking the i-th match. */
const within = (sel: string, i: number): Element | undefined => {
  const b = block(i);
  return b ? b.querySelector(sel) ?? undefined : document.querySelectorAll(sel)[i] ?? undefined;
};

/** Sets a field the way a person's edit would reach StepUp: through the element's own setter, then input, change, blur. */
function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string, method: EntryMethod = "events"): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const set = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (!set) return;
  el.focus();
  if (method === "typed") {
    set.call(el, "");
    el.dispatchEvent(new Event("input", { bubbles: true }));
    let typed = "";
    for (const ch of value) {
      el.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true }));
      typed += ch;
      set.call(el, typed);
      el.dispatchEvent(new InputEvent("input", { bubbles: true, data: ch, inputType: "insertText" }));
      el.dispatchEvent(new KeyboardEvent("keyup", { key: ch, bubbles: true }));
    }
  } else {
    set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
  el.dispatchEvent(new Event("change", { bubbles: true }));
  el.blur(); // StepUp commits a typed value on blur
}

function giveFile(el: HTMLInputElement, file: { name: string; mime: string; bytes: ArrayBuffer }): void {
  const dt = new DataTransfer();
  dt.items.add(new File([file.bytes], file.name, { type: file.mime }));
  el.files = dt.files;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

const PICK_TOGGLE: Partial<Record<PickTarget, string>> = {
  student: "#Student__Select",
  category: "#category",
  categoryType: "#categoryType",
  categoryDetail: "#categoryDetail",
  provider: "#provider",
  individualProvider: "#individualProvider",
};
function toggleOf(target: PickTarget, i: number): HTMLElement | undefined {
  if (target === "student") return document.querySelector<HTMLElement>("#Student__Select") ?? undefined;
  const fixed = PICK_TOGGLE[target];
  if (fixed) return (within(fixed, i) as HTMLElement | undefined) ?? undefined;
  // "Who did you pay?" for a vendor has no id: it is the dropdown inside the field with that label.
  const root = block(i) ?? document;
  const field = Array.from(root.querySelectorAll(".reimbursement-item-field")).find((f) => /^\s*Who did you pay/i.test(f.querySelector("label")?.textContent ?? ""));
  return field?.querySelector<HTMLElement>(".dropdown > button") ?? undefined;
}
const menuLeaves = (): HTMLElement[] =>
  Array.from(document.querySelectorAll<HTMLElement>(".dropdown-menu.show *")).filter((e) => e.children.length === 0 && (e.textContent ?? "").trim() !== "");
const menuTexts = (): string[] => menuLeaves().map((e) => (e.textContent ?? "").trim()).filter((t, i, a) => a.indexOf(t) === i);
function clickMenu(text: string): boolean {
  const hits = menuLeaves().filter((e) => (e.textContent ?? "").trim() === text);
  const last = hits[hits.length - 1];
  if (!last) return false;
  last.click(); // a plain DOM click: the list can sit outside the window, where a pointer click cannot reach
  return true;
}

function totalOf(container: Element | undefined): string | undefined {
  if (!container) return undefined;
  for (const e of Array.from(container.querySelectorAll<HTMLElement>("*"))) {
    const t = (e.textContent ?? "").replace(/\s+/g, " ").trim();
    if (/^\$[\d,]+(\.\d{1,2})? total$/i.test(t)) return t;
  }
  return undefined;
}

/** What the spike panel's tests may do (spike.ts). */
export const pageOps: PageOps = {
  count: (sel) => document.querySelectorAll(sel).length,
  value: (sel, i) => (document.querySelectorAll(sel)[i] as HTMLInputElement | undefined)?.value,
  setValue: (sel, i, value, method) => {
    const el = document.querySelectorAll(sel)[i] as HTMLInputElement | HTMLTextAreaElement | undefined;
    if (el) setValue(el, value, method);
  },
  setFiles: (sel, i, file) => {
    const el = document.querySelectorAll(sel)[i] as HTMLInputElement | undefined;
    if (el) giveFile(el, file);
  },
  itemTotal: (i) => totalOf(document.querySelectorAll(BLOCK)[i]),
  openPicker: (target, i) => {
    const t = toggleOf(target, i);
    if (!t) return false;
    t.click();
    return true;
  },
  pickerText: (target, i) => toggleOf(target, i)?.textContent?.trim(),
  menuTexts,
  clickMenuItem: clickMenu,
};

/**
 * The Submit guard: while a reason is set, a click on (or Enter on) a Submit button, and a form submit, go nowhere.
 * Its listeners live on the page, not in the script, so a script that is replaced (the bookmark clicked again) must take
 * the earlier script's guard away with it, or that guard keeps holding Submit with a reason from a run long over.
 */
declare global {
  interface Window {
    __stepUpGuard?: { remove(): void };
  }
}
let guardReason: string | undefined;
let guardInstalled = false;
let guardSay: ((text: string) => void) | undefined;

/** Takes any guard this page has away (this script's own, or one a replaced script left). */
export function removeGuard(): void {
  guardReason = undefined;
  guardInstalled = false;
  try {
    window.__stepUpGuard?.remove();
  } catch {
    /* nothing to remove */
  }
  window.__stepUpGuard = undefined;
}
const isSubmitButton = (t: EventTarget | null): boolean => {
  const b = (t as Element | null)?.closest?.("button, [role='button'], input[type='submit']");
  return Boolean(b && /^\s*submit\b/i.test((b as HTMLElement).textContent ?? (b as HTMLInputElement).value ?? ""));
};
function installGuard(): void {
  if (guardInstalled) return;
  guardInstalled = true;
  const stop = (ev: Event): void => {
    if (!guardReason) return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
    guardSay?.(`Submit is held. ${guardReason}`);
  };
  const onClick = (ev: Event): void => void (isSubmitButton(ev.target) && stop(ev));
  const onKey = (ev: KeyboardEvent): void => void ((ev.key === "Enter" || ev.key === " ") && isSubmitButton(ev.target) && stop(ev));
  document.addEventListener("click", onClick, true);
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("submit", stop, true);
  window.__stepUpGuard = {
    remove: () => {
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("submit", stop, true);
    },
  };
}

/** The engine's view of the page (engine.ts). `say` is how a held Submit explains itself. */
export function makeFilingOps(say: (text: string) => void): FilingOps {
  guardSay = say;
  // A new script starts with nothing held: whatever an earlier one left on this page is from a run that is over.
  removeGuard();
  const buttons = (): HTMLButtonElement[] => Array.from(document.querySelectorAll<HTMLButtonElement>("button")).filter((b) => visible(b));
  const words = (b: Element): string => (b.textContent ?? "").replace(/\s+/g, " ").trim();
  const press = (what: PressTarget, i = 0): boolean => {
    let target: HTMLElement | undefined;
    if (what === "confirmDelete") target = document.querySelector<HTMLElement>("#confirm-button") ?? undefined;
    else if (what === "cancelDelete") target = document.querySelector<HTMLElement>("#deny-button") ?? undefined;
    else if (what === "deleteItem") target = Array.from((block(i) ?? document).querySelectorAll<HTMLButtonElement>("button")).find((b) => /^delete$/i.test(words(b)) && !b.disabled && visible(b));
    else if (what === "navReimbursements") target = Array.from(document.querySelectorAll<HTMLElement>("#sidenav a")).find((a) => /^reimbursements?$/i.test(words(a)) && visible(a));
    else if (what === "newReimbursement") target = document.querySelector<HTMLElement>("#New__Reimbursement__Button") ?? undefined;
    else if (what === "requestAnother") {
      const scope = document.querySelector("#Content__Wrapper .confirmation-container") ?? document;
      target = Array.from(scope.querySelectorAll<HTMLElement>("button")).find((b) => /^request another reimbursement/i.test(words(b)) && visible(b));
    } else {
      const re = what === "continue" ? /^continue/i : what === "back" ? /^back$/i : /^add an item$/i;
      target = buttons().find((b) => re.test(words(b)) && !b.disabled);
    }
    if (!target || (target as HTMLButtonElement).disabled) return false;
    if (/^\s*submit\b/i.test(target.textContent ?? "")) return false; // never, whatever was asked for
    target.click();
    return true;
  };
  return {
    map: () => mapForm(document as unknown as Parameters<typeof mapForm>[0], location.href, { visible: (e: FormEl) => visible(e as unknown as Element), pseudo: (e, w) => pseudoText(e, w) }),
    now: () => Date.now(),
    has: (i, sel) => Boolean(within(sel, i)),
    read: (i, sel) => (within(sel, i) as HTMLInputElement | undefined)?.value,
    write: (i, sel, value) => {
      const el = within(sel, i) as HTMLInputElement | HTMLTextAreaElement | undefined;
      if (el) setValue(el, value, "events");
    },
    hasPicker: (i, t) => Boolean(toggleOf(t, i)),
    open: (i, t) => {
      const el = toggleOf(t, i);
      if (!el) return false;
      el.click();
      return true;
    },
    menu: menuTexts,
    choose: clickMenu,
    shown: (i, t) => toggleOf(t, i)?.textContent?.trim(),
    attach: (file: FileData) => {
      const el = document.querySelector<HTMLInputElement>(FILE_INPUT);
      if (el) giveFile(el, file);
    },
    boxLabels: () => Array.from(document.querySelectorAll("div.right-container > div.line-items .form-check-label")).map((l) => (l.textContent ?? "").trim()),
    check: (i) => {
      const box = document.querySelectorAll<HTMLInputElement>('div.right-container > div.line-items input[id^="item_"]')[i];
      if (box && !box.checked) box.click();
    },
    blocks: () => ({
      named: Array.from(document.querySelectorAll(BLOCK)).map((b) => {
        const h = b.querySelector("h3")?.textContent ?? "";
        return h.includes(":") && h.split(":").slice(1).join(":").trim().length > 0;
      }),
    }),
    scan: (i) => {
      const b = document.querySelectorAll(BLOCK)[i];
      const heading = b?.querySelector("h3")?.textContent ?? "";
      const name = heading.includes(":") ? heading.split(":").slice(1).join(":").trim() : undefined;
      const cost = (b?.querySelector('[placeholder="Enter Cost per Item"]') as HTMLInputElement | null)?.value;
      return { ...(cost ? { cost } : {}), ...(name ? { name } : {}) };
    },
    itemTotal: (i) => totalOf(document.querySelectorAll(BLOCK)[i]),
    confirmationNumber: () => {
      const m = /reimbursement request for Reimbursement #(\d+)/i.exec(document.body?.innerText ?? "");
      return m && m[1] !== "0" ? m[1] : undefined;
    },
    press,
    guard: (reason) => {
      installGuard();
      guardReason = reason;
    },
  };
}

/** Lets a person release the held Submit on purpose (from the app). */
export function releaseGuard(): void {
  guardReason = undefined;
}
