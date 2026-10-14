# Plan: replace the command line with a browser extension

Status: **PLAN, not started.** Written 2026-10-13 for an AI coding agent (and the owner) to carry out in a later session.
Read this whole file, then `CLAUDE.md`, then `docs/PLAN.md` §7 (working agreements) before changing anything.

> **Public repo rule** (from `docs/PLAN.md`): never commit real names, amounts, file names, share links, tokens, OneDrive
> ids or captured StepUp responses. Test fixtures must be invented or scrubbed.

## 1. Why, and what "done" means

Today anything that touches StepUp (filing, status sync, category/vendor/pre-auth learning) needs the Node command line
driving a real Chrome with Playwright. Everything else already runs in the web app. A web page cannot do the StepUp part
by itself (see §2), so the part that has to run next to StepUp becomes a **browser extension**, and the web app stays the
brain.

Done means: a person with Chrome or Edge and the extension can file, sync and learn from StepUp without installing Node,
without a terminal, without an Azure device-code login and without a separate Chrome profile; and `packages/cli` is
removed except the maintainer-only reference tools (§9).

### Already moved to the web (2026-10-13, before this plan)

These were CLI-only and are now shared code that the web app, the CLI and the extension all call. Do **not** redo them.

| CLI command | Now | Where |
|---|---|---|
| `verify` | Advanced → Check this year (/and its files/contents); result panel on the Summary tab | `shared/verify/ledger.ts`, `shared/verify/files.ts` |
| `backup` | Advanced → Back up this year (zip), with or without documents | `shared/backup/backup.ts`, `shared/util/zip.ts` |
| `plan` | "Ready to file" panel on the Summary tab | `shared/submit/plan.ts` |
| `statuses --from-capture` / the archive half of every sync | Advanced → Bring in StepUp's list (file) | `shared/stepup/sync.ts` (`archiveStepUpList`, `resultsFromSavedList`) |
| `year`, `ingest`, `report` | already existed in the web (New year, Refresh data, spreadsheet copy) | — |

`archiveStepUpList` is the single entry point the extension must use to hand StepUp's list to storage. The web's import
handler (`packages/web/src/main.ts`, id `stepup-import`) is the reference for what to do with the result: archive, apply
to the open ledger year (`applyStepUpStatuses`), then refresh.

## 2. Constraints that were verified (do not re-litigate)

1. **StepUp's API only answers its own origin.** A CORS preflight to
   `reimbursementapi-prod.stepupforstudents.org` from `https://apply.stepupforstudents.org` returns 200 with
   `access-control-allow-origin` set to that origin; from any other origin it returns 400. So the web app cannot call it,
   with or without a token.
2. The login token lives in StepUp's own page. It cannot be read from another site or from a frame on another site.
3. StepUp is a **Blazor WebAssembly + Radzen** app and the home page sends **no Content-Security-Policy** header, so
   scripts an extension injects are not blocked by the site.
4. WebAssembly does not lift browser security limits; emulating a browser in WASM is rejected.
5. Chrome puts a per-site "local network" permission in front of requests from an HTTPS page to localhost (Chrome 142+,
   last opt-out removed in 156), so "web app talks to a local helper" is not the end state either.

Unknowns that only a logged-in human session can answer are §5 (Phase 0). Nothing in later phases may be started on a
guess about them.

## 3. Architecture

```
 stepup.wooleys.us tab (web app: OneDrive/Google auth, ledger, shared code)        <- the brain, writes all data
        ^  window.postMessage (same page)
        |
 content script "bridge" (matches stepup.wooleys.us and localhost:5173 in dev)
        ^  chrome.runtime port (JSON only, so files travel as chunked base64)
        |
 service worker (message router, claim/lock timers, chrome.storage for small state)
        ^  chrome.runtime port
        |
 content script "stepup" (matches apply.stepupforstudents.org)  <- the hands
   - MAIN-world hook: wraps fetch/XHR to observe StepUp's own API calls and reuse its Authorization header
   - ISOLATED-world panel: banner, prompts, skip/split/resync buttons
   - flow driver: finds fields, sets values, reads the DOM, waits for steps
```

Rules of the design:

- **The extension never has its own storage login.** It never talks to Microsoft or Google. Every read of the ledger and
  every write goes through the web app tab. If no web app tab is open the popup says so and offers to open one.
