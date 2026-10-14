import { describe, expect, it } from "vitest";
import { StepUpAgent, signatureOf, type AgentHost, type AppWindow } from "../src/agent/agent.js";
import { observeTraffic } from "../src/agent/observe.js";
import { findAccessToken, REIMBURSEMENT_SCOPE } from "../src/agent/token.js";
import { shapeOf, normalizeUrl } from "../src/agent/recorder.js";

const HOME = "https://app.example/";
const APP = "https://app.example";
const jwt = (claims: Record<string, unknown>) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
const soon = () => Math.floor(Date.now() / 1000) + 3000;

const listBody = (n = 2) => ({ Results: Array.from({ length: n }, (_, i) => ({ Id: `g${i}`, LineItems: [{ LineItemNumber: `${i}-1`, ExternalStatus: "Submitted", Appealed: false, ItemAmount: 10 }] })) });
const API_LIST = "https://reimbursementapi-prod.stepupforstudents.org/api/reimbursements/V2/search";
const CATS = "https://reimbursementapi-prod.stepupforstudents.org/api/categories/search";
const TYPES = "https://reimbursementapi-prod.stepupforstudents.org/api/categories/typesbyids";
const VENDORS = "https://providerapi-prod.stepupforstudents.org/api/businesssummary/getbusinesssummarydropdown";

interface Setup {
  tokens?: Array<{ target: string; expiresOn: number; claims?: Record<string, unknown> }>;
  popup?: boolean;
  appAnswers?: boolean;
  /** The app also says what it already knows right after "ready" (it does once its workspace is open). */
  appCache?: { lastSyncAt: number };
  fetchStatus?: number;
  fetchBody?: unknown;
  handler?: (url: string, body: unknown) => unknown;
}

function make(setup: Setup = {}) {
  const store = new Map<string, string>();
  (setup.tokens ?? [{ target: REIMBURSEMENT_SCOPE, expiresOn: soon() }]).forEach((t, i) =>
    store.set(`msal.2|a|b|accesstoken|${i}`, JSON.stringify({ credentialType: "AccessToken", target: `https://x/${t.target}`, expiresOn: t.expiresOn, secret: jwt(t.claims ?? { scholar_personId: "person-1" }) })));
  store.set("msal.version", "2.0");
  const said: string[] = [];
  const sent: Array<{ data: { type: string; [k: string]: unknown }; origin: string }> = [];
  const requests: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
  const listeners: Array<(e: { origin: string; source: unknown; data: unknown }) => void> = [];
  let opened: unknown[] | undefined;
  const deliver = (e: { origin: string; source: unknown; data: unknown }) => listeners.forEach((l) => l(e));
  const popup: AppWindow = {
    postMessage(data, origin) {
      sent.push({ data: data as never, origin });
      if ((data as { type: string }).type === "stepup-hello" && setup.appAnswers !== false) {
        deliver({ origin: APP, source: popup, data: { type: "stepup-ready" } });
        if (setup.appCache) deliver({ origin: APP, source: popup, data: { type: "stepup-cache", categories: { lastSyncAt: setup.appCache.lastSyncAt, categories: {}, types: {}, details: {}, partnerCodes: {} } } });
      }
    },
  };
  let now = Date.now();
  const host: AgentHost = {
    storage: { get length() { return store.size; }, key: (i) => [...store.keys()][i] ?? null, getItem: (k) => store.get(k) ?? null },
    fetch: (async (url: string, init: { headers: Record<string, string>; body: string }) => {
      const body = init.body ? JSON.parse(init.body) : undefined;
      requests.push({ url, headers: init.headers, body });
      const data = setup.handler ? setup.handler(url, body) : setup.fetchBody ?? listBody();
      const status = setup.fetchStatus ?? 200;
      return { ok: status < 300, status, json: async () => data };
    }) as unknown as typeof fetch,
    open: (...a) => ((opened = a), setup.popup === false ? null : popup),
    addMessageListener: (fn) => { listeners.push(fn); return () => listeners.splice(listeners.indexOf(fn), 1); },
    say: (t) => { said.push(t); },
    now: () => now,
    sleep: async (ms) => { now += ms; },
    appHome: HOME,
    currentPage: () => "apply/Dashboard",
  };
  const agent = new StepUpAgent(host);
  const fromApp = (data: unknown, origin = APP, source: unknown = popup) => deliver({ origin, source, data });
  return { agent, host, said, sent, requests, opened: () => opened, fromApp, advance: (ms: number) => { now += ms; } };
}

