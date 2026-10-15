# Plan: the bookmarklet agent replaces the command line

**Status (2026-10-14): the plan is being iterated; nothing in it is final until the owner says so.** This file is the single
current statement of the plan. The facts it rests on are in `docs/STEPUP_FINDINGS.md`. Older context:
`docs/EXTENSION_PLAN.md` (superseded for now; kept for the extension option) and `docs/PLAN.md` (the original redesign).
Read `CLAUDE.md` first: its rules (Excel view read-only; StepUp's data wins; History for every data change) still apply.

> **Public repo rule:** never commit real names, amounts, ids, file names, tokens or captured responses. Fixtures are
> invented. Recorded reports are shapes only and are checked before being shared.

**For a new chat:** read this file, then `docs/STEPUP_FINDINGS.md`. Section 8 lists the open questions this plan wants
answered; start there. Nothing needs to be rebuilt to discuss the plan.

---

## 1. Goal

Do everything the Node command line (`packages/cli`, Playwright driving a real Chrome) does, from the web app plus a
**bookmark** the person clicks on StepUp's own page, so that no terminal, Node install, Azure app registration or separate
browser profile is needed. What the CLI did: keep statuses current, learn StepUp's category list and providers, file
reimbursements into StepUp's form.

## 2. Decisions taken (with the owner's reasons)

| Date | Decision | Why |
|---|---|---|
| 2026-10-13 | The web app is the brain, a script on StepUp's page is the hands. The page's script never sends StepUp's sign-in anywhere | StepUp's APIs answer only StepUp's own origin; the app already holds the person's storage sign-in |
| 2026-10-13 | The bookmark is a **small loader** that fetches `stepup-bookmarklet.js` from the app's site each click. The self-contained variant was removed; revisit only if asked | Updates reach everyone without re-making a bookmark |
| 2026-10-14 | **No writing to StepUp through its API.** Filing is **autofill of StepUp's own form, fail-closed**, with the agent navigating the intermediate steps as the CLI does and a person alone pressing the final Submit (corrected 2026-10-14) | StepUp changes the form every few weeks or months; an API-written draft could be accepted yet wrong. Automated writes are the larger risk of a ban or a terms-of-use problem. A form that refuses input fails safely |
| 2026-10-14 | The agent's **only own requests are a short allow-list of reads** (`isAllowedOwnRead`); the extra reads (category list, providers, students) are **off by default** | Same optics concern; the one request a click asks for is the list the dashboard loads itself |
| 2026-10-14 | Awards, children and categories may be *proposed* from StepUp's data but only written to the ledger by an explicit click (or, for a category's service-date flag, only ever raised) | The ledger is the person's record; maintainers' stricter rules stand |
| 2026-10-14 | Lists brought by the bookmark are confirmed once per session, then applied automatically while that page stays connected | Open for review (§8) |
| 2026-10-14 | **Form autofill is the filing path.** The goal is to replicate the CLI's Playwright behaviour in the bookmarklet (§5 parity map) | Owner decision; the CLI is crashing and last year's Excel items must be filed |
| 2026-10-14 | **The agent never clicks the final Submit** (legally binding), and **must not let a person click it** while there is clear evidence something is wrong. Every earlier step may be navigated by automation, as the CLI does | Owner decision. Supersedes "a person pressing every Continue" |
| 2026-10-14 | **Receipt and additional documents are attached by driving StepUp's own file control** (not API) | Same as the CLI's `setInputFiles` |
| 2026-10-14 | **Gathering categories, vendors, providers is passive first;** active reads stay available | Owner is open to active |
| 2026-10-14 | **Order of work: M1, then B**, carefully, without making a mess | Owner decision |
| 2026-10-14 | **Excel years: the writes the CLI already makes to the workbook stay allowed** (D1 decided: keep). More only by discussion | Last year's items are still filed from Excel |
| 2026-10-14 | **Autofill never guesses.** A field that does not match expectation is flagged and left alone; every other field is still filled. A step with an unexpected field is not cleared to continue, and the agent will not move past it | One drifting field must not waste the rest, nor file wrong data |

Still open: **D4** where learned data lives (`_stepup-cache` in the workspace today). **D1 is decided:** the Excel
write-back stays. The CLI's workbook writes (`packages/cli/src/filing/excelStore.ts`): Status, Submitted, Reimbursement ID,
Line Number, Notes (needs attention), Category fixes, plus the status sync in `statusSync.ts`.

## 3. Principles

