# @step-up/web

Static data-entry portal for GitHub Pages (Vite + TypeScript, no framework). Uses the browser-safe subset of
`@step-up/shared` (`@step-up/shared/web`).

`npm run dev -w @step-up/web` to run it, `npm run build -w @step-up/web` to build.

**Current slice (local mode):** the "needs your attention" queue, start a purchase from a file or from scratch,
attach a file as a receipt or as additional documentation, and the receipt workspace (receipt details entered once,
items below with child/amount/category carry-over, estimated then real tax/shipping, per-item readiness reasons).
Events are stored in this browser's localStorage; Import/Export events moves a ledger as `events.jsonl`.



**Onboarding:** sign in with Microsoft, pick a folder in the built-in navigator (your OneDrive or folders shared with you; you can create a new one), and if it has no school year yet, create one. The choice is remembered in this browser.

**Sharing:** the Share button invites someone to edit the workspace folder. They accept in OneDrive, use **Add shortcut to My files** on it (Graph's shared list is unreliable, so a shortcut or a pasted link is how the app finds it), then sign in here and pick it from My OneDrive.

**Settings:** the header's **Advanced** menu holds Import events, Export events and Disconnect. Anything that waits on OneDrive shows a labelled spinner; the caching strategy for slow Graph calls is in `docs/PLAN.md` §3.2b.

**Caching:** the last-known ledger for the open year is kept in this browser (IndexedDB) so the page appears immediately and then refreshes from OneDrive, downloading only event logs whose ETag changed. It is cleared on sign-out and Disconnect.

**Receipts:** once a folder is open, **Add receipt files** and **Take a photo** upload into the year folder and add the files to the list (identical files are skipped, name clashes get "(2)", big photos are shrunk). **Preview** shows a receipt from OneDrive (images and PDFs) without leaving the page.

**Categories:** the picker and the readiness rules use the published StepUp category tree (`public/reference/categories.json`, built by `npm run reference:build` from the CLI's category cache and checked by `npm run reference:validate` and a test). If it cannot load, every category is accepted.

**Category fixes:** a missing category, or one that needs a Service Date, is recorded for the year in the ledger (item page -> *Category missing, or needs a Service Date?*). *Advanced -> Share category fixes* downloads them as `category-edits.json`; a maintainer merges that with `npm run reference:promote -- category-edits.json`. Everything under "Testing and Assessments" requires a Service Date by default.

**Offline:** edits are written to this device (IndexedDB outbox) the moment you make them and uploaded as soon as OneDrive is reachable; anything left over from a closed tab or lost connection is recovered and uploaded on the next visit, and the header shows when you are offline. Signing out or disconnecting with unuploaded changes asks first. The site is installable (web manifest) and its own files are cached by a service worker (`public/sw.js`); Microsoft traffic is never cached.

**New year / joining:** the **New year** button creates the next school-year folder (suggesting the year after your newest) and brings over students, payment methods and the tax rate from the latest year; receipts and purchases start fresh. The first screen after sign-in offers *Set up a new workspace* or *Join a shared workspace* (shortcut steps, pasted sharing link, or a folder shared with you).

**Summary tab:** per-student award, paid / approved / pending / remaining (with a usage bar), items by status, and the submission deadline with days left. Awards and the deadline are set right on the page (stored in the year's ledger).

**Spreadsheet copy:** about a minute after you save, a values-only `<year> FES UA Tracking (mirror).xlsx` is rebuilt in the year's `_ledger/reports` folder (skipped when nothing changed; a copy open in Excel is retried later). *Advanced -> Update spreadsheet now* does it immediately and *Automatic spreadsheet* turns it off for the year. The Excel library loads only when this runs.
