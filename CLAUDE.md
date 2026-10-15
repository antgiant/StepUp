# Step Up Helper

## The Excel year mirrors the ledger view, read-only

A school year still kept in Excel (`workspace.legacy`) is drawn by the **same screens** as a ledger year
(`queueView`, `purchaseView`, `summaryView`, `statementsView`, `statementReview` in `packages/web/src/main.ts`), so layout and
styling match. It is read-only: no buttons that act, no editable fields. **One exception, decided by the owner (2026-10-14):** the
workbook writes the CLI already makes (Status, Submitted, Reimbursement ID, Line Number, Notes, Category fixes, the status
sync; see `packages/cli/src/filing/excelStore.ts`) stay allowed. Anything beyond them is discussed with the owner first.
The app's own filing (`packages/web/src/filing.ts`, `writeWorkbookRows`) writes exactly those columns, found by the row's `ID`:
Status, Submitted, Reimbursement ID, Line Number and Notes. Its controls (`[data-file-group]`, `[data-file-stop]`,
`[data-file-release]`) are on `READ_ONLY_KEEP` for that reason alone.

- Change the ledger screens and the Excel view follows. Do not build separate Excel-only screens.
- `enforceReadOnly` (`packages/web/src/readOnly.ts`) runs over the Excel view and removes every control that is not on the
  `READ_ONLY_KEEP` allow-list (navigation, preview, filter, pivot, refresh/download, and picking which file is the
  receipt when the workbook is unclear: the one deliberate exception, kept beside the workbook). Leaving the year (`#year-pick`),
  closing a notice and the StepUp bookmarklet's controls are page chrome, not data; bringing StepUp's list in writes only
  `<year>/_stepup/`, never the workbook. A new button is therefore hidden there by
  default. Only add to `READ_ONLY_KEEP` for something that merely looks at data.
- Where the Excel year needs different wording or data (statuses are Excel's own, statements are not read), branch on
  `readOnly()` inside the shared view rather than forking it.

## Which source wins

For anything StepUp holds about a filed item (status, paid/approved amounts, its message, the reimbursement's id), the order of
authority is **StepUp's own data, then the ledger, then Excel**. StepUp's list is read from `<year>/_stepup/` (see
`packages/shared/src/stepup/`). The one exception is something done here (the app or the CLI) after StepUp was last read: StepUp's
copy has not caught up, so the newer local change stands until the next read.

- Ledger years: `stepUpOverlayEvents` folds StepUp's data in as events stamped with the time the list was last read, so the
  ledger's normal latest-change-wins rule gives the exception for free. They are never written to the logs. Do not add a second
  mechanism; add the field to `stepUpItemFields` instead.
- A ledger year also shows what StepUp holds that the ledger has never heard of (as purchases and items of their own; drafts are
  left out), and an item whose amount StepUp holds differently from the ledger's is flagged Adjusted (with both amounts shown on
  the item) at any stage except a denial.
- Excel years: the StepUp enhancement in `buildLegacyImport` replaces the sheet's status, amounts and message.
- The CLI applies each reimbursement to its own school year's ledger or workbook (`packages/cli/src/yearSync.ts`). Writing StepUp's
  list into `<year>/_stepup/` is `archiveStepUpList` in `packages/shared/src/stepup/sync.ts`, shared by the CLI and the web app
  (Advanced → Bring in StepUp's list). Keep it environment-agnostic: no Node imports.
- The plan to replace the CLI is `docs/AGENT_PLAN.md` (the bookmarklet agent in `packages/web/src/agent`); what is known
  about StepUp's sign-in, calls and drafts is `docs/STEPUP_FINDINGS.md`. **Nothing may write to StepUp through its API:** the
  agent makes a short allow-list of reads only (`isAllowedOwnRead`), and filing is form autofill that replicates the CLI's
  Playwright flow. The agent may navigate the intermediate steps; it **never presses the final Submit** (legally binding) and
  blocks a person's Submit while there is clear evidence something is wrong. `docs/EXTENSION_PLAN.md` is kept for the extension option only.

## History

The History tab lists every change from every source, newest first: the ledger's (derived from its event log by
`ledgerHistory`, never stored twice), StepUp's own (`diffStepUp`, written by the CLI whenever a fresh list differs) and the
Excel workbook's (`diffExcel`, from before/after readings by the CLI's status sync). The last two are small immutable files in
`<year>/_history/`, so a refresh reads only new ones.

- Anything new that changes data (a new source, a new kind of event) must show up there: give ledger events a `label`, and put
  field names a person should see in `FIELD_NAMES` in `packages/shared/src/history/ledger.ts` (and bookkeeping in `IGNORED`).
- `_history` is skipped when looking for receipts, like `_ledger` and `_stepup`.