1. **The agent never writes to StepUp through its API and never presses the final Submit.** It reads, fills the form's
   fields, attaches files through the form's own control and moves through the intermediate steps as the CLI does. It also
   blocks a person's Submit when there is clear evidence something is wrong. Enforced in code (`isAllowedOwnRead` for
   requests; a click allow-list for buttons that never contains Submit) and by tests that fail if either grows a write path.
2. **Fail closed.** When anything is not exactly as expected the agent does nothing and says what differs.
3. **Controlled pace.** Starts on the person's request, one group at a time, with a visible stop/skip control at all times.
   The person alone presses Submit; the agent may press Continue where the CLI does.
4. **The app owns data and decisions;** the agent returns observations only. StepUp's sign-in never leaves StepUp's page;
   the refresh token is never touched.
5. **Shape-checked reads.** A StepUp response that no longer looks right is not used (`checkStepUpShape`).
6. **Privacy by construction.** Recordings keep field names and types, a fixed list of setting-like values, and (only when
   the person opts in with made-up numbers) item values. Name-like fields are never sampled.

## 4. Current state (what exists)

**Architecture**

```
 Step Up Helper (web app, signed in to OneDrive/Google)          <- brain: ledger, storage, decisions, UI
        ^ postMessage (origin-checked both ways, hello/ready handshake)
        |
 stepup-bookmarklet.js  (agent, bundled from packages/web/src/agent)   <- hands: runs on apply.stepupforstudents.org
        ^ loaded each click by the tiny loader bookmark
```

**Code map**

| Path | What |
|---|---|
| `packages/web/src/agent/` | The agent: `agent.ts` (class `StepUpAgent`, the read allow-list), `observe.ts` (wraps `fetch`/XHR, reads byte bodies), `recorder.ts` (shapes, provenance of ids, samples), `token.ts`, `protocol.ts`, `main.ts` (installs it) |
| `packages/web/src/stepUpBridge.ts` | The loader bookmark, message validation on the app side |
| `packages/web/bookmarkletAsset.ts` | Vite plugin that bundles the agent and serves it as `stepup-bookmarklet.js` |
| `packages/web/src/main.ts` | App side: `bringInStepUpList`, learned-data store, the "What StepUp says" and "Unfinished drafts" panels, the bookmarklet/connection/recorder panel, "Check this year", "Back up", "Ready to file" |
| `packages/shared/src/stepup/` | `sync.ts` (archive a list per year), `learn.ts` (category/provider/student/balance/draft learners, pure), `archive.ts`, `overlay.ts`, `shapes.ts` |
| `packages/cli/` | The CLI being replaced; its category/vendor learners now share `learn.ts` |

**Built and tested (413 tests):**

- Status list: fetched on click; a changed list the dashboard fetches is forwarded; applied through `archiveStepUpList` and
  to the open ledger year; the result panel says what changed, by year, with timings.
- Passive learning from what StepUp's page loads: categories (with types/details), providers, students, balances.
- Optional (off) active reads of the category tree, providers and students, once a day.
- Read-only panels: StepUp's funding/awards beside the ledger's (with explicit "use as award"/"add student" buttons),
  unfinished drafts on StepUp, StepUp's `RequiresServiceDate` raising a category's requirement.
- Recorder: calls, shapes of requests and responses (every distinct shape), id provenance, setting samples, opt-in values
  mode, resource timing for storage uploads, short report view.
- Web equivalents of CLI `verify`, `backup`, `plan`, `statuses --from-capture`, `year`, `ingest`, `report`.

**Not built:** any filling of StepUp's form; the form map; C4 (comments → reasons); anything that retires the CLI.

**Git (at the time of writing):** branch `ledger-redesign`, three local commits ahead of origin (the recorder privacy fix,
a request builder that was then removed, and the autofill/read-only decision). Nothing here is lost; push when ready.

## 5. Workstreams

### B. Filing: form autofill, fail-closed (the main remaining work)