const typesOf = (r: ReturnType<typeof make>) => r.sent.map((s) => s.data.type);
const obs = (url: string, body: unknown, status = 200, requestBody?: unknown) => ({
  via: "fetch" as const, method: "POST", url, status, ms: 5,
  responseText: JSON.stringify(body), requestBody: requestBody === undefined ? undefined : JSON.stringify(requestBody),
});

describe("the agent starting from the bookmark", () => {
  it("reads the token, asks for the list as the dashboard does, and sends only the list to the app", async () => {
    const r = make({ tokens: [{ target: "other/access_as_user", expiresOn: soon() }, { target: REIMBURSEMENT_SCOPE, expiresOn: soon(), claims: { scholar_personId: "person-9" } }] });
    await r.agent.start();
    expect(r.opened()).toEqual([`${HOME}#stepup-import`, "stepup-helper"]);
    expect(r.requests).toHaveLength(1);
    expect(r.requests[0]!.url).toMatch(/^https:\/\/reimbursementapi-prod\.stepupforstudents\.org\/api\/reimbursements\/V2\/search\?v=\d+$/);
    expect((r.requests[0]!.body as { Filters: unknown }).Filters).toEqual({ GuardianId: "person-9", ExcludedStatuses: ["Canceled"] });
    expect(r.requests[0]!.headers["authorization"]).toMatch(/^Bearer h\./);
    const list = r.sent.find((s) => s.data.type === "stepup-list")!;
    expect(list.origin).toBe(APP);
    expect((list.data["results"] as unknown[]).length).toBe(2);
    expect(JSON.stringify(r.sent)).not.toContain("Bearer");
    expect(r.said.at(-1)).toMatch(/Sent 2 reimbursements/);
  });

  it("uses the token that expires last, and says why when it cannot go on", async () => {
    const newer = make({ tokens: [{ target: REIMBURSEMENT_SCOPE, expiresOn: soon(), claims: { scholar_personId: "newer" } }, { target: REIMBURSEMENT_SCOPE, expiresOn: soon() - 1000, claims: { scholar_personId: "older" } }] });
    await newer.agent.start();
    expect((newer.requests[0]!.body as { Filters: { GuardianId: string } }).Filters.GuardianId).toBe("newer");

    const none = make({ tokens: [{ target: "other/access_as_user", expiresOn: soon() }] });
    await none.agent.start();
    expect(none.opened()).toBeUndefined();
    expect(none.said.at(-1)).toMatch(/could not find your StepUp sign-in/);

    const old = make({ tokens: [{ target: REIMBURSEMENT_SCOPE, expiresOn: Math.floor(Date.now() / 1000) + 10 }] });
    await old.agent.start();
    expect(old.requests).toHaveLength(0);
    expect(old.said.at(-1)).toMatch(/expired/);

    const nobody = make({ tokens: [{ target: REIMBURSEMENT_SCOPE, expiresOn: soon(), claims: {} }] });
    await nobody.agent.start();
    expect(nobody.requests).toHaveLength(0);
  });

  it("sends nothing when the pop-up is blocked, StepUp refuses, the list changed shape or the app does not answer", async () => {
    const blocked = make({ popup: false });
    await blocked.agent.start();
    expect(blocked.requests).toHaveLength(0);
    expect(blocked.said.at(-1)).toMatch(/pop-up was blocked/);

    const refused = make({ fetchStatus: 401 });
    await refused.agent.start();
    expect(typesOf(refused)).not.toContain("stepup-list");
    expect(refused.said.at(-1)).toMatch(/StepUp answered 401/);

    const drift = make({ fetchBody: { Results: [{ LineItems: [{ Nope: 1 }] }] } });
    await drift.agent.start();
    expect(typesOf(drift)).not.toContain("stepup-list");
    expect(drift.said.at(-1)).toMatch(/no longer looks the way/);

    const silent = make({ appAnswers: false });
    await silent.agent.start();
    expect(typesOf(silent)).not.toContain("stepup-list");
    expect(silent.said.at(-1)).toMatch(/did not answer/);
  });

  it("ignores messages from another origin or another window", async () => {
    const r = make();
    await r.agent.start();
    r.fromApp({ type: "stepup-record", on: true }, "https://evil.example");
    r.fromApp({ type: "stepup-record", on: true }, APP, {});
    expect(r.agent.recorder.on).toBe(false);
    r.fromApp({ type: "stepup-record", on: true });
    expect(r.agent.recorder.on).toBe(true);
  });
});

