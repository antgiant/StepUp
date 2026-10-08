import {
  HlcClock,
  Ledger,
  listLooseFiles,
  planIngest,
  registerLooseFiles,
  addItem,
  attachAdditional,
  attachAsReceipt,
  buildQueue,
  createPurchase,
  duplicateItem,
  evaluateItem,
  fileNameHints,
  formatCents,
  itemsOf,
  newId,
  reallocateTax,
  remainingToItemize,
  startPurchaseFromDocument,
  suggestNextItem,
  toCents,
  type EventStore,
  type MapTarget,
  type RulesContext,
} from "@step-up/shared/web";
import { initAuth, signIn, signOut } from "./auth.js";
import { LocalEventStore, exportJsonl, parseJsonl } from "./localStore.js";
import { loadPointer, openWorkspace, pointerFromLink, savePointer, type OpenWorkspace } from "./workspace.js";
import "./style.css";

const CLIENT_KEY = "stepup.clientId";
function clientId(): string {
  try {
    const have = localStorage.getItem(CLIENT_KEY);
    if (have) return have;
    const made = newId("web");
    localStorage.setItem(CLIENT_KEY, made);
    return made;
  } catch {
    return newId("web");
  }
}

const store = new LocalEventStore(clientId());
let ledger = new Ledger(store, new HlcClock(store.clientId), "web");
let account: Awaited<ReturnType<typeof initAuth>> = null;
let workspace: OpenWorkspace | undefined;
let activeStore: EventStore = store;
let status = "";

// Category rules are shared reference data (plan §3.8) and are not loaded yet: every category counts as known.
const ctx = (): RulesContext => ({
  today: new Date().toISOString().slice(0, 10),
  category: (id) => ({ id, path: [], requiresServiceDate: false, eligibleScholarships: [], isActive: true }),
});

type View = { name: "queue" } | { name: "purchase"; id: string };
let view: View = { name: "queue" };
const root = document.getElementById("app")!;

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const val = (form: HTMLFormElement, name: string) => (form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement | null)?.value.trim() ?? "";

/** Runs an action that may hit the network; shows the error instead of leaving the page half-updated. */
async function guarded(action: () => Promise<void>): Promise<void> {
  status = "";
  try {
    await action();
  } catch (err) {
    status = err instanceof Error ? err.message : String(err);
  }
  render();
}

async function save(): Promise<void> {
  await guarded(() => ledger.flush());
}

async function attach(next: OpenWorkspace | undefined): Promise<void> {
  workspace = next;
  if (next) {
    ledger = next.ledger;
    activeStore = ledger.store;
    savePointer(next.pointer);
  }
}

function connectionBar(): string {
  if (!account) return `<p class="note">Local mode: data stays in this browser. <button id="sign-in">Sign in with Microsoft</button></p>`;
  const who = esc(account.username);
  if (!workspace) {
    return `<p class="note">Signed in as ${who}. <button id="sign-out">Sign out</button></p>
      <form id="connect" class="row"><input name="link" placeholder="Paste the OneDrive sharing link to the StepUp folder" required><button>Connect</button></form>`;
  }
  const options = workspace.years.filter((y) => y.kind === "ledger").map((y) => `<option${y.label === workspace!.year.label ? " selected" : ""}>${esc(y.label)}</option>`).join("");
  return `<p class="note">Signed in as ${who}. Year <select id="year-pick" style="width:auto">${options}</select>
    <button id="check-files">Check for new files</button> <button id="disconnect">Disconnect</button> <button id="sign-out">Sign out</button></p>`;
}

function header(): string {
  const unsaved = ledger.unflushedCount;
  return `<header><h1><a href="#" data-go="queue">Step Up Helper</a></h1>
    <nav><label class="btn">Import events<input type="file" id="import" accept=".jsonl,.json,.txt" hidden></label>
    <button id="export">Export events</button>${unsaved ? `<span class="warn">${unsaved} unsaved</span>` : ""}</nav></header>
    ${connectionBar()}${status ? `<p class="warn">${esc(status)}</p>` : ""}`;
}

