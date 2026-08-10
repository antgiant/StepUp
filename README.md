# Step Up Automator

Semi-automated Playwright helper for the [StepUp For Students](https://apply.stepupforstudents.org/) scholarship application. It:

- Opens a real browser to the StepUp site and lets **you** log in manually (StepUp's session handling is flaky — even the back button can log you out — so this never tries to persist or replay that login).
- Reads applicant data directly from your OneDrive Excel workbook via the **Microsoft Graph API** — not a downloaded copy — so it's always current and safe to use even while other collaborators have the sheet open.
- Matches required documents by name from your OneDrive reference-files folder (also via Graph) and uploads them.
- Fills each form page for you, then always pauses for you to review in the browser and click Next/Submit yourself. It never navigates or submits on its own.
- Optionally writes a status/date back to your row in the spreadsheet once you confirm you submitted.

## One-time setup

### 1. Install dependencies

```bash
npm install
npx playwright install chromium
```

### 2. Register an Azure app (required for Graph API access)

We tried skipping this by reusing Microsoft's own well-known public client IDs (Graph PowerShell, VS Code, OneDrive sync, Office) for device-code sign-in. All four failed for a personal Microsoft account: some reject personal accounts outright, and the rest get flagged by Microsoft's anti-phishing protections (device-code flow with a well-known high-trust client ID is a known phishing pattern, so Microsoft blocks/warns on it for personal accounts). So: register your own app. It's free and only takes a few minutes.

1. Go to <https://azure.microsoft.com/free> and sign up for a free Azure account. This asks for a card for identity verification only — nothing in this project ever creates a billable resource (app registrations and Graph API calls are free), so you won't be charged.
2. Once your subscription is active, go to <https://portal.azure.com> → **Entra ID** → **App registrations** → **New registration**.
3. Name it anything (e.g. "Step Up Automator").
4. Under **Supported account types**, choose **"Accounts in any organizational directory and personal Microsoft accounts"**.
5. Leave Redirect URI blank. Click **Register**.
6. On the app's Overview page, copy the **Application (client) ID**.
7. Go to **Authentication** → **Advanced settings** → set **"Allow public client flows"** to **Yes** → Save. (Needed for the device-code sign-in this script uses — no client secret required.)
8. Go to **API permissions** → **Add a permission** → **Microsoft Graph** → **Delegated permissions** → add `Files.ReadWrite`, `Files.ReadWrite.All`, `offline_access` → Save. (No admin consent needed — you'll consent yourself on first sign-in.)

Because it's genuinely your own app, device-code sign-in won't look anomalous to Microsoft the way reusing a well-known client ID did.

**Browser note:** do the device-code sign-in (steps 4 and onward below) in **Chrome or Edge, not Safari** — Safari's cross-site tracking prevention breaks the multi-domain redirect chain Microsoft's login flow relies on and produces confusing, unrelated-looking errors.

### 3. Configure

```bash
cp .env.example .env
```

Edit `.env` and paste in the Client ID from step 2.6. The authority and both OneDrive links are already filled in.

### 4. Discover your spreadsheet & folder structure

```bash
npm run discover
```

First run will print a Microsoft device-login link + code — open it, sign in as yourself, approve. After that it's cached (`.cache/`, gitignored) and you won't be asked again until it expires.

This prints your Excel workbook's table/column names and the reference-files folder contents — structure only, no applicant data rows — so we can build the config below together.

### 5. Build the field mapping (do this together, once)

```bash
cp config/form-config.example.json config/form-config.json
npm run inspect
```

This opens the real StepUp site. Log in manually, click to each page of the application, and each time press Enter in the terminal to dump that page's field labels/names/selectors (values are never printed — only structure). Use that output plus the column names from step 4 to fill in `config/form-config.json`: one entry per page, mapping each field's selector to either an Excel column, a fixed value, or a reference-file search query.

## Running it for an applicant

```bash
npm start -- "Jordan Smith"
```

(the value should match whatever's in the column you set as `matchColumn` in `config/form-config.json`). The script will:

1. Look up that applicant's row via Graph.
2. Open StepUp and wait for you to log in.
3. Walk through each configured page: fill what it can, tell you what it couldn't (e.g. ambiguous file matches), and wait for you to review + click Next yourself.
4. At the end, ask whether you actually submitted — if yes, it writes a status/date back to your row (only that one cell; nothing else in the sheet is touched).

## Updating for a new school year

Everything year-specific lives outside the code, so a new cycle is just:

- **`.env`** — update `ONEDRIVE_EXCEL_URL` and `ONEDRIVE_FILES_FOLDER_URL` to that year's workbook/folder share links.
- **`config/form-config.json`** — rerun `npm run discover` and `npm run inspect` to check whether StepUp's form or your spreadsheet's columns changed, and adjust the mapping if so. If neither changed, no edits needed.

Nothing in `src/` should need to change year to year.

## Notes on data safety

- Applicant PII (names, SSNs, addresses, etc.) is never printed to the console or written to any log/config file — only column *names*, file *names*, and field *selectors* are.
- Writes to the spreadsheet go through the Graph Excel API's row-level update, which only ever touches the specific column(s) you configure — never a full-file re-upload, so concurrent edits from other collaborators aren't at risk of being clobbered or the file corrupted.
- `.env` and `.cache/` (your auth token cache) are gitignored — don't commit them.
