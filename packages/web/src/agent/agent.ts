import {
  STEPUP_PATTERNS,
  categoriesOfRequest,
  categoryCacheFrom,
  checkStepUpShape,
  chunks,
  detailIdsToExpand,
  emptyCategoryCache,
  expansionDue,
  mergeCategorySearch,
  mergeDetails,
  mergeTypes,
  mergeVendors,
  parseBalances,
  parseStudents,
  typeIdsToExpand,
  type CategoryCache,
  type VendorEntry,
} from "@step-up/shared/web";
import type { Observed } from "./observe.js";
import { AGENT_PROTOCOL, type AgentToApp, type AppToAgent, type RecordingReport } from "./protocol.js";
import { mapForm, type FormRoot } from "./form.js";
import { runSpike, type PageOps } from "./spike.js";
import { Recorder } from "./recorder.js";
import { findAccessToken, tokenFresh, PERSON_SCOPE, PROVIDER_SCOPE, type StepUpToken } from "./token.js";

export { AGENT_PROTOCOL };

const API = "https://reimbursementapi-prod.stepupforstudents.org/api/reimbursements/V2/search";
const CATEGORIES_SEARCH = "https://reimbursementapi-prod.stepupforstudents.org/api/categories/search";
const CATEGORY_TYPES = "https://reimbursementapi-prod.stepupforstudents.org/api/categories/typesbyids";
const VENDORS_SEARCH = "https://providerapi-prod.stepupforstudents.org/api/vendors/search";

/** The request envelope every StepUp "search" takes (seen in recordings); only `Filters` differs between calls. */
const envelope = (filters: Record<string, unknown>) => ({
  ApplyDefaultFilters: true,
  ContextBag: {},
  CurrentPage: null,
  Filters: filters,
  IncludeGlobalSearchTotal: false,
  Keywords: null,
  MultiOrderBy: {},
  OrderBy: null,
  PageSize: null,
  SkipCount: false,
  SortOrder: 0,
});
const CHUNK = 50;
const CHUNK_DELAY_MS = 400;
const HANDSHAKE_TRIES = 75;
const HANDSHAKE_MS = 400;
const QUEUE_LIMIT = 100;
const HEARTBEAT_MS = 20_000;

/**
 * The only requests the agent ever makes itself, and the only methods it may use: reads. Every one is a call StepUp's own
 * page makes (a search or a plain GET). Anything else throws, so the agent cannot create, change, upload or submit anything;
 * all writes to StepUp are made by StepUp's own page when a person uses it.
 */
