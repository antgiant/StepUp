# Plan: the bookmarklet agent replaces the command line, and uses what StepUp already knows

Status: **PLAN.** Written 2026-10-14 after the first real recording of StepUp's traffic. Supersedes the "extension" route in
`docs/EXTENSION_PLAN.md` for now (an extension stays a possible later wrapper; §9). Read `CLAUDE.md` first.

> **Public repo rule:** never commit real names, amounts, ids, file names, tokens or captured responses. Fixtures are
> invented. Recorded reports are shapes only (field names and types), and are scrubbed before being kept.

## 1. Where we are

Done and pushed: the bookmark is a loader for `stepup-bookmarklet.js`, a bundled TypeScript agent (`packages/web/src/agent`)
that runs on StepUp's page. It fetches the reimbursements list on click, re-sends a changed list the dashboard fetched,
learns the category tree (with a once-a-day expansion) and providers, and can record the shapes of StepUp's calls. The
app (`packages/web/src/main.ts`) confirms and applies lists, keeps what was learned in `_stepup-cache/`, shows what changed
and shows the connection. The learners are shared with the CLI (`packages/shared/src/stepup/learn.ts`).

What the first recording established (all 2026-10-14, one real session):

- StepUp is a single-page app: one page load across the whole wizard, so an agent started by a click survives it.
- Everything goes through `fetch`; the agent sees it.
- Reimbursements are plain API calls: `POST …/reimbursements/v2` (create draft), `GET`/`PUT …/reimbursements/v2/{id}`
  (read and save the whole draft, including receipts and line items), `DELETE …/reimbursements/V2/{id}` (abandon),
  `POST …/documents-sasuri` and `POST …/sasuri` (storage addresses for the receipt), then a direct upload to blob storage.
- StepUp already holds data the app makes people type: per-student balances (`balancecheck/bulk/details`: funding,
  spending, reserved, available, adjustments), the student list with scholarships (`studentScholarship`), per-category
  flags (`RequiresServiceDate`, `RequiresVendor`, `RequiresServiceProvider`, `IsTaxable`), and comments with reason codes.
- Two defects found and fixed: request bodies were not captured (Blazor sends bytes) and the provider list moved to
  `providerapi … /vendors/search`.

What the second recording (2026-10-14, request bodies included, field names only, two levels deep) added:

- **The draft is written whole.** `POST …/reimbursements/v2` (create) and `PUT …/reimbursements/v2/{id}` (every save, and the
  one before a delete) send the full reimbursement object: ids and names of the guardian, student and program
  (`guardianId`, `studentId`, `programId`, `internalProgramId`, `programType` as a number, `studentSequenceNumber`), status
  fields, `lineItems`, `receipts`, `additionalDocuments`, `submitDate`, and `Id` / `PartitionVersion`.
  **The draft's `Id` is chosen by the page** (it is in the create request), so the agent can choose it too.
- **A line item** carries both capitalised and lower-case fields: `CostPerItem`, `AdditionalCosts`, `Quantity`, `ItemUrl`,
  `PurchaseMinDate`/`PurchaseMaxDate`, `ServiceMinDate`/`ServiceMaxDate`, `ServiceProviderPersonIdString`, with
  `categoryId`/`categoryTypeId`/`categoryDetailId` (and names), `itemAmount`, `taxPercent`, `purchaseDate`, `serviceDate`,
  `vendorName`/`vendorCode`, `serviceInvoiceNumber`, `educationalBenefit`, `receiptId`.
