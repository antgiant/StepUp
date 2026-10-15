/**
 * The hand-off from StepUp's own page to this app, used by the bookmarklet (and later the extension).
 *
 * The bookmarklet loads the agent (src/agent), which runs on apply.stepupforstudents.org where the person is already signed
 * in. It reads StepUp's own access token for the reimbursement API from that page's session storage, asks for the
 * reimbursements list exactly as StepUp's dashboard does, watches the page's own requests for what is worth learning, and
 * posts only that data to this app. The token never leaves StepUp's page.
 *
 * Verified 2026-10 against a real session (see docs/EXTENSION_PLAN.md §5): MSAL keeps one 60-minute access token per API in
 * sessionStorage; the list request is a POST with `Filters.GuardianId` set to the token's `scholar_personId` claim (a wrong
 * or missing id is refused), no paging, about 6 MB for every school year.
 */
import type { AgentToApp } from "./agent/protocol.js";

export const STEPUP_ORIGIN = "https://apply.stepupforstudents.org";
export interface StepUpListMessage {
  type: "stepup-list";
  results: unknown[];
}

/** Checks a message event is the list, from StepUp's own page. Anything else (another site, another shape) is ignored. */
export function stepUpListFrom(origin: string, data: unknown): unknown[] | undefined {
  if (origin !== STEPUP_ORIGIN || !data || typeof data !== "object") return undefined;
  const m = data as Partial<StepUpListMessage>;
  return m.type === "stepup-list" && Array.isArray(m.results) && m.results.length > 0 ? m.results : undefined;
}

/**
 * A message from the agent, checked: right origin and a known shape. Anything else (another site, another version, junk)
 * is ignored. Contents are sanitised further where they are used.
 */
export function agentMessageFrom(origin: string, data: unknown): AgentToApp | undefined {
  if (origin !== STEPUP_ORIGIN || !data || typeof data !== "object") return undefined;
  const m = data as Record<string, unknown>;
  switch (m["type"]) {
    case "stepup-hello":
      return { type: "stepup-hello", version: Number(m["version"]) || 0 };
    case "stepup-alive":
      return { type: "stepup-alive", version: Number(m["version"]) || 0, page: typeof m["page"] === "string" ? m["page"].slice(0, 200) : "" };
    case "stepup-bye":
      return { type: "stepup-bye" };
    case "stepup-list":
      return Array.isArray(m["results"]) && m["results"].length > 0 ? { type: "stepup-list", results: m["results"] } : undefined;
    case "stepup-learned":
      if (m["kind"] === "categories" && m["cache"] && typeof m["cache"] === "object") return { type: "stepup-learned", kind: "categories", cache: m["cache"] as never };
      if (m["kind"] === "vendors" && Array.isArray(m["entries"])) {
        const entries = (m["entries"] as unknown[]).filter((e): e is { id: string; businessProfileId: string; name: string; categoryIds?: string[] } =>
          Boolean(e) && typeof e === "object" && typeof (e as { id?: unknown }).id === "string" && typeof (e as { name?: unknown }).name === "string");
        return { type: "stepup-learned", kind: "vendors", entries };
      }
      if (m["kind"] === "students" && Array.isArray(m["students"])) return { type: "stepup-learned", kind: "students", students: m["students"] as never };
      if (m["kind"] === "balances" && m["balances"] && typeof m["balances"] === "object") return { type: "stepup-learned", kind: "balances", balances: m["balances"] as never };
      return undefined;
    case "stepup-recording":
      return m["report"] && typeof m["report"] === "object" ? { type: "stepup-recording", report: m["report"] as never } : undefined;
    default:
      return undefined;
  }
}

/** True when the message is the bookmarklet asking whether this app is ready to receive. */
export const isStepUpHello = (origin: string, data: unknown): boolean =>
  origin === STEPUP_ORIGIN && Boolean(data) && typeof data === "object" && (data as { type?: unknown }).type === "stepup-hello";

/** The file this app serves as `stepup-bookmarklet.js`: the agent in src/agent, bundled (see bookmarkletAsset.ts). */
export const BOOKMARKLET_FILE = "stepup-bookmarklet.js";

/**
 * The bookmark people keep: a few lines that load `stepup-bookmarklet.js` from the app each time it is clicked, so an update
 * to the app reaches everyone without anyone re-creating a bookmark. Trade-off: whoever controls the app's site controls what
 * runs on StepUp's page (a self-contained bookmark was dropped; bring it back only if someone asks for it).
 */
export function loaderCode(appHome: string): string {
  const url = new URL(BOOKMARKLET_FILE, appHome).href;
  return `(()=>{const s=document.createElement("script");s.src=${JSON.stringify(url)}+"?v="+Date.now();s.onerror=()=>alert("Step Up Helper could not be loaded. Check your connection, then click again.");(document.head||document.documentElement).appendChild(s)})()`;
}

/** The `javascript:` link to drag to the bookmarks bar. */
export const loaderHref = (appHome: string): string => "javascript:" + encodeURIComponent(loaderCode(appHome));
