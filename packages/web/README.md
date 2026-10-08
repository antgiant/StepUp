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

**Statements tab:** mark a file as a statement (list page -> *Mark as statement*), then *Read statement*: the PDF's text is read on this device (pdf.js, loaded only then), charges are parsed and matched to purchases at the order level, and confident matches are linked as payment proof automatically. Each charge shows its linked purchase (with Undo) or the best candidates to confirm with one tap; confirming a match whose vendor name looks different teaches the app that name for the rest of the year. After every save, new purchases are matched against statements already read. Scanned PDFs and photos are read with OCR.

**Redacted proof:** on a statement's page, *Make redacted copy* builds, on this device, an image-only PDF in which everything is black except the issuer name, the statement period, the column headings and the charges already linked to purchases (account numbers, balances, interest, rewards, payments and every other charge are blacked out, and anything unrecognised is blacked out too). Pixels outside the kept boxes are never copied, so they cannot be recovered. You check every page before saving; the saved copy (`... (redacted).pdf`, next to the original) is what the submission plan sends instead of the statement, and statements without one are flagged.

**OCR (reading scans and photos):** text that is not in a PDF's text layer is read on this device with Tesseract (the engine, its WebAssembly core and English data are served from this site under `/ocr/`, never from a CDN, and download only the first time they are needed, about 7 MB). It is used for scanned/photographed statements and receipts. OCR rows are flagged *check this row*. On a purchase, **Read receipt** fills only blank fields (vendor, date, invoice #, total, tax/shipping) and records whether the receipt itself shows payment (a zero balance, "paid", or a card line), which counts as proof of payment.

**Being filed right now:** when someone is filing items from the command line, the list page shows a banner ("Alice is filing Amazon, 2026-10-01, $54.28", with the time it started), the purchase page says so and shows each item as *Being filed by Alice*, the Summary notes how many items are mid-filing, and the page re-checks every minute while anything is active (or press *Refresh*). A purchase with an unsubmitted StepUp draft says so, with its reimbursement number and the last step reached. Item statuses now read as they are (Ready to file, Submitted, Paid, ...) rather than just Ready.

**More receipt tools:** *Shrink to under 5 MB* makes a smaller copy of an oversized receipt (PDFs are re-drawn as images, photos re-encoded) and switches the purchase to it, keeping the original. *Scan a receipt (several pages)* takes one photo per page, warns about blurry ones, lets you rotate/reorder/remove pages, and saves one PDF. Files dropped in the year's `_ledger/inbox` folder are picked up by *Check for new files*; a saved email (`.eml`) can be read like a receipt (**Read receipt**) and *Save its attachments* files its PDFs/photos. *Give the file a readable name* renames the OneDrive file to `2026-09-17 Amazon 54.28 a1b2c3.pdf`.

**More statement tools:** refunds on a statement are matched to the purchase they belong to (a full refund stops that purchase being filed); several charges that add up to one purchase (an order shipped in parts) can be linked together; a redacted copy can keep only the pages with linked charges, or only one purchase's charges; and the finished copy is read again with OCR to confirm the kept charges are legible and nothing else (other amounts, account numbers) is.

**Category list per year:** each year freezes its own copy of the published category list the first time it is opened (`_ledger/reference.snapshot.json`), so old years never change underneath you. When a newer list is published, Advanced shows *Update category list (N new, M changed)*; updating keeps entries the old list had (inactive) so nothing already used breaks. *Share them on GitHub* opens a prefilled issue with your category fixes.

**Other:** files chosen while offline are kept on this device and uploaded when the connection returns; downloaded receipts are kept on this device for fast re-opening (cleared on sign-out); the list page says what other people and the command line did since you were last here; a warning appears if this device's clock is off from OneDrive's or if the ledger contains changes from a newer version of the app. To read scans in another language, build with e.g. `OCR_LANGS=eng,spa` after `npm i -w @step-up/web @tesseract.js-data/spa`; Advanced then offers a language choice.
