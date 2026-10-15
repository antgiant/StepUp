# Plan: the bookmarklet agent replaces the command line

**Status (2026-10-14, end of day): filing works end to end on the live form.** A real reimbursement was filed from an Excel
year through the bookmarklet and submitted by the owner. What remains is in §7. The facts about StepUp's site are in
`docs/STEPUP_FINDINGS.md`. Older context: `docs/EXTENSION_PLAN.md` (superseded; kept for the extension option) and
`docs/PLAN.md` (the original redesign). Read `CLAUDE.md` first: its rules still apply (Excel view read-only with one
exception, StepUp's data wins, History for every data change).

> **Public repo rule:** never commit real names, amounts, ids, file names, tokens or captured responses. Fixtures are
> invented. Recorded reports are shapes only and are checked before being shared.

## 0. To resume in a new chat

1. Read this file, then `docs/STEPUP_FINDINGS.md`, then `CLAUDE.md`.
2. The branch is `ledger-redesign`. **Pushing it deploys the site** (GitHub Pages, about 2 minutes; sometimes a duplicate run
   is cancelled and the other succeeds). Check with `gh run list --branch ledger-redesign --workflow "Deploy web app to GitHub Pages"`.
3. Tests: `npx vitest run` (root, whole repo) or `npx vitest run` inside `packages/web`; typecheck `npx tsc --noEmit -p .` in
   `packages/web`, `packages/shared`, `packages/cli`. The repo lives in OneDrive: file reads occasionally time out; retry.
4. The owner tests on the live site with a real (Excel-year) reimbursement. After a deploy: **hard-refresh the helper tab,
   then click the bookmark again on StepUp's page.** A page reload on StepUp ends the connection; the bookmark must be re-clicked.
5. **Before any clean-up for production, read `docs/PRODUCTION_CLEANUP.md`:** it sorts what is the product from what
   is debugging leftover (the spike session, the recorder, the form-map diagnostics).
6. Start with §7 (what remains). The most valuable next thing is more live filings (multi-item, provider, service date),
   each stop teaching one more rule; §6 lists the bugs found that way and what fixed them.

## 1. Goal

Do everything the Node command line (`packages/cli`, Playwright driving a real Chrome) does, from the web app plus a
**bookmark** the person clicks on StepUp's own page, so that no terminal, Node install, Azure app registration or separate
browser profile is needed: keep statuses current, learn StepUp's categories and providers, and **file reimbursements into
StepUp's form**.

## 2. Decisions taken (the owner's, with reasons)

| Date | Decision | Why |
|---|---|---|
| 2026-10-13 | The web app is the brain, a script on StepUp's page is the hands. The page's script never sends StepUp's sign-in anywhere | StepUp's APIs answer only StepUp's own origin; the app already holds the person's storage sign-in |
| 2026-10-13 | The bookmark is a **small loader** that fetches `stepup-bookmarklet.js` from the app's site each click | Updates reach everyone without re-making a bookmark |
| 2026-10-14 | **No writing to StepUp through its API.** Filing is autofill of StepUp's own form, fail-closed | StepUp changes the form every few weeks or months; an API-written draft could be accepted yet wrong; automated writes are the larger risk of a ban |
| 2026-10-14 | **The agent never clicks the final Submit** (legally binding) and does not let a person click it while a check is red. Every earlier step may be navigated by automation, as the CLI does | The attestation on StepUp's summary is made under penalty of law |
| 2026-10-14 | The agent's **only own requests are a short allow-list of reads** (`isAllowedOwnRead`); extra reads (category list, providers, students) are off by default; gathering is passive first | Optics; the one request a click asks for is the list the dashboard loads itself |
| 2026-10-14 | **Receipt and additional documents are attached by driving StepUp's own file control**, not API | Same as the CLI's `setInputFiles` |
| 2026-10-14 | **Autofill never guesses.** A field that does not match is flagged and left alone, the others still fill, and the step is not continued. Entries are matched by exact words, then ignoring case and punctuation, then a single partial hit; two hits stop | One drifting field must not waste the rest, nor file wrong data |
| 2026-10-14 | **Excel years: the writes the CLI already made to the workbook stay allowed** (Status, Submitted, Reimbursement ID, Line Number, Notes, category fixes). More only by discussion | Last year's items are still filed from Excel |
| 2026-10-14 | A walk **runs in one go** (no pause between steps); a person presses Submit. Deleting unnamed surplus item blocks is approved | The CLI's lessons are encoded; stop where unsure |
| 2026-10-14 | A full page load loses the bookmarklet; the person **re-clicks the bookmark** (no navigation by URL) | Simple and visible |
| 2026-10-14 | Preference, **not built**: set an item's name/amount on the item-selection step where possible | A nicer flow; needs a spike (§7) |

Still open: **D4** where learned data lives (`_stepup-cache` in the workspace today); whether StepUp's terms say anything about
automated assistance (the owner should read them).

## 3. Principles

1. **The agent never writes to StepUp through its API and never presses the final Submit.** There is no operation for Submit in
   `FilingOps`; `press` refuses any button whose words begin "Submit"; a capture-phase guard holds the button and Enter while
   the walk is unsure. Pinned by tests.
2. **Fail closed.** Anything not exactly as expected: do nothing and say what differs (`recognise`'s `problems`).
3. **Controlled pace.** Starts on the person's click, one group at a time, with a Stop control.
4. **The app owns data and decisions;** the agent returns observations. StepUp's sign-in never leaves StepUp's page.
5. **Shape-checked reads.** A StepUp response that no longer looks right is not used (`checkStepUpShape`).
6. **Privacy by construction.** Form maps and recordings keep names and types, never values, dropdown entries, or the words
   after a colon in a heading; names are scrubbed from headings. Shared output is checked before it leaves.

## 4. Architecture and code map

```
 Step Up Helper (web app, signed in to OneDrive/Google)          <- brain: ledger, storage, decisions, UI, write-back
        ^ postMessage (origin-checked both ways; hello/alive/bye; protocol version 5)
        |
 stepup-bookmarklet.js  (agent, bundled from packages/web/src/agent)   <- hands: runs on apply.stepupforstudents.org
        ^ loaded each click by the tiny loader bookmark ("Step Up Helper")
```

| Path | What |
|---|---|
| `packages/web/src/agent/agent.ts` | `StepUpAgent`: handshake, heartbeat, the read allow-list, learning, form map, spike and filing handlers, confirmation watcher |
| `packages/web/src/agent/protocol.ts` | The messages and `AGENT_PROTOCOL` (bump when they change; the app shows "out of date") |
| `packages/web/src/agent/form.ts` | `detectStep`, `mapForm` (visible-aware, scrubbed, folds repeats, Summary item lines as numbers) |
| `packages/web/src/agent/signatures.ts` | `recognise(map)`: the expected controls of every step and variant; problems, `busy`, `attention` |
| `packages/web/src/agent/fill.ts` | Pure decisions: entry choice, money/date text, totals, block pairing, which boxes to tick |
| `packages/web/src/agent/engine.ts` | `runFiling`: the walk, against `FilingOps` (tested with a pretend site) |
| `packages/web/src/agent/dom.ts` | `FilingOps` and `PageOps` on the real DOM; the Submit guard (with cleanup on replace) |
| `packages/web/src/agent/spike.ts` | Deliberate single test actions with read-backs (type, date, pick, attach), behind a switch |
| `packages/web/src/agent/main.ts` | Installs the agent; replaces an older copy of itself; removes its guard |
| `packages/web/src/agentConnection.ts` | Connection state, "which of several StepUp pages", wording |
| `packages/web/src/filing.ts` | `buildJob` (reads files, checks type/size), `writeWorkbookRows` (Graph table writes by `ID`) |
| `packages/web/src/main.ts` | App side: connection panel, spike panel, "Ready to file" with **File this on StepUp**, Filing panel, recording (`onFilingSubmitted`, `recordByHand`), fold memory |
| `packages/shared/src/submit/plan.ts`, `filing.ts`, `record.ts` | The plan (what is ready, held back, filed), the CLI-shaped rows, the ledger recording |
| `packages/shared/src/legacy/read.ts` | Excel year import; `linkRowFiles` (see §6) |
| `packages/cli/` | The CLI being replaced (still the reference: `form/reimbursementFlow.ts`, `main.ts` `runGroupSteps`) |

## 5. What is built (all deployed)

- **Monitoring:** connection states (connected, closed, reloaded, silent, out of date, several pages), reconnect after a
  reload of the helper tab, last-heard time.
- **Form map and recognition:** every wizard step and variant (student; upload empty/attached; item selection scanning/none
  found/detected/read error; item details in every payee state and with the delete question open; additional documents;
  summary), checked against real maps.
- **Filing walk:** student, upload, item selection (tick only unambiguous boxes), item details (remove unnamed surplus
  blocks, add missing ones, pair blocks with rows, category cascade, payee, service date, invoice, cost, quantity, tax,
  date, each read back, item total checked), additional documents, Summary check (lines and total, refill up to twice),
  Submit held until the Summary matches the rows.
- **Recording:** the confirmation page's reimbursement number is noticed whenever the bookmark is connected; the app keeps its
  filing run across a reload; a group can be recorded by hand ("Already submitted in StepUp? ... Record it"). Excel year:
  Status, Submitted, Reimbursement ID, Line Number. Ledger year: `recordSubmitted`. A missing service date marks the rows
  "Unfiled (Missing Things)" with a dated note.
- **Spike tools** (Advanced → Connect to StepUp (bookmark) → Turn on spike tools): single test actions on a throwaway draft.
- **Excel year in "Ready to file":** the panel shows for read-only years too; rows the sheet still calls unfiled are in the plan.
- Earlier: status list, passive learning, awards/students/drafts panels, recorder, web equivalents of CLI commands.

## 6. What the first live runs taught (so they are not relearned)

| Found live | Cause | Fix |
|---|---|---|
| Two StepUp pages flipped the connection between "connected" and "out of date" | The app kept one connection and the last message won | Each page kept separately; the newest current script wins; the panel says how many are connected |
| Spike refused an idle upload page as "still working" | StepUp keeps a "Loading..." heading in the page and shows it only while uploading | Headings and notices count only when visible |
| Amount entry looked like a failure | StepUp reformats money (`5` becomes `$5.00`) and saves at step changes, not per edit | Compare numbers, not text; the proof is the field plus the item's recomputed total |
| Nothing in an Excel year could be ready | The Excel view stamps each row's sheet status as an override and the plan read any override as filed | Rows whose status begins "Unfiled" stay in the plan |
| Receipts saved since Excel's last refresh looked missing | The workbook's Documentation File columns are Excel's own, stale folder scan | Also link folder files named `NN - ...` for the row (`linkRowFiles`) |
| **File this on StepUp** did nothing | The Excel view has three gates: the render guard (`READ_ONLY_KEEP`), the legacy click handler's own allow-list, and the plan. Only one was opened. Then the button was disabled when not connected | All opened; the button always answers, with the reason in the Filing panel |
| Payee "not on the page" for a listed vendor | The vendor list loads from the server after opening; read at 350 ms it was empty | Wait for the list to stop growing; say what was read when a name is not found |
| Category left unselected, then Continue pressed | The row's category path was dropped (the reference tree knew the id but had no path) and a blank category was treated as nothing to do | Fall back to the item's own path; a row with no category stops the walk; the dropdown must show a choice before Continue |
| Submit held by an old reason after re-clicking the bookmark | Guard listeners live on the page and outlived the replaced script | A new script removes the earlier guard; a disposed agent removes its own |
| Submission not recorded after the owner reloaded StepUp | The confirmation watcher lived only in the run that did the walk | Watch whenever connected; keep the run across a reload; record by hand |
| Ready items missing from every list | The CLI wrote a draft's reimbursement number onto a row (before submitting); the plan read any submission as filed | A submission with no date and no submitted status is a draft: the item stays in the plan with the draft number shown |
| "Held back" list closed itself | Every redraw rebuilt it closed | Fold-open lists remember their state by their words |

Process lessons: a click that "does nothing" in an Excel year is almost always a gate; a re-clicked bookmark must clean up
what the previous script left on the page; and a pasted form map says which build made it (`mapVersion`).

## 7. What remains (suggested order)

1. **Confirm the automatic recording** after Submit on the next live filing (the manual "Record it" path is built). Check the
   workbook row gets Status, Submitted, Reimbursement ID, Line Number.
2. **More live filings**, each a new case: a multi-item receipt (block pairing, checkboxes on the detected variant), a
   category with a service date, "Provider not Listed" with a typed name, a listed provider that has individual people,
   several additional documents, a receipt StepUp cannot read.
3. **Existing drafts.** The engine always starts a new request; the CLI resumed the draft it left. The plan shows a warning
   when a draft exists; the person must delete or finish it first. A walk may already continue from a draft that is open on
   its own step (it starts from whichever step is showing), untested. Decide: resume, or detect and refuse.
4. **Start from the dashboard.** The person opens "New Reimbursement" first; the CLI clicked through the nav itself, and
   "Request Another Reimbursement" after a confirmation. Then **file all ready groups in turn**.
5. **CLI features not ported:** the category-rename fix (CLI renamed a category to match StepUp's list and corrected other rows),
   "needs to be split" and "documentation problem" holds, the status sync writing StepUp's statuses into the workbook, the
   session lock, and claims so two people cannot file the same group (ledger years).
6. **Item-selection edits** (the owner's preference): spike whether the name/amount fields there accept scripted entry and
   are saved.
7. **Spike results still unexercised:** service date entry, additional-document attach on step 4, individual provider.
8. **Retire the CLI** (workstream E): keep the maintainer tools (`reference:*`), remove Playwright, MSAL device-code sign-in,
   Azure registration steps and the commands with web equivalents; update `README.md`, the privacy page, `docs/PLAN.md`.
9. **Docs and wording:** README intro and privacy page do not yet say the bookmark fills StepUp's form and writes to the
   workbook; the bookmark's name changed to "Step Up Helper" (an existing bookmark keeps its old name until renamed).
10. **C4 comments to per-item reasons**; **C5 pre-authorisations** (dormant).
11. Housekeeping: remove the spike session and fold the diagnostics (all listed, with where each lives, in
    `docs/PRODUCTION_CLEANUP.md`); a regression fixture built from the recorded form shapes.

## 8. CLI parity map (status)

| CLI behaviour | Bookmarklet |
|---|---|
| Step detection by URL | done (`detectStep`) |
| Student pick, Continue | done |
| `setInputFiles` receipt / additional | done (DataTransfer on `#inputDrop__`) |
| Wait for the scan; three outcomes | done (read error stops) |
| Item selection: tick boxes when matched | done |
| Item details: cascade, payee, service date, numbers | done |
| Add / delete surplus item blocks | done |
| Category mismatch: ask, rename, fix rows | done: a looser match is reported as `categoryFixes`; an unmatched level pauses for the person to pick it in StepUp's open list (`pick`, "I picked it" / "Skip this row"); the row, the other waiting rows with the same words, and the workbook's Table5 are corrected (ledger: `recordCategoryFix`) |
| Summary: re-check total, go back up to twice | done, plus per-item lines |
| Resume a draft by URL | **not ported** (see §7.3) |
| Skip / split / resync buttons | Stop only |
| `FilingStore`: claim, draft number, submitted, needs attention | submitted and needs attention done; claim and draft number not |
| Session lock | not ported |
| Statuses into the workbook | not ported |

## 9. Testing and operating

- **Tests:** `packages/web/test/` has the agent, form map, signatures, fill, engine (a pretend StepUp), spike and connection
  tests; `packages/shared/test/` has plan, filing and legacy view. The pretend site in `engine.test.ts` is built from recorded shapes.
- **Operating a filing:** in StepUp press New Reimbursement (student page); in the helper open the Excel year's Summary,
  "Ready to file", **File this on StepUp**; watch the Filing panel; when it says ready, read StepUp's summary and press
  Submit yourself. If it stops, the panel names the step and the reason.
- **Form map:** connection panel → "Map the form on this StepUp step" → copy. The panel also says whether the step is
  recognised. A map that starts with an old `mapVersion` came from a cached script.
- **Recording traffic:** connection panel → "Record StepUp's traffic" (shapes only) or the values mode with made-up numbers.

## 10. Risks

| Risk | Mitigation |
|---|---|
| StepUp changes the form (weeks to months) | recognise by signature and stop; read back; Summary check; the form map re-checks |
| StepUp changes endpoints or shapes | shape checks; one table of URL patterns; the recorder re-learns quickly |
| Account restriction or terms of use | reads only; autofill on request; extra reads off by default; the owner reads StepUp's terms |
| Two people filing | claims exist for ledger years but are not yet used by the walk |
| A duplicate draft | the plan warns when a draft number is on the item |
| Bookmarklet limits (lost on reload) | re-click; an extension would remove the limit |
| Sensitive data in maps and reports | names and values never recorded; reports checked before sharing |

## 11. If an extension is wanted later

Everything above is TypeScript with an injected host (`AgentHost`, `FilingOps`). An extension needs a different host
(content script, `chrome.storage`, runtime messaging) and a manifest. It would add starting without a click, seeing calls
made before the page finished loading, and surviving a reload. It adds no capability the agent lacks.

## 12. Not yet verified live (do not treat as proven)

Everything below is built and (where it can be) unit-tested against the pretend site, but has **not** been seen working on
StepUp's real form or the owner's real storage. Each stop in a live run has so far been one more rule; expect the same here.

| Area | What is unverified |
|---|---|
| Recording after Submit | The agent noticing the confirmation page by itself, and the app then writing the workbook row (the manual "Record it" path is the fallback). The Excel write of Status / Submitted / Reimbursement ID / Line Number has been exercised only through that path, if at all |
| Several items in one receipt | Pairing blocks with rows by the scan's cost/name (`matchBlock`); the "detected" variant's checkboxes (`boxesToCheck`); blocks that StepUp adds or that need removing |
| Payee branches | "Provider not Listed" with a typed name; a provider category's `#provider` list; a listed provider that reveals `#individualProvider` (left to the person unless the Service Provider matches exactly) |
| Service date | A category that requires one, filled from the row; the missing-service-date stop and its "Unfiled (Missing Things)" write |
| Additional documents | More than one; a statement that has a redacted copy |
| Read error and "none found" | The read-error page's live wording (known only from the CLI); the "none found" variant filling blocks by order |
| Ledger years | Filing from a ledger year at all (`recordSubmitted`, `recordNeedsAttention`, claims, drafts). Only an Excel year has been filed |
| Google storage | Reading receipts via `storage.download` on a Google Drive workspace |
| Mobile | The bookmark panel used to say it worked in Safari on iPhone and iPad; filing relies on `DataTransfer`, `getClientRects` and a pop-up, none checked on a phone. The claim was removed from the panel |
| Enter key | The guard also intercepts Enter and Space on a Submit button and a form `submit`; only clicks were exercised |
| Terms of use | The owner has not read StepUp's terms about automated assistance |

Other limits worth knowing: the Summary's item lines are read only in the shape "N x $cost" or "N x $cost + $tax Tax/Shipping";
a file is linked to a row by the `NN - ` name prefix (a file for a row that is already filed is linked too, harmlessly);
line numbers follow the order StepUp's blocks took the rows; a walk times out at 25 minutes and waits up to 90 seconds for a
step to change.

## 13. Working with the owner and the environment

**How the owner likes to work** (stated in the session, worth keeping):

- Go step by step, "properly, not make a mess"; no rush to reorder for speed. Decide with them, then build.
- **Never guess.** A mismatch is flagged and left; the rest still fills. Ambiguity stops the walk with the reason.
- Prefers things to happen in the flow they are in (edits on the same step), and to be told plainly what to press and what
  to report. They paste the Filing panel and screenshots; each stop line is the next fix.
- Wants commits to be logical, small, with the reason in the message, and the branch pushed (a push deploys).
- Does not want real data in the repo; reports with names are scrubbed (`wordsOnly`) and fixtures are invented.

**Environment notes:**

- The repo is in OneDrive: reads and test runs occasionally time out or stall. Retry; run long commands in the background.
- One flaky shared test (`publishYearMirror` in `cli-support.test.ts`) can time out when the whole suite runs on a slow
  disk and passes alone.
- A push runs two workflows; the deploy is about 2 minutes and a duplicate deploy run is sometimes cancelled while the other
  succeeds. Confirm the head commit's run, not just any run.
- After a deploy: hard-refresh the helper tab **and** click the bookmark again on StepUp. A script already on the page is old.
  Close extra StepUp tabs: two connected pages are handled, but a stale script on the other tab confuses what is tested.
- When something "does nothing" in an Excel year, check the three gates first (§6).
- The helper's panels, wording and CLI parity are in §5 and §8; the sort of production versus debugging code is
  `docs/PRODUCTION_CLEANUP.md`.
