import { describe, expect, it } from "vitest";
import { runFiling, type FilingJob, type FilingOps, type PickTarget, type PressTarget } from "../src/agent/engine.js";
import type { FormMap, MappedControl, WizardStep } from "../src/agent/form.js";
import type { FilingRow } from "../src/agent/fill.js";

/** A pretend StepUp: the wizard's steps, built from the recorded shapes, reacting to what the engine does. */
interface Block {
  scan: { cost?: string; name?: string };
  values: Record<string, string>;
  levels: string[];
  payee?: string;
  notListed?: boolean;
}
interface Site {
  step: WizardStep;
  attached: boolean;
  variant: "detected" | "notDetected" | "readError" | "scanning";
  boxes: string[];
  ticked: number[];
  blocks: Block[];
  docs: number;
  /** The category family the next category chosen belongs to. */
  family: "vendor" | "provider";
  serviceDateRequired: boolean;
  /** A bug in StepUp: tax is not added to the total. */
  ignoreTax: boolean;
  guard: string | undefined;
  pressed: string[];
}

const SELS = { quantity: '[placeholder="Enter Quantity"]', cost: '[placeholder="Enter Cost per Item"]', tax: '[placeholder="Enter Additional Costs"]' };
const CATS = { Books: { Print: ["Textbooks/Workbooks"] } };
const btn = (text: string, o: Partial<MappedControl> = {}): MappedControl => ({ kind: "button", id: "<random-id>", text, ...o });
const chrome: MappedControl[] = [
  { kind: "dropdown", id: "notificationDropDown", options: 0 },
  { kind: "button", id: "<random-id>", text: "Student Selection" },
  { kind: "button", id: "<random-id>", build: { classes: ["textual-stepper-button"] } },
];