- **The web app never talks to StepUp.** It sends a job ("file this group", "bring in the list") and receives results.
- **Nothing sensitive is persisted by the extension.** No StepUp credentials, no Authorization header at rest, no receipt
  bytes at rest (hold in memory for the run). `chrome.storage.session` for run state; `chrome.storage.local` only for
  harmless preferences.
- **It never submits.** A human clicks StepUp's own Submit. This is the product's central safety property and has a test
  (§8) that fails if any code path clicks a Submit/Continue-to-confirmation control without a person's action.
- **Same shared code.** Reuse `@step-up/shared/web`: `planSubmissions`, `claims`, `drafts`, `record` (`markSubmitted`
  style helpers), `stepup/shapes` drift checks, `archiveStepUpList`, `SessionLock`. New pure logic goes in `shared`, not
  in the extension.

### New package

`packages/extension/` (npm workspace), TypeScript, built with the same Vite/esbuild toolchain as `packages/web`.

```
packages/extension/
  manifest.json            MV3
  src/
    protocol.ts            typed messages, shared by the bridge and the web app (also exported for the web)
    background.ts          service worker: routing, lock heartbeat, run state
    bridge.ts              content script on the web app origin
    stepup/hook.ts         MAIN-world fetch/XHR observer
    stepup/panel.ts        ported from cli/src/form/browserPrompt.ts
    stepup/flow.ts         ported from cli/src/form/reimbursementFlow.ts
    stepup/dom.ts          small query/wait/set-value helpers (replaces Playwright locators)
    stepup/learners.ts     category tree, vendor list, pre-auth, draft tracker
  test/
```

Manifest (least privilege; review at each phase):

- `host_permissions`: `https://apply.stepupforstudents.org/*`, `https://reimbursementapi-prod.stepupforstudents.org/*`,
  `https://providerapi-prod.stepupforstudents.org/*`, `https://stepup.wooleys.us/*`.
- `permissions`: `storage`, `scripting`, `activeTab`. Add `debugger` **only** if Phase 0 proves page scripts cannot drive
  a control; it is the permission store reviewers scrutinise and it shows a persistent "debugging this browser" bar.
- No `<all_urls>`, no remote code, no `eval`, CSP default for extension pages.

### Message protocol (sketch; finish it in `protocol.ts` first and test it)

Web app → extension (via bridge): `hello`, `ingestStatus` (ask for a fresh list), `fileGroup { group, files[] }`,
`cancel { runId }`, `releaseLock`.
Extension → web app: `ready { version }`, `stepUpList { results }` (the raw `Results`), `learned { kind: "categories" |
"vendors" | "preauth", payload }`, `draft { guid, sequenceNumber, step, scanOutcome, attachedFiles }`,
`progress { runId, step, text }`, `needsPerson { runId, prompt }`, `filed { runId, reimbursementId, guid, lineOrder[] }`,
`failed { runId, reason, resumable }`, `drift { shape, problems[] }`.

Files: the web app holds the bytes (it has the storage token). It sends each file as `{name, size, sha256, chunk, of,
base64}` frames; the extension reassembles, verifies the SHA-256 and builds a `File`. Receipts are capped at 5 MB by
StepUp (`MAX_RECEIPT_BYTES`), so this is small.

## 4. What each CLI piece becomes