function queueView(): string {
  const state = ledger.state;
  const entries = buildQueue(state, ctx());
  const children = Object.values(state.children);
  const childForm = `<details><summary>Children (${children.length})</summary>
    <ul>${children.map((c) => `<li>${esc(c.name)} ${c.scholarship ? `<small>${esc(c.scholarship)}</small>` : ""}</li>`).join("")}</ul>
    <form id="add-child" class="row"><input name="name" placeholder="Name" required><input name="scholarship" placeholder="Scholarship (e.g. FES-UA)"><button>Add child</button></form></details>`;
  const startBlank = `<p><button id="new-purchase">New purchase without a file</button></p>`;
  if (entries.length === 0) return `${childForm}${startBlank}<p>Nothing needs attention.</p>`;
  const rows = entries.map((e) => {
    const sugg = (e.suggestions ?? []).map((s) => {
      const name = s.target.kind === "purchase" ? state.purchases[s.target.id]?.vendor ?? s.target.id : state.items[s.target.id]?.description ?? s.target.id;
      return `<button data-attach="${esc(e.id)}" data-kind="${s.target.kind}" data-target="${esc(s.target.id)}" data-role="${s.role}">${s.role === "receipt" ? "Receipt of" : "Attach to"} ${esc(name)}</button>`;
    }).join("");
    const actions =
      e.kind === "unattached-document"
        ? `<button data-start="${esc(e.id)}">Start purchase</button>${sugg}`
        : `<button data-open="${esc(e.purchaseId ?? e.id)}">Open</button>`;
    const hint = e.hints?.vendor || e.hints?.date ? `<small>Looks like: ${esc([e.hints.vendor, e.hints.date].filter(Boolean).join(", "))}</small>` : "";
    return `<li class="q"><div><strong>${esc(e.title)}</strong> ${hint}<br><small>${esc(e.reasons.join("; "))}</small></div><div class="actions">${actions}</div></li>`;
  });
  return `${childForm}${startBlank}<h2>Needs your attention (${entries.length})</h2><ul class="queue">${rows.join("")}</ul>`;
}

function purchaseView(id: string): string {
  const state = ledger.state;
  const p = state.purchases[id];
  if (!p) return `<p>That purchase no longer exists.</p>`;
  const doc = p.receiptDocumentId ? state.documents[p.receiptDocumentId] : undefined;
  const items = itemsOf(state, id);
  const remaining = remainingToItemize(state, id);
  const next = suggestNextItem(state, id);
  const children = Object.values(state.children);
  const money = (c: number | undefined) => (c === undefined ? "" : (c / 100).toFixed(2));
  const rows = items.map((i) => {
    const ev = evaluateItem(state, i.id, ctx());
    return `<tr><td>${esc(state.children[i.childId ?? ""]?.name ?? "?")}</td><td>${esc(i.description)}</td><td class="num">${formatCents(i.amountCents)}</td>
      <td class="num">${formatCents(i.taxShippingCents)}${i.taxShippingEstimated ? " <small>est.</small>" : ""}</td><td>${esc(i.categoryId ?? "")}</td>
      <td>${ev.readiness === "ready" ? `<span class="ok">Ready</span>` : `<small class="warn">${esc(ev.reasons.map((r) => r.message).join("; "))}</small>`}</td>
      <td><button data-dup="${esc(i.id)}">Duplicate</button></td></tr>`;
  });
  const categories = [...new Set(Object.values(state.items).map((i) => i.categoryId).filter(Boolean))];
  return `<p><a href="#" data-go="queue">&larr; Back to the list</a></p>
  <h2>Receipt${doc ? `: ${esc(doc.filename)}` : " (no file yet)"}</h2>
  <form id="purchase-form" class="grid" data-id="${esc(id)}">
    <label>Vendor<input name="vendor" value="${esc(p.vendor)}"></label>
    <label>Date<input name="date" type="date" value="${esc(p.date)}"></label>
    <label>Invoice #<input name="invoiceNo" value="${esc(p.invoiceNo)}"></label>
    <label>Receipt total<input name="orderTotal" inputmode="decimal" value="${money(p.orderTotalCents)}"></label>
    <label>Tax/shipping total<input name="taxTotal" inputmode="decimal" value="${money(p.taxShippingTotalCents)}"></label>
    <button>Save receipt details</button></form>
  <h3>Items${remaining !== undefined ? ` <small>(${formatCents(remaining)} left to itemize)</small>` : ""}</h3>
  ${items.length ? `<table><thead><tr><th>Child</th><th>Description</th><th>Amount</th><th>Tax/ship</th><th>Category</th><th>Status</th><th></th></tr></thead><tbody>${rows.join("")}</tbody></table>` : "<p>No items yet.</p>"}
  ${items.length && p.taxShippingTotalCents !== undefined ? `<p><button data-realloc="${esc(id)}">Spread the real tax/shipping across items</button></p>` : ""}
  <h3>Add an item</h3>
  ${children.length === 0 ? `<p class="warn">Add a child on the list page first.</p>` : ""}
  <form id="item-form" class="grid" data-id="${esc(id)}">
    <label>Child<select name="childId" required>${children.map((c) => `<option value="${esc(c.id)}"${c.id === next.childId ? " selected" : ""}>${esc(c.name)}</option>`).join("")}</select></label>
    <label>Description<input name="description" required></label>
    <label>Amount<input name="amount" inputmode="decimal" required value="${money(next.amountCents)}"></label>
    <label>Category<input name="categoryId" list="cats" required></label><datalist id="cats">${categories.map((c) => `<option value="${esc(c)}">`).join("")}</datalist>
    <label>Benefit message<input name="benefitMessage" required></label>
    <label>Service date<input name="serviceDate" type="date"></label>
    <label>Service provider<input name="serviceProvider" value="${esc(next.serviceProvider)}"></label>
    <button>Save and add another</button></form>`;
}