- **A receipt** is registered on the draft as `{Id, blobSasUri, fileType, sourceFileName, ...}` after `POST …/documents-sasuri`
  (request: `ReimbursementDocuments.ReceiptDocuments[]`, `ReimbursementId`, `EntityId`, `ShouldUpload`) returns upload
  addresses; `POST …/sasuri {GeneratedFileName}` returns a read address. **The upload to storage itself was not seen**: that
  code holds its own `fetch`, so the wrappers miss it (the recorder now also reads the browser's resource timeline for it).
- `categories/search`'s request is the standard envelope with `Filters:{IsActive}`; the agent now calls it itself, then
  expands types and details, and reads `vendors/search`, once a day after a click (no one has to open a dropdown).
- **Both provider endpoints are live**: `vendors/search` (the full list) and `getbusinesssummarydropdown` (paged, with
  `Filters:{ProgramType}`).
- A SignalR hub (`infrastructureapi … /negotiate`) pushes notifications; a possible later source of status changes.

The third recording (same day) added: `typesbyids`/`detailsbyids` take a plain JSON array of ids; the balance request is
`{ "<student sequence number>": [strings] }` (what the strings are is traced by the recorder's provenance report, not
guessed); `comments/search` is filtered by `SourceEntityId`; `notifications/in-app/search` lists in-app notifications; a
reimbursement's details page is `Reimbursement/Details/{id}/Two`. It was produced by an older recorder object that a newer
script inherited on a second click; the agent now carries the recording as data and rebuilds its recorder, so an update
takes effect immediately. The recorder also traces each id in a request to the response field it came from (paths only)
and masks identifier-like object keys.

Still unknown for B: the values of the status/enum fields on a new draft (the recorder now samples a fixed set of
setting-like fields), the exact `ReceiptDocuments[]` item, how storage upload is authorised, and the submit call (never
exercised, by design).

### What the fourth recording established (2026-10-14; the first from a current build with ids traced and values sampled)

All of this is shape and traced origin, never values. Where a word is quoted it is a setting StepUp uses, not personal data.

**Creating a draft** (`POST …/reimbursements/v2`, about 1.4 KB):

| Field | Where the page gets it |
|---|---|
| `Id` | made up by the page (the call's own response is the first place it appears) |
| `guardianId` | `studentScholarship[].primaryGuardianId` |
| `guardianSequenceNumber` | `guardians/{id}.sequenceNumber` |
| `studentId`, `studentSequenceNumber` | `studentScholarship[].id`, `.sequenceNumber` |
| `programId`, `internalProgramId` | `infrastructureapi … /programs/search` → `Results[].Id` (a call made at page load; its request is not yet recorded) |
| `guardianName`, `studentName`, `programName` | the same sources (names) |
| fixed words | `externalStatus` = `"Draft"`, `internalStatus` = `"Draft"`, `displayExternalStatus` = `"Draft"`, `displayInternalStatus` = `null`, `submitDate` = `"0001-01-01T00:00:00"`, `schoolYear` = `null`, `programType` = `0`, `PartitionVersion` = `0`, `skipValidation` = `false`, `lineItems` = `[]`, `receipts` = `[]` |

The server replies with the stored draft: `sequenceNumber` (the reimbursement number), `schoolYear` (`"2026-2027"`),
`programType` as text (`"FESUA"`), and `displayInternalStatus` = `"Draft"`. **A later save sends `programType` as the number
`24`** (StepUp's partner id for the program), not `0`, and `schoolYear` as returned.

**Receipt upload** is three calls, then a save:

1. `POST …/documents-sasuri` with `ReimbursementDocuments.ReceiptDocuments[]` = `{ Id (made up), PartitionVersion: 0,
   sourceFileName, everything else null }`, `ReimbursementId` and `EntityId` = the draft's id, `ShouldUpload: true`. The reply
   gives the same item with `blobSasUri` (an upload address).
2. `PUT <blobSasUri>`: an Azure blob upload with `x-ms-blob-type`, `x-ms-version`, `content-type`, `content-length`; 201 on
   success. **This goes through `fetch`, so it is visible to the agent**; the older reading that it was hidden was wrong
   (those earlier builds had not yet wrapped the storage host).
3. `PUT …/reimbursements/v2/{id}` with `receipts[]` = `{ Id (the same), PartitionVersion: 0, blobSasUri, sourceFileName,
   fileType: "data:application/pdf;base64," (a data-URI prefix, not a media type), others null }`. The reply carries
   `generatedFileName` and `fileData` for the receipt.
4. `POST …/sasuri { GeneratedFileName }` returns a read address, for the preview.

**Saving and leaving**: every step change is a `PUT` of the whole draft; `GET …/reimbursements/v2/{id}` is polled while the
page waits for the scan (`ocrFormatted`, `ocrTimeToProcessInSeconds` fill in). Abandoning is `DELETE …/V2/{id}` with the
whole draft as its body. **No submit call was exercised, by design.**

**A line item** in a save is the set (PascalCase is how StepUp's own model spells them; the rest are camelCase):
`AdditionalCosts, CostPerItem, EvaluationFields, Id, ItemUrl, MatchedItemName, PartitionVersion, PreAuthSequenceNumber,
PurchaseMaxDate, PurchaseMinDate, Quantity, ServiceMaxDate, ServiceMinDate, ServiceProviderPersonIdString` and
`categoryId/categoryName, categoryTypeId/Name, categoryDetailId/Name, educationalBenefit, itemAmount, lineItemNumber,
purchaseDate, serviceDate, serviceInvoiceNumber, serviceProviderCode/Name/PersonId/PersonName, taxPercent, vendorCode,
vendorName, receiptId`, plus status fields. `receiptId` is the receipt's `Id`; the item's own `Id` is assigned by the
server's reply to the first save that includes it. The arithmetic between `itemAmount`, `CostPerItem`, `Quantity`,
`AdditionalCosts` and `taxPercent`, and the date formats, are **not yet known** (see "next recording").

**Other facts:** `programs/search` supplies program ids and exists on the infrastructure API; `categories/search`'s
approved programs carry `PartnerId` and `ProgramType: 24`; `getbusinesssummarydropdown` filters by `ProgramType: "FESUA"`
and pages 20 at a time; `vendors/search` is the full list (request: the standard envelope with `Filters: {}`); an
unfinished draft's status word is **`Draft`**. A student's `scholarships[]` carries `programName`, `programYear`, `status`
(`Funded`), **`awardAmount` and `fundedAmount`**: the award per year, so awards need not be typed at all.

### The fifth recording (values mode), what it settled

- **The balance request is buildable by the agent.** `balancecheck/bulk/details` takes `{ "<student sequence number>":
  ["<internal program id>", ...] }`: the keys are `StudentSequenceNumber` values and the strings are `InternalProgramId`
  values, both taken from the reimbursements list (distinct program ids per student). The agent can therefore ask for
  balances itself on a click, instead of waiting for the Dashboard to.
- **Program ids need no `programs/search`.** A new draft's `programId` and `internalProgramId` equal the student's
  scholarship `internalProgramId`; `guardianId`, `guardianSequenceNumber`, `studentId` and `studentSequenceNumber` equal the
  same fields on any earlier reimbursement of that student in the list (or the student/guardian records).
- **Comments are fetched by guardian**: `comments/search` with `Filters.SourceEntityId` = the guardian id and
  `InternalOnly: false` returns every external comment (`ReasonCode`, `ReasonDescription`, `CommentText`,
  `ParentRecordSequenceNumber`, `CommentType: "External"`). A comment belongs to a reimbursement through
  `ParentRecordSequenceNumber`. (C4 can be built on this.)
- **A privacy slip, fixed:** a comment's `SourceEntityName` is the guardian's own name and had been whitelisted as a
  "setting". It, and every name-like field, is now never sampled, with a test. Reports before this build may contain it.
- The paste of this recording was cut off at the chat's size limit inside the `DELETE` call, which is where the item values
  are. The report now has a **short version** (only calls that matter for filing and learning, response shapes dropped for
  big lists) and keeps **every distinct shape** of a call, so a save before and after an item are both there.

### Next recording (needed before an item can be written)

Turn on **Record, keeping what I type into an item** and enter made-up values, so the field arithmetic is learned:
quantity 2, cost per item 10.00, tax/shipping 5.00, one purchase date and one service date (any, made up), an invoice
number `TEST-1`, vendor chosen from the list, benefit message `test`, URL `https://example.test/x`. Also start recording
**before** the Dashboard loads, or navigate away and back to the Dashboard while recording, so `programs/search` and
`balancecheck/bulk/details` requests are caught.

## 2. Principles (non-negotiable)

1. **The agent never submits.** A person presses StepUp's own Submit. The agent may create and fill a draft; it may not
   take any step that sends it for review. This is enforced in code, not by convention (§4, "the write gate").
2. **The app is the brain, StepUp's page is the hands.** The agent reads the page's own sign-in, never sends it anywhere,
   never stores it, and never touches the refresh token. The app owns all storage and every decision.
3. **Same calls the page makes, nothing else.** No guessed endpoints. Anything the agent calls was seen in a recording.
4. **Visible and reversible.** Every write to StepUp is announced on the page, recorded in the ledger (History), and
   limited to drafts the agent itself created and can name by id.
5. **Shape-checked.** A StepUp response that no longer looks right stops the run with a message; nothing is written from it.
6. **Excel stays read-only** and ledger/History rules in `CLAUDE.md` still hold.

## 3. Workstreams, in order

Each has value, size (S/M/L), dependencies, evidence needed, and acceptance. A "milestone" is something that can ship alone.

### A. Evidence: the second recording (S, blocks B) — **milestone M0**

The agent now records request bodies and header names. Needed, on a throwaway draft, stopping before Submit:

1. create the draft (student chosen),
2. upload a receipt (`documents-sasuri`, `sasuri`, the blob request's headers and size, the `PUT` that follows),
3. let the item scan finish (what the PUT body contains for OCR results),
4. add one item with a category, provider, amount, date, tax, benefit message and URL,
5. move forward and back one step (which calls the step change makes),
6. abandon the draft (`DELETE`).

Output: a scrubbed shapes report, kept as `docs/fixtures/stepup-shapes-2026-10.md` (field names and types only).
Acceptance: every field the CLI's `fillItemDetails` sets has a named counterpart in a request body.

### B. Direct filing: "Fill the draft for me" (L) — **milestones M2–M4**

Instead of clicking through the form (Playwright's job in the CLI), the agent makes the page's own calls, then hands the
draft to the person at the Summary step to check and submit.

| Step | What it does | Replaces (CLI) |
|---|---|---|
| B1 draft lifecycle | create a draft for a student; read it back; delete one the agent made | `selectStudent`, `ensureOnNewReimbursementForm`, `draftTracker` |
| B2 receipt upload | request storage addresses, upload the file (≤ 5 MB, from the app), record it on the draft | `uploadFile` |
| B3 items | write one line item per ledger item: category ids, amounts, tax, dates, vendor/provider, benefit message, URL | `fillItemDetails`, `autoCheckDetectedItems` |
| B4 verify | read the draft back and compare with the plan: item count, each amount, total | `readSummaryTotal` |
| B5 hand-off | send the page to `…/SubmitReimbursement/{id}/5`; the person reviews and submits | `waitForStepChange`, summary pause |
| B6 record | on seeing the submission (the page's own call and the next list), write reimbursement # and line numbers to the ledger | `readReimbursementId`, `markSubmitted` |

Inputs come from existing shared code: `planSubmissions` groups items per purchase and child; `claims`/`drafts`/`record`
in `shared/submit` already model claiming, resuming and recording. The app sends the receipt bytes (it holds the storage
token) and the plan; the agent returns progress, then the verified draft.

**The write gate.** All StepUp writes go through one function with an allow-list of (method, path pattern) pairs taken from
the recording: create draft, save draft, storage-address requests, blob upload, delete a draft whose id the agent created
in this session or recorded as its own. Anything else throws. A test fails if a path that can submit is ever added, and a
second test asserts the agent module never contains a call to a submit endpoint.

**Dry run.** Every filing step can run in "show me" mode: the requests it would send are built and displayed, none sent.
Used first against the fixtures, then live on a throwaway draft.

**Fallback.** If StepUp rejects a draft written this way (server-side checks the page does in the browser, OCR linkage,
duplicate-document hashes), the remaining option is to drive the form's controls from the page. That is the original
Phase 0 spike set (`docs/EXTENSION_PLAN.md` §5) and is only started if B3 fails its live test.

Acceptance (M4): a ledger purchase with two items is filled into a draft whose totals match, the page opens at Summary
with everything populated, the person submits, and the ledger shows the reimbursement # and line numbers without any CLI.

### C. Use what StepUp already knows (M, parallel to B, read-only so low risk)

| # | Idea | Value | Notes |
|---|---|---|---|
| C1 | **Balances → awards and remaining** | stops typing awards; shows StepUp's number beside ours | `balancecheck/bulk/details` is keyed by student sequence number; needs the request body (recording) |
| C2 | **Students → children and programs** | new year setup without typing | `studentScholarship`; map to ledger children by name + sequence; never overwrite an edited child |
| C3 | **Category flags** | StepUp's own `RequiresServiceDate` etc. instead of hand-kept rules | policy change for `reference:validate`; types and details report `null`, so inherit from the category |
| C4 | **Comments → reasons** | richer "StepUp says" per item and in History | exclude internal-only comments and staff names, as `projectReimbursement` already does |
| C5 | **Pre-auth list** | show pre-authorisations | dormant; only if the owner has a use |
| C6 | **Drafts on StepUp** | list unsubmitted drafts automatically | the app already shows "unsubmitted StepUp draft" from claims; this makes it complete |

**Status (2026-10-14):** C1, C2, C3 and C6 are built and tested; C4 and C5 are not.

- **C1/C2** (`stepUpSaysPanel` on the Summary tab): students are read once on each click (person-API sign-in, a plain GET)
  and again when the dashboard loads them; balances come only when the dashboard asks for them (its request body is not
  known, so the agent does not call that endpoint itself yet). Nothing is written without a click: *Add <name>* creates a
  child, *Use $X as the award* sets that child's award. Only names, ids, sequence numbers and program names are kept;
  birth dates and school details never leave StepUp's page. Kept in `_stepup-cache/student-balances.json`.
- **C3**: StepUp's `RequiresServiceDate` on a category is learned and may **raise** this year's requirement; it never lowers
  one, so the maintainers' stricter rules stand. Types and details report `null` and inherit from the category.
- **C6** (`draftsPanel`): drafts are what StepUp's list holds with a draft/incomplete status or no submit date, with a link
  to open each in StepUp. The exact status word for a draft is not confirmed from a recording; the match is the
  CLI's (`draft|incomplete|unsubmitted`) plus "never submitted".
- **C4 not built**: it needs to be known whether a comment's `SourceEntityId` is a reimbursement or a line item, and the
  recorder's report was cut off at the level that would say. The recorder now goes two levels deeper. **C5 not built**:
  dormant, nothing would use it.

Each is a small learner in `shared/stepup/learn.ts` (pure, tested with invented payloads), an agent observer, and an app
handler. C1–C3 are the ones that remove the most manual work.

### D. Make the passive monitoring dependable (M) — **milestone M1**

- **Connection state**: the panel says connected / window closed / script out of date (a protocol version in the hello).
- **Reconnect**: closing the app tab or reloading StepUp is expected; one click recovers; queued learnings are kept.
- **Updates**: the loader fetches the current script each click (already); a running old agent says "click again to update".
- **Auto-apply policy**: lists are confirmed once per session, then applied automatically (already); make this a setting.
- **Large lists**: measure the 6 MB hand-off on slow devices; compress or send per-year if needed.
- **Observability**: the result panel shows timings (already); add a "last seen from StepUp" line to the Summary.

### E. Retire the CLI (S–M, last) — **milestone M5**

Keep: `reference:build|promote|validate` and `reference:vendors` (they commit to the repo), pointed at `_stepup-cache/`.
Remove: Playwright and its profile handling, MSAL device-code sign-in and the Azure app registration steps, `start`,
`statuses`, `inspect`, `browser`, `discover`, `plan`, `year`, `ingest`, `report`, `verify`, `backup` (all have web
equivalents), the Excel workbook write-back (decision D1), and `.cache` handling. Update `README.md`, `CLAUDE.md`
("The CLI applies each reimbursement…"), the privacy page, and `docs/PLAN.md`'s progress log.
`import-legacy` stays maintainer-only unless the owner wants a web "preview conversion" (it only downloads).

## 4. Sequencing and milestones

| M | Contents | Gate |
|---|---|---|
| **M0** | A: second recording, scrubbed shapes kept | owner records one walkthrough |
| **M1** | D: connection state, reconnect, update notice; vendors learned from `vendors/search` verified in a real session | owner confirms providers appear in `_stepup-cache` |
| **M2** | B1–B2 behind the write gate, dry-run first, then live on a throwaway draft | draft appears in StepUp, receipt attached |
| **M3** | B3–B4: items written and verified against the plan | totals match on a real receipt |
| **M4** | B5–B6: hand-off and recording of the submission | one real filing end to end |
| **M5** | C1–C3 as chosen; E: retire the CLI | owner uses it for a full filing round |

C1–C4 can be interleaved after M1 whenever B is waiting on a recording or a test.

## 5. Testing

- **Unit, with fakes** (the pattern in `packages/web/test/agent.test.ts`): every observer, learner and filing step against
  an injected host; no browser.
- **Shape fixtures**: invented payloads with the recorded field names and types; `checkStepUpShape` drift checks extended
  to every call the filing path reads.
- **Bundle smoke test** (exists): the built script is run against a pretend page.
- **Write-gate tests**: allow-list is exact; a new path fails until added deliberately; nothing matching submit passes.
- **Throwaway-draft checklist** (manual, owner present): create, fill, verify, abandon; then one real filing.
- **Dry-run first**: no live write is ever the first execution of a new step.

## 6. Risks

| Risk | Mitigation |
|---|---|
| StepUp rejects or silently mishandles API-written drafts | dry run, verify-by-readback (B4), fallback to form driving |
| StepUp changes endpoints or shapes without notice | shape checks, one table of patterns, recorder to re-learn quickly |
| A write goes to the wrong draft or student | only drafts created by this run or recorded as ours; ids shown on the page; delete never touches others |
| Token expires mid-run (60 min) | re-read from storage before each phase; stop cleanly and resume from the draft record |
| Two people filing at once | existing claims and the StepUp session lock (`SessionLock`); the app refuses to start under a foreign claim |
| Terms of use / account risk | the agent does only what the page does with the person's own sign-in, one item at a time; owner's call (D2) |
| Bookmarklet limits (starts on click, lost on reload) | resume from the draft record; an extension (§9) removes the limit without rewriting anything |
| Sensitive data in recordings | shapes only by construction; reports checked before sharing; blob addresses reduced to the kind of call |

## 7. Decisions needed from the owner

- **D1 Excel write-back**: drop it (recommended). The web already overlays `_stepup` on Excel years.
- **D2 API filing**: comfortable with the agent making the page's own draft calls instead of driving the form? It is a
  different character of automation from Playwright clicking, though it uses the same sign-in and calls.
- **D3 Which of C1–C6** to take (recommended: C1, C2, C3; C4 if reasons matter; C5/C6 later).
- **D4 Learned data location**: `_stepup-cache` in the workspace (current) vs. sent as a prefilled GitHub issue.
- **D5 Auto-apply**: keep "confirm once per session"?
- **D6 Throwaway drafts**: permission to create and delete drafts on the real account for testing.

## 8. Definition of done for "the CLI is retired"

- A filing round (several receipts, mixed children) completes using only the web app and the bookmark.
- Statuses, categories and providers stay current while StepUp is open, with a visible connection state.
- No `npm run` command is needed for day-to-day use; the maintainer reference tools are the only CLI left.
- `README.md`, `CLAUDE.md` and the privacy page describe the new reality; tests cover the write gate and shape drift.

## 9. If an extension is wanted later

Everything above is a TypeScript module with an injected host (`agent.ts`'s `AgentHost`). An extension needs a different
host (content script, `chrome.storage`, runtime messaging) and a manifest. What it adds: starts without a click, sees the
calls made before the page finished loading, survives a reload, and can keep the lock heartbeat. It adds no capability the
agent lacks for filing.