| CLI file | Becomes | Notes |
|---|---|---|
| `statusSync.ts` `attachSearchCapture` / `attachStatusSyncListenerWith` | `stepup/hook.ts` + web handler | List response `…/api/reimbursements/V2/search` (~6 MB, every year). Send as `stepUpList`; the web app runs the same code as its import handler. Keep the "identical repeat is skipped" and `stepUpShapeOk` guards. |
| `statusSync.ts` `syncStatusesFromApiResponse` (Excel workbook write-back) | **dropped** | The web is read-only for Excel years and already overlays `_stepup`. Needs owner sign-off (§10 D1). |
| `stepUpArchive.ts`, `yearSync.ts` | `archiveStepUpList` (done) | `yearSync`'s per-year ledger apply happens for the open year in the web; other years follow when opened. |
| `categorySync.ts` | `stepup/learners.ts` | Intercept `…/api/categories/search`, `typesbyids`, `detailsbyids`; the piggy-back (extra out-of-band request for known ids reusing the page's real Authorization) becomes `fetch` from the MAIN world with the captured header. Throttle and 24h cap unchanged. Output replaces `.cache/category-tree-cache.json` (§6). |
| `vendorListingSync.ts` | `stepup/learners.ts` | `providerapi-prod…/api/businesssummary/getbusinesssummarydropdown`; providers are keyed by the category id found in the request. |
| `preauthSync.ts` | `stepup/learners.ts` | `…/api/preauthorization/search`. Dormant today (no Pre-Auth # recorded); port as-is, keep dormant. |
| `draftTracker.ts` | `stepup/learners.ts` | Authorization header + `GET /api/reimbursements/v2/{guid}`. Draft records move from `.cache/drafts.json` into the ledger's `drafts` (shared `submit/drafts.ts` already models them). |
| `form/reimbursementFlow.ts` | `stepup/flow.ts` | See §7. Biggest piece. |
| `form/browserPrompt.ts` | `stepup/panel.ts` | Already draws inside StepUp's page (Popover API workaround for ancestor transforms). Replace `page.evaluate` string injection with a real content-script module; keep the self-heal-to-one-instance behaviour and heartbeat. |
| `main.ts` (the filing run) | `background.ts` + `flow.ts` orchestration; trigger lives in the web | Group loop, skip/split/resync, resume from a draft, summary-total check, record result. |
| `filing/ledgerStore.ts` | the web app (it already is the ledger owner) | `claim`/`release`/`markSubmitted`/`recordDraftNumber`/`fixCategory` call the same shared helpers. |
| `filing/excelStore.ts` | **dropped** | Spreadsheet filing is the old path. §10 D1. |
| `stepupLock.ts` | web app calls shared `SessionLock` on the extension's behalf | One StepUp session per account. Heartbeat from the service worker; release on tab close. |
| `graph/auth.ts`, `storage/*` | **dropped** | The web app is signed in. |
| `form/browser.ts`, `browserServer.ts`, `inspect*.ts`, `discover.ts` | **dropped** | Playwright and profile management. Dev tooling: see §8 for DOM fixtures. |
| `clientId.ts` | **dropped** | The web app already has its client id. |
| `drift.ts` | `shared` (already) | Keep: an unexpected response shape is reported, not used. |

## 5. Phase 0: spikes (needs a human logged in to StepUp; ~1 day)

Write a throwaway unpacked extension that logs, never writes. Answer each question in `docs/EXTENSION_SPIKES.md` with
evidence (redacted) and a decision. Do not start Phase 1 until 1–4 are answered; 5–7 gate Phase 4.

1. **Where is the Authorization header?** Observe StepUp's own requests from a MAIN-world `fetch`/XHR wrapper. Confirm the
   header is visible, whether it refreshes mid-session, and how the wrapper behaves with Blazor's HTTP client (it uses
   `fetch` via JS interop; confirm).
2. **Can the extension call the list endpoint itself?** `fetch` the search endpoint from the content script's MAIN world
   with that header. If yes, status sync needs no page navigation at all.
3. **Does the 6 MB list survive messaging?** Chrome messages are JSON-serialised with size limits; chunk or compress
   (`CompressionStream`) and measure.
4. **Does the bridge work?** `window.postMessage` from the web app to a content script on its origin, round trip to the
   service worker and back, in dev (`localhost:5173`) and prod.
5. **Setting values:** for each control type used in the wizard (text, date, Radzen dropdown/typeahead, checkbox, the
   student select, the category cascade), does `value = …` + `input`/`change` events update Blazor's state, or must it be
   key events / real clicks? Verify by reading the summary page back.
6. **File upload:** set `input.files` from a `DataTransfer` holding a `File` and dispatch `change` on `#inputDrop__`.
   Confirm StepUp starts the scan. If not, this is the single case that justifies the `debugger` permission.
7. **Trusted clicks:** does StepUp ignore `element.click()` (untrusted) for Continue/step buttons?
8. **Session behaviour:** does the content script survive StepUp's soft navigations and its habit of logging out on Back?

Decision rule: if 5–7 pass with page scripts, use them (no `debugger`). If one fails, prefer
[playwright-crx](https://npmjs.com/package/playwright-crx) (Playwright's API over `chrome.debugger`) for that step only
and port the rest as page scripts.

## 6. Phase 1: extension skeleton + status capture (replaces `npm run statuses`)

1. `packages/extension` scaffold, build, `protocol.ts`, bridge, service worker, popup with connection state.
2. `stepup/hook.ts`: capture the list response; apply the guards from `statusSync.ts` (non-empty, shape OK, skip
   identical repeat); send `stepUpList`.
3. Web app: a listener that feeds `stepUpList` into the **same function** the file import uses. Extract that handler body
   from `main.ts` into a named function (`bringInStepUpList(results)`) and call it from both. Show "StepUp: updated 12:04".
4. Optional: the extension fetches the list on its own when the dashboard loads (per Phase 0 #2).

Acceptance: open StepUp's dashboard with the web app open in another tab; within seconds the History tab shows StepUp's
changes with no CLI running. Tests: protocol unit tests; bridge tests with a fake `chrome` (use `vitest` + a small
`chrome` stub); the web function is covered by extending `shared/test/webMoves.test.ts`-style tests.

## 7. Phase 2: learners; Phase 3: filing

### Phase 2: learners (category tree, vendors, pre-auth, drafts)

- Move `.cache/category-tree-cache.json` and `.cache/vendor-listing-cache.json` to the workspace: the web app writes
  them to `<root>/_stepup-cache/` (new constant in `shared/workspace`, skipped like `_ledger` when looking for receipts;
  add it to `CLAUDE.md`'s list of ignored folders). Keep the existing JSON shapes so `reference:build` and
  `reference:vendors` keep working by reading that folder instead of `.cache/`.
- Ledger years: feed `applyObservedCategories` (shared) from the web app as `recordCategories` does today.
- Throttle: preserve "at most once per 24h" and chunking with the piggy-back.

### Phase 3: filing (port `reimbursementFlow.ts`, ~1200 lines)

Port in this order, each behind a test against a saved DOM fixture (§8). Selectors and quirks are documented in the
header comments of `reimbursementFlow.ts` and the README "Known StepUp quirks"; **carry those comments over**.

1. Step detection from the URL (`REIMBURSEMENT_STEP_PATTERNS`): wizard steps are numbered in the URL, with a GUID once a
   draft exists. Pure function; move to `shared` so the CLI and extension agree until the CLI is removed.
2. `waitForLogin`, dashboard modal, `goToNewReimbursement`, `ensureOnNewReimbursementForm`, `selectStudent`
   (`#Student__Select`, `ul.dropdown-menu.show`, "Name … : Program").
3. `uploadFile` (`#inputDrop__`) and `checkItemScan` (wait out "One moment while we read your document", then the
   not-detected and read-error headings; never conclude from a short timeout mid-scan).
4. `autoCheckDetectedItems` (matching detected item blocks to rows by amount; ask on ambiguity).
5. `fillItemDetails`: positional targeting (`.nth`) because StepUp repeats ids across item blocks; overwrite OCR guesses
   with a warning; `MissingServiceDateError`; category cascade; vendor/"Who did you pay".
6. Additional documents step; `readSummaryTotal` / `summaryTotalIsZero`; `readReimbursementId` from the confirmation
   screen; `goBackToStep`.
7. Orchestration from `main.ts`: groups, skip, split, resync, resume from a draft (`DraftRecord`), claim/release,
   record result with `markSubmitted` after the person confirms they submitted.

Buttons with random per-session ids (Continue, Submit, the step bar) must be found by text, as today.

## 8. Phase 4: web UI, tests, safety

- **Web UI.** The "Ready to file" panel (already there) gets a **File with StepUp** button per group when the extension is
  connected. The existing "Being filed right now" banner and per-item "Being filed by" already read claims; no new
  concepts. An unconnected extension shows an install link instead. The Excel (read-only) view must not gain it:
  `READ_ONLY_KEEP` is unchanged and the button is dropped by `enforceReadOnly` by default.
- **Fixtures.** Save scrubbed HTML snapshots of each wizard step from the Phase 0 session under
  `packages/extension/test/fixtures/` (invented names and amounts only). Flow functions take a `Document`, so they run in
  jsdom without a browser. Add one opt-in Playwright smoke test (not in CI) that loads the built extension against a
  local copy of those fixtures.
- **Contract tests** for every message in `protocol.ts` (round trip, unknown kinds ignored, version mismatch reported).
- **Safety test:** a test that scans the flow module's click targets and fails if it can activate a control whose text
  matches Submit/"Submit for approval". Assert `flow.ts` exports nothing that submits.
- **Drift.** Reuse `checkStepUpShape`; on mismatch send `drift` and show it in the popup and the web app. StepUp changes
  without notice; every selector lives in one `selectors.ts` with the date it was last confirmed.
- **Manual end-to-end checklist** in `docs/EXTENSION_SPIKES.md`: a draft is created, filled and **abandoned**, never
  submitted, using a throwaway receipt.

## 9. Phase 5: retire the CLI

Only when Phases 1–4 have been used for one real filing round by the owner:

1. Remove `npm start`, `statuses`, `discover`, `inspect`, `browser`, `plan`, `import-legacy`, Playwright, MSAL, the
   Chrome-profile instructions and the Azure app registration steps from `README.md` (keep the Google client notes the
   web needs). Delete `packages/cli/src/form`, `filing`, `graph`, `storage`, `*Sync.ts`, `draftTracker.ts`, `main.ts`.
2. Keep as maintainer tools (they commit to the repo, which the extension cannot): `reference:build|promote|validate`,
   `reference:vendors`, and `backup` if the owner wants a scriptable one. Point the first two at `_stepup-cache/`.
3. `import-legacy` (a dry-run conversion of an Excel year into events + a report): decide with the owner whether a web
   "Preview conversion" download belongs in the Excel view (it only downloads, so it fits `READ_ONLY_KEEP`), or whether it
   stays maintainer-only. It was not moved because converting an Excel year is a product decision, not a port.
4. Update `CLAUDE.md` ("The CLI applies each reimbursement to its own year…" becomes "The extension hands StepUp's list
   to the web app, which applies it") and the README intro.
5. Privacy page: say what the extension reads (StepUp pages and API responses) and that nothing leaves the browser except
   to the user's own storage.

## 10. Decisions to take from the owner (do not guess)

- **D1 – Excel workbooks.** The CLI still writes StepUp statuses into a year's Excel workbook (2025-2026 only). The web
  treats Excel years as read-only and overlays `_stepup`. Dropping the write-back removes Excel as something the tool
  edits. Recommended: drop it; the Excel view already shows StepUp's data.
- **D2 – Distribution.** Unpacked (developer mode) for the family, or the Chrome Web Store ($5 one-time; review will
  look hard at `debugger` if it is needed). Safari/Firefox: out of scope unless asked.
- **D3 – Pre-Auth submission** stays out of scope (blocked on a real e-signature flow; see `todo.md`).
- **D4 – Where learned category/vendor data goes** if the owner would rather not store it in the workspace: send it as a
  prefilled GitHub issue like "Share category fixes".

## 11. Risks

- StepUp's site changes (new Blazor/Radzen versions change the DOM). Mitigation: fixtures, one selectors file, drift check.
- Chrome MV3 service workers are killed after ~30 s idle: keep run state in `chrome.storage.session`, use alarms for the
  lock heartbeat, and make every step resumable from the draft record.
- StepUp logs users out on Back and mishandles two sessions: keep the lock, never navigate Back on a person's behalf
  except via `goBackToStep`'s existing, tested route.
- Large lists (6 MB, ~700 reimbursements): process in the web app's worker-friendly chunks; `archiveStepUpList` already
  writes only changed files with limited concurrency.
- Web Store review or policy changes could remove the easy distribution path; the unpacked route does not depend on it.

## 12. Instructions for the implementing agent

1. Work in phases; each phase ends green: `npm run typecheck`, `npx vitest run`, `npm run build -w @step-up/web`.
2. Do Phase 0 with the owner present; commit only `docs/EXTENSION_SPIKES.md` and scrubbed fixtures from it.
3. Never add a code path that submits. Never store an Authorization header. Never log receipt contents.
4. Obey `CLAUDE.md`: the Excel view mirrors the ledger view and is read-only; new controls are hidden there by default;
   StepUp data wins over ledger over Excel; anything that changes data must appear in History (new event kinds get a
   `label` and `FIELD_NAMES` entries).
5. Keep pure logic in `packages/shared` with tests; the extension holds only DOM and messaging glue.
6. Update this file's status line and the progress log in `docs/PLAN.md` §9 as phases land.
