# Step Up Automator — Outstanding Items

## Next step

- [ ] Run the **end-to-end test on one real group**.

## To verify during/after the end-to-end test

- [ ] Confirm the **student-dropdown option click** in `selectStudent()` (`src/form/reimbursementFlow.ts`) actually lands correctly — marked `UNVERIFIED` in code, since we only ever saw that dropdown closed during discovery.
- [ ] Confirm the **category cascading-dropdown option clicks** in `fillCategory()` (same file) actually land correctly — same reason, marked `UNVERIFIED`.
- [ ] Confirm the **vendor/provider dropdown option click** (and the "Provider not Listed" fallback path) in `selectVendorOrProvider()` actually lands correctly — same reason, marked `UNVERIFIED`.
- [ ] Verify whether on-screen **line-item order actually matches the `-1`/`-2`/`-3` `LineItemNumber` suffix order** for a real multi-item submission. `main.ts` currently assumes it does when writing the `Line Number` column back to the spreadsheet — left open since the test draft (Child A, sequence `NNNNNNNN`) couldn't be finished last time.
- [ ] Confirm `statusSync.ts` actually updates `Status` correctly now that 59 rows have real `Reimbursement ID` + `Line Number` data to match against (the underlying write mechanism is confirmed working, but this module's own matching logic hasn't been exercised against a real row yet — none of those 59 rows' current `Status` should actually need changing since they're already `"Submitted"`, so watch for correct no-ops, not necessarily updates).
- [ ] Confirm `categorySync.ts`'s request-interception rewrite (`route.fetch()` piggybacking on real Category/Type clicks) actually fires and populates Table5 during a real session.
- [ ] Confirm `clickContinue()` (`src/form/reimbursementFlow.ts`) actually lands on the real Continue button after the main receipt upload — brand new, `UNVERIFIED`, uses a text/role locator since this flow's buttons have no stable IDs.
- [ ] Confirm `waitForScanProcessing()` correctly detects when StepUp's AI scan finishes (item blocks rendered, or "not detected" message) rather than timing out or firing too early.

## Blocked (not this session)

- [ ] Build **Pre-Auth submission automation** — blocked, not abandoned. Confirmed a real (if not currently urgent) need; genuinely separate flow from reimbursements, not a tweak to the existing one:
  - Its own wizard: Student Selection → Item/Service Details → Educational Benefit → Summary (no receipt upload step).
  - Distinct fields discovered so far: `itemDetails__category`, Quantity, Cost, a documentation file upload, `LearningEnhancementText`, a provider dropdown + `OtherServiceProviderName` fallback, `affirmationCheckbox`, typed `SignatureName` e-signature. The real API also reveals `LearningSubjectAreas` (array) and `CourseDescription` fields we never saw on the actual form — that page likely has more fields than we captured.
  - Several of this flow's buttons have **stable, semantic IDs** (`studentSelectContinueButton`, `continue-btn`, `itemDetails__category`) unlike the reimbursement flow's random-UUID buttons — good.
  - `/api/preauthorization/search` fires automatically on the **home page** (convenient, no special navigation needed) and on a dedicated Pre-Authorizations list page. Real data captured from the latter: each result has one `LineItem` (not an array — Pre-Auth requests are always single-item), and a `ReimbursementId`/`ReimbursementSequenceNumber`/`IsReimbursement` linkage showing how an approved Pre-Auth connects to its eventual reimbursement — that's the mechanism behind Table1's `Pre-Auth #` column.
  - **Blocked on**: the Summary/Submit step and confirmation screen — can't get either without an actual future Pre-Auth need or you pushing a real one through (requires a genuine e-signature, which you don't want to do just for test data). Revisit when either happens.
- [ ] Excel dependent-dropdown validation (Category list filtered by Scholarship) — parked. No automatable approach exists: Data Validation rejects structured/array formulas outright, and Power Query's refresh can't be triggered via Graph API. Zero practical effect today anyway since every child has the same single scholarship. Revisit only if a second scholarship shows up (try a relative-named-range formula then).
