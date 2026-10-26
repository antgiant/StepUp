import type { FormMap, WizardStep } from "./form.js";
import { PROVIDER_NOT_LISTED, boxesToCheck, categoryLevels, chooseEntry, expectedTotal, isoDate, linesMatch, matchBlock, moneyText, numberOf, sameNumber, type FilingRow } from "./fill.js";
import { recognise } from "./signatures.js";

/**
 * The filing engine: walks StepUp's reimbursement form for one group of rows, the way the command line's `runGroupSteps`
 * did, but from the page itself. It is written against `FilingOps`, a short list of things it may do to the page, so the
 * whole walk can be tested against a pretend site.
 *
 * What it will not do, by construction (there is no operation for it): press Submit. It presses Continue, Back,
 * "Add an Item", and (to remove a surplus, unnamed block) Delete and its confirmation. Everywhere it is unsure it
 * stops and says why; it never chooses between two possible answers.
 */

export interface FileData {
  name: string;
  mime: string;
  bytes: ArrayBuffer;
}

export interface FilingJob {
  child: string;
  program: string;
  receipt: FileData;
  additional: FileData[];
  rows: FilingRow[];
  /** StepUp's id of a draft to carry on with: the walk opens it itself rather than starting a new request. */
  resumeDraft?: string;
}

export type PressTarget = "continue" | "back" | "addItem" | "deleteItem" | "confirmDelete" | "cancelDelete" | "navReimbursements" | "newReimbursement" | "requestAnother";
export type PickTarget = "student" | "category" | "categoryType" | "categoryDetail" | "provider" | "payee" | "individualProvider";

/** Everything the engine may do to (or ask of) the page. There is deliberately no way to press Submit. */
export interface FilingOps {
  /** A map of the page as it is now (visible headings only). */
  map(): FormMap;
  now(): number;
  /** A field of item block `block` (0 is the first), found by selector inside that block. */
  has(block: number, selector: string): boolean;
  read(block: number, selector: string): string | undefined;
  /** Sets a field: the value, then input, change and blur, so StepUp commits it. */
  write(block: number, selector: string, value: string): void;
  hasPicker(block: number, target: PickTarget): boolean;
  /** Opens a dropdown by its own toggle. */
  open(block: number, target: PickTarget): boolean;
  /** The words of the entries of the dropdown that is open. */
  menu(): string[];
  /** Clicks one entry of the open dropdown, by its exact words. */
  choose(text: string): boolean;
  /** What a dropdown's toggle shows now. */
  shown(block: number, target: PickTarget): string | undefined;
  /** Hands a file to the page's own file control. */
  attach(file: FileData): void;
  /** The words beside each detected item's checkbox, and ticking one (never unticking). */
  boxLabels(): string[];
  check(index: number): void;
  /** The item blocks on the Item/Service Details page: whether each has a name from the scan in its heading. */
  blocks(): { named: boolean[] };
  /** What StepUp's scan read for a block: its cost and its name. */
  scan(block: number): { cost?: string; name?: string };
  /** The block's running total as the page shows it. */
  itemTotal(block: number): string | undefined;
  /** One of the few buttons; false when it is not there or is disabled. */
  press(button: PressTarget, block?: number): boolean;
  /** Opens a step of an existing draft the way a click on a link would (no page load). Only an address inside the reimbursement wizard. */
  openDraft?(guid: string, step: number): boolean;
  /** Stops a person's Submit from going through while a reason is given; undefined lets it through. */
  guard(reason: string | undefined): void;
  /** On the confirmation page after a submission: StepUp's reimbursement number, once it is a real one. */
  confirmationNumber(): string | undefined;
}

export interface FilingEnv {
  ops: FilingOps;
  sleep(ms: number): Promise<void>;
  /** A line of progress for the person. */
  report(line: string): void;
  cancelled(): boolean;
  /**
   * Asks the person to pick an entry themselves in StepUp's own dropdown (left open), and answers when they say they did
   * or that the row should be skipped. Absent: a level that matches nothing simply stops the walk.
   */
  pick?(message: string): Promise<"picked" | "skip">;
}

export type StopKind = "needsYou" | "missingServiceDate" | "stepUpChanged" | "readError" | "cancelled" | "wrongTotal";

/** A row whose Category had to be matched to a different entry of StepUp's list: the row should be corrected to `to`. */
export interface CategoryFix {
  rowId: string;
  from: string;
  to: string;
}