describe("learning from the page's own requests", () => {
  it("passes on the category list, in shape-checked form", async () => {
    const r = make();
    await r.agent.start();
    r.agent.observed(obs(CATS, { Results: [{ Id: "c1", Name: "Curriculum", Types: ["t1"], IsActive: true, IsDeleted: false, ApprovedPrograms: [{ PartnerId: "24" }] }] }));
    const learned = r.sent.filter((s) => s.data.type === "stepup-learned");
    expect(learned).toHaveLength(1);
    const cache = learned[0]!.data["cache"] as { categories: Record<string, { name: string; childIds: string[] }> };
    expect(cache.categories["c1"]).toMatchObject({ name: "Curriculum", childIds: ["t1"] });
    // A response that no longer looks right is not used.
    r.agent.observed(obs(CATS, { Results: [{ Id: 5 }] }));
    expect(r.sent.filter((s) => s.data.type === "stepup-learned")).toHaveLength(1);
  });

  it("keeps what it learned while the app's window is not there, and sends it when the next click reconnects", async () => {
    const r = make({ appAnswers: false });
    await r.agent.start();
    r.agent.observed(obs(CATS, { Results: [{ Id: "c1", Name: "Curriculum", Types: [], IsActive: true, IsDeleted: false }] }));
    expect(r.sent.filter((s) => s.data.type === "stepup-learned")).toHaveLength(0);
    r.fromApp({ type: "stepup-ready" });
    expect(r.sent.filter((s) => s.data.type === "stepup-learned")).toHaveLength(1);
  });

  it("learns providers, tagged with the category the page asked about", async () => {
    const r = make();
    await r.agent.start();
    r.agent.observed(obs(CATS, { Results: [{ Id: "5b8a1c1e-0d0b-4f6e-9b0a-1c2d3e4f5a6b", Name: "Curriculum", Types: [], IsActive: true, IsDeleted: false }] }));
    r.agent.observed(obs(`${VENDORS}?categoryId=5b8a1c1e-0d0b-4f6e-9b0a-1c2d3e4f5a6b`, { Results: [{ Id: "v1", BusinessProfileId: "bp1", DBAName: "Book Shop" }] }));
    const v = r.sent.find((s) => s.data.type === "stepup-learned" && s.data["kind"] === "vendors")!;
    expect(v.data["entries"]).toEqual([{ id: "v1", businessProfileId: "bp1", name: "Book Shop", categoryIds: ["5b8a1c1e-0d0b-4f6e-9b0a-1c2d3e4f5a6b"] }]);
    // The same provider again is not news.
    r.agent.observed(obs(`${VENDORS}?categoryId=5b8a1c1e-0d0b-4f6e-9b0a-1c2d3e4f5a6b`, { Results: [{ Id: "v1", BusinessProfileId: "bp1", DBAName: "Book Shop" }] }));
    expect(r.sent.filter((s) => s.data["kind"] === "vendors")).toHaveLength(1);
  });

  it("passes on a list the dashboard itself fetched, once", async () => {
    const r = make();
    await r.agent.start();
    const before = r.sent.filter((s) => s.data.type === "stepup-list").length;
    const same = obs(API_LIST, listBody());
    r.agent.observed(same); // identical to what the click already sent
    expect(r.sent.filter((s) => s.data.type === "stepup-list")).toHaveLength(before);
    const changed = listBody(3);
    r.agent.observed(obs(API_LIST, changed));
    r.agent.observed(obs(API_LIST, changed));
    expect(r.sent.filter((s) => s.data.type === "stepup-list")).toHaveLength(before + 1);
  });

  it("expands types and details once a day, using the page's own address and sign-in, and not before the app has said what it knows", async () => {
    const r = make({
      handler: (url, body) => {
        const ids = body as string[];
        if (/typesbyids/.test(url)) return ids.map((id) => ({ id, name: `Type ${id}`, details: [`d-${id}`], isActive: true, isDeleted: false }));
        return ids.map((id) => ({ id, name: `Detail ${id}`, isActive: true, isDeleted: false }));
      },
    });
    await r.agent.start();
    r.agent.observed(obs(CATS, { Results: [{ Id: "c1", Name: "Cat", Types: ["t1", "t2"], IsActive: true, IsDeleted: false }] }));
    const requestsBefore = r.requests.length;
    // The app has not said what is already known: nothing is expanded yet.
    r.agent.observed(obs(TYPES, [{ id: "t1", name: "T1", isActive: true, isDeleted: false }], 200, ["t1"]));
    await Promise.resolve();
    expect(r.requests.length).toBe(requestsBefore);

    r.fromApp({ type: "stepup-cache", categories: { lastSyncAt: 0, categories: {}, types: {}, details: {}, partnerCodes: {} } });
    r.agent.observed(obs(TYPES, [{ id: "t1", name: "T1", isActive: true, isDeleted: false }], 200, ["t1"]));
    await new Promise((res) => setTimeout(res, 20));
    const calls = r.requests.slice(requestsBefore);
    expect(calls.map((c) => c.url)).toEqual([TYPES, TYPES.replace("typesbyids", "detailsbyids")]);
    expect((calls[0]!.body as string[]).sort()).toEqual(["t1", "t2"]);
    expect(calls[0]!.headers["authorization"]).toMatch(/^Bearer /);
    const last = r.sent.filter((s) => s.data["kind"] === "categories").at(-1)!.data["cache"] as { lastSyncAt: number; details: Record<string, unknown> };
    expect(last.lastSyncAt).toBeGreaterThan(0);
    expect(Object.keys(last.details).sort()).toEqual(["d-t1", "d-t2"]);

    // Done for the day: another types request does not expand again.
    const after = r.requests.length;
    r.agent.observed(obs(TYPES, [], 200, ["t1"]));
    await new Promise((res) => setTimeout(res, 20));
    expect(r.requests.length).toBe(after);
  });
});

