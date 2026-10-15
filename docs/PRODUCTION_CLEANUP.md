# Production versus debugging leftovers (for the clean-up before this is called finished)

Written 2026-10-14, at the end of the first day of live filing. The bookmarklet agent was built in the open: some of what is
in the code and the UI exists only to learn how StepUp's form behaves, and some is the real product. This lists which is
which, so the clean-up removes the first and keeps the second. Nothing here has been removed yet.

`docs/AGENT_PLAN.md` is the plan and the state of the work; this file is only the sort of what ships.

## 1. Debugging leftovers (remove, or hide behind an "advanced / for support" fold)

### The spike session: single test actions on a draft

Built to learn whether StepUp's controls accept scripted input. **Answered** (`AGENT_PLAN.md` §6 and `STEPUP_FINDINGS.md` §6):
the filing engine now does all of it. Nothing in the engine depends on these.

| Where | What | Notes |
|---|---|---|
| `packages/web/src/agent/spike.ts` | `runSpike`, the test targets, `PageOps` | Whole file. Delete |
| `packages/web/test/spike.test.ts` | Its tests | Delete with it |
| `packages/web/src/agent/dom.ts`: `pageOps` | The spike's view of the page (`count`, `value`, `setValue`, `setFiles`, `itemTotal`, `openPicker`, `pickerText`, `menuTexts`, `clickMenuItem`) | Delete the export. **Keep** the helpers it shares with `makeFilingOps`: `setValue`, `giveFile`, `toggleOf`, `menuTexts`/`clickMenu`, `totalOf`, `visible` |
| `packages/web/src/agent/dom.ts`: the `"typed"` entry method | Character-by-character typing, built as a fallback and never needed | Remove the branch in `setValue` and the `method` argument |
| `packages/web/src/agent/protocol.ts` | Messages `stepup-spike`, `stepup-spike-enable`, `stepup-spike-result` and the `SpikeTest`/`SpikeResult` imports | Remove, and **bump `AGENT_PROTOCOL`** so old scripts show "out of date" |
| `packages/web/src/stepUpBridge.ts` | The `stepup-spike-result` case in `agentMessageFrom` | Remove |
| `packages/web/src/agent/agent.ts` | `spikeOn`, `spikeBusy`, `spike()`, the `stepup-spike*` cases, `AgentHost.pageOps` | Remove |
| `packages/web/src/agent/main.ts` | `pageOps` passed to the host | Remove |
| `packages/web/src/main.ts` | The "spike session" block: `spikeOn`, `spikeResults`, `spikeForm`, `spikeFile`, `SPIKE_TARGETS`, `setSpike`, `spikePanel()`, `onSpikeField` and its two listeners, the `data-agent` cases `spike-on/off/run/copy/clear`, the case for `stepup-spike-result`, and re-sending `stepup-spike-enable` on connect | Remove |
| `packages/web/src/style.css` | The two `.spike` rules at the end | Remove |
| `packages/web/src/agent/engine.ts` | A second `PickTarget` type that duplicates the one in `spike.ts` | After removing `spike.ts`, this is the only one; nothing to do |

### Diagnostics for learning the form (keep as a support tool at most)

Useful again whenever StepUp changes its form, but they are for the maintainer and a support conversation, not for the
person filing. Move them into one folded "Diagnostics" section; do not delete without deciding that StepUp will never change.

| Where | What |
|---|---|
| Connection panel: "Map the form on this StepUp step", the recognition line and copy button | `stepup-formmap` message; `formMapReport`, `formMapRecognition()` in `main.ts` |
| `packages/web/src/agent/form.ts` | `mapForm` is **production** (the engine and `recognise` read it). Diagnostic only: `FORM_MAP_VERSION`, the per-button `build` description (`classWords`, `pseudo`, `MapOptions.pseudo`), `notices` |
| `packages/web/src/agent/dom.ts`: `pseudoText` | Only used to describe wordless buttons in a map |
| Connection panel: "Record StepUp's traffic" and "Record, keeping what I type into an item" | The recorder (`recorder.ts`, `stepup-record`, `stepup-report`, `shortReport`, `INTERESTING_CALL`, `recordingReport`, `recordingShort`). A maintainer tool for learning new calls |
| Connection panel: "Turn on" active reads | A **real option** (off by default), but a power-user setting: keep, but not beside the daily controls |

