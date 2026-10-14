# What is known about StepUp's site (verified from real sessions, October 2026)

Reference for `docs/AGENT_PLAN.md`. Everything here was observed from StepUp's own pages in a real, signed-in session, as
**shapes and traced origins, never personal values**. Words in quotes are settings StepUp uses. Nothing in this file may
contain a real name, id, amount, file name or token (public repo).

**How this is used.** The agent only *reads* (see the plan's principles). The write-side facts below (how a draft is saved)
are kept to **recognise and verify** what StepUp's own form does, never to write it ourselves. StepUp changes its site
every few weeks to months: treat every entry as "true when recorded" and re-check with the recorder.

## 1. The site

- A Blazor WebAssembly single-page app (Radzen controls) at `apply.stepupforstudents.org`. Whole wizard flows happen with
  **one page load**; soft navigation only. No Content-Security-Policy on the pages or scripts. All calls go through `fetch`.
- Several back-end APIs, each on its own host, each with its own sign-in scope: reimbursement, provider, person, financial,
  infrastructure, application, comment. Their scopes and base URLs are public in the site's own `appsettings.json`.
- **CORS:** the APIs answer only `https://apply.stepupforstudents.org`; any other origin is refused. So anything that talks
  to StepUp must run inside StepUp's page (bookmarklet/extension/CLI browser).

## 2. Sign-in

- MSAL.js v2 against Azure AD B2C (user flow `b2c_1a_signupsignin`), authorization code + PKCE.
- Tokens are in the tab's **`sessionStorage`**, MSAL v2 layout: one `credentialType: "AccessToken"` entry per API (`target`
  ends `<api guid>/access_as_user`, `secret` a plaintext JWT, **60-minute** life), plus an ID token and a ~24 h refresh token.
- **Never read or use the refresh token** (B2C may rotate it and sign the page out).
- The person's id is the access token's **`scholar_personId` claim**; it is the `GuardianId` the list request filters on.
  A missing id gives 500, another value 401 (it is checked server-side).
- Reimbursement-API scope `5bd9fe13-76ed-4dbb-b8c3-7811dbf16276`, provider `429e3036-53d2-4215-a413-05b7ced0fa9d`, person
  `cb885232-83b3-49bc-99cb-55d5b14c52ae`, comment `1a7dc840-32bb-4be5-9f43-cbd9d470e9e2` (all `/access_as_user`).

## 3. Calls worth knowing (all JSON; searches share one envelope)

The standard **search envelope**: `{ ApplyDefaultFilters: true, ContextBag: {}, CurrentPage: null, Filters: {...},
IncludeGlobalSearchTotal: false, Keywords: null, MultiOrderBy: {}, OrderBy: null, PageSize: null, SkipCount: false,
SortOrder: 0 }`. Only `Filters` differs between calls. Responses repeat it under `Info` with `Results`.

| Call | Notes |
|---|---|
| `POST reimbursementapi …/api/reimbursements/V2/search` | The list: every reimbursement of every school year in one response (~6 MB, ~4 s). `Filters: { GuardianId, ExcludedStatuses: ["Canceled"] }`. A draft's status word is **`Draft`** |
| `GET personapi …/api/guardian/{guardianId}/studentScholarship/` (and `/Funded`) | Students: `id`, `sequenceNumber`, `firstName`, `lastName`, `isActive`, `scholarships[]` (`programName`, `programYear`, `status` e.g. `"Funded"`, **`awardAmount`, `fundedAmount`**, `internalProgramId`, `programId` number), `renewalPrograms[]`. Also carries a birth date and other personal fields: never forward them |
| `POST infrastructureapi …/api/balancecheck/bulk/details` | Request `{ "<student sequence number>": ["<internal program id>", …] }` (keys and ids come from the list); response per student `[{ ProgramAlias, ProgramType, Funding, Spending, Reserved, Available, Adjustments }]` |
| `POST reimbursementapi …/api/categories/search` | `Filters: { IsActive: true }`; top-level categories with `Types[]` ids, `ApprovedPrograms[]` (`PartnerId`, `ProgramType`), and flags `RequiresServiceDate`, `RequiresVendor`, `RequiresServiceProvider`, `RequiresDocumentation`, `RequiresAdditionalInfo`, `IsTaxable`, `DoeCode` |
| `POST …/api/categories/typesbyids`, `…/detailsbyids` | Body: a plain JSON array of ids (batches of ≤ 50 are fine). Lower-case response fields; `requiresServiceDate` is `null` on types/details (inherit from the category) |
| `POST providerapi …/api/vendors/search` | The full provider list (≈ 56): `Id`, `Name`, `DBAName`, `ProviderCode`. `Filters: {}` |
| `POST providerapi …/api/businesssummary/getbusinesssummarydropdown` | The "Who did you pay?" dropdown: 20 at a time, `Filters: { ProgramType: "FESUA" }`, results `{ BusinessProfileId, DBAName, Id }` |
| `POST commentapi …/api/comments/search` | `Filters: { InternalOnly: false, SourceEntityId: <guardian id> }`: every external comment (`ReasonCode`, `ReasonDescription`, `CommentText`, `CommentType: "External"`, `ParentRecordSequenceNumber` = the reimbursement number). **`SourceEntityName` is the guardian's own name: never sample it** |
| `POST infrastructureapi …/api/notifications/in-app/search` | In-app notifications (50 per page) |
| SignalR hub at `infrastructureapi …/negotiate` | Pushes notifications; a possible later source of status changes |