describe("what StepUp's page really sends", () => {
  it("reads request bodies sent as bytes, and the names (never values) of headers", async () => {
    const seen: Array<{ requestBody?: string; requestBytes?: number; requestHeaders?: string[]; method: string }> = [];
    const g = { fetch: (async () => new Response("{}")) as typeof fetch };
    observeTraffic(g, (x) => seen.push(x));
    const bytes = new TextEncoder().encode(JSON.stringify({ Filters: { GuardianId: "x" } }));
    await g.fetch("https://reimbursementapi-prod.stepupforstudents.org/api/a", { method: "POST", body: bytes, headers: { Authorization: "Bearer secret", "Content-Type": "application/json" } });
    await g.fetch("https://reimbursementapi-prod.stepupforstudents.org/api/b", { method: "PUT", body: new Blob(['["id1"]']) });
    await new Promise((r) => setTimeout(r, 10));
    expect(seen[0]).toMatchObject({ requestBody: '{"Filters":{"GuardianId":"x"}}', requestHeaders: ["authorization", "content-type"] });
    expect(JSON.stringify(seen)).not.toContain("Bearer secret");
    expect(seen[1]).toMatchObject({ requestBody: '["id1"]', requestBytes: 7, method: "PUT" });
  });

  it("measures, rather than reads, a large upload", async () => {
    const seen: Array<{ requestBody?: string; requestBytes?: number }> = [];
    const g = { fetch: (async () => new Response("")) as typeof fetch };
    observeTraffic(g, (x) => seen.push(x));
    await g.fetch("https://acct.blob.core.windows.net/c/file.pdf?sv=1&sig=abc", { method: "PUT", body: new Uint8Array(2_000_000) });
    await new Promise((r) => setTimeout(r, 10));
    expect(seen[0]!.requestBody).toBeUndefined();
    expect(seen[0]!.requestBytes).toBe(2_000_000);
  });

  it("records the shape of a body that arrived as bytes, and a storage upload without its file name or signature", async () => {
    const r = make();
    await r.agent.start();
    r.fromApp({ type: "stepup-record", on: true });
    r.agent.observed({ via: "fetch", method: "PUT", url: "https://reimbursementapi-prod.stepupforstudents.org/api/reimbursements/v2/0f8fad5b-d9cb-469f-a165-70867728950e", status: 200, ms: 4, requestBody: JSON.stringify({ lineItems: [{ itemAmount: 12.5, vendorName: "Private Shop" }] }), requestHeaders: ["authorization", "content-type"], responseText: "{}" });
    r.agent.observed({ via: "fetch", method: "PUT", url: "https://myacct.blob.core.windows.net/receipts/some-private-name.pdf?sv=2024&sig=SECRET", status: 201, ms: 9, requestBytes: 480_000, requestHeaders: ["x-ms-blob-type"], responseText: "" });
    r.fromApp({ type: "stepup-report" });
    const rep = r.sent.find((s) => s.data.type === "stepup-recording")!.data["report"] as { calls: Record<string, { req?: string; headers?: string[]; bytes?: number }> };
    expect(rep.calls["PUT reimbursementapi-prod/api/reimbursements/v2/{guid}"]).toMatchObject({ req: "{lineItems:[1x{itemAmount:number,vendorName:string}]}", headers: ["authorization", "content-type"] });
    const blob = rep.calls["PUT *.blob.core.windows.net/{path}?sig&sv"];
    expect(blob).toMatchObject({ headers: ["x-ms-blob-type"], bytes: 480000 });
    const text = JSON.stringify(rep);
    for (const secret of ["Private Shop", "some-private-name", "SECRET", "myacct"]) expect(text).not.toContain(secret);
  });

  it("learns providers from vendors/search, which is what the page uses now", async () => {
    const r = make();
    await r.agent.start();
    r.agent.observed(obs("https://providerapi-prod.stepupforstudents.org/api/vendors/search", { Results: [{ Id: "v1", Name: "Book Shop", DBAName: null }, { Id: "v2", Name: "Legal Name", DBAName: "Trading Name" }, { Id: "v3" }] }, 200, { Filters: {} }));
    const v = r.sent.find((s) => s.data["kind"] === "vendors")!;
    expect(v.data["entries"]).toEqual([
      { id: "v1", businessProfileId: "", name: "Book Shop", categoryIds: [] },
      { id: "v2", businessProfileId: "", name: "Trading Name", categoryIds: [] },
    ]);
  });
});