function site(over: Partial<Site> = {}, nBlocks = 1): { ops: FilingOps; s: Site; clock: { t: number } } {
  const s: Site = {
    step: "studentSelection", attached: false, variant: "detected", boxes: ["x"], ticked: [],
    blocks: Array.from({ length: nBlocks }, () => ({ scan: {}, values: { [SELS.quantity]: "1", [SELS.cost]: "0.00", [SELS.tax]: "0.00", "#purchaseDate": "" }, levels: [] })),
    docs: 0, family: "vendor", serviceDateRequired: false, ignoreTax: false, guard: undefined, pressed: [], ...over,
  };
  const clock = { t: 0 };
  let menu: string[] = [];
  let open: { target: PickTarget; block: number } | undefined;
  const lineTotal = (b: Block, glitch = false): number => Number.parseFloat(b.values[SELS.quantity] ?? "1") * Number.parseFloat(b.values[SELS.cost] ?? "0") + (glitch ? 0 : Number.parseFloat(b.values[SELS.tax] ?? "0"));

  const map = (): FormMap => {
    const base: FormMap = { mapVersion: 10, step: s.step, path: "/x", controls: [...chrome], headings: ["Scholarship Portal"], notices: [] };
    switch (s.step) {
      case "studentSelection":
        base.controls.push({ kind: "dropdown", id: "Student__Select", options: 3 });
        break;
      case "upload":
        base.controls.push(btn("BACK"), btn("CONTINUE TO ITEM/SERVICE SELECTION CONTINUE"));
        base.controls.push(s.attached ? { kind: "text", id: "fileName", hasValue: true } : { kind: "file", id: "inputDrop__" }, ...(s.attached ? [] : [btn("BROWSE")]));
        break;
      case "itemSelection":
        base.controls.push(btn("BACK"));
        if (s.variant === "scanning") base.headings.push("One moment while we read your document...");
        else if (s.variant === "readError") base.headings.push("Oops! Something went wrong on our end. It looks like we were not able to read your document.");
        else if (s.variant === "notDetected") base.headings.push("We were not able to detect items or services on your document"), base.controls.push(btn("UPLOAD A DIFFERENT DOCUMENT"), btn("CONTINUE TO ITEM/SERVICE DETAILS CONTINUE"));
        else {
          base.headings.push("Item(s) and/or service(s) detected! Select what you would like to reimburse for <name>");
          base.controls.push({ kind: "checkbox", id: "select-all" }, { kind: "checkbox", id: "item_0", count: s.boxes.length }, btn("CONTINUE TO ITEM/SERVICE DETAILS CONTINUE"));
        }
        break;
      case "itemDetails": {
        const b = s.blocks[0]!;
        base.headings.push("Confirm details for each reimbursable item or service for <name>");
        base.controls.push(
          { kind: "date", id: "purchaseDate", label: "Purchase Date*" },
          { kind: "dropdown", id: "category", label: "Category*", options: 5 },
          { kind: "text", placeholder: "Enter Quantity" }, { kind: "text", placeholder: "Enter Cost per Item" }, { kind: "text", placeholder: "Enter Additional Costs" },
          btn("Add an Item"), btn("Back"), btn("Continue Continue to Additional Documents"),
        );
        if (b.levels.length >= 1) base.controls.push({ kind: "dropdown", id: "categoryType", options: 3 });
        if (b.levels.length >= 2) base.controls.push({ kind: "dropdown", id: "categoryDetail", options: 3 });
        if (b.levels.length >= 3 || b.levels.length === 0) {
          if (s.family === "provider" && b.levels.length >= 1) base.controls.push({ kind: "dropdown", id: "provider", label: "Who did you pay?*", options: 4 });
          else base.controls.push({ kind: "dropdown", label: "Who did you pay?*", options: 4 });
          if (b.levels.length === 0 || (s.family === "vendor" && (!b.payee || b.notListed))) base.controls.push({ kind: "text", id: "vendorName", label: "Vendor Name*" });
          if (s.family === "provider" && b.notListed) base.controls.push({ kind: "text", id: "otherServiceProviderName", label: "Provider Name*" });
        }
        if (s.serviceDateRequired && b.levels.length >= 3) base.controls.push({ kind: "date", id: "serviceDate", label: "Service Date*" });
        break;
      }
      case "additionalDocuments":
        base.controls.push(btn("BROWSE"), { kind: "file", id: "inputDrop__" }, btn("BACK"), btn("CONTINUE TO SUMMARY CONTINUE"));
        if (s.docs) base.controls.push({ kind: "link", id: "display_Document_<id>", count: s.docs }, { kind: "link", id: "delete_Document_<id>", text: "Delete", count: s.docs });
        break;
      case "summary": {
        base.controls.push({ kind: "button", id: "backButton", text: "Back" }, btn("Submit for approval"));
        const total = s.blocks.reduce((n, b) => n + lineTotal(b, s.ignoreTax), 0);
        base.headings.push("Review your purchase(s) for <name>", "Total", `$${total.toFixed(2)}`);
        base.items = s.blocks.map((b) => ({ quantity: Number(b.values[SELS.quantity]), cost: Number(b.values[SELS.cost]), tax: s.ignoreTax ? 0 : Number(b.values[SELS.tax]) }));
        break;
      }
    }
    return base;
  };

  const levelWords = (b: Block, k: number): string[] => (k === 0 ? Object.keys(CATS) : k === 1 ? Object.keys(CATS.Books) : CATS.Books.Print);
  const ops: FilingOps = {
    map,
    now: () => clock.t,
    has: (i, sel) => {
      const m = map();
      const b = s.blocks[i];
      if (!b) return false;
      if (sel === "#serviceDate") return m.controls.some((c) => c.id === "serviceDate");
      if (sel === "#vendorName") return m.controls.some((c) => c.id === "vendorName");
      if (sel === "#otherServiceProviderName") return m.controls.some((c) => c.id === "otherServiceProviderName");
      return true;
    },
    read: (i, sel) => s.blocks[i]?.values[sel],
    write: (i, sel, v) => {
      const b = s.blocks[i]!;
      b.values[sel] = sel === SELS.cost || sel === SELS.tax ? Number(v).toFixed(2) : v;
      if (sel === "#vendorName" || sel === "#otherServiceProviderName") b.payee = v;
    },
    hasPicker: (i, t) => {
      const m = map();
      if (t === "individualProvider") return false;
      if (t === "provider") return m.controls.some((c) => c.id === "provider");
      if (t === "payee") return m.controls.some((c) => c.kind === "dropdown" && !c.id && c.label?.startsWith("Who"));
      if (t === "categoryType") return m.controls.some((c) => c.id === "categoryType");
      if (t === "categoryDetail") return m.controls.some((c) => c.id === "categoryDetail");
      return true;
    },
    open: (i, t) => {
      open = { target: t, block: i };
      if (t === "student") menu = ["Pat Example : FES-UA", "Sam Example : FES-UA", "Pat Example : FES-EO"];
      else if (t === "category") menu = levelWords(s.blocks[i]!, 0);
      else if (t === "categoryType") menu = levelWords(s.blocks[i]!, 1);
      else if (t === "categoryDetail") menu = levelWords(s.blocks[i]!, 2);
      else menu = ["Apple Store", "Wal-mart", "Provider not Listed"];
      return true;
    },
    menu: () => menu,
    choose: (text) => {
      if (!open) return false;
      const b = s.blocks[open.block]!;
      if (open.target === "student") s.pressed.push(`student:${text}`);
      else if (["category", "categoryType", "categoryDetail"].includes(open.target)) b.levels.push(text);
      else if (text === "Provider not Listed") b.notListed = true;
      else (b.payee = text), (b.notListed = false);
      open = undefined;
      return true;
    },
    shown: (i, t) => (t === "student" ? s.pressed.find((p) => p.startsWith("student:"))?.slice(8) : t === "category" ? s.blocks[i]!.levels[0] : t === "categoryType" ? s.blocks[i]!.levels[1] : t === "categoryDetail" ? s.blocks[i]!.levels[2] : s.blocks[i]!.notListed ? "Provider not Listed" : s.blocks[i]!.payee),
    attach: () => {
      if (s.step === "upload") s.attached = true;
      else s.docs++;
    },
    boxLabels: () => s.boxes,
    check: (i) => void s.ticked.push(i),
    blocks: () => ({ named: s.blocks.map((b) => Boolean(b.scan.name)) }),
    scan: (i) => s.blocks[i]?.scan ?? {},
    itemTotal: (i) => `$${lineTotal(s.blocks[i]!).toFixed(2)} total`,
    press: (b: PressTarget) => {
      s.pressed.push(b);
      if (b === "continue") {
        const next: Partial<Record<WizardStep, WizardStep>> = { studentSelection: "upload", upload: "itemSelection", itemSelection: "itemDetails", itemDetails: "additionalDocuments", additionalDocuments: "summary" };
        if (s.step === "upload" && !s.attached) return false;
        s.step = next[s.step] ?? s.step;
        return true;
      }
      if (b === "back") {
        s.step = "itemDetails";
        return true;
      }
      if (b === "addItem") {
        s.blocks.push({ scan: {}, values: { [SELS.quantity]: "1", [SELS.cost]: "0.00", [SELS.tax]: "0.00", "#purchaseDate": "" }, levels: [] });
        return true;
      }
      return true;
    },
    guard: (reason) => void (s.guard = reason),
    confirmationNumber: () => undefined,
  };
  return { ops, s, clock };
}