| Step | What it does | How it stays safe |
|---|---|---|
| B1 recognise | Identify the wizard step on screen from the URL pattern plus a **signature** of expected labels, placeholders and ids | A mismatch stops everything: "StepUp's form has changed here: <what>". Nothing is touched |
| B2 fill | Put the plan's values into the fields of the **current step only**, when the person asks | Only fields the signature names; a field that is not as expected is flagged and left alone, the others still fill |
| B3 read back | Read every field back and compare with what was meant | Any difference stops and shows both values |
| B4 verify the save | When the person presses Continue, StepUp's own save is observed (read-only) and compared with the plan | A mismatch is shown before the person goes on |
| B5 hand over | The agent moves through intermediate steps like the CLI; at Summary it shows the review and the person presses Submit | Submit is never clicked by the agent, and is blocked (capture-phase interception of the button and Enter) while any check is red |
| B6 record | The next list read (the person's click) brings the reimbursement and line numbers into the ledger | Nothing is written to StepUp |

- **Form map** (to build first): on request, the labels, ids, placeholders and control types of the current step, never
  values. B1's signatures are made from it and re-checked against it when StepUp changes.
- **Spikes that decide B2**, each on a throwaway draft with the owner present: are scripted values accepted by Blazor's
  and Radzen's controls (text, number, date, the student and category dropdowns); can a file be attached by script; does
  StepUp ignore anything that is not a real click. A control that fails is left to the person and the app says so.
- **Receipt and additional documents are attached by the agent** through StepUp's own file control.
- The CLI's `packages/cli/src/form/reimbursementFlow.ts` and the loop in `packages/cli/src/main.ts` (`runGroupSteps`) are the
  specification. **CLI parity map** (what the CLI does, and what the bookmarklet needs instead):

| CLI behaviour (Playwright) | Bookmarklet equivalent / open question |
|---|---|
| Step detection by URL patterns `/SubmitReimbursement/<guid>/1..5`, `/Confirmation/` | Same patterns on `location`; poll or hook history/popstate |
| Student pick, auto Continue | DOM click on the picker, then the option, then Continue |
| `setInputFiles` for receipt and additional documents | **Spike:** set `input.files` from a `DataTransfer` and dispatch `change`; bytes come from the app (OneDrive/storage) by message |
| Wait for the OCR scan (`checkItemScan`), three outcomes | Same text checks |
| Item selection: auto-check boxes if counts equal or names match; else leave for the person | Same; auto-Continue only when every box is matched |
| Item details: category cascade with retries, vendor vs provider detection, service date, quantities, blur to commit | Same logic, with `fill` replaced by native-setter + `input`/`change`/`blur` (spike); raw `.click()` as the CLI already does |
| Add / delete item blocks (delete confirmed in StepUp's modal) | Same; deleting unnamed surplus blocks is **approved** for the bookmarklet |
| Category mismatch: asks the person, then renames the category and fixes rows | App-side dialog; writes through the store |
| Summary: re-check total, go back and re-fill up to twice | Same; then the Submit block if still wrong |
| Resume a draft by `page.goto(.../<guid>/<step>)` | **Decided:** a full page load loses the bookmarklet, so the person re-clicks the bookmark after it |
| Skip / split / resync buttons and banners | An in-page panel owned by the agent |
| `FilingStore` (`excelStore.ts`, `ledgerStore.ts`): claim, record draft number, markSubmitted, markNeedsAttention, fixCategory, download | Move the store interface to shared; the **app** implements it (Graph writes to the workbook, ledger events); the agent only reports observations |
| Session lock `stepupLock.ts` | Reuse the ledger claim; port the lock |

### C. Use what StepUp already knows (read-only)

C1 balances/awards, C2 students → children, C3 category rules, C6 drafts: **built** (see §4). C4 comments → per-item reasons:
buildable (comments are fetched by guardian and keyed by reimbursement number) but not built. C5 pre-authorisations:
dormant, not built.

### D. Dependable passive monitoring

Connection state (connected / window closed / script out of date), reconnect after a reload, an update notice, an
auto-apply setting, large-list measurement, a "last seen from StepUp" line on the Summary.

### E. Retire the CLI (last)

Keep the maintainer tools that commit to the repo (`reference:*`), pointed at `_stepup-cache/`. Remove Playwright, MSAL
device-code sign-in, the Azure app registration steps, `start`, `statuses`, `inspect`, `browser`, `discover`, and the
commands that have web equivalents. Update `README.md`, `CLAUDE.md`, the privacy page and `docs/PLAN.md`'s progress log.

## 6. Milestones

| M | Contents | Gate |
|---|---|---|
| M1 | D: connection state, reconnect, update notice, "last heard from StepUp" | tests pass; providers are **not** a gate here: they are checked in the spike session |
| M2 | B1 + B3: the form map, recognise a step, read back (nothing is written to the form) | owner records a form map on a throwaway draft |
| M3 | B2 for the controls the spikes pass, each followed by a read back | spikes pass or are scoped |
| M4 | B4–B6: verify StepUp's own save against the plan; record the submission by reading | one real filing, person pressing every button |
| M5 | C4 if wanted; E: retire the CLI | a full filing round done without the CLI |

C-items and D can be interleaved whenever B waits on a recording or a test.

## 7. Testing and risks

**Testing:** unit tests with fakes (the pattern in `packages/web/test/agent.test.ts`, no browser); invented fixtures with the
recorded field names; the built bundle is run against a pretend page; the read allow-list is pinned by test; a manual
throwaway-draft checklist with the owner present before anything runs on a real filing.

| Risk | Mitigation |
|---|---|
| StepUp changes the form (weeks to months) | recognise by signature and stop (B1); read back (B3); verify the save (B4); the form map re-checks |
| StepUp changes endpoints or shapes | shape checks; one table of URL patterns; the recorder re-learns quickly |
| Account restriction or terms of use | reads only; autofill human-paced and on request; extra reads off by default; the owner should read StepUp's terms on automated assistance |
| Token expires mid-run (60 min) | re-read from storage before each phase; stop cleanly |
| Two people filing | existing claims and the StepUp session lock |
| Bookmarklet limits (starts on click, lost on reload) | resume from the draft; an extension removes the limit without rewriting anything |
| Sensitive data in recordings | shapes only; name fields never sampled; reports checked before sharing |

## 8. Open questions for the owner (the agenda for the next chat)

1. **How is autofill started?** A button in the app (the app holds the plan and the receipt) that sends the values to the
   page, or a small panel on StepUp's page, or both? Which is less error-prone when StepUp's tab is the one being worked in?
2. ~~Fail closed per field~~ **Decided:** flag the field, leave it, fill the rest, do not move past the step. **Evidence
   that blocks Submit: decided** as the CLI does it. The Summary total is the only thing visible on the final page, so a
   total that differs from the expected one sends the flow back to Item/Service Details to re-fill (up to twice). If it is
   still wrong the agent shows a warning and blocks Submit (owner's rule; the CLI only warned).
3. **How much to fill?** Only items on step 3, or also the student and the document steps? Is a manual receipt choice fine?
4. **Is observing StepUp's own saves to verify the plan (B4) acceptable?** It is read-only and uses calls the page makes.
5. **The list request on click:** keep it (one request, the same one the dashboard makes), or make the agent make *zero*
   requests and rely on what the page loads (the person clicks Dashboard after the bookmark)?
6. **Auto-apply:** keep "confirm once per session"?
7. **Excel write-back (D1)** and how much of the CLI to retire, and when.
8. **Terms of use:** has the owner read StepUp's terms about automated assistance, and does it change the autofill design?
9. ~~Order of work~~ **Decided:** M1 first, then B.

## 9. Recording (how evidence is gathered)

The app's connection panel (Advanced → Get the StepUp bookmarklet) has **Record StepUp's traffic** and **Record, keeping
what I type into an item** (made-up values only). The report shows calls, request/response shapes, the response field each
id came from, setting-like samples and storage-upload timing; **Show the short version** keeps it small enough to paste.
Before recording after an update: fully refresh both tabs, click the bookmark, then start. The form map will join this.

## 10. If an extension is wanted later

Everything above is a TypeScript module with an injected host (`AgentHost`). An extension needs a different host (content
script, `chrome.storage`, runtime messaging) and a manifest. It would add: starting without a click, seeing calls made
before the page finished loading, surviving a reload. It adds no capability the agent lacks.

## 11. Order agreed 2026-10-14

M1 (monitoring) → M2 (form map, recognise a step, read back) → spikes on a throwaway draft with the
owner present (value entry, file attach) → M3 → M4 → M5. No reordering; nothing in B starts before M1's gate.

**Spike session checklist** (one sitting on a throwaway draft, owner present): value entry accepted by Blazor/Radzen
controls; file attach through the file control; **providers learned** (open "Who did you pay?", then the connection panel's
provider count rises above 0 and `_stepup-cache` has them); the recorded form map.

**Observed on item selection (2026-10-14, recorded maps):** after an item is ticked StepUp shows an editable name and an
amount (`$0.00` placeholder, with up/down buttons). The CLI never touched them; it set name and amount on Item/Service
Details. **Owner preference:** make the edits on this step where possible (a nicer flow). Needs a spike: do these fields
accept scripted entry, and does StepUp save them to the line item? Until proven, Item/Service Details stays the place
that is verified and read back.