describe("learning on its own after the click", () => {
  const PROVIDER = "429e3036-53d2-4215-a413-05b7ced0fa9d/access_as_user";
  const handler = (url: string, body: unknown) => {
    if (/categories\/search/.test(url)) return { Results: [{ Id: "c1", Name: "Cat", Types: ["t1"], IsActive: true, IsDeleted: false, RequiresServiceDate: true }] };
    if (/typesbyids/.test(url)) return (body as string[]).map((id) => ({ id, name: `T ${id}`, details: ["d1"], isActive: true, isDeleted: false, requiresServiceDate: null }));
    if (/detailsbyids/.test(url)) return (body as string[]).map((id) => ({ id, name: `D ${id}`, isActive: true, isDeleted: false }));
    if (/vendors\/search/.test(url)) return { Results: [{ Id: "v1", Name: "Book Shop", DBAName: null }] };
    return listBody();
  };
  const tokens = [{ target: REIMBURSEMENT_SCOPE, expiresOn: soon(), claims: { scholar_personId: "person-1" } }, { target: PROVIDER, expiresOn: soon(), claims: {} }];

  it("asks for the category tree and the provider list itself, once a day, with the recorded request shape", async () => {
    const r = make({ tokens, handler, appCache: { lastSyncAt: 0 } });
    await r.agent.start();
    const urls = r.requests.map((q) => q.url);
    expect(urls).toContain("https://reimbursementapi-prod.stepupforstudents.org/api/categories/search");
    expect(urls).toContain("https://reimbursementapi-prod.stepupforstudents.org/api/categories/typesbyids");
    expect(urls).toContain("https://reimbursementapi-prod.stepupforstudents.org/api/categories/detailsbyids");
    expect(urls).toContain("https://providerapi-prod.stepupforstudents.org/api/vendors/search");
    const search = r.requests.find((q) => /categories\/search/.test(q.url))!.body as { Filters: unknown; PageSize: unknown; CurrentPage: unknown };
    expect(search).toMatchObject({ Filters: { IsActive: true }, PageSize: null, CurrentPage: null });
    const cache = r.sent.filter((s) => s.data["kind"] === "categories").at(-1)!.data["cache"] as { categories: Record<string, { requiresServiceDate?: boolean | null }>; types: Record<string, unknown>; details: Record<string, unknown>; lastSyncAt: number };
    expect(cache.categories["c1"]!.requiresServiceDate).toBe(true);
    expect(Object.keys(cache.types)).toEqual(["t1"]);
    expect(Object.keys(cache.details)).toEqual(["d1"]);
    expect(cache.lastSyncAt).toBeGreaterThan(0);
    expect(r.sent.find((s) => s.data["kind"] === "vendors")!.data["entries"]).toEqual([{ id: "v1", businessProfileId: "", name: "Book Shop", categoryIds: [] }]);
  });

  it("does not repeat it within a day, or before the app has said what it knows", async () => {
    const recent = make({ tokens, handler, appCache: { lastSyncAt: Date.now() } });
    await recent.agent.start();
    expect(recent.requests.some((q) => /categories\/search/.test(q.url))).toBe(false);

    const unknown = make({ tokens, handler });
    await unknown.agent.start();
    expect(unknown.requests.some((q) => /categories\/search/.test(q.url))).toBe(false);
  });

  it("does not use a response that no longer looks right", async () => {
    const r = make({ tokens, handler: (url, body) => (/categories\/search/.test(url) ? { Results: [{ Id: 5 }] } : handler(url, body)), appCache: { lastSyncAt: 0 } });
    await r.agent.start();
    expect(r.sent.some((s) => s.data["kind"] === "categories")).toBe(false);
  });
});

