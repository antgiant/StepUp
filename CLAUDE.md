# Step Up Helper

## The Excel year mirrors the ledger view, read-only

A school year still kept in Excel (`workspace.legacy`) is drawn by the **same screens** as a ledger year
(`queueView`, `purchaseView`, `summaryView`, `statementsView`, `statementReview` in `packages/web/src/main.ts`), so layout and
styling match. It is read-only: no buttons that act, no editable fields.

- Change the ledger screens and the Excel view follows. Do not build separate Excel-only screens.
- `enforceReadOnly` (`packages/web/src/readOnly.ts`) runs over the Excel view and removes every control that is not on the
  `READ_ONLY_KEEP` allow-list (navigation, preview, filter, pivot, refresh/download). A new button is therefore hidden there by
  default. Only add to `READ_ONLY_KEEP` for something that merely looks at data.
- Where the Excel year needs different wording or data (statuses are Excel's own, statements are not read), branch on
  `readOnly()` inside the shared view rather than forking it.
