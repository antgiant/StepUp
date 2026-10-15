import { describe, expect, it } from "vitest";
import { detectStep, mapForm, type FormEl, type FormRoot } from "../src/agent/form.js";

const G = "00000000-0000-4000-8000-000000000000";

interface Spec {
  tag: string;
  attrs?: Record<string, string>;
  text?: string;
  value?: string;
  checked?: boolean;
  disabled?: boolean;
  label?: string;
  block?: string;
  inMenu?: boolean;
  options?: number;
}
const bare = (tag: string, text: string | null): FormEl => ({ tagName: tag, textContent: text, getAttribute: () => null, closest: () => null, querySelectorAll: () => [] });

function el(s: Spec): FormEl {
  // The control's surrounding field: holds its label, its list entries and (for item blocks) the block's id.
  const around: FormEl = {
    tagName: "DIV", textContent: null,
    getAttribute: (n) => (n === "id" ? s.block ?? null : null),
    closest: () => null,
    querySelectorAll: (sel) =>
      sel === "label"
        ? (s.label ? [bare("LABEL", s.label)] : [])
        : Array.from({ length: s.options ?? 0 }, () => bare("LI", "Someone Real")),
  };
  return {
    tagName: s.tag.toUpperCase(), textContent: s.text ?? null, value: s.value, checked: s.checked, disabled: s.disabled,
    getAttribute: (n) => s.attrs?.[n] ?? null,
    closest: (sel) => {
      if (sel === ".dropdown-menu") return s.inMenu ? around : null;
      if (sel === ".dropdown") return s.options !== undefined ? around : null;
      if (sel.startsWith("[id^=")) return s.block ? around : null;
      return s.label !== undefined ? around : null;
    },
    querySelectorAll: () => [],
  };
}
const page = (controls: FormEl[], extra: Record<string, FormEl[]> = {}): FormRoot => ({
  querySelectorAll: (sel) => (/input|button/.test(sel) ? controls : extra[sel] ?? []),
});

describe("which wizard step a page is", () => {
  it("reads it from the address", () => {
    expect(detectStep("https://apply.example/SubmitReimbursement")).toBe("studentSelection");
    expect(detectStep(`https://apply.example/SubmitReimbursement/${G}/1`)).toBe("upload");
    expect(detectStep(`https://apply.example/SubmitReimbursement/${G}/3?x=1`)).toBe("itemDetails");
    expect(detectStep(`https://apply.example/SubmitReimbursement/${G}/5`)).toBe("summary");
    expect(detectStep(`https://apply.example/SubmitReimbursement/Confirmation/${G}`)).toBe("confirmation");
    expect(detectStep("https://apply.example/Dashboard")).toBeUndefined();
  });
});