function render(): void {
  root.innerHTML = header() + (view.name === "queue" ? queueView() : purchaseView(view.id));
}

function go(next: View): void {
  view = next;
  render();
}

root.addEventListener("click", async (ev) => {
  const t = (ev.target as HTMLElement).closest<HTMLElement>("button, a");
  if (!t) return;
  const d = t.dataset;
  if (d["go"]) { ev.preventDefault(); go({ name: "queue" }); }
  else if (t.id === "sign-in") await signIn();
  else if (t.id === "sign-out") { savePointer(undefined); await signOut(); }
  else if (t.id === "disconnect") { savePointer(undefined); workspace = undefined; activeStore = store; ledger = new Ledger(store, new HlcClock(store.clientId), "web"); await ledger.refresh(); render(); }
  else if (t.id === "check-files" && workspace) {
    await guarded(async () => {
      const plan = planIngest(ledger.state, await listLooseFiles(workspace!.driveId, workspace!.year.folderId));
      registerLooseFiles(ledger, plan.toRegister);
      await ledger.flush();
      status = plan.toRegister.length ? `Registered ${plan.toRegister.length} new file(s).` : "No new files.";
    });
  }
  else if (t.id === "export") {
    await ledger.flush();
    const url = URL.createObjectURL(new Blob([exportJsonl(await activeStore.readAll())], { type: "text/plain" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: "events.jsonl" });
    a.click();
    URL.revokeObjectURL(url);
  } else if (t.id === "new-purchase") {
    const id = createPurchase(ledger);
    await ledger.flush();
    go({ name: "purchase", id });
  } else if (d["open"]) go({ name: "purchase", id: d["open"] });
  else if (d["start"]) {
    const doc = ledger.state.documents[d["start"]];
    const hints = fileNameHints(doc?.filename ?? "");
    const id = startPurchaseFromDocument(ledger, d["start"], { vendor: hints.vendor, date: hints.date });
    await ledger.flush();
    go({ name: "purchase", id });
  } else if (d["attach"]) {
    const target: MapTarget = { kind: d["kind"] as "purchase" | "item", id: d["target"]! };
    const result = d["role"] === "receipt" ? attachAsReceipt(ledger, target.id, d["attach"]) : attachAdditional(ledger, target, d["attach"]);
    if (!result.ok) alert(`Could not attach: ${result.reason}`);
    await save();
  } else if (d["dup"]) {
    duplicateItem(ledger, d["dup"]);
    await save();
  } else if (d["realloc"]) {
    reallocateTax(ledger, d["realloc"]);
    await save();
  }
});

root.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const form = ev.target as HTMLFormElement;
  if (form.id === "connect") {
    await guarded(async () => attach(await openWorkspace(await pointerFromLink(val(form, "link")), store.clientId)));
    return;
  }
  if (form.id === "add-child") {
    ledger.set("child", newId("child"), { name: val(form, "name"), ...(val(form, "scholarship") ? { scholarship: val(form, "scholarship") } : {}) }, { label: "child.created" });
  } else if (form.id === "purchase-form") {
    const fields: Record<string, string | number> = {};
    for (const k of ["vendor", "date", "invoiceNo"]) if (val(form, k)) fields[k] = val(form, k);
    const total = toCents(val(form, "orderTotal"));
    const tax = toCents(val(form, "taxTotal"));
    if (total !== undefined) fields["orderTotalCents"] = total;
    if (tax !== undefined) fields["taxShippingTotalCents"] = tax;
    ledger.set("purchase", form.dataset["id"]!, fields, { label: "purchase.edited" });
    if (tax !== undefined) reallocateTax(ledger, form.dataset["id"]!);
  } else if (form.id === "item-form") {
    addItem(ledger, form.dataset["id"]!, {
      childId: val(form, "childId"),
      description: val(form, "description"),
      amountCents: toCents(val(form, "amount")),
      categoryId: val(form, "categoryId"),
      benefitMessage: val(form, "benefitMessage"),
      serviceDate: val(form, "serviceDate") || undefined,
      serviceProvider: val(form, "serviceProvider") || undefined,
    });
  }
  await save();
});

root.addEventListener("change", async (ev) => {
  const input = ev.target as HTMLInputElement;
  if (input.id === "year-pick" && workspace) {
    const pointer = workspace.pointer;
    await guarded(async () => attach(await openWorkspace(pointer, store.clientId, input.value)));
    return;
  }
  if (input.id !== "import" || !input.files?.[0]) return;
  const events = parseJsonl(await input.files[0].text());
  await activeStore.appendOwn(events);
  await ledger.refresh();
  render();
});

await ledger.refresh();
render();
await guarded(async () => {
  account = await initAuth();
  const pointer = loadPointer();
  if (account && pointer) await attach(await openWorkspace(pointer, store.clientId));
});