const OWN_READS: Array<{ method: "GET" | "POST"; url: RegExp }> = [
  { method: "POST", url: /^https:\/\/reimbursementapi-prod\.stepupforstudents\.org\/api\/reimbursements\/V2\/search(\?|$)/i },
  { method: "GET", url: /^https:\/\/personapi-prod\.stepupforstudents\.org\/api\/guardian\/[0-9a-f-]{36}\/studentScholarship\/?(\?[^#]*)?$/i },
  { method: "POST", url: /^https:\/\/reimbursementapi-prod\.stepupforstudents\.org\/api\/categories\/(search|typesbyids|detailsbyids)(\?[^#]*)?$/i },
  { method: "POST", url: /^https:\/\/providerapi-prod\.stepupforstudents\.org\/api\/vendors\/search(\?[^#]*)?$/i },
];

/** Whether a request is one the agent is allowed to make (exported for the tests). */
export const isAllowedOwnRead = (method: string, url: string): boolean => OWN_READS.some((r) => r.method === method.toUpperCase() && r.url.test(url));

export interface AppWindow {
  postMessage(data: unknown, origin: string): void;
  closed?: boolean;
}

/** Everything the agent needs from the page it runs in; the real one is built in main.ts, tests supply fakes. */
export interface AgentHost {
  storage: Pick<Storage, "length" | "key" | "getItem">;
  /** The page's own `fetch`, not observed: the agent's own calls go through it. */
  fetch: typeof fetch;
  /** Opens (or reuses) the app's window. Must be called from the click that started the bookmarklet. */
  open(url: string, name: string): AppWindow | null;
  addMessageListener(fn: (e: { origin: string; source: unknown; data: unknown }) => void): () => void;
  /** One message box on the page; `keep` leaves it up until the next message. */
  say(text: string, keep?: boolean): void;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Calls `fn` every `ms` until the returned function is called. Optional: without it the agent sends no "alive" messages. */
  every?(ms: number, fn: () => void): () => void;
  /** Where the app lives, with a trailing slash. */
  appHome: string;
  currentPage(): string;
  /** The page's document, for reading the form on it. Optional: without it a form map is empty. */
  readPage?(): FormRoot;
  /** The page's full address (the wizard step is in it). */
  currentUrl?(): string;
  /** What the spike tests may do to the page. Optional: without it every spike test is refused. */
  pageOps?: PageOps;
  /** The text a stylesheet adds before or after an element (it counts towards a button's name). */
  pseudoText?(el: unknown, which: "::before" | "::after"): string | undefined;
}

/** What survives replacing the agent with a newer copy of itself (a second click loads the latest script). */
export interface AgentState {
  categories: CategoryCache;
  vendors: Record<string, VendorEntry>;
  /** The recording as data: the newer agent rebuilds its own recorder from it (never reuses the older object's code). */
  recording: RecordingReport;
  lastListSignature?: string;
}

/**
 * The part of Step Up Helper that runs on StepUp's own page. It reads the person's StepUp sign-in from the page's session
 * storage (never sending it anywhere), asks StepUp for the reimbursements list the way the dashboard does, watches the
 * page's own requests for what is worth learning, and hands only that data to the app. The app owns all storage.
 */
export class StepUpAgent {
  private win: AppWindow | null = null;
  private ready = false;
  private cacheKnown = false;
  private queue: AgentToApp[] = [];
  private categories: CategoryCache;
  private vendors: Record<string, VendorEntry>;
  readonly recorder: Recorder;
  private lastListSignature: string | undefined;
  private expanding = false;
  /** Off until the app says so: the agent then only watches the page, plus the one list a click asks for. */
  private activeReads = false;
  private unlisten: (() => void) | undefined;
  private stopBeat: (() => void) | undefined;
  private spikeOn = false;
  private spikeBusy = false;
  private saveCount = 0;
  private disposed = false;
  private readonly appOrigin: string;

  constructor(private readonly host: AgentHost, carried?: AgentState) {
    this.appOrigin = new URL(host.appHome).origin;
    this.categories = carried?.categories ?? emptyCategoryCache();
    this.vendors = carried?.vendors ?? {};
    // `carried.recording` may come from an older copy of this script, whose recorder object has older code and may even be a
    // live object rather than data: take its report either way and rebuild.
    const was = carried?.recording as unknown;
    const data = was && typeof (was as { report?: unknown }).report === "function" ? (was as { report(): RecordingReport }).report() : (was as RecordingReport | undefined);
    this.recorder = Recorder.restore(data);
    this.lastListSignature = carried?.lastListSignature;
    this.unlisten = host.addMessageListener((e) => this.onAppMessage(e));
  }

  state(): AgentState {
    return { categories: this.categories, vendors: this.vendors, recording: this.recorder.report(), lastListSignature: this.lastListSignature };
  }

  dispose(): void {
    this.disposed = true;
    this.stopBeat?.();
    this.unlisten?.();
  }

  /** Tells the app this page is going away (a reload or a closed tab), so it shows that at once instead of after a wait. */
  goodbye(): void {
    this.sendLive({ type: "stepup-bye" });
  }

  /** Straight to the app's window or nowhere: a late "alive" is worthless, so these are never queued. */
  private sendLive(m: AgentToApp): void {
    if (!this.win || !this.ready || this.win.closed) return;
    try {
      this.win.postMessage(m, this.appOrigin);
    } catch {
      /* the window is gone */
    }
  }

  private beat(): void {
    this.sendLive({ type: "stepup-alive", version: AGENT_PROTOCOL, page: this.host.currentPage() });
  }

  /** The bookmark was clicked: connect to the app and bring the current list in. Opens the app's window before anything else. */
  async start(): Promise<void> {
    const say = this.host.say.bind(this.host);
    const token = findAccessToken(this.host.storage);
    if (!token) return say("I could not find your StepUp sign-in. Open StepUp's Dashboard and click again.");
    if (!tokenFresh(token, this.host.now())) return say("Your StepUp sign-in just expired. Reload this page, then click again.");
    if (!token.guardian) return say("StepUp's sign-in did not say who you are, so nothing was fetched.");

    this.ready = false;
    this.win = this.host.open(`${this.host.appHome}#stepup-import`, "stepup-helper");
    if (!this.win) return say("The pop-up was blocked. Allow pop-ups for StepUp, then click again.");
    say("Asking StepUp for your reimbursements (a few seconds)…", true);
    const connected = this.handshake();

    let results: unknown[] | undefined;
    try {
      const r = await this.ownRead(`${API}?v=${this.ticks()}`, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${token.secret}` },
        body: JSON.stringify({ Keywords: null, CurrentPage: null, PageSize: null, OrderBy: null, SortOrder: 0, MultiOrderBy: {}, Filters: { GuardianId: token.guardian, ExcludedStatuses: ["Canceled"] }, ApplyDefaultFilters: true, ContextBag: {}, IncludeGlobalSearchTotal: false, SkipCount: false }),
      });
      if (!r.ok) return say(`StepUp answered ${r.status}. Reload this page and click again.`);
      say("StepUp answered. Reading the list…", true);
      const body = (await r.json()) as { Results?: unknown };
      if (!Array.isArray(body.Results)) return say("StepUp's list was not in the expected form, so nothing was sent.");
      const problems = checkStepUpShape("reimbursements-search", body);
      if (problems.length) return say("StepUp's list no longer looks the way this expects (the site may have changed), so nothing was sent.");
      results = body.Results;
      // Our own calls are not observed; they are indexed so a request later can be traced to the response its ids came from.
      this.recorder.noteOwnResponse("POST", API, body);
    } catch (err) {
      return say(`Something went wrong: ${err instanceof Error ? err.message : String(err)}`);
    }

    say(`Got ${results.length} reimbursements. Waiting for Step Up Helper…`, true);
    if (!(await connected)) return say("Step Up Helper did not answer. Open it, sign in, and click again.");
    this.stopBeat?.();
    this.stopBeat = this.host.every?.(HEARTBEAT_MS, () => this.beat());
    this.beat();
    this.lastListSignature = signatureOf(results);
    this.post({ type: "stepup-list", results });
    say(`Sent ${results.length} reimbursements to Step Up Helper. Switch to its tab to see what changed.`);
    if (this.activeReads) {
      await this.readStudents(token.guardian);
      await this.refreshLearned();
    }
  }

  /**
   * Once a day, after a click: StepUp's category tree and provider list, asked for directly with the page's own sign-in
   * (the same calls the page makes, with the request shapes recorded from it). Nothing waits for a person to open a dropdown.
   */
  private async refreshLearned(): Promise<void> {
    // The app says what it already knows a moment after it connects; without that, a day's work might be repeated.
    for (let i = 0; i < 25 && this.ready && !this.cacheKnown; i++) await this.host.sleep(200);
    if (this.expanding || !this.ready || !this.cacheKnown || !expansionDue(this.categories, this.host.now())) return;
    const token = findAccessToken(this.host.storage);
    if (!token || !tokenFresh(token, this.host.now(), 5 * 60_000)) return;
    this.expanding = true;
    try {
      const found = await this.callApi(CATEGORIES_SEARCH, envelope({ IsActive: true }), token);
      if (found !== undefined && checkStepUpShape("categories-search", found).length === 0) {
        mergeCategorySearch(this.categories, found);
        await this.expandTree(token, CATEGORY_TYPES, []);
      }
      const providerToken = findAccessToken(this.host.storage, PROVIDER_SCOPE);
      if (providerToken && tokenFresh(providerToken, this.host.now(), 5 * 60_000)) {
        const vendors = await this.callApi(VENDORS_SEARCH, envelope({}), providerToken);
        const touched = vendors === undefined ? [] : mergeVendors(this.vendors, vendors, []);
        if (touched.length) this.post({ type: "stepup-learned", kind: "vendors", entries: touched });
      }
    } catch {
      /* best effort: tried again at the next click */
    } finally {
      this.expanding = false;
    }
  }

  /** One of StepUp's own calls with the page's sign-in; the parsed body, or undefined when it was refused. */
  private async callApi(url: string, body: unknown, token: StepUpToken): Promise<unknown | undefined> {
    const r = await this.ownRead(url, { method: "POST", headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${token.secret}` }, body: JSON.stringify(body) });
    if (!r.ok) return undefined;
    const json = await r.json();
    this.recorder.noteOwnResponse("POST", url, json);
    return json;
  }

  /** Types, then their details, in small batches with a pause between (as the command line always did). Records the day. */
  private async expandTree(token: StepUpToken, typesUrl: string, requested: string[]): Promise<void> {
    const each = async (url: string, ids: string[], merge: (c: CategoryCache, d: unknown) => number): Promise<void> => {
      for (const batch of chunks(ids, CHUNK)) {
        if (this.disposed) return;
        const r = await this.ownRead(url, { method: "POST", headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${token.secret}` }, body: JSON.stringify(batch) });
        if (r.ok) {
          const json = await r.json();
          this.recorder.noteOwnResponse("POST", url, json);
          merge(this.categories, json);
        } else if (r.status === 401 || r.status === 403) return;
        await this.host.sleep(CHUNK_DELAY_MS);
      }
    };
    await each(typesUrl, typeIdsToExpand(this.categories, requested), mergeTypes);
    await each(typesUrl.replace(/typesbyids/i, "detailsbyids"), detailIdsToExpand(this.categories), mergeDetails);
    this.categories.lastSyncAt = this.host.now();
    this.post({ type: "stepup-learned", kind: "categories", cache: this.categories });
  }

  /** The student list is a plain read with the person-API sign-in; best effort (a refusal just means it is not learned now). */
  private async readStudents(guardian: string): Promise<void> {
    const token = findAccessToken(this.host.storage, PERSON_SCOPE);
    if (!token || !tokenFresh(token, this.host.now())) return;
    try {
      const r = await this.ownRead(`https://personapi-prod.stepupforstudents.org/api/guardian/${guardian}/studentScholarship/`, {
        method: "GET",
        headers: { authorization: `Bearer ${token.secret}` },
      });
      if (!r.ok) return;
      const json = await r.json();
      this.recorder.noteOwnResponse("GET", `https://personapi-prod.stepupforstudents.org/api/guardian/${guardian}/studentScholarship/`, json);
      const students = parseStudents(json);
      if (students.length) this.post({ type: "stepup-learned", kind: "students", students });
    } catch {
      /* not learned now; the dashboard asks for it itself too */
    }
  }

  /** The one way the agent makes a request of its own: refuses anything that is not a known read. */
  private async ownRead(url: string, init: RequestInit): Promise<Response> {
    if (!isAllowedOwnRead(init.method ?? "GET", url)) throw new Error(`The agent does not make this request: ${init.method ?? "GET"} ${url}`);
    return this.host.fetch(url, init);
  }

  private ticks(): string {
    return String(BigInt(this.host.now()) * 10000n + 621355968000000000n);
  }

  private async handshake(): Promise<boolean> {
    for (let i = 0; i < HANDSHAKE_TRIES && !this.ready && !this.disposed; i++) {
      try {
        this.win?.postMessage({ type: "stepup-hello", version: AGENT_PROTOCOL } satisfies AgentToApp, this.appOrigin);
      } catch {
        /* the window is gone */
      }
      if (this.ready) break; // the app answered while it was being greeted: no need to wait out the interval
      await this.host.sleep(HANDSHAKE_MS);
    }
    if (this.ready) this.flush();
    return this.ready;
  }

  private onAppMessage(e: { origin: string; source: unknown; data: unknown }): void {
    if (e.origin !== this.appOrigin || !this.win || e.source !== this.win || !e.data || typeof e.data !== "object") return;
    const m = e.data as AppToAgent;
    switch (m.type) {
      case "stepup-ready":
        this.ready = true;
        this.flush();
        break;
      case "stepup-cache":
        // What the workspace already knows: build on it, so the once-a-day expansion is not repeated by every new session.
        this.categories = mergeKnown(this.categories, categoryCacheFrom(m.categories));
        this.cacheKnown = true;
        break;
      case "stepup-record":
        if (m.on) this.recorder.start(new Date(this.host.now()).toISOString(), this.host.currentPage(), m.values === true);
        else this.recorder.stop();
        break;
      case "stepup-spike-enable":
        this.spikeOn = m.on === true;
        break;
      case "stepup-spike":
        void this.spike(m.test);
        break;
      case "stepup-formmap":
        this.post({ type: "stepup-formmap", map: mapForm(this.host.readPage?.() ?? { querySelectorAll: () => [] }, this.host.currentUrl?.() ?? this.host.currentPage(), { pseudo: (el, which) => this.host.pseudoText?.(el, which) }) });
        break;
      case "stepup-report":
        this.post({ type: "stepup-recording", report: this.recorder.report() });
        break;
      case "stepup-refresh-students": {
        const t = findAccessToken(this.host.storage);
        if (this.activeReads && t?.guardian) void this.readStudents(t.guardian);
        break;
      }
      case "stepup-settings":
        this.activeReads = m.activeReads === true;
        break;
    }
  }

  /** One spike test; refused unless tools are on and a page to act on exists. One at a time. */
  private async spike(test: Parameters<typeof runSpike>[0]): Promise<void> {
    const reply = (ok: boolean, line: string): void => this.sendLive({ type: "stepup-spike-result", result: { test: "spike", ok, lines: [line] } });
    if (!this.spikeOn) return reply(false, "Spike tools are off.");
    if (!this.host.pageOps || !this.host.readPage) return reply(false, "This page cannot be acted on.");
    if (this.spikeBusy) return reply(false, "A test is already running.");
    this.spikeBusy = true;
    try {
      const result = await runSpike(test, {
        ops: this.host.pageOps,
        root: this.host.readPage(),
        url: this.host.currentUrl?.() ?? this.host.currentPage(),
        sleep: (ms) => this.host.sleep(ms),
        saves: () => this.saveCount,
      });
      this.sendLive({ type: "stepup-spike-result", result });
    } catch (err) {
      reply(false, `The test stopped: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.spikeBusy = false;
    }
  }

  private post(m: AgentToApp): void {
    if (this.win && this.ready && !this.win.closed) {
      try {
        this.win.postMessage(m, this.appOrigin);
        return;
      } catch {
        /* fall through to the queue */
      }
    }
    // The app's window is not there (closed, or still loading): keep a little, and send it when the next click reconnects.
    if (m.type === "stepup-list") return;
    this.queue.push(m);
    if (this.queue.length > QUEUE_LIMIT) this.queue.shift();
  }

  private flush(): void {
    const pending = this.queue;
    this.queue = [];
    for (const m of pending) this.post(m);
  }

  /** Called for every request the page makes (see observe.ts). */
  observed(o: Observed): void {
    if (this.disposed) return;
    this.recorder.note(o);
    // StepUp's own save of the reimbursement is the best sign that a change was committed.
    if (o.method.toUpperCase() === "PUT" && /\/api\/reimbursements\/v2\//i.test(o.url) && o.status >= 200 && o.status < 300) this.saveCount++;
    if (o.status < 200 || o.status >= 300 || !o.responseText) return;
    const url = o.url;
    const P = STEPUP_PATTERNS;
    if (!Object.values(P).some((re) => re.test(url))) return;
    let body: unknown;
    try {
      body = JSON.parse(o.responseText);
    } catch {
      return;
    }

    if (P.reimbursementsSearch.test(url)) {
      // The dashboard asked for the list itself (any time after the click): pass it on if it is new.
      const results = (body as { Results?: unknown }).Results;
      if (!Array.isArray(results) || results.length === 0 || checkStepUpShape("reimbursements-search", body).length) return;
      const sig = signatureOf(results);
      if (sig === this.lastListSignature) return;
      this.lastListSignature = sig;
      this.post({ type: "stepup-list", results });
    } else if (P.categoriesSearch.test(url)) {
      if (checkStepUpShape("categories-search", body).length) return;
      if (mergeCategorySearch(this.categories, body) > 0) this.post({ type: "stepup-learned", kind: "categories", cache: this.categories });
    } else if (P.categoryTypes.test(url)) {
      if (mergeTypes(this.categories, body) > 0) this.post({ type: "stepup-learned", kind: "categories", cache: this.categories });
      void this.maybeExpand(url, idsIn(o.requestBody));
    } else if (P.categoryDetails.test(url)) {
      if (mergeDetails(this.categories, body) > 0) this.post({ type: "stepup-learned", kind: "categories", cache: this.categories });
    } else if (P.studentScholarship.test(url)) {
      const students = parseStudents(body);
      if (students.length) this.post({ type: "stepup-learned", kind: "students", students });
    } else if (P.balances.test(url)) {
      const balances = parseBalances(body);
      if (Object.keys(balances).length) this.post({ type: "stepup-learned", kind: "balances", balances });
    } else if (P.vendorDropdown.test(url)) {
      const ids = categoriesOfRequest(`${url}\n${o.requestBody ?? ""}`, this.categories);
      const touched = mergeVendors(this.vendors, body, ids);
      if (touched.length) this.post({ type: "stepup-learned", kind: "vendors", entries: touched });
    }
  }

  /**
   * Once a day, the first time the page itself asks about category types, ask for every type and detail we know the id of
   * (a type's details only appear when asked for). Uses the page's own sign-in and the same address the page just used,
   * in small batches with a pause between them, as the command line always did.
   */
  private async maybeExpand(typesUrl: string, requested: string[]): Promise<void> {
    if (!this.activeReads || this.expanding || !this.ready || !this.cacheKnown || !expansionDue(this.categories, this.host.now())) return;
    const token = findAccessToken(this.host.storage);
    if (!token || !tokenFresh(token, this.host.now(), 5 * 60_000)) return;
    this.expanding = true;
    try {
      await this.expandTree(token, typesUrl, requested);
    } catch {
      /* best effort: it is tried again the next time the page asks */
    } finally {
      this.expanding = false;
    }
  }
}

/** The request body of a `…byids` call is a JSON array of ids. */
function idsIn(body: string | undefined): string[] {
  try {
    const v = JSON.parse(body ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** A cheap fingerprint of a list, so an identical repeat is not sent again. */
export function signatureOf(results: unknown[]): string {
  const text = JSON.stringify(results);
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0;
  return `${results.length}:${text.length}:${h}`;
}

function mergeKnown(mine: CategoryCache, theirs: CategoryCache): CategoryCache {
  return {
    lastSyncAt: Math.max(mine.lastSyncAt, theirs.lastSyncAt),
    categories: { ...theirs.categories, ...mine.categories },
    types: { ...theirs.types, ...mine.types },
    details: { ...theirs.details, ...mine.details },
    partnerCodes: { ...theirs.partnerCodes, ...mine.partnerCodes },
  };
}