## 2. Production (keep)

| Where | What |
|---|---|
| `engine.ts`, `fill.ts`, `signatures.ts`, `form.ts` (`mapForm`, `detectStep`), `dom.ts` (`makeFilingOps`, the guard) | The filing walk and its checks |
| `agent.ts` | Handshake, heartbeat, the read allow-list, learning, the filing handler, `watchConfirmations` |
| `agentConnection.ts` and the connection wording | Connection state, several pages, "out of date", "last heard" |
| `filing.ts` and the Ready to file / Filing panels in `main.ts` | Starting a walk, progress, the result, recording (`onFilingResult`, `onFilingSubmitted`, `recordByHand`), `persistFiling`/`restoreFiling` |
| **Let Submit through** and **Stop** | The safety valve and the stop control. Keep; review the wording |
| **Already submitted in StepUp? ... Record it** | The fallback when a submission is not noticed. Keep |
| `foldState` / `menuOpen` / `bookmarkletOpen` persistence | UI fixes found during testing; production |
| Excel-year changes: `UNFILED_ECHO` in `plan.ts`, `draftOnly`/`existingDrafts`, `linkRowFiles`, the category-path fallback in `filingRow` | Real behaviour fixes |
| `READ_ONLY_KEEP` entries `[data-file-*]`, `input[id^='file-record-']`, and the legacy click handler's `fileGroup/fileStop/fileRelease/fileRecord` | Both are needed (see `CLAUDE.md`) |
| Tests: `engine.test.ts` (the pretend StepUp), `signatures.test.ts`, `fill.test.ts`, `form.test.ts`, `agent*.test.ts`, `plan.test.ts`, `filing.test.ts`, `legacyView.test.ts` | Keep. The pretend site is how the walk is tested without a browser |

## 3. Wording and presentation to review (neither debugging nor finished)

- **One mixed panel.** "Connect to StepUp (bookmark)" holds production controls (connection state, the bookmark link) beside
  debugging ones (recording, form map, spike). Split it: Connection (always), Diagnostics (folded).
- **Developer words in messages.** Stop reasons say things like "Waited too long for the next step", "matched ... partial",
  "not as expected on this step: unexpected: button ...". They are accurate and useful now; rewrite for someone who has not
  seen the code, and keep the detail behind a "details" fold.
- **Names.** The bookmark is now "Step Up Helper"; an older bookmark keeps its old name. The menu item reads "Connect to
  StepUp (bookmark)". Settle one term ("bookmark", not "bookmarklet", for people).
- **The Filing panel's progress lines** ("Filling item 1: phone case") are production, but show only the last eight; decide
  whether a finished run should keep its full log.
- **Where the first step is.** A walk starts from the student page the person opened; say so in the button's hint, or build
  the navigation (`AGENT_PLAN.md` §7.4).
- **Console and `window` globals.** `window.__stepUpHelper` and `window.__stepUpGuard` are how a re-clicked script replaces
  its predecessor; they are production, not debugging, and need a one-line comment each if not already there.

## 4. Order for the clean-up

1. Finish the live filings in `AGENT_PLAN.md` §7 items 1 to 3 first: the diagnostics are how new problems are found.
2. Remove the spike session (§1, first table) as one commit; run the tests; bump `AGENT_PROTOCOL`.
3. Fold the diagnostics into one section (§1, second table); split the panel (§3).
4. Rewrite the messages (§3); update `README.md` and the privacy page (`AGENT_PLAN.md` §7.9).
5. Only then retire the CLI (`AGENT_PLAN.md` §7.8).