const row = (id: string, data: Record<string, string>): FilingRow => ({ id, data });
const job = (rows: FilingRow[], over: Partial<FilingJob> = {}): FilingJob => ({
  child: "Pat Example", program: "FES-UA", receipt: { name: "r.pdf", mime: "application/pdf", bytes: new ArrayBuffer(8) }, additional: [], rows, ...over,
});
const run = (j: FilingJob, ops: FilingOps, clock: { t: number }, cancelled = () => false) =>
  runFiling(j, { ops, sleep: async (ms) => void (clock.t += ms), report: () => undefined, cancelled });

const book = row("a", { Item: "Math book", Amount: "5.00", Quantity: "3", "Tax, Shipping, etc.": "0.50", Category: "Books - Print - Textbooks/Workbooks", Vendor: "Wal-mart", Date: "2026-01-31" });

describe("filing one group, start to finish", () => {
  it("walks every step and leaves the Summary for a person to submit", async () => {
    const { ops, s, clock } = site();
    s.blocks[0]!.scan = { cost: "5.00", name: "Math book" };
    const out = await run(job([book], { additional: [{ name: "p.pdf", mime: "application/pdf", bytes: new ArrayBuffer(4) }] }), ops, clock);
    expect(out, JSON.stringify(out)).toMatchObject({ status: "ready", matched: ["a"], total: 15.5 });
    expect(s.step).toBe("summary");
    expect(s.guard).toBeUndefined();
    expect(s.blocks[0]!.values[SELS.quantity]).toBe("3");
    expect(s.blocks[0]!.levels).toEqual(["Books", "Print", "Textbooks/Workbooks"]);
    expect(s.blocks[0]!.payee).toBe("Wal-mart");
    expect(s.docs).toBe(1);
    // it never asked for anything but the buttons it is allowed
    expect(s.pressed.filter((p) => !p.startsWith("student:") && p !== "continue")).toEqual([]);
  });

  it("stops, and holds Submit, when a row needs a service date it does not have", async () => {
    const { ops, s, clock } = site({ serviceDateRequired: true });
    s.blocks[0]!.scan = { cost: "5.00" };
    const out = await run(job([book]), ops, clock);
    expect(out).toMatchObject({ status: "stopped", kind: "missingServiceDate", step: "itemDetails" });
    expect(s.guard).toMatch(/stopped/i);
  });

  it("flags a category entry that does not exist instead of choosing another", async () => {
    const { ops, s, clock } = site();
    s.blocks[0]!.scan = { cost: "5.00" };
    const out = await run(job([row("a", { ...book.data, Category: "Toys - Print - X" })]), ops, clock);
    expect(out).toMatchObject({ status: "stopped", kind: "needsYou" });
    expect((out as { reason: string }).reason).toMatch(/no single Category entry reads "Toys"/);
    expect(s.guard).toBeDefined();
  });

  it("does not guess when the scan's items cannot be matched to the rows", async () => {
    const { ops, s, clock } = site({ boxes: ["Receipt total", "Math book", "Fee"] });
    const out = await run(job([book]), ops, clock);
    expect(out).toMatchObject({ status: "stopped", kind: "needsYou", step: "itemSelection" });
    expect(s.ticked).toEqual([]);
  });

  it("stops on a receipt StepUp could not read", async () => {
    const { ops, clock } = site({ variant: "readError" });
    const out = await run(job([book]), ops, clock);
    expect(out).toMatchObject({ status: "stopped", kind: "readError" });
  });

  it("goes back to fill again when the total is wrong, then refuses Submit if it stays wrong", async () => {
    const { ops, s, clock } = site({ ignoreTax: true });
    s.blocks[0]!.scan = { cost: "5.00" };
    const out = await run(job([book]), ops, clock);
    expect(out, JSON.stringify(out)).toMatchObject({ status: "stopped", kind: "wrongTotal" });
    expect(s.pressed.filter((p) => p === "back")).toHaveLength(2);
    expect(s.guard).toMatch(/total/);
  });

  it("says what the payee list held when the name is not in it, instead of only saying it failed", async () => {
    const { ops, s, clock } = site();
    s.blocks[0]!.scan = { cost: "5.00" };
    const out = await run(job([row("a", { ...book.data, Vendor: "Nonesuch Mart" })]), ops, clock);
    expect(out).toMatchObject({ status: "ready" });
    // not listed: the name is typed into the field that appears, and nothing is guessed from a near entry
    expect(s.blocks[0]!.payee).toBe("Nonesuch Mart");
  });

  it("stops at once when asked", async () => {
    const { ops, s, clock } = site();
    const out = await run(job([book]), ops, clock, () => true);
    expect(out).toMatchObject({ status: "stopped", kind: "cancelled" });
    expect(s.guard).toBeUndefined();
  });
});