describe("students and balances", () => {
  const STUDENTS = "https://personapi-prod.stepupforstudents.org/api/guardian/0f8fad5b-d9cb-469f-a165-70867728950e/studentScholarship/";
  const BALANCES = "https://infrastructureapi-prod.stepupforstudents.org/api/balancecheck/bulk/details";
  const student = { sequenceNumber: 1001, id: "s-1", firstName: "Alex", lastName: "Sample", dob: "2012-01-01", isActive: true, scholarships: [{ name: "FES-UA" }] };

  it("reads the student list itself after the click, with the person-API sign-in, and sends no private fields", async () => {
    const PERSON = "cb885232-83b3-49bc-99cb-55d5b14c52ae/access_as_user";
    const r = make({
      tokens: [{ target: REIMBURSEMENT_SCOPE, expiresOn: soon(), claims: { scholar_personId: "person-1" } }, { target: PERSON, expiresOn: soon(), claims: {} }],
      handler: (url) => (/studentScholarship/.test(url) ? [student] : listBody()),
    });
    await r.agent.start();
    const call = r.requests.find((q) => /studentScholarship/.test(q.url))!;
    expect(call.url).toBe("https://personapi-prod.stepupforstudents.org/api/guardian/person-1/studentScholarship/");
    const msg = r.sent.find((s) => s.data["kind"] === "students")!;
    expect(msg.data["students"]).toEqual([{ sequenceNumber: 1001, id: "s-1", firstName: "Alex", lastName: "Sample", isActive: true, programs: ["FES-UA"] }]);
    expect(JSON.stringify(r.sent)).not.toContain("2012");
  });

  it("learns the same list, and balances, when the dashboard loads them", async () => {
    const r = make();
    await r.agent.start();
    r.agent.observed(obs(STUDENTS, [student]));
    r.agent.observed(obs(BALANCES, { "1001": [{ ProgramAlias: "FES-UA", ProgramType: 2, Funding: 100, Spending: 10, Reserved: 5, Available: 85, Adjustments: 0 }] }));
    const kinds = r.sent.map((s) => s.data["kind"]);
    expect(kinds).toContain("students");
    const b = r.sent.find((s) => s.data["kind"] === "balances")!.data["balances"] as Record<string, Array<{ fundingCents: number }>>;
    expect(b["1001"]![0]!.fundingCents).toBe(10000);
  });
});

