import type { Ledger } from "../events/ledger.js";
import type { RulesContext } from "../rules/readiness.js";
import { openLedgerFolders } from "../workspace/workspace.js";
import { buildMirror } from "./build.js";
import { publishMirror } from "./publish.js";

export const mirrorFileName = (yearLabel: string) => `${yearLabel} FES UA Tracking (mirror).xlsx`;

export interface YearMirrorOptions {
  ledger: Ledger;
  ctx: RulesContext;
  driveId: string;
  yearFolderId: string;
  yearLabel: string;
  /** Known reports folder id, to save a lookup. */
  reportsId?: string;
  appVersion: string;
}

/**
 * Rebuilds a year's mirror spreadsheet from its ledger and writes it to the reports folder (skipped when nothing changed
 * since the last write; a copy open in Excel is "locked", never an error). The one routine the web app and the CLI share,
 * so both produce the same file. Returns "off" when the year has the mirror switched off.
 */
export async function publishYearMirror(o: YearMirrorOptions): Promise<{ status: "written" | "unchanged" | "locked" | "off"; reportsId?: string }> {
  if (o.ledger.state.settings["year"]?.mirror === false) return { status: "off" };
  let reportsId = o.reportsId;
  if (!reportsId) {
    const folders = await openLedgerFolders(o.driveId, o.yearFolderId);
    if (!folders) throw new Error("This year has no ledger folders yet.");
    reportsId = folders.reportsId;
  }
  const model = buildMirror(o.ledger.state, o.ctx, { generatedAt: new Date().toISOString(), appVersion: o.appVersion });
  const { status } = await publishMirror(o.driveId, reportsId, mirrorFileName(o.yearLabel), model);
  return { status, reportsId };
}
