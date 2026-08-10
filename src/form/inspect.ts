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
}

/**
 * Dumps every visible input/select/textarea on the current page as structural
 * metadata only (labels, names, ids, types) — never the field's actual value,
 * so applicant PII never ends up in terminal output or logs.
 */
export async function dumpFormFields(page: Page): Promise<FieldInfo[]> {
  return page.evaluate(() => {
    function labelFor(el: Element): string {
      const id = el.getAttribute("id");
      if (id) {
        const lbl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
        if (lbl?.textContent) return lbl.textContent.trim();
      }
      const closestLabel = el.closest("label");
      if (closestLabel?.textContent) return closestLabel.textContent.trim();
      const ariaLabel = el.getAttribute("aria-label");
      if (ariaLabel) return ariaLabel.trim();
      const describedBy = el.getAttribute("aria-describedby");
      if (describedBy) {
        const d = document.getElementById(describedBy);
        if (d?.textContent) return d.textContent.trim();
      }
      return "";
    }

    function suggestSelector(el: Element): string {
      const id = el.getAttribute("id");
      if (id) return `#${CSS.escape(id)}`;
      const name = el.getAttribute("name");
      if (name) return `[name="${name}"]`;
      return "";
    }

    const elements = Array.from(document.querySelectorAll("input, select, textarea"));
    return elements
      .filter((el) => (el as HTMLElement).offsetParent !== null)
      .map((el) => {
        const tag = el.tagName.toLowerCase();
        const type = (el as HTMLInputElement).type || tag;
        const hasValue =
          tag === "select"
            ? (el as HTMLSelectElement).selectedIndex > 0
            : Boolean((el as HTMLInputElement).value);
        const info: FieldInfo = {
          tag,
          type,
          name: el.getAttribute("name") ?? "",
          id: el.getAttribute("id") ?? "",
          label: labelFor(el),
          placeholder: el.getAttribute("placeholder") ?? "",
          hasValue,
          selectorSuggestion: suggestSelector(el),
        };
        if (tag === "select") {
          info.options = Array.from((el as HTMLSelectElement).options).map((o) => o.textContent?.trim() ?? "");
        }
        return info;
      })
      .filter((f) => f.type !== "hidden");
  });
}

export function printFieldTable(fields: FieldInfo[]): void {
  console.log(`\nFound ${fields.length} visible field(s) on this page:\n`);
  for (const f of fields) {
    const bits = [
      `type=${f.type}`,
      f.label && `label="${f.label}"`,
      f.name && `name="${f.name}"`,
      f.id && `id="${f.id}"`,
      f.placeholder && `placeholder="${f.placeholder}"`,
      f.hasValue && "(already has a value)",
    ].filter(Boolean);
    console.log(`  - ${bits.join("  ")}`);
    if (f.options?.length) console.log(`      options: ${f.options.join(" | ")}`);
    if (f.selectorSuggestion) console.log(`      suggested selector: ${f.selectorSuggestion}`);
  }
}