describe("recording", () => {
  it("records which calls were made and the names and types of their fields, never values", async () => {
    const r = make();
    await r.agent.start();
    r.fromApp({ type: "stepup-record", on: true });
    r.agent.observed(obs("https://reimbursementapi-prod.stepupforstudents.org/api/reimbursements/v2/0f8fad5b-d9cb-469f-a165-70867728950e?v=1", { sequenceNumber: 123456, externalStatus: "Draft", note: "private words" }, 200));
    r.agent.observed({ via: "xhr", method: "POST", url: "https://reimbursementapi-prod.stepupforstudents.org/api/x/search", status: 200, ms: 3, requestBody: JSON.stringify({ Filters: { GuardianId: "secret-id" }, Keywords: null }), responseText: JSON.stringify({ Results: [{ a: 1 }] }) });
    r.agent.observed(obs("https://example.org/not-ours", { a: 1 }));
    r.fromApp({ type: "stepup-report" });
    const rep = r.sent.find((s) => s.data.type === "stepup-recording")!.data["report"] as { calls: Record<string, { req?: string; res?: string; via: string[] }> };
    const keys = Object.keys(rep.calls);
    expect(keys).toContain("POST reimbursementapi-prod/api/reimbursements/v2/{guid}");
    expect(keys).toContain("POST reimbursementapi-prod/api/x/search");
    expect(keys.some((k) => /example\.org/.test(k))).toBe(false);
    const text = JSON.stringify(rep);
    expect(text).not.toContain("secret-id");
    expect(text).not.toContain("private words");
    expect(text).not.toContain("123456");
    expect(rep.calls["POST reimbursementapi-prod/api/x/search"]).toMatchObject({ req: "{Filters:{GuardianId:string},Keywords:null}", res: "{Results:[1x{a:number}]}", via: ["xhr"] });
  });

  it("describes shapes and normalises addresses", () => {
    expect(shapeOf({ b: [1, 2], a: "x", c: { d: null } })).toBe("{a:string,b:[2xnumber],c:{d:null}}");
    expect(normalizeUrl("https://reimbursementapi-prod.stepupforstudents.org/api/r/12/0f8fad5b-d9cb-469f-a165-70867728950e?v=9&page=2")).toBe("reimbursementapi-prod/api/r/{n}/{guid}?page");
  });
});

describe("what the recorder keeps of values", () => {
  it("samples only settings and statuses, never other values", async () => {
    const r = make();
    await r.agent.start();
    r.fromApp({ type: "stepup-record", on: true });
    r.agent.observed({
      via: "fetch", method: "POST", url: "https://reimbursementapi-prod.stepupforstudents.org/api/reimbursements/v2", status: 200, ms: 3,
      requestBody: JSON.stringify({ externalStatus: "Draft", programType: 2, skipValidation: false, studentName: "Private Name", submitDate: "0001-01-01T00:00:00", lineItems: [{ itemAmount: 12.34, vendorName: "Private Shop", externalStatus: "Draft", PartitionVersion: 1 }] }),
      responseText: "{}",
    });
    r.agent.observed({
      via: "fetch", method: "POST", url: "https://reimbursementapi-prod.stepupforstudents.org/api/other", status: 200, ms: 3,
      requestBody: JSON.stringify({ submitDate: "2026-09-01T10:00:00", sortOrder: 0 }), responseText: "{}",
    });
    r.fromApp({ type: "stepup-report" });
    const calls = (r.sent.find((s) => s.data.type === "stepup-recording")!.data["report"] as { calls: Record<string, { samples?: Record<string, unknown> }> }).calls;
    expect(calls["POST reimbursementapi-prod/api/reimbursements/v2"]!.samples).toEqual({ externalStatus: "Draft", programType: 2, skipValidation: false, PartitionVersion: 1, submitDate: "0001-01-01T00:00:00" });
    expect(calls["POST reimbursementapi-prod/api/other"]!.samples).toEqual({ sortOrder: 0 });
    const text = JSON.stringify(calls);
    for (const secret of ["Private Name", "Private Shop", "12.34", "2026-09-01"]) expect(text).not.toContain(secret);
  });

  it("notes uploads to storage that only the browser's own timeline sees, without file names or signatures", async () => {
    const r = make();
    await r.agent.start();
    r.fromApp({ type: "stepup-record", on: true });
    r.agent.recorder.resource("https://myacct.blob.core.windows.net/receipts/private-name.pdf?sv=1&sig=SECRET", "fetch", 480000);
    r.agent.recorder.resource("https://apply.stepupforstudents.org/css/site.css", "css", 10);
    r.fromApp({ type: "stepup-report" });
    const rep = r.sent.find((s) => s.data.type === "stepup-recording")!.data["report"] as { calls: Record<string, { via: string[]; bytes?: number }> };
    expect(Object.keys(rep.calls)).toEqual(["RESOURCE *.blob.core.windows.net/{path}?sig&sv"]);
    expect(rep.calls["RESOURCE *.blob.core.windows.net/{path}?sig&sv"]).toMatchObject({ via: ["fetch"], bytes: 480000 });
    const text = JSON.stringify(rep);
    for (const secret of ["private-name", "SECRET", "myacct"]) expect(text).not.toContain(secret);
  });
});

