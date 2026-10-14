/**
 * The hand-off from StepUp's own page to this app, used by the bookmarklet (and later the extension).
 *
 * The bookmarklet runs on apply.stepupforstudents.org, where the person is already signed in. It reads StepUp's own
 * access token for the reimbursement API from that page's session storage, asks for the reimbursements list exactly as
 * StepUp's dashboard does, and posts only the list to this app. The token never leaves StepUp's page.
 *
 * Verified 2026-10 against a real session (see docs/EXTENSION_PLAN.md §5): MSAL keeps one 60-minute access token per API in
 * sessionStorage; the list request is a POST with `Filters.GuardianId` set to the token's `scholar_personId` claim (a wrong
 * or missing id is refused), no paging, about 6 MB for every school year.
 */
export const STEPUP_ORIGIN = "https://apply.stepupforstudents.org";
const API = "https://reimbursementapi-prod.stepupforstudents.org/api/reimbursements/V2/search";
/** The reimbursement API's scope (public: it is in StepUp's own appsettings.json). */
const SCOPE = "5bd9fe13-76ed-4dbb-b8c3-7811dbf16276/access_as_user";

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

/** True when the message is the bookmarklet asking whether this app is ready to receive. */
export const isStepUpHello = (origin: string, data: unknown): boolean =>
  origin === STEPUP_ORIGIN && Boolean(data) && typeof data === "object" && (data as { type?: unknown }).type === "stepup-hello";

/**
 * What the bookmarklet does once it is running on StepUp's page. Needs `APP` (this app's origin, for postMessage) and `HOME`
 * (this app's address, to open it). Plain JavaScript on purpose: it must not depend on anything this app's bundler does to code.
 */
const BODY = `const SCOPE=${JSON.stringify(SCOPE)},API=${JSON.stringify(API)};
const say=m=>{const d=document.createElement("div");d.textContent="Step Up Helper: "+m;d.style.cssText="position:fixed;z-index:2147483647;top:12px;left:50%;transform:translateX(-50%);max-width:80vw;padding:10px 16px;background:#1a2b4c;color:#fff;font:15px system-ui;border-radius:8px;box-shadow:0 4px 16px #0006";document.body.appendChild(d);setTimeout(()=>d.remove(),9000)};
try{
let tok;
for(let i=0;i<sessionStorage.length;i++){let v;try{v=JSON.parse(sessionStorage.getItem(sessionStorage.key(i)))}catch(e){continue}
if(v&&v.credentialType==="AccessToken"&&typeof v.target==="string"&&v.target.endsWith(SCOPE)&&(!tok||v.expiresOn>tok.expiresOn))tok=v}
if(!tok)return say("I could not find your StepUp sign-in. Open StepUp's Dashboard and click again.");
if(tok.expiresOn*1000-Date.now()<60000)return say("Your StepUp sign-in just expired. Reload this page, then click again.");
let guardian;try{guardian=JSON.parse(atob(tok.secret.split(".")[1].replace(/-/g,"+").replace(/_/g,"/"))).scholar_personId}catch(e){}
if(!guardian)return say("StepUp's sign-in did not say who you are, so nothing was fetched.");
const w=window.open(HOME+"#stepup-import","stepup-helper");
if(!w)return say("The pop-up was blocked. Allow pop-ups for StepUp, then click again.");
say("Reading your reimbursements from StepUp\u2026");
let ready=false;
const onMsg=e=>{if(e.origin===APP&&e.source===w&&e.data&&e.data.type==="stepup-ready")ready=true};
addEventListener("message",onMsg);
const ping=setInterval(()=>{try{w.postMessage({type:"stepup-hello"},APP)}catch(e){}},400);
const ticks=String(BigInt(Date.now())*10000n+621355968000000000n);
const r=await fetch(API+"?v="+ticks,{method:"POST",headers:{"content-type":"application/json; charset=utf-8",authorization:"Bearer "+tok.secret},body:JSON.stringify({Keywords:null,CurrentPage:null,PageSize:null,OrderBy:null,SortOrder:0,MultiOrderBy:{},Filters:{GuardianId:guardian,ExcludedStatuses:["Canceled"]},ApplyDefaultFilters:true,ContextBag:{},IncludeGlobalSearchTotal:false,SkipCount:false})});
if(!r.ok){clearInterval(ping);removeEventListener("message",onMsg);return say("StepUp answered "+r.status+". Reload this page and click again.")}
const results=(await r.json()).Results;
if(!Array.isArray(results)){clearInterval(ping);removeEventListener("message",onMsg);return say("StepUp's list was not in the expected form, so nothing was sent.")}
for(let i=0;i<75&&!ready;i++)await new Promise(f=>setTimeout(f,400));
clearInterval(ping);removeEventListener("message",onMsg);
if(!ready)return say("Step Up Helper did not answer. Open it, sign in, and click again.");
w.postMessage({type:"stepup-list",results},APP);
say("Sent "+results.length+" reimbursements to Step Up Helper.");
}catch(err){say("Something went wrong: "+(err&&err.message||err))}`;

/** The file this app serves as `stepup-bookmarklet.js`: it finds its own address, so the same file works on any host. */
export const BOOKMARKLET_FILE = "stepup-bookmarklet.js";

export function bookmarkletScript(): string {
  return `(async()=>{
const SRC=document.currentScript&&document.currentScript.src;
if(!SRC){alert("Step Up Helper: start this from its bookmark.");return}
const APP=new URL(SRC).origin,HOME=new URL("./",SRC).href;
${BODY}
})()`;
}

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
