# Step Up Helper

## The Excel year mirrors the ledger view, read-only

A school year still kept in Excel (`workspace.legacy`) is drawn by the **same screens** as a ledger year
(`queueView`, `purchaseView`, `summaryView`, `statementsView`, `statementReview` in `packages/web/src/main.ts`), so layout and
styling match. It is read-only: no buttons that act, no editable fields.

- Change the ledger screens and the Excel view follows. Do not build separate Excel-only screens.
- `enforceReadOnly` (`packages/web/src/readOnly.ts`) runs over the Excel view and removes every control that is not on the
  `READ_ONLY_KEEP` allow-list (navigation, preview, filter, pivot, refresh/download, and picking which file is the
  receipt when the workbook is unclear: the one deliberate exception, kept beside the workbook). A new button is therefore hidden there by
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
- The CLI applies each reimbursement to its own school year's ledger or workbook (`packages/cli/src/yearSync.ts`).