describe("carrying on after a second click", () => {
  it("a replacement agent keeps what the old one learned", async () => {
    const a = make();
    await a.agent.start();
    a.agent.observed(obs(CATS, { Results: [{ Id: "c1", Name: "Cat", Types: [], IsActive: true, IsDeleted: false }] }));
    const state = a.agent.state();
    const b = new StepUpAgent(a.host, state);
    expect(Object.keys(b.state().categories.categories)).toEqual(["c1"]);
    expect(b.recorder).toBe(a.agent.recorder);
  });
});

describe("watching the page's requests", () => {
  it("sees them without changing what the page gets, and takes itself off again", async () => {
    const seen: Array<{ url: string; status: number; responseText?: string; requestBody?: string }> = [];
    const g = { fetch: (async () => new Response('{"ok":true}', { status: 200 })) as typeof fetch };
    const original = g.fetch;
    const o = observeTraffic(g, (x) => seen.push(x));
    const res = await g.fetch("https://apply.stepupforstudents.org/api/x", { method: "POST", body: '{"k":"v"}' });
    expect(await res.json()).toEqual({ ok: true });
    await new Promise((r) => setTimeout(r, 5));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ url: "https://apply.stepupforstudents.org/api/x", status: 200, responseText: '{"ok":true}', requestBody: '{"k":"v"}' });
    o.dispose();
    expect(g.fetch).toBe(original);
  });

  it("an observer that throws never breaks the page", async () => {
    const g = { fetch: (async () => new Response("{}")) as typeof fetch };
    observeTraffic(g, () => { throw new Error("boom"); });
    await expect(g.fetch("https://apply.stepupforstudents.org/y")).resolves.toBeInstanceOf(Response);
    await new Promise((r) => setTimeout(r, 5));
  });
});

describe("tokens and signatures", () => {
  it("finds the person's id in the token, and ignores junk entries", () => {
    const store = new Map([["x", "not json"], ["y", JSON.stringify({ credentialType: "RefreshToken", target: REIMBURSEMENT_SCOPE, secret: "r" })], ["z", JSON.stringify({ credentialType: "AccessToken", target: `u/${REIMBURSEMENT_SCOPE}`, expiresOn: "123", secret: jwt({ scholar_personId: "p" }) })]]);
    const t = findAccessToken({ get length() { return store.size; }, key: (i) => [...store.keys()][i] ?? null, getItem: (k) => store.get(k) ?? null });
    expect(t?.guardian).toBe("p");
    expect(t?.expiresOn).toBe(123);
  });
  it("tells different lists apart", () => {
    expect(signatureOf([{ a: 1 }])).toBe(signatureOf([{ a: 1 }]));
    expect(signatureOf([{ a: 1 }])).not.toBe(signatureOf([{ a: 2 }]));
  });
});