export type FilingOutcome =
  | { status: "ready"; matched: string[]; notes: string[]; total: number; categoryFixes?: CategoryFix[] }
  | { status: "stopped"; kind: StopKind; step?: WizardStep; reason: string; matched: string[]; notes: string[]; categoryFixes?: CategoryFix[] };

const SEL = {
  purchaseDate: "#purchaseDate",
  invoice: "#invoiceNumber",
  category: "#category",
  serviceDate: "#serviceDate",
  quantity: '[placeholder="Enter Quantity"]',
  cost: '[placeholder="Enter Cost per Item"]',
  tax: '[placeholder="Enter Additional Costs"]',
  vendorName: "#vendorName",
  providerName: "#otherServiceProviderName",
  benefit: "#educationalBenefit",
  url: "#itemServiceUrl",
  individualName: "#otherIndividualProvider",
};
const LEVELS: PickTarget[] = ["category", "categoryType", "categoryDetail"];
const LEVEL_WORDS = ["Category", "Type", "Description"];
const MINUTES = 60_000;

class Stop extends Error {
  constructor(readonly kind: StopKind, readonly reason: string, readonly step?: WizardStep) {
    super(reason);
  }
}

const escapeRe = (v: string): string => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export async function runFiling(job: FilingJob, env: FilingEnv): Promise<FilingOutcome> {
  const { ops } = env;
  const matched: string[] = [];
  const notes: string[] = [];
  const categoryFixes: CategoryFix[] = [];
  let scanFailed = false;
  let refills = 0;
  /** Flags that are a decision (no category on the row, a category the person skipped): the walk stops rather than waits. */
  const holds: string[] = [];
  let deadline = ops.now() + 25 * MINUTES;
  // Until the walk has checked everything, a Submit must not go through.
  ops.guard("Step Up Helper is still checking this reimbursement.");

  const fixes = (): { categoryFixes?: CategoryFix[] } => (categoryFixes.length ? { categoryFixes: [...categoryFixes] } : {});

  const waitFor = async (what: string, ready: () => boolean, ms: number): Promise<void> => {
    const until = ops.now() + ms;
    while (!ready()) {
      if (env.cancelled()) throw new Stop("cancelled", "Stopped at your request.");
      if (ops.now() > until) throw new Stop("stepUpChanged", `Waited too long for ${what}.`, ops.map().step);
      await env.sleep(400);
    }
  };
  /** Presses Continue and waits for StepUp to move to another step. */
  const advance = async (from: WizardStep): Promise<void> => {
    if (!(await pressWhenEnabled("continue"))) throw new Stop("stepUpChanged", "The Continue button is not available.", from);
    await waitFor("the next step", () => ops.map().step !== from, 90_000);
  };
  const pressWhenEnabled = async (b: PressTarget, block?: number): Promise<boolean> => {
    for (let i = 0; i < 25; i++) {
      if (ops.press(b, block)) return true;
      await env.sleep(400);
    }
    return false;
  };

  /**
   * As the command line did: the person fixes what the walk cannot decide in StepUp itself and presses StepUp's Continue,
   * and the walk carries on from the next step. Submit stays held and the summary check still has to pass.
   */
  const handOver = async (message: string, from: WizardStep): Promise<void> => {
    env.report(`${message} Do it in StepUp and press its Continue; the walk carries on from there.`);
    const began = ops.now();
    try {
      await waitFor("you to finish this step and press Continue", () => ops.map().step !== from, 10 * MINUTES);
    } catch (err) {
      // Nobody did: stop with what was asked, not with a bare timeout.
      if (err instanceof Stop && err.kind === "stepUpChanged") throw new Stop("needsYou", message, from);
      throw err;
    }
    deadline += ops.now() - began;
  };

  try {
    await reachForm();
    for (;;) {
      if (env.cancelled()) throw new Stop("cancelled", "Stopped at your request.");
      if (ops.now() > deadline) throw new Stop("stepUpChanged", "This took too long; stopping.");
      let map = ops.map();
      let rec = recognise(map);
      // A step's heading shows before its controls do (the student picker after "New Reimbursement"): look again for a few
      // seconds before calling the form unexpected.
      for (let look = 0; look < 10 && rec.step && !rec.busy && rec.problems.length > 0; look++) {
        await env.sleep(500);
        map = ops.map();
        rec = recognise(map);
      }
      if (!rec.step) throw new Stop("stepUpChanged", "StepUp's reimbursement form is not showing. Open a new reimbursement and start again.");
      if (rec.busy) {
        await env.sleep(500);
        continue;
      }
      if (rec.variant === "confirmDelete") {
        env.report("StepUp is asking whether to delete an item. Answer it in StepUp; the walk carries on after.");
        const began = ops.now();
        await waitFor("you to answer StepUp's question", () => recognise(ops.map()).variant !== "confirmDelete", 10 * MINUTES);
        deadline += ops.now() - began;
        continue;
      }
      if (rec.problems.length) throw new Stop("stepUpChanged", `StepUp's form is not as expected on this step: ${rec.problems.slice(0, 4).join("; ")}.`, rec.step);

      switch (rec.step) {
        case "studentSelection": {
          env.report(`Choosing ${job.child}.`);
          if (!ops.open(0, "student")) throw new Stop("stepUpChanged", "The student list is not on the page.", rec.step);
          await env.sleep(400);
          const re = new RegExp(`^${escapeRe(job.child)}\\b.*:\\s*${escapeRe(job.program)}\\s*$`, "i");
          const hits = ops.menu().filter((e) => re.test(e));
          if (hits.length !== 1) {
            await handOver(`${hits.length === 0 ? "No student" : "More than one student"} in StepUp's list matches ${job.child} (${job.program}). Choose the right one`, "studentSelection");
            break;
          }
          ops.choose(hits[0]!);
          await env.sleep(600);
          if (!(ops.shown(0, "student") ?? "").includes(hits[0]!)) throw new Stop("stepUpChanged", "The student did not take.", rec.step);
          await advance("studentSelection");
          break;
        }
        case "upload": {
          const attached = map.controls.some((c) => c.id === "fileName");
          if (!attached) {
            env.report("Attaching the receipt.");
            ops.attach(job.receipt);
            await waitFor("the receipt to attach", () => ops.map().controls.some((c) => c.id === "fileName"), 3 * MINUTES);
          }
          await advance("upload");
          break;
        }
        case "itemSelection": {
          if (rec.variant === "readError") throw new Stop("readError", "StepUp could not read the receipt at all. Look at the file, then start again.", rec.step);
          if (rec.variant === "notDetected") {
            scanFailed = true;
            notes.push("StepUp found no items on the receipt; the items were filled in from the rows, in order.");
          } else if (rec.variant === "detected") {
            const picks = boxesToCheck(ops.boxLabels(), job.rows);
            if (!picks) {
              // As the command line did: the person ticks the right boxes and presses Continue in StepUp, and the walk
              // carries on from the next step. Submit stays held, and the summary check still has to pass.
              await handOver("StepUp found items that cannot be matched to the rows. Tick the right ones", "itemSelection");
              break;
            }
            for (const i of picks) ops.check(i);
            await env.sleep(500);
          }
          await advance("itemSelection");
          break;
        }
        case "itemDetails": {
          if (!(await fillDetails())) break; // the person finished this step in StepUp
          await advance("itemDetails");
          break;
        }
        case "additionalDocuments": {
          const shown = (): number => ops.map().controls.filter((c) => /^display_Document_/.test(c.id ?? "")).reduce((n, c) => n + (c.count ?? 1), 0);
          for (let i = shown(); i < job.additional.length; i = shown()) {
            const before = shown();
            env.report(`Attaching an additional document (${before + 1} of ${job.additional.length}).`);
            ops.attach(job.additional[before]!);
            await waitFor("the document to attach", () => shown() > before && !ops.map().headings.some((h) => /^loading\.{3}$/i.test(h)), 3 * MINUTES);
          }
          await advance("additionalDocuments");
          break;
        }
        case "summary": {
          const verdict = await judgeSummary();
          if (verdict === "ok") {
            ops.guard(undefined);
            return { status: "ready", matched, notes, total: expectedTotal(job.rows), ...fixes() };
          }
          if (refills < 2) {
            refills++;
            env.report(`${verdict} Going back to fill the details again (try ${refills} of 2).`);
            await backTo("itemDetails");
            break;
          }
          ops.guard(verdict);
          throw new Stop("wrongTotal", `${verdict} Do not submit this one.`, rec.step);
        }
        case "confirmation":
          return { status: "ready", matched, notes, total: expectedTotal(job.rows), ...fixes() };
      }
    }
  } catch (err) {
    if (err instanceof Stop) {
      if (err.kind !== "cancelled") ops.guard(`Step Up Helper stopped: ${err.reason}`);
      else ops.guard(undefined);
      return { status: "stopped", kind: err.kind, ...(err.step ? { step: err.step } : {}), reason: err.reason, matched, notes, ...fixes() };
    }
    ops.guard("Step Up Helper stopped on an unexpected error.");
    return { status: "stopped", kind: "stepUpChanged", reason: `An unexpected error: ${err instanceof Error ? err.message : String(err)}`, matched, notes, ...fixes() };
  }

  /**
   * Gets to a new request's student page from wherever the person left StepUp: "Request Another Reimbursement" on a
   * confirmation page, or the Reimbursements page's New button (through the side menu when it is not showing). A page that
   * is already a step of the form is left exactly as it is, so a draft that is open is carried on from where it stands.
   */
  async function reachForm(): Promise<void> {
    const first = ops.map();
    if (job.resumeDraft && ops.openDraft && recognise(first).step === undefined) {
      env.report("Opening the draft StepUp already holds.");
      // Details first (StepUp remembers chosen items), then Item/Service Selection, as the command line did.
      for (const n of [3, 2]) {
        if (!ops.openDraft(job.resumeDraft, n)) break;
        try {
          await waitFor("the draft", () => recognise(ops.map()).step !== undefined, 15_000);
          return;
        } catch (err) {
          if (err instanceof Stop && err.kind === "cancelled") throw err;
          /* StepUp would not open that step directly: try an earlier one */
        }
      }
      env.report("Could not open the draft; starting a new request instead.");
    }
    if (first.step === "confirmation") {
      env.report("Starting another request.");
      if (!(await pressWhenEnabled("requestAnother"))) throw new Stop("stepUpChanged", "\"Request Another Reimbursement\" is not on the page.", first.step);
    } else if (recognise(first).step === undefined) {
      env.report("Opening a new reimbursement.");
      if (!ops.press("newReimbursement")) {
        if (!ops.press("navReimbursements")) throw new Stop("stepUpChanged", "StepUp's form is not showing, and its Reimbursements menu entry was not found. Open a new reimbursement and start again.");
        await waitFor("the Reimbursements page", () => ops.press("newReimbursement"), 20_000);
      }
    } else {
      return;
    }
    await waitFor("the student page", () => ops.map().step === "studentSelection", 60_000);
  }

  /** The open dropdown's entries, once the list has stopped growing (StepUp loads a long list in pages). */
  async function readMenu(): Promise<string[]> {
    let last = ops.menu();
    for (let i = 0; i < 12; i++) {
      await env.sleep(250);
      const now = ops.menu();
      if (now.length === last.length && now.length > 0 && i >= 1) return now;
      last = now;
    }
    return last;
  }

  async function backTo(step: WizardStep): Promise<void> {
    for (let i = 0; i < 8 && ops.map().step !== step; i++) {
      const was = ops.map().step;
      if (!ops.press("back")) throw new Stop("stepUpChanged", "Back is not available.", was);
      await waitFor("the earlier step", () => ops.map().step !== was, 30_000);
    }
  }

  /** Whether the Summary is what the rows say: every item line, and the total. A sentence when it is not. */
  async function judgeSummary(): Promise<"ok" | string> {
    let m = ops.map();
    for (let i = 0; i < 30 && !(m.items && m.items.length); i++) {
      await env.sleep(500);
      m = ops.map();
    }
    const total = (() => {
      const i = m.headings.findIndex((h) => /^total$/i.test(h));
      return numberOf(i >= 0 ? m.headings[i + 1] : undefined);
    })();
    const expected = expectedTotal(job.rows);
    if (total === undefined) return "StepUp's summary shows no total.";
    if (total === 0 || Math.abs(total - expected) > 0.005) return `StepUp's total is $${total.toFixed(2)} but the rows say $${expected.toFixed(2)}.`;
    if (!m.items || !linesMatch(m.items, job.rows)) return "StepUp's item lines are not the rows' quantities, costs and tax.";
    return "ok";
  }

  /** True when the fields were filled and the walk may continue; false when the person took the step over. */
  async function fillDetails(): Promise<boolean> {
    // 1. surplus blocks left by an earlier attempt: unnamed ones, only when a named one is kept.
    for (let guard = 0; guard < 10; guard++) {
      const { named } = ops.blocks();
      if (named.length <= job.rows.length || !named.includes(true)) break;
      const at = named.indexOf(false);
      if (at === -1) break;
      env.report(`Removing an unused item block (${at + 1}).`);
      if (!ops.press("deleteItem", at) || !(await pressWhenEnabled("confirmDelete"))) throw new Stop("stepUpChanged", "Could not remove the unused item block.", "itemDetails");
      await waitFor("the block to go", () => ops.blocks().named.length < named.length, 15_000);
    }
    // 2. missing blocks.
    for (let guard = 0; guard < 20 && ops.blocks().named.length < job.rows.length; guard++) {
      const had = ops.blocks().named.length;
      env.report("Adding an item block.");
      if (!(await pressWhenEnabled("addItem"))) throw new Stop("stepUpChanged", "Add an Item is not available.", "itemDetails");
      await waitFor("the new item block", () => ops.blocks().named.length > had, 15_000);
    }
    const blocks = ops.blocks().named.length;
    if (blocks < job.rows.length) throw new Stop("stepUpChanged", "StepUp has fewer item blocks than rows.", "itemDetails");

    // 3. fill each block from a row.
    const remaining = [...job.rows];
    const flags: string[] = [];
    holds.length = 0;
    let missingServiceDate: string | undefined;
    matched.length = 0;
    for (let b = 0; b < blocks; b++) {
      const sc = ops.scan(b);
      const none = !ops.blocks().named.some(Boolean);
      const m = matchBlock(remaining, sc.cost, sc.name, scanFailed || none);
      if (m.how === "none") {
        flags.push(`Item block ${b + 1} has no row left; fill it or delete it yourself.`);
        continue;
      }
      if (m.how === "ambiguous") {
        await handOver(`Item block ${b + 1} cannot be matched to one row (the scan read cost ${sc.cost || "nothing"} and name "${sc.name || ""}"). Fill in the item blocks`, "itemDetails");
        return false;
      }
      remaining.splice(remaining.indexOf(m.row), 1);
      matched.push(m.row.id);
      env.report(`Filling item ${b + 1}: ${m.row.data["Item"] ?? m.row.id}.`);
      const r = await fillBlock(b, m.row);
      flags.push(...r.flags);
      missingServiceDate ??= r.missingServiceDate;
    }
    if (missingServiceDate) throw new Stop("missingServiceDate", missingServiceDate, "itemDetails");
    // A row with no Category, or a choice the person made to skip one, is a decision: it stops here instead of carrying on.
    if (holds.length) throw new Stop("needsYou", `Some fields need you: ${flags.join(" ")}`, "itemDetails");
    if (flags.length) {
      await handOver(`Some fields need you: ${flags.join(" ")}`, "itemDetails");
      return false;
    }
    return true;
  }

  async function fillBlock(b: number, row: FilingRow): Promise<{ flags: string[]; missingServiceDate?: string }> {
    const flags: string[] = [];
    const n = b + 1;
    const d = row.data;
    const item = d["Item"] ?? row.id;

    // Category, Type, Description: each level by its words. StepUp requires one, so a row without it stops the walk.
    const levels = categoryLevels(d["Category"] ?? "");
    if (levels.length === 0) {
      flags.push(`Item ${n} (${item}): the row has no Category, which StepUp requires. Add it in the workbook.`);
      holds.push("no category");
    }
    const chosen: string[] = [];
    let loosely = false;
    for (let k = 0; k < levels.length && k < LEVELS.length; k++) {
      const target = LEVELS[k]!;
      if (k > 0) await waitFor(`the ${LEVEL_WORDS[k]} list`, () => ops.hasPicker(b, target), 10_000).catch(() => undefined);
      if (!ops.open(b, target)) {
        flags.push(`Item ${n} (${item}): the ${LEVEL_WORDS[k]} dropdown is not on the page.`);
        break;
      }
      let entries = await readMenu();
      let choice = chooseEntry(entries, levels[k]!);
      // A long list loads in pages, and a pause between pages can look like the end: look again before saying it is missing.
      for (let again = 0; again < 4 && choice.how === "none"; again++) {
        await env.sleep(1000);
        entries = await readMenu();
        choice = chooseEntry(entries, levels[k]!);
      }
      if (choice.how === "none" || choice.how === "ambiguous") {
        const unmatched = `Item ${n} (${item}): no single ${LEVEL_WORDS[k]} entry reads "${levels[k]}" (the list read had ${entries.length} entries${entries.length ? `, from "${entries[0]}" to "${entries[entries.length - 1]}"` : ""}).`;
        if (!env.pick) {
          flags.push(unmatched);
          ops.open(b, target); // close it again
          break;
        }
        // The dropdown stays open; the person picks the right entry in StepUp itself and says so.
        const before = (ops.shown(b, target) ?? "").trim();
        let picked: string | undefined;
        env.report(`${unmatched} Pick the right one in StepUp's open list, then say so here.`);
        for (let ask = 0; ask < 5 && picked === undefined; ask++) {
          const said = await env.pick(`${unmatched} StepUp's ${LEVEL_WORDS[k]} list is open on the page: click the right entry there, then press "I picked it".`);
          if (said === "skip" || env.cancelled()) break;
          const now = (ops.shown(b, target) ?? "").trim();
          if (now && now !== before && !/^select\b/i.test(now)) picked = now;
          else env.report(`The ${LEVEL_WORDS[k]} still shows "${now || "nothing"}". Pick an entry in StepUp's list, then say so again.`);
        }
        if (picked === undefined) {
          flags.push(`${unmatched} Skipped, so fill it in StepUp yourself.`);
          holds.push("skipped");
          break;
        }
        chosen.push(picked);
        loosely = true;
        continue;
      }
      ops.choose(choice.text);
      await env.sleep(700);
      if (!(ops.shown(b, target) ?? "").includes(choice.text)) {
        flags.push(`Item ${n} (${item}): the ${LEVEL_WORDS[k]} did not take "${choice.text}".`);
        break;
      }
      chosen.push(choice.text);
      if (choice.how !== "exact") loosely = true;
    }
    // StepUp's list words it differently from the row: say so, so the row (and its siblings) can be corrected like the CLI did.
    if (loosely && levels.length > 0 && chosen.length === Math.min(levels.length, LEVELS.length)) {
      const to = chosen.join(" - ");
      const from = (d["Category"] ?? "").trim();
      if (to !== from) {
        categoryFixes.push({ rowId: row.id, from, to });
        env.report(`Item ${n}: the category "${from}" is listed as "${to}" on StepUp; the row will be corrected.`);
      }
    }

    // The top level must now show a choice, not the prompt: StepUp refuses to go on otherwise.
    if (levels.length > 0 && !flags.some((f) => f.includes(`Item ${n} (${item}): no single`) || f.includes("did not take") || f.includes("dropdown is not on the page"))) {
      const picked = (ops.shown(b, "category") ?? "").trim();
      if (!picked || /^select\b/i.test(picked)) flags.push(`Item ${n} (${item}): the Category still shows "${picked || "nothing"}" after choosing it.`);
    }

    const put = async (selector: string, want: string | undefined, label: string, kind: "text" | "money" | "date" = "text"): Promise<void> => {
      if (want === undefined || want === "") return;
      if (!ops.has(b, selector)) {
        flags.push(`Item ${n} (${item}): ${label} is not on the page.`);
        return;
      }
      const same = (v: string | undefined): boolean => (kind === "money" ? sameNumber(v, want) : (v ?? "").trim() === want.trim());
      if (same(ops.read(b, selector))) return;
      ops.write(b, selector, want);
      await env.sleep(500);
      const after = ops.read(b, selector);
      if (!same(after)) flags.push(`Item ${n} (${item}): ${label} shows "${after ?? ""}", expected "${want}".`);
    };

    await put(SEL.benefit, d["Benefit Message"], "the benefit message");
    await put(SEL.url, d["Item/Service URL"], "the item URL");

    // Who was paid: the dropdown always; "not listed" reveals a text field.
    const name = (d["Service Provider"] || d["Vendor"] || "").trim();
    await waitFor("the payee control", () => ops.hasPicker(b, "provider") || ops.hasPicker(b, "payee"), 10_000).catch(() => undefined);
    const payeeTarget: PickTarget = ops.hasPicker(b, "provider") ? "provider" : "payee";
    if (name) {
      if (!ops.open(b, payeeTarget)) {
        flags.push(`Item ${n} (${item}): "Who did you pay?" is not on the page.`);
      } else {
        const entries = await readMenu();
        const choice = chooseEntry(entries, name, [PROVIDER_NOT_LISTED]);
        if (choice.how === "exact" || choice.how === "normalized" || choice.how === "partial") {
          env.report(`Paying "${choice.text}" (${choice.how === "exact" ? "listed" : `matched "${name}"`}).`);
          ops.choose(choice.text);
          await env.sleep(700);
          if (!(ops.shown(b, payeeTarget) ?? "").includes(choice.text)) flags.push(`Item ${n} (${item}): the payee did not take "${choice.text}".`);
        } else {
          // Say what the list held, so a person can tell a wording difference from a list that did not load.
          const first = name.toLowerCase().split(/\s+/)[0] ?? "";
          const near = entries.filter((e) => e.toLowerCase().includes(first)).slice(0, 5);
          const seen = `${entries.length} entr${entries.length === 1 ? "y" : "ies"} read from the ${payeeTarget === "provider" ? "provider" : "vendor"} list; ${choice.how === "ambiguous" ? `${choice.count} contain "${name}"` : `none matches "${name}"`}${near.length ? `; nearest: ${near.map((e) => `"${e}"`).join(", ")}` : ""}`;
          env.report(`"${name}" is not in the list (${seen}). Choosing "${PROVIDER_NOT_LISTED}".`);
          if (!ops.choose(PROVIDER_NOT_LISTED)) {
            flags.push(`Item ${n} (${item}): "${name}" is not in StepUp's list (${seen}), and "${PROVIDER_NOT_LISTED}" could not be chosen.`);
          } else {
            await env.sleep(800);
            const field = ops.has(b, SEL.providerName) ? SEL.providerName : ops.has(b, SEL.vendorName) ? SEL.vendorName : undefined;
            if (!field) flags.push(`Item ${n} (${item}): "${name}" is not in StepUp's list (${seen}); after "${PROVIDER_NOT_LISTED}" no name field appeared.`);
            else await put(field, name, "the payee's name");
          }
        }
        // A listed business may list people under it: choose one only when its words match exactly.
        if (ops.hasPicker(b, "individualProvider")) {
          const person = (d["Service Provider"] ?? "").trim();
          let done = false;
          if (person && ops.open(b, "individualProvider")) {
            const c = chooseEntry(await readMenu(), person);
            if (c.how === "exact" || c.how === "normalized") {
              ops.choose(c.text);
              await env.sleep(600);
              done = true;
            } else {
              ops.open(b, "individualProvider");
            }
          }
          if (!done) flags.push(`Item ${n} (${item}): choose the individual provider yourself.`);
        }
      }
    }

    // Service date, only where the category asks for it.
    let missingServiceDate: string | undefined;
    const serviceWanted = isoDate(d["Service Date"]);
    if (ops.has(b, SEL.serviceDate)) {
      if (!serviceWanted) missingServiceDate = `Item ${n} (${item}) needs a Service Date for its category, and the row has none.`;
      else await put(SEL.serviceDate, serviceWanted, "the service date", "date");
    } else if (serviceWanted) {
      flags.push(`Item ${n} (${item}): the row has a service date (${serviceWanted}) but no Service Date field appeared.`);
    }

    await put(SEL.invoice, (d["Invoice #"] ?? "").trim() || undefined, "the invoice number");
    await put(SEL.cost, moneyText(d["Amount"]), "the cost per item", "money");
    await put(SEL.quantity, (d["Quantity"] ?? "").trim() || "1", "the quantity", "money");
    await put(SEL.tax, moneyText(d["Tax, Shipping, etc."]), "tax and shipping", "money");
    await put(SEL.purchaseDate, isoDate(d["Date"]), "the purchase date", "date");

    // The page's own total for the block is the last check that it took the numbers.
    const total = ops.itemTotal(b)?.replace(/\s*total$/i, "");
    if (total !== undefined) {
      const want = expectedTotal([row]);
      if (!sameNumber(total, String(want))) flags.push(`Item ${n} (${item}): the page totals ${total} but the row works out to $${want.toFixed(2)}.`);
    }
    return { flags, ...(missingServiceDate ? { missingServiceDate } : {}) };
  }
}
