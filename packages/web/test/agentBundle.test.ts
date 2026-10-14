import { describe, expect, it } from "vitest";
import { bundleAgent } from "../bookmarkletAsset.js";
import { BOOKMARKLET_FILE } from "../src/stepUpBridge.js";

const SCOPE = "5bd9fe13-76ed-4dbb-b8c3-7811dbf16276/access_as_user";
const jwt = (c: Record<string, unknown>) => `h.${Buffer.from(JSON.stringify(c)).toString("base64url")}.s`;

/** The script exactly as the bookmark's loader would add it to StepUp's page, run against a pretend page. */
describe("the built bookmarklet script", () => {
  it("is one self-contained script that starts from its own address and does the job", async () => {
    const code = await bundleAgent();
    expect(code).not.toMatch(/^\s*import\s/m);

    const store = new Map([["k", JSON.stringify({ credentialType: "AccessToken", target: `https://x/${SCOPE}`, expiresOn: Math.floor(Date.now() / 1000) + 3000, secret: jwt({ scholar_personId: "person-1" }) })]]);
    const sessionStorage = { get length() { return store.size; }, key: (i: number) => [...store.keys()][i] ?? null, getItem: (k: string) => store.get(k) ?? null };
    const posted: Array<{ data: { type: string }; origin: string }> = [];
    const listeners: Array<(e: unknown) => void> = [];
    const popup = {
      postMessage(data: { type: string }, origin: string) {
        posted.push({ data, origin });
        if (data.type === "stepup-hello") for (const l of listeners) l({ origin: "https://app.example", source: popup, data: { type: "stepup-ready" } });
      },
    };
    let opened: unknown[] | undefined;
    const fetched: string[] = [];
    const toasts: string[] = [];
    const win: Record<string, unknown> = {
      sessionStorage,
      open: (...a: unknown[]) => ((opened = a), popup),
      addEventListener: (_: string, l: (e: unknown) => void) => listeners.push(l),
      removeEventListener: () => undefined,
      fetch: async (url: string) => {
        fetched.push(url);
        return new Response(JSON.stringify({ Results: [{ Id: "g", LineItems: [{ LineItemNumber: "1-1", ExternalStatus: "Submitted", Appealed: false, ItemAmount: 5 }] }] }));
      },
      XMLHttpRequest: undefined,
    };
    const history = { pushState() {}, replaceState() {} };
    const document = {
      currentScript: { src: `https://app.example/${BOOKMARKLET_FILE}?v=1` },
      body: { appendChild() {} },
      createElement: () => ({ style: {}, set textContent(v: string) { toasts.push(v); }, remove() {} }),
    };
    new Function("window", "document", "history", "location", "alert", "setTimeout", "clearTimeout", code)(
      win, document, history, { href: "https://apply.stepupforstudents.org/Dashboard" }, (m: string) => toasts.push(m), setTimeout, clearTimeout,
    );
    await new Promise((r) => setTimeout(r, 100));

    expect(opened).toEqual(["https://app.example/#stepup-import", "stepup-helper"]);
    expect(fetched[0]).toMatch(/\/api\/reimbursements\/V2\/search\?v=\d+$/);
    const list = posted.find((p) => p.data.type === "stepup-list");
    expect(list?.origin).toBe("https://app.example");
    expect(toasts.at(-1)).toMatch(/Sent 1 reimbursements/);
    expect((win as { __stepUpHelper?: unknown }).__stepUpHelper).toBeDefined();
  });
});
