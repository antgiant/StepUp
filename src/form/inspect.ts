import type { Page } from "playwright";

export interface FieldInfo {
  tag: string;
  type: string;
  name: string;
  id: string;
  label: string;
  placeholder: string;
  hasValue: boolean;
  selectorSuggestion: string;
  options?: string[];
  role?: string;
}

/**
 * Dumps every visible input/select/textarea, plus custom ARIA-based controls (combobox,
 * listbox, option, button, anything with aria-haspopup — common for styled dropdowns that
 * aren't real <select> elements), as structural metadata only (labels, names, ids, types,
 * short text content) — never a field's actual filled-in value, so applicant PII never ends
 * up in terminal output or logs.
 */
export async function dumpFormFields(page: Page): Promise<FieldInfo[]> {
  // Passed as a source string, not a function reference: tsx/esbuild injects a `__name(...)`
  // helper around any named function/const binding it compiles, which breaks once Playwright
  // ships that compiled code into the browser (no such helper exists there). A string bypasses
  // our bundler's transform entirely — Playwright just evals it directly in the page.
  return page.evaluate(`(() => {
    const labelFor = (el) => {
      const id = el.getAttribute("id");
      if (id) {
        const lbl = document.querySelector('label[for="' + CSS.escape(id) + '"]');
        if (lbl && lbl.textContent) return lbl.textContent.trim();
      }
      const closestLabel = el.closest("label");
      if (closestLabel && closestLabel.textContent) return closestLabel.textContent.trim();
      const ariaLabel = el.getAttribute("aria-label");
      if (ariaLabel) return ariaLabel.trim();
      const describedBy = el.getAttribute("aria-describedby") || el.getAttribute("aria-labelledby");
      if (describedBy) {
        const d = document.getElementById(describedBy);
        if (d && d.textContent) return d.textContent.trim();
      }
      return "";
    };

    const suggestSelector = (el, text) => {
      const id = el.getAttribute("id");
      if (id) return '[id="' + id + '"]';
      const name = el.getAttribute("name");
      if (name) return '[name="' + name + '"]';
      const testId = el.getAttribute("data-testid") || el.getAttribute("data-test-id");
      if (testId) return '[data-testid="' + testId + '"]';
      if (text) return 'text="' + text.replace(/"/g, '\\\\"') + '"';
      return "";
    };

    const seen = new Set();
    const results = [];

    const nativeFields = Array.from(document.querySelectorAll("input, select, textarea"))
      .filter((el) => el.offsetParent !== null);
    for (const el of nativeFields) {
      if (seen.has(el)) continue;
      seen.add(el);
      const tag = el.tagName.toLowerCase();
      const type = el.type || tag;
      if (type === "hidden") continue;
      const hasValue = tag === "select" ? el.selectedIndex > 0 : Boolean(el.value);
      const info = {
        tag,
        type,
        name: el.getAttribute("name") || "",
        id: el.getAttribute("id") || "",
        label: labelFor(el),
        placeholder: el.getAttribute("placeholder") || "",
        hasValue,
        selectorSuggestion: suggestSelector(el, null),
      };
      if (tag === "select") {
        info.options = Array.from(el.options).map((o) => (o.textContent || "").trim());
      }
      results.push(info);
    }

    const customControls = Array.from(
      document.querySelectorAll(
        'button, [role="combobox"], [role="listbox"], [role="option"], [role="button"], [role="radio"], [role="checkbox"], [aria-haspopup]'
      )
    ).filter((el) => el.offsetParent !== null);
    for (const el of customControls) {
      if (seen.has(el)) continue;
      seen.add(el);
      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute("role") || "";
      const ownText = Array.from(el.childNodes)
        .filter((n) => n.nodeType === 3)
        .map((n) => n.textContent || "")
        .join(" ")
        .trim();
      const text = (ownText || el.textContent || "").trim().slice(0, 120);
      results.push({
        tag,
        type: role || tag,
        role,
        name: el.getAttribute("name") || "",
        id: el.getAttribute("id") || "",
        label: labelFor(el) || text,
        placeholder: el.getAttribute("placeholder") || "",
        hasValue: el.getAttribute("aria-expanded") === "true",
        selectorSuggestion: suggestSelector(el, text),
      });
    }

    return results;
  })()`) as Promise<FieldInfo[]>;
}

export function printFieldTable(fields: FieldInfo[]): void {
  console.log(`\nFound ${fields.length} visible field(s)/control(s) on this page:\n`);
  for (const f of fields) {
    const bits = [
      `type=${f.type}`,
      f.role && `role="${f.role}"`,
      f.label && `label="${f.label}"`,
      f.name && `name="${f.name}"`,
      f.id && `id="${f.id}"`,
      f.placeholder && `placeholder="${f.placeholder}"`,
      f.hasValue && "(already has a value / expanded)",
    ].filter(Boolean);
    console.log(`  - ${bits.join("  ")}`);
    if (f.options?.length) console.log(`      options: ${f.options.join(" | ")}`);
    if (f.selectorSuggestion) console.log(`      suggested selector: ${f.selectorSuggestion}`);
  }
}