describe("mapping a step's controls", () => {
  const url = `https://apply.example/SubmitReimbursement/${G}/3`;

  it("keeps names and types and never what is typed or chosen", () => {
    const map = mapForm(page([
      el({ tag: "input", attrs: { id: "purchaseDate", type: "date" }, value: "2026-01-02", label: "Purchase Date" }),
      el({ tag: "input", attrs: { placeholder: "Enter Quantity", type: "text" }, value: "7" }),
      el({ tag: "button", attrs: { id: "category", class: "dropdown-toggle" }, text: "Some Chosen Category Name", options: 12, label: "Category" }),
    ]), url);
    expect(map.step).toBe("itemDetails");
    expect(map.path).toBe("/SubmitReimbursement/<id>/3");
    const text = JSON.stringify(map);
    expect(text).not.toContain("2026-01-02");
    expect(text).not.toContain("Some Chosen Category Name");
    expect(text).not.toContain("Someone Real");
    expect(map.controls.find((c) => c.id === "purchaseDate")).toMatchObject({ kind: "date", label: "Purchase Date", hasValue: true });
    expect(map.controls.find((c) => c.id === "category")).toMatchObject({ kind: "dropdown", options: 12 });
  });

  it("keeps a button's plain words, and writes a random per-session id as a placeholder", () => {
    const map = mapForm(page([
      el({ tag: "button", text: "Continue" }),
      el({ tag: "button", attrs: { id: "3ea9a406-34af-47e5-81a5-16468de1dc5c" }, text: "Step 2 of 5 reached the end of a long sentence here" }),
      el({ tag: "button", attrs: { id: "6c82e196-3bb2-4331-b5e4-8b69b3d1425f" }, disabled: true }),
      el({ tag: "button", attrs: { id: "379945fb-d1cf-410d-a179-eac6de3bd5f1" }, disabled: true }),
    ]), url);
    expect(map.controls[0]).toMatchObject({ kind: "button", text: "Continue" });
    expect(map.controls[1]!.text).toBeUndefined();
    expect(map.controls[1]!.id).toBe("<random-id>");
    // the two empty disabled ones are the same control seen twice
    expect(map.controls.filter((c) => c.disabled)).toEqual([{ kind: "button", id: "<random-id>", disabled: true, count: 2 }]);
  });

  it("folds repeats across item blocks into a count and skips a dropdown's own entries", () => {
    const qty = () => el({ tag: "input", attrs: { placeholder: "Enter Quantity" }, value: "1", block: "collapseOne____item_1" });
    const map = mapForm(page([qty(), qty(), qty(), el({ tag: "button", text: "Delete", inMenu: true })]), url);
    expect(map.controls).toHaveLength(1);
    expect(map.controls[0]).toMatchObject({ placeholder: "Enter Quantity", count: 3 });
  });

  it("keeps only the words before a colon in a heading and in a label", () => {
    const heading = bare("H3", "Item 1 : Real Product Name");
    const map = mapForm(page([], { "h1, h2, h3, h4": [heading] }), url);
    expect(map.headings).toEqual(["Item 1"]);
  });

  it("names an icon-only button from its title, alt or svg title", () => {
    const withTitle = el({ tag: "button", attrs: { title: "Continue" } });
    const withAlt: FormEl = { ...el({ tag: "button" }), querySelectorAll: (sel) => (sel === "img" ? [{ ...bare("IMG", null), getAttribute: (n: string) => (n === "alt" ? "Continue to Item/Service Details" : null) }] : []) };
    const map = mapForm(page([withTitle, withAlt]), url);
    expect(map.controls.map((c) => c.text)).toEqual(["Continue", "Continue to Item/Service Details"]);
  });

  it("describes a wordless button by how it is built, including text a stylesheet adds", () => {
    const btn = el({ tag: "button", attrs: { class: "btn btn-primary next-step", "aria-labelledby": "x" } });
    const map = mapForm(page([btn]), url, { pseudo: (_e, w) => (w === "::after" ? "Continue" : undefined) });
    expect(map.controls[0]!.build).toEqual({ classes: ["btn", "btn-primary", "next-step"], points: ["aria-labelledby"], after: "Continue" });
  });

  it("keeps a button's desktop and mobile wording together", () => {
    const map = mapForm(page([el({ tag: "button", text: "CONTINUE TO ITEM/SERVICE DETAILS  CONTINUE" })]), url);
    expect(map.controls[0]!.text).toBe("CONTINUE TO ITEM/SERVICE DETAILS CONTINUE");
  });

  it("maps an attached file's row: Delete is kept, the file's name is not", () => {
    const map = mapForm(page([
      el({ tag: "a", text: "Delete" }),
      el({ tag: "a", text: "Receipt for Pat Example.pdf", attrs: { href: "#" } }),
    ]), url);
    expect(JSON.stringify(map)).not.toContain("Pat");
    expect(map.controls).toEqual([{ kind: "link", text: "Delete" }, { kind: "link" }]);
  });

  it("counts attached documents: ids with a random part fold together", () => {
    const doc = (g: string) => [
      el({ tag: "a", text: "Delete", attrs: { id: `delete_Document_${g}` } }),
      el({ tag: "a", text: "a name.pdf", attrs: { id: `display_Document_${g}` } }),
    ];
    const map = mapForm(page([...doc("c78bd2b7-a7b1-48bc-b3a8-59ad25acae9f"), ...doc("7ba535b5-1a54-4ff5-8a13-f3eb3a5b20e2")]), url);
    expect(map.controls).toEqual([
      { kind: "link", id: "delete_Document_<id>", text: "Delete", count: 2 },
      { kind: "link", id: "display_Document_<id>", count: 2 },
    ]);
  });

  it("never lets a person's name out of a heading", () => {
    const h = (t: string) => bare("H3", t);
    const map = mapForm(page([], { "h1, h2, h3, h4": [h("Upload a receipt or invoice for Pat Example."), h("Welcome Pat Example"), h("Review for Pat O'Example Jr.")] }), url);
    expect(JSON.stringify(map)).not.toMatch(/Pat|Example/);
    expect(map.headings[0]).toBe("Upload a receipt or invoice for <name>");
  });

  it("is empty and unnamed off the wizard", () => {
    const map = mapForm(page([]), "https://apply.example/Dashboard");
    expect(map.step).toBeUndefined();
    expect(map.controls).toEqual([]);
  });
});
