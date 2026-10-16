# Step Up Helper — Outstanding Items

Last updated 2026-10-15. The detail behind the bookmarklet items is in `docs/AGENT_PLAN.md` (§7 what remains, §12 not yet
verified live). Test locally first (`npm run dev -w @step-up/web`, a dev bookmark on `localhost:5173`); a merge to `main`
deploys.

## 1. Validate the Google Drive changes

- [x] Replace the `drive` scope with `drive.file` (consent screen, web app and CLI)
- [x] Confirm the project number used for `GOOGLE_APP_ID` is right
- [x] Add `http://localhost:5173` as a Microsoft redirect URI
- [x] Picker API key's website and API restrictions are saved, including `http://localhost:5173/*` for local testing
- [ ] Sign in with Google on the live site; the consent screen should show only the new, non-sensitive scopes
- [ ] Open an existing workspace the app created earlier; it should still load
- [ ] Use the picker on a folder that already has files, **including files added by hand**. If they look empty, a different
      approach is needed (pick the files themselves, or import them)
- [x] Create a new workspace folder from the app and add a school year
- [ ] Download a receipt from a Google workspace for filing (the "Google storage" item in AGENT_PLAN §12); previewing one works
- [x] Invite a second Google account, then join with the picker
- [ ] CLI with `STEPUP_STORAGE=google`: re-consent with the new scopes (delete `.cache/google-token.json` first)

## 2. Validate the bookmarklet

- [x] Rename existing bookmarks to "Step Up Helper"
- [ ] Set up the dev bookmark at `localhost:5173` and confirm it connects
- [ ] Automatic recording after Submit: Status, Submitted, Reimbursement ID and Line Number land on the workbook row
- [ ] A multi-item receipt: block pairing, and checkboxes on the "detected" variant
- [ ] A category that requires a service date, and the missing-service-date stop ("Unfiled (Missing Things)")
- [ ] "Provider not Listed" with a typed name; a listed provider with individual people
- [ ] Several additional documents; a statement that has a redacted copy
- [ ] A receipt StepUp cannot read: the read-error wording and the "none found" variant
- [ ] Resuming an existing draft, including the app's "a draft exists" prompt
- [ ] "File all ready, one after another", and starting from the dashboard or a confirmation page
- [ ] The ported CLI features, each probably needing a rule: category fix with a manual pick, holds, claims, session lock,
      draft number
- [ ] Statuses written into the workbook ("Bring in StepUp's list" on an Excel year)
- [ ] Pre-authorization status sync (dormant until a row has a Pre-Auth #)
- [ ] Enter and Space on Submit are intercepted by the guard (only clicks have been exercised)
- [ ] Filing from a ledger year (`recordSubmitted`, claims, drafts); only an Excel year has been filed so far
- [ ] Spike results not yet exercised: service-date entry, additional-document attach on step 4, individual provider
- [ ] Item-selection edits: do the name and amount fields accept scripted entry?
- [ ] Mobile (Safari on iPhone/iPad)

## 3. Filing and housekeeping

- [ ] Delete or finish any old CLI drafts in StepUp before filing the same rows again
- [ ] Check rows that share a date and amount before filing both (one purchase duplicated?)
- [ ] File the remaining ready purchases, the largest last
- [ ] Confirm the earlier live filing was recorded in the workbook
- [ ] Read StepUp's terms about automated assistance

## 4. Engineering backlog

- [ ] Retire the CLI: keep `reference:*`; remove Playwright, MSAL device-code sign-in and the commands with web equivalents
- [ ] README intro and privacy page: say the bookmark fills StepUp's form and writes to the workbook
- [ ] Remove debugging leftovers as sorted in `docs/PRODUCTION_CLEANUP.md` (spike session, recorder, form-map diagnostics)
- [ ] A regression fixture built from the recorded form shapes
- [ ] C4: comments to per-item reasons
- [ ] C5: pre-authorizations (dormant)
- [ ] The flaky `publishYearMirror` test in `cli-support.test.ts` (times out on a slow disk, passes alone)
- [ ] Add a "Testing locally" section to the README

## 5. UI improvements

- [ ] The bookmark shows a visual indicator of its status on the StepUp website and on the helper website
- [ ] Reorganize the clutter across the screens
- [ ] Significant reorganization of the Advanced menu
- [ ] Rethink how automated submission is started and managed
- [ ] Google welcome screen: lead with the picker when configured, and explain why a folder may look empty
- [ ] Filing panel: a step progress indicator (student, upload, items, details, summary) beside the stop line
- [ ] Connection panel: show which origin the connected script came from, so a dev script is never mistaken for live
- [ ] Say plainly when the connected script is out of date and what to click
- [ ] Review every screen at phone width
- [ ] Sign-in and picker errors that say what to do, with a retry button
- [ ] "Ready to file": a clearer summary of what will be filed, what is held back, and why

## Blocked (not now)

- [ ] Build **Pre-Auth submission automation** — blocked, not abandoned. Confirmed a real (if not currently urgent) need;
      genuinely separate flow from reimbursements, not a tweak to the existing one:
  - Its own wizard: Student Selection → Item/Service Details → Educational Benefit → Summary (no receipt upload step).
  - Distinct fields discovered so far: `itemDetails__category`, Quantity, Cost, a documentation file upload,
    `LearningEnhancementText`, a provider dropdown + `OtherServiceProviderName` fallback, `affirmationCheckbox`, typed
    `SignatureName` e-signature. The real API also reveals `LearningSubjectAreas` (array) and `CourseDescription` fields never
    seen on the actual form, so that page likely has more fields than were captured.
  - Several of this flow's buttons have **stable, semantic IDs** (`studentSelectContinueButton`, `continue-btn`,
    `itemDetails__category`), unlike the reimbursement flow's random-UUID buttons.
  - `/api/preauthorization/search` fires automatically on the **home page** and on a dedicated Pre-Authorizations list page.
    Each result has one `LineItem` (Pre-Auth requests are always single-item), and a
    `ReimbursementId`/`ReimbursementSequenceNumber`/`IsReimbursement` linkage shows how an approved Pre-Auth connects to its
    eventual reimbursement: that is the mechanism behind Table1's `Pre-Auth #` column.
  - **Blocked on** the Summary/Submit step and confirmation screen: neither can be seen without a real future Pre-Auth need
    (it requires a genuine e-signature). Revisit when that happens.
- [ ] Excel dependent-dropdown validation (Category list filtered by Scholarship) — parked. No automatable approach exists:
      Data Validation rejects structured/array formulas outright, and Power Query's refresh can't be triggered via Graph
      API. No practical effect today since every child has the same single scholarship. Revisit only if a second
      scholarship shows up (try a relative-named-range formula then).
