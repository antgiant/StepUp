# Step Up Helper

This is a system for tracking and managing the documentation and reimbursement requests for the Florida [StepUp For Students](https://apply.stepupforstudents.org/) program. It is available at https://stepup.wooleys.us 

## Why

This is a system built to solve the problem of keeping personal records for the reimbursement process of StepUp for Students. It is designed to make it easy to pull together all of the information required to submit for reimbursement and to streamline the submission process.

## How it works

When you first visit this site asks you to log in to your personal Microsoft OneDrive account. It then saves all of your data to a folder structure in OneDrive. This site never sees your data all of your data only ever goes from your computer to your OneDrive.

## Excessivly Technical Details

(Yes this part is AI Written)

In addition to the web interface there is also a semi-automated Playwright helper for filing **reimbursement requests** on [StepUp For Students](https://apply.stepupforstudents.org/), driven by the data on OneDrive. It:

- Reads unfiled purchase rows (`Status = "Unfiled (Ready to Submit)"`) directly from your OneDrive data via the **Microsoft Graph API** — not a downloaded copy — so it's always current and safe to use even while other collaborators have the sheet open.
- Groups rows that share the same child and main receipt into one StepUp submission each (matching how one uploaded receipt can cover several line items).
- Opens a real browser to StepUp and lets **you** log in manually every run (StepUp's own session handling is flaky — even the back button can log you out — so this never tries to persist or replay that login).
- Fills what it reliably can (Category, Benefit Message, Item/Service URL, and Date/Cost/Tax/Vendor/Invoice#, overwriting StepUp's OCR guesses with a warning when they differ), and always pauses for **you** to review in the browser and click Continue/Submit yourself. It never navigates or submits on its own.
- After you confirm you actually submitted, captures the Reimbursement # from the confirmation screen and writes Status/Submitted-date/Reimbursement ID/Line Number back to just those rows in the spreadsheet.
- Passively keeps Status current afterward: StepUp's own reimbursements-list API loads automatically during normal navigation, and whenever that happens (throttled to once per 2 hours) it's used to sync each already-submitted row's Status as it moves through StepUp's review process (Submitted → Approved/Denied → Paid), matched per line item, not just per submission.
- Also keeps `Table5` (Categories) current, at most once per 24h: StepUp's Category/Type/Detail picker APIs can't be called from scratch by us (they need an auth token only the page's own JS attaches), so instead — the first time you (or our own Category-filling step) naturally trigger one of those requests that day — we intercept it and piggyback an *additional* out-of-band request asking for every ID we know about so far, reusing that request's real auth, chunked and lightly throttled between chunks. The original request is always left completely untouched, so the page's own UI never sees anything different. Results accumulate in `.cache/category-tree-cache.json` across days, so full tree coverage typically only takes a couple of real Category clicks to bootstrap, not months of incidental exposure.
- Passively accumulates the **known vendor/provider list** too (`.cache/vendor-listing-cache.json`), from the "Who did you pay?" dropdown's own API responses whenever they naturally load — local cache only for now, not yet synced into a spreadsheet table.
- Also passively syncs `Pre-Auth` status (matched by `Pre-Auth #`) from StepUp's Pre-Authorization list API, same throttled pattern — currently dormant since no rows have a `Pre-Auth #` recorded yet. (Full Pre-Auth *submission* automation — a separate wizard from reimbursements — isn't built yet; see `todo.md`.)

## Repo layout

npm workspaces monorepo. Everything is still run from the repo root, so `.env`, `.cache/`, `.chrome-profile/` and `data/` stay where they were.

- `packages/cli/` — the Playwright automator (everything described below). Node-only: MSAL device-code auth, disk caches, browser automation.
- `packages/shared/` — environment-agnostic code used by both sides: the Microsoft Graph/Excel client (token supplied by the host via `setTokenProvider`), workbook table names, status constants and category parsing.
- `packages/web/` — placeholder for the static GitHub Pages data-entry portal (not built yet).

Run `npm run typecheck` to check every package.

## One-time setup

### 1. Install dependencies

```bash
npm install
```

The StepUp browser session (`npm run inspect`, `npm start`) launches your real, installed **Google Chrome** through a dedicated profile at `.chrome-profile/` (gitignored, separate from your everyday Chrome profile) — not a bundled/downloaded browser. (We looked into getting Apple Passwords autofill working in that profile too; it ran into a few layers of Chrome restrictions around automated sessions that weren't worth fighting for what it saved, so credentials just get typed manually — you're already doing that for StepUp's own login regardless.)

### 2. Register an Azure app (required for Graph API access)

We tried skipping this by reusing Microsoft's own well-known public client IDs (Graph PowerShell, VS Code, OneDrive sync, Office) for device-code sign-in. All four failed for a personal Microsoft account: some reject personal accounts outright, and the rest get flagged by Microsoft's anti-phishing protections (device-code flow with a well-known high-trust client ID is a known phishing pattern, so Microsoft blocks/warns on it for personal accounts). So: register your own app. It's free and only takes a few minutes.

1. Go to <https://azure.microsoft.com/free> and sign up for a free Azure account. This asks for a card for identity verification only — nothing in this project ever creates a billable resource (app registrations and Graph API calls are free), so you won't be charged.
2. Once your subscription is active, go to <https://portal.azure.com> → **Entra ID** → **App registrations** → **New registration**.
3. Name it anything (e.g. "Step Up Helper").
4. Under **Supported account types**, choose **"Accounts in any organizational directory and personal Microsoft accounts"**.
5. Leave Redirect URI blank. Click **Register**.
6. On the app's Overview page, copy the **Application (client) ID**.
7. Go to **Authentication** → **Advanced settings** → set **"Allow public client flows"** to **Yes** → Save. (Needed for the device-code sign-in this script uses — no client secret required.)
8. Go to **API permissions** → **Add a permission** → **Microsoft Graph** → **Delegated permissions** → add `Files.ReadWrite`, `Files.ReadWrite.All`, `offline_access` → Save. (No admin consent needed — you'll consent yourself on first sign-in.)

Because it's genuinely your own app, device-code sign-in won't look anomalous to Microsoft the way reusing a well-known client ID did.

**Browser note:** do the device-code sign-in in **Chrome or Edge, not Safari** — Safari's cross-site tracking prevention breaks the multi-domain redirect chain Microsoft's login flow relies on and produces confusing, unrelated-looking errors.

### 3. Configure

```bash
cp .env.example .env
```

Edit `.env` and paste in the Client ID from step 2.6. The authority and both OneDrive links are already filled in.

### 4. Sign in once

```bash
npm run discover
```

First run will print a Microsoft device-login link + code — open it in Chrome/Edge, sign in as yourself, approve. After that it's cached (`.cache/`, gitignored) and you won't be asked again for months of normal use. This also prints your workbook's table/worksheet/column names and the reference-files folder contents — useful if the spreadsheet's structure ever changes and the code needs updating to match.

## Running it

```bash
npm start
```

No arguments — it processes every unfiled row in one run, in groups. For each group it will:

1. Ask you to log into StepUp and start a new reimbursement request, then select the student for you.
2. Download the group's main receipt from OneDrive and upload it.
3. If StepUp's OCR detected items: tell you which checkboxes to tick (it can't reliably click these itself — see "Known StepUp quirks" below).
4. Fill each item's Category, Benefit Message, Item/Service URL, and Date/Cost/Tax/Vendor/Invoice# (matching each detected item block to a spreadsheet row by dollar amount, asking you to confirm or correct the match).
5. Upload any additional supporting documents for the group.
6. Pause on the Summary page for you to review everything and click **Submit for approval** yourself — this is a real submission to StepUp, not a sandbox.
7. Once you confirm you see the confirmation screen, write Status/Submitted date/Reimbursement ID/Line Number back to just those rows.

You can type `skip` at the start of any group to move to the next one without processing it.

**One-time spreadsheet change:** Table1 now has a `Line Number` column (added right after `Reimbursement ID`) — a submission's `Reimbursement ID` is shared across all its rows, but each row's specific line item within that submission (`Reimbursement ID` + `Line Number`, e.g. `35958661` + `1`) is what StepUp's status API actually keys on, which is what lets status-sync update rows individually instead of only in whole-submission batches. **Table3 (Statuses) also needs a `Paid` entry added** — StepUp's API reports it as distinct from `Approved`, but it wasn't in the original list; add it yourself in the spreadsheet whenever convenient before status-sync needs to use it.

## Known StepUp quirks this project works around

- **Nav/action button IDs (Continue, Submit, step-progress bar) are random per session** — different every time you load the page. Selectors for those are text-based, not ID-based.
- **Repeated field IDs**: on multi-item screens (item checkboxes, item detail blocks), StepUp reuses the exact same `id` (e.g. `item_0`, `category`) across every repeated instance — a bug on their end. Fields are targeted positionally (`.nth(i)`), not by plain `#id`.
- **OCR item detection can fail outright** ("We were not able to detect items or services on your document"), in which case you either retry with a different document or continue and manually add item blocks.

## Updating for a new school year

Everything year-specific lives in `.env`, not code:

- Update `ONEDRIVE_EXCEL_URL` and `ONEDRIVE_FILES_FOLDER_URL` to that year's workbook/folder share links.
- Rerun `npm run discover` to confirm the table/column names still match what `packages/cli/src/reimbursements.ts` expects (`Table1`, `Status`, `Documentation File 1-6`, etc.) — if StepUp's site changed its field IDs or your spreadsheet's columns were renamed, `packages/cli/src/` would need updating too, but the links themselves never require a code change.

## Notes on data safety

- Applicant/child PII in the strict sense (SSNs, addresses, DOBs — none of which this spreadsheet actually stores) is never printed. Item descriptions, dollar amounts, vendor names, and filenames *are* printed to the terminal where relevant (e.g. to confirm an item match) — the same information already visible in your own spreadsheet, needed for the tool to be usable.
- Writes to the spreadsheet go through the Graph Excel API's row-level update, which only ever touches the specific column(s) being set — never a full-file re-upload, so concurrent edits from other collaborators aren't at risk of being clobbered or the file corrupted.
- `.env`, `.cache/` (your auth token cache), `.chrome-profile/`, and `data/` (downloaded receipts, temporary) are all gitignored — don't commit them.

## Filing from the ledger (new)

`npm start` still files from the Excel workbook exactly as before. To file from a ledger year instead:

```
npm start -- --ledger=2026-2027
```

- Items that are **ready** (per the same readiness rules the web app shows) are grouped one per StepUp submission (a purchase x a child) and filed through the same supervised browser flow. Receipts and additional documents are found by their OneDrive item ids; if a statement has a redacted copy, that copy is what gets uploaded (and you are warned about any statement sent as it is).
- Everything the run learns is recorded in the ledger instead of the spreadsheet: submitted items (reimbursement number, line number, date), items that could not be filed (held with the reason in their notes, so they are not offered again until a person clears the hold in the web app), draft numbers (so a crash loses nothing), category names corrected from StepUp's live list, and statuses/paid amounts seen on StepUp's reimbursements list.
- Pre-authorization syncing is spreadsheet-only. The category sync works in both modes: in ledger mode, when StepUp's category list is observed, anything new or changed (new entries, renames, deactivations, eligibility now known) is recorded as category edits in that year's ledger (the web app shows them and can export them); it never touches a category's Service Date flag. `npm run reference:build` still folds the local cache into the shared list.
- When a run records a submission, and at the end of the run, the year's mirror spreadsheet is rebuilt exactly as the web app does it (same file, skipped if unchanged, left alone if open in Excel, off if the year has switched it off). `npm run report -- 2026-2027` does it on demand.
- Nothing is written to OneDrive until a step in the flow actually records something, and a real submission still needs you to click the final Submit in StepUp.

### Only one person at a time

StepUp misbehaves when two people (or two sessions) use the same account, so `npm start` (either mode) and `npm run inspect` take a lock first: a small `stepup-session.lock.json` in the shared workspace folder, refreshed every minute and removed on exit or Ctrl+C. If someone else holds it, you are told who, from which machine, and since when, and the run stops. A lock whose owner has stopped refreshing it (crash, sleeping laptop) is treated as abandoned after 5 minutes. `npm start -- --force-unlock` takes over a lock you are sure is a leftover; the other session is told at its next refresh.

### Claims and resume state (ledger mode)

- **Claims.** Before filing a group, the run claims its items ("alice is filing this"): the claim is uploaded, every log is re-read, and the run goes ahead only if its claim is still the earliest for every item, so two people starting together cannot both file the same thing. The other person's run skips those items and says who has them. A claim is given back when the group ends (submitted, skipped or failed), renewed at every step of a run, and expires by itself 45 minutes after the last step, so a crash never locks items for long. Your own leftover claim from a crashed run is simply resumed.
- **Resume state.** What a run knows about a StepUp draft (its id and number, the last step reached, the scan outcome, which documents were attached, whether you skipped it) is saved in the ledger instead of `.cache/drafts.json`, so either person, on any machine, is offered to resume it. The spreadsheet mode still uses `.cache/drafts.json`.
