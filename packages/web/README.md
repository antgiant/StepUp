# @step-up/web

Static data-entry portal for GitHub Pages (Vite + TypeScript, no framework). Uses the browser-safe subset of
`@step-up/shared` (`@step-up/shared/web`).

`npm run dev -w @step-up/web` to run it, `npm run build -w @step-up/web` to build.

**Current slice (local mode):** the "needs your attention" queue, start a purchase from a file or from scratch,
attach a file as a receipt or as additional documentation, and the receipt workspace (receipt details entered once,
items below with child/amount/category carry-over, estimated then real tax/shipping, per-item readiness reasons).
Events are stored in this browser's localStorage; Import/Export events moves a ledger as `events.jsonl`.

**Not yet:** shared category reference
data (every category is currently accepted), offline queue / PWA, join and new-year screens.

**Onboarding:** sign in with Microsoft, pick a folder in the built-in navigator (your OneDrive or folders shared with you; you can create a new one), and if it has no school year yet, create one. The choice is remembered in this browser.

**Sharing:** the Share button invites someone to edit the workspace folder. They accept in OneDrive, use **Add shortcut to My files** on it (Graph's shared list is unreliable, so a shortcut or a pasted link is how the app finds it), then sign in here and pick it from My OneDrive.

**Settings:** the header's **Advanced** menu holds Import events, Export events and Disconnect. Anything that waits on OneDrive shows a labelled spinner; the caching strategy for slow Graph calls is in `docs/PLAN.md` §3.2b.

**Caching:** the last-known ledger for the open year is kept in this browser (IndexedDB) so the page appears immediately and then refreshes from OneDrive, downloading only event logs whose ETag changed. It is cleared on sign-out and Disconnect.

**Receipts:** once a folder is open, **Add receipt files** and **Take a photo** upload into the year folder and add the files to the list (identical files are skipped, name clashes get "(2)", big photos are shrunk). **Preview** shows a receipt from OneDrive (images and PDFs) without leaving the page.