## 4. How a reimbursement is made (recognise and verify only: the agent does not do this)

- **Create** `POST …/reimbursements/v2`: the whole reimbursement object, ~1.4 KB. The page chooses the draft's `Id` (a
  GUID). Guardian and student ids/sequence numbers and the program id come from earlier responses (the list, the student
  list, the student's scholarship `internalProgramId`). Fixed words: `externalStatus`/`internalStatus` `"Draft"`,
  `displayInternalStatus` `null`, `submitDate` `"0001-01-01T00:00:00"`, `schoolYear` `null`, `programType` `0`,
  `PartitionVersion` `0`, `lineItems` and `receipts` `[]`. The server replies with `sequenceNumber` (the reimbursement
  number), `schoolYear`, `programType` as text (`"FESUA"`).
- **Save** `PUT …/reimbursements/v2/{id}`: the whole object every time (each step change, receipt added, item added);
  `programType` is the number `24` on a save. `GET …/reimbursements/v2/{id}` is polled while the receipt scan runs
  (`ocrFormatted`, `ocrTimeToProcessInSeconds` fill in).
- **Receipt**: `POST …/documents-sasuri` (`ReimbursementDocuments.ReceiptDocuments[]` with a page-made `Id`,
  `sourceFileName`, `ShouldUpload: true`, `EntityId`/`ReimbursementId` = the draft's id) returns an upload address
  (`blobSasUri`); the file goes to it with an Azure `PUT` (`x-ms-blob-type`, 201) through `fetch`; the save then registers it
  (`receipts[]` with `fileType: "data:application/pdf;base64,"`, a data-URI prefix). `POST …/sasuri { GeneratedFileName }`
  returns a read address for the preview.
- **Item** (inside `lineItems`), observed with made-up values: **`itemAmount` = `Quantity` × `CostPerItem` +
  `AdditionalCosts`** (2 × 10.00 + 5.00 = 25.00); `taxPercent` `0`; "Tax, shipping, etc." is `AdditionalCosts`;
  `purchaseDate` `"YYYY-MM-DDT00:00:00"` (no zone); any unset date `"0001-01-01T00:00:00"` (also `PurchaseMin/MaxDate`,
  `ServiceMin/MaxDate`, `assignedDate`, `paymentDate`); `invoiceDate` `null`; `vendorCode` = the provider's `ProviderCode`,
  `vendorName` its `Name`; service-provider fields `null` unless the category needs a person; `lineItemNumber`
  `<reimbursement number>-<line>`; `doeCode` repeated from the category; item statuses `"Draft"`; `receiptId` = the receipt's
  `Id`. A few fields are PascalCase in StepUp's model (`AdditionalCosts, CostPerItem, EvaluationFields, Id, ItemUrl,
  MatchedItemName, PartitionVersion, PreAuthSequenceNumber, PurchaseMax/MinDate, Quantity, ServiceMax/MinDate,
  ServiceProviderPersonIdString`); the rest camelCase.
- **Abandon** `DELETE …/reimbursements/V2/{id}` with the whole object as its body.
- **Submit**: never exercised (by design); its call is unknown.

## 5. Not yet known

- How a **service provider** (a person) is written, and what `ServiceProviderPersonIdString` holds.
- Whether the page makes up an item's `Id` itself (it does for drafts and receipts).
- The **submit** call and anything that happens after it.
- Anything about the form's **DOM** (labels, ids, placeholders, which controls accept scripted input): the CLI's
  `packages/cli/src/form/reimbursementFlow.ts` encodes selectors known when it was written (`#Student__Select`,
  `ul.dropdown-menu.show`, `#inputDrop__`, `[placeholder="Enter Quantity"]`, random per-session button ids found by text,
  repeated ids across item blocks), but they have not been re-verified. This is what the planned **form map** is for.
