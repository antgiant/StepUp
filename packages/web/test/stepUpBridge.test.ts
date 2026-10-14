import { describe, expect, it } from "vitest";
import { STEPUP_ORIGIN, bookmarkletCode, bookmarkletHref, isStepUpHello, stepUpListFrom } from "../src/stepUpBridge.js";

const APP = "https://app.example";
const SCOPE = "5bd9fe13-76ed-4dbb-b8c3-7811dbf16276/access_as_user";
const jwt = (claims: Record<string, unknown>) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;

interface Setup {
  tokens?: Array<{ target: string; expiresOn: number; claims?: Record<string, unknown> }>;
  fetchStatus?: number;
  fetchBody?: unknown;
  appAnswers?: boolean;
}

/** Runs the bookmarklet's real source against a pretend StepUp page. */
async function run(setup: Setup) {
  const store = new Map<string, string>();
  (setup.tokens ?? []).forEach((t, i) =>
    store.set(`msal.2|acct|login|accesstoken|${i}`, JSON.stringify({ credentialType: "AccessToken", target: `https://x/${t.target}`, expiresOn: t.expiresOn, secret: jwt(t.claims ?? { scholar_personId: "person-1" }) })));
  store.set("msal.version", "2.0");
  const sessionStorage = { get length() { return store.size; }, key: (i: number) => [...store.keys()][i] ?? null, getItem: (k: string) => store.get(k) ?? null };

  const listeners: Array<(e: unknown) => void> = [];
  const toasts: string[] = [];
  const posted: unknown[] = [];
  const popup = {
    postMessage(data: { type: string }, origin: string) {
      expect(origin).toBe(APP);
      posted.push(data);
      if (data.type === "stepup-hello" && setup.appAnswers !== false) for (const l of listeners) l({ origin: APP, source: popup, data: { type: "stepup-ready" } });
    },
  };
  let opened: unknown[] | undefined;
  const requests: Array<{ url: string; init: { headers: Record<string, string>; body: string } }> = [];
  const document = {
    body: { appendChild: (d: { textContent: string }) => toasts.push(d.textContent) },
    createElement: () => ({ style: {}, textContent: "", remove() {} }),
  };
  const window = { open: (...a: unknown[]) => ((opened = a), popup) };
  const fetchFn = async (url: string, init: { headers: Record<string, string>; body: string }) => {
    requests.push({ url, init });
    return { ok: (setup.fetchStatus ?? 200) < 300, status: setup.fetchStatus ?? 200, json: async () => setup.fetchBody ?? { Results: [{ Id: "r1" }, { Id: "r2" }] } };
  };
  const fn = new Function("sessionStorage", "window", "document", "fetch", "addEventListener", "removeEventListener", `return ${bookmarkletCode(APP)}`);
  await fn(sessionStorage, window, document, fetchFn, (_: string, l: (e: unknown) => void) => listeners.push(l), (_: string, l: (e: unknown) => void) => listeners.splice(listeners.indexOf(l), 1));
  return { toasts, posted, opened, requests };
}

const soon = Math.floor(Date.now() / 1000) + 3000;

describe("the bookmarklet", () => {
  it("reads the reimbursement token, asks for the list as the dashboard does, and sends only the list", async () => {
    const r = await run({ tokens: [{ target: "other-api/access_as_user", expiresOn: soon }, { target: SCOPE, expiresOn: soon, claims: { scholar_personId: "person-9" } }] });
    expect(r.opened).toEqual([`${APP}/#stepup-import`, "stepup-helper"]);
    expect(r.requests).toHaveLength(1);
    const req = r.requests[0]!;
    expect(req.url).toMatch(/^https:\/\/reimbursementapi-prod\.stepupforstudents\.org\/api\/reimbursements\/V2\/search\?v=\d+$/);
    expect(JSON.parse(req.init.body).Filters).toEqual({ GuardianId: "person-9", ExcludedStatuses: ["Canceled"] });
    expect(req.init.headers["authorization"]).toMatch(/^Bearer h\./);
    const sent = r.posted.find((p) => (p as { type: string }).type === "stepup-list") as { results: unknown[] };
    expect(sent.results).toHaveLength(2);
    expect(JSON.stringify(r.posted)).not.toContain("Bearer");
    expect(r.toasts.at(-1)).toMatch(/Sent 2 reimbursements/);
  });

  it("uses the token that expires last when there are several", async () => {
    const r = await run({ tokens: [{ target: SCOPE, expiresOn: soon, claims: { scholar_personId: "newer" } }, { target: SCOPE, expiresOn: soon - 1000, claims: { scholar_personId: "older" } }] });
    expect(JSON.parse(r.requests[0]!.init.body).Filters.GuardianId).toBe("newer");
  });

  it("does nothing, and says why, with no sign-in or an expired one", async () => {
    const none = await run({ tokens: [{ target: "other/access_as_user", expiresOn: soon }] });
    expect(none.opened).toBeUndefined();
    expect(none.requests).toHaveLength(0);
    expect(none.toasts.at(-1)).toMatch(/could not find your StepUp sign-in/);
    const old = await run({ tokens: [{ target: SCOPE, expiresOn: Math.floor(Date.now() / 1000) + 10 }] });
    expect(old.requests).toHaveLength(0);
    expect(old.toasts.at(-1)).toMatch(/expired/);
  });

  it("refuses to fetch when the token does not say who the person is", async () => {
    const r = await run({ tokens: [{ target: SCOPE, expiresOn: soon, claims: {} }] });
    expect(r.requests).toHaveLength(0);
  });

  it("sends nothing when StepUp refuses the request", async () => {
    const r = await run({ tokens: [{ target: SCOPE, expiresOn: soon }], fetchStatus: 401 });
    expect(r.posted.some((p) => (p as { type: string }).type === "stepup-list")).toBe(false);
    expect(r.toasts.at(-1)).toMatch(/StepUp answered 401/);
  });

  it("is a javascript: link that decodes back to the same source", () => {
    const href = bookmarkletHref(APP);
    expect(href.startsWith("javascript:")).toBe(true);
    expect(decodeURIComponent(href.slice("javascript:".length))).toBe(bookmarkletCode(APP));
  });
});

describe("receiving", () => {
  it("accepts the list only from StepUp's page, in the right shape", () => {
    const msg = { type: "stepup-list", results: [{ Id: "a" }] };
    expect(stepUpListFrom(STEPUP_ORIGIN, msg)).toHaveLength(1);
    expect(stepUpListFrom("https://evil.example", msg)).toBeUndefined();
    expect(stepUpListFrom(STEPUP_ORIGIN, { type: "stepup-list", results: [] })).toBeUndefined();
    expect(stepUpListFrom(STEPUP_ORIGIN, { type: "other", results: [{}] })).toBeUndefined();
    expect(stepUpListFrom(STEPUP_ORIGIN, "text")).toBeUndefined();
  });
  it("answers hello only from StepUp's page", () => {
    expect(isStepUpHello(STEPUP_ORIGIN, { type: "stepup-hello" })).toBe(true);
    expect(isStepUpHello("https://evil.example", { type: "stepup-hello" })).toBe(false);
  });
});
