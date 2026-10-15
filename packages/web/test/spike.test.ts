import { describe, expect, it } from "vitest";
import type { FormEl, FormRoot } from "../src/agent/form.js";
import { runSpike, type PageOps, type SpikeTest } from "../src/agent/spike.js";

const G = "00000000-0000-4000-8000-000000000000";
const bare = (tag: string, text: string | null, attrs: Record<string, string> = {}, extra: Partial<FormEl> = {}): FormEl => ({
  tagName: tag, textContent: text, getAttribute: (n) => attrs[n] ?? null, closest: () => null, querySelectorAll: () => [], ...extra,
});

/** A page of controls the spike can recognise: item details with a quantity field. */
function itemDetails(): FormRoot {
  const els: FormEl[] = [
    bare("INPUT", null, { id: "purchaseDate", type: "date" }, { value: "2026-01-01" }),
    bare("DIV", "x"),
    bare("BUTTON", null, { id: "category", class: "dropdown-toggle" }),
    bare("INPUT", null, { placeholder: "Enter Quantity", type: "text" }, { value: "1" }),
    bare("INPUT", null, { placeholder: "Enter Cost per Item", type: "text" }, { value: "2" }),
    bare("INPUT", null, { placeholder: "Enter Additional Costs", type: "text" }, { value: "0" }),
    bare("BUTTON", "Add an Item", { id: "x1" }),
    bare("BUTTON", "Back", { id: "x2" }),
    bare("BUTTON", "Continue Continue to Additional Documents", { id: "x3" }),
    bare("BUTTON", null, { id: "provider", class: "dropdown-toggle" }),
  ];
  return { querySelectorAll: (sel) => (/input|button/.test(sel) ? els : []) };
}

function fake(over: Partial<PageOps> = {}) {
  const log: string[] = [];
  const state = { value: "1", menu: ["Alpha", "Beta"], picked: "Choose" };
  const ops: PageOps = {
    count: () => 3,
    itemTotal: () => "$0.00 total",
    value: () => state.value,
    setValue: (sel, i, v) => { log.push(`set ${sel} ${i} ${v}`); state.value = v; },
    setFiles: (sel, i, f) => { log.push(`file ${sel} ${i} ${f.name}`); },
    openPicker: (t) => { log.push(`open ${t}`); return true; },
    pickerText: () => state.picked,
    menuTexts: () => state.menu,
    clickMenuItem: (t) => { log.push(`click ${t}`); state.picked = t; return true; },
    ...over,
  };
  return { ops, log, state };
}

const env = (ops: PageOps, root: FormRoot, url: string, saves = () => 0) => ({ ops, root, url, sleep: async () => {}, saves });
const url3 = `https://apply.example/SubmitReimbursement/${G}/3`;

describe("the spike tests", () => {
  it("types into a field and reads it back, noting whether StepUp saved", async () => {
    const { ops, log } = fake();
    let n = 0;
    const r = await runSpike({ kind: "text", target: "quantity", index: 0, value: "7", method: "events" }, env(ops, itemDetails(), url3, () => (n++ > 0 ? 1 : 0)));
    expect(log).toEqual(["set [placeholder=\"Enter Quantity\"] 0 7"]);
    expect(r.ok).toBe(true);
    expect(r.lines.join(" ")).toMatch(/kept it/);
    const quiet = await runSpike({ kind: "text", target: "quantity", index: 0, value: "8", method: "events" }, env(fake().ops, itemDetails(), url3));
    expect(quiet.ok).toBe(true);
    expect(quiet.lines.join(" ")).toMatch(/saves at step changes/);
  });

  it("reports a field that does not keep what was set", async () => {
    const { ops } = fake({ value: () => "1" });
    const r = await runSpike({ kind: "text", target: "quantity", index: 0, value: "7", method: "typed" }, env(ops, itemDetails(), url3));
    expect(r.ok).toBe(false);
    expect(r.lines.join(" ")).toMatch(/does NOT show/);
  });

  it("refuses on the wrong step, or while the page is busy or asking about a delete", async () => {
    const { ops, log } = fake();
    const wrong = await runSpike({ kind: "text", target: "quantity", index: 0, value: "7", method: "events" }, env(ops, itemDetails(), `https://apply.example/SubmitReimbursement/${G}/1`));
    expect(wrong.ok).toBe(false);
    expect(wrong.lines[0]).toMatch(/for the itemDetails step/);
    const asking: FormRoot = { querySelectorAll: (sel) => (/h1/.test(sel) ? [bare("H3", "Are you sure you want to delete \"Item 1")] : /input|button/.test(sel) ? [] : []) };
    const modal = await runSpike({ kind: "text", target: "quantity", index: 0, value: "7", method: "events" }, env(ops, asking, url3));
    expect(modal.lines[0]).toMatch(/asking whether to delete/);
    expect(log).toEqual([]);
  });

  it("chooses an entry only when it reads exactly, and clicks nothing else", async () => {
    const { ops, log } = fake();
    const ok = await runSpike({ kind: "pick", target: "category", index: 0, option: "Beta" }, env(ops, itemDetails(), url3));
    expect(ok.ok).toBe(true);
    expect(log).toEqual(["open category", "click Beta"]);
    const none = fake();
    const miss = await runSpike({ kind: "pick", target: "category", index: 0, option: "Bet" }, env(none.ops, itemDetails(), url3));
    expect(miss.ok).toBe(false);
    expect(none.log).toEqual(["open category"]);
  });

  it("checks a file before handing it over", async () => {
    const upload: FormRoot = { querySelectorAll: (sel) => (/input|button/.test(sel) ? [bare("INPUT", null, { id: "inputDrop__", type: "file" }), bare("BUTTON", "BACK", { id: "b" })] : []) };
    const u = `https://apply.example/SubmitReimbursement/${G}/1`;
    const { ops, log } = fake();
    const bad = await runSpike({ kind: "file", target: "receipt", name: "notes.docx", mime: "x", bytes: new ArrayBuffer(10) }, env(ops, upload, u));
    expect(bad.ok).toBe(false);
    const big = await runSpike({ kind: "file", target: "receipt", name: "a.pdf", mime: "application/pdf", bytes: new ArrayBuffer(6 * 1024 * 1024) }, env(ops, upload, u));
    expect(big.ok).toBe(false);
    expect(log).toEqual([]);
    const good = await runSpike({ kind: "file", target: "receipt", name: "a.pdf", mime: "application/pdf", bytes: new ArrayBuffer(100) } as SpikeTest, env(ops, upload, u));
    expect(log).toEqual(["file #inputDrop__ 0 a.pdf"]);
    expect(good.lines[0]).toMatch(/Handed the file/);
  });
});
