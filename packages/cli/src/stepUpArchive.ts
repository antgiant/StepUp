import { archiveStepUpList, listYears, type StepUpTarget, type YearInfo, type StorageProvider } from "@step-up/shared";
import { locateWorkspace } from "./storage/index.js";

/**
 * Keeps StepUp's list of reimbursements with the year each belongs to. The work is `archiveStepUpList` in
 * shared/stepup/sync.ts (the web app and the future extension call the same function); this adds the command line's
 * one-workspace-per-run cache and its best-effort, log-and-carry-on behaviour.
 */
export interface Workspace { storage: StorageProvider; driveId: string; rootId: string; years: Map<string, YearInfo> }
let workspace: Promise<Workspace> | undefined;

async function open(): Promise<Workspace> {
  const { storage, driveId, rootId } = await locateWorkspace();
  return { storage, driveId, rootId, years: new Map((await listYears(storage, driveId, rootId)).map((y) => [y.label, y])) };
}

/** The workspace and its year folders as of this run (listed once). */
export async function workspaceYears(): Promise<Workspace> {
  workspace ??= open();
  return workspace;
}

/** Applies a fresh copy of the list (see `archiveStepUpList`). Best effort: a failure is reported, never fatal. */
export async function archiveSearchResults(results: unknown[]): Promise<void> {
  try {
    if (results.length === 0 || process.argv.includes("--dry-run")) return;
    const ws: StepUpTarget = await workspaceYears();
    await archiveStepUpList(ws, results, (line) => console.log(`[archive] ${line}`));
  } catch (err) {
    console.log(`[archive] Could not keep the full list: ${(err as Error).message}`);
  }
}
