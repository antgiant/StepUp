import type { FormMap } from "./form.js";
import type { FilingJob, FilingOutcome } from "./engine.js";
import type { SpikeResult, SpikeTest } from "./spike.js";
import type { CategoryCache, StepUpBalance, StepUpStudent, VendorEntry } from "@step-up/shared/web";

/**
 * Bumped when the agent's messages change in a way an older copy of the script (or an older open app tab) would not
 * understand. The app compares it with the version an agent reports and tells the person to click the bookmark again when
 * the script on StepUp's page is older. 2: adds the periodic "alive" and the "bye" messages. 3: adds the form map. 4: adds the spike tests. 5: adds filing (a job in, progress and an outcome back). 6: adds the person's answer when a category cannot be matched (need-pick and pick).
 */
export const AGENT_PROTOCOL = 6;

/** Messages between the agent (running on StepUp's page) and this app, over `postMessage`. Both sides check the origin. */
export type AgentToApp =
  | { type: "stepup-hello"; version: number }
  /** Sent every so often while the agent is connected: it is how the app tells a live StepUp page from a closed or reloaded one. */
  | { type: "stepup-alive"; version: number; page: string }
  /** The StepUp page is being closed or reloaded; the agent goes with it. */
  | { type: "stepup-bye" }
  | { type: "stepup-list"; results: unknown[] }
  | { type: "stepup-learned"; kind: "categories"; cache: CategoryCache }
  | { type: "stepup-learned"; kind: "vendors"; entries: VendorEntry[] }
  | { type: "stepup-learned"; kind: "students"; students: StepUpStudent[] }
  | { type: "stepup-learned"; kind: "balances"; balances: Record<string, StepUpBalance[]> }
  | { type: "stepup-recording"; report: RecordingReport }
  /** The map of the controls on the page's current wizard step: names and types, never values. */
  | { type: "stepup-formmap"; map: FormMap }
  /** The outcome of one spike test (see spike.ts). */
  | { type: "stepup-spike-result"; result: SpikeResult }
  /** One line of what the filing walk is doing. */
  | { type: "stepup-file-progress"; line: string }
  /** How a filing walk ended: at the Summary ready for a person to submit, or stopped with the reason. */
  | { type: "stepup-file-result"; outcome: FilingOutcome }
  /** The walk is paused: a category entry matched nothing, so the person picks it in StepUp's open list and answers. */
  | { type: "stepup-file-need-pick"; message: string }
  /** The person submitted: StepUp's confirmation page named the reimbursement. */
  | { type: "stepup-file-submitted"; number: string; guid?: string };

export type AppToAgent =
  | { type: "stepup-ready" }
  /** What the workspace already knows, so the agent builds on it and keeps to the once-a-day expansion. */
  | { type: "stepup-cache"; categories: CategoryCache }
  /** Ask the agent to read the student list again now (only when active reads are on). */
  | { type: "stepup-refresh-students" }
  /**
   * What the agent may do on its own. Off by default: with it off the agent makes exactly one request of its own (the list a
   * click asks for) and otherwise only watches what StepUp's page itself loads.
   */
  | { type: "stepup-settings"; activeReads: boolean }
  | { type: "stepup-record"; on: boolean; /** Also keep the values typed into items; only when the person is entering made-up ones. */ values?: boolean }
  | { type: "stepup-report" }
  /** Ask for the map of the step StepUp's page is on. Read-only: nothing on the page is touched. */
  | { type: "stepup-formmap" }
  /** Spike tools on or off. Off unless a person turns them on, and never remembered across a reload. */
  | { type: "stepup-spike-enable"; on: boolean }
  /** One spike test, from a person's click. Ignored unless spike tools are on. */
  | { type: "stepup-spike"; test: SpikeTest }
  /** Walk one group's reimbursement through StepUp's form, from the page that is open. From a person's click only. */
  | { type: "stepup-file"; job: FilingJob }
  | { type: "stepup-file-stop" }
  /** The person's answer to a "need-pick": they picked the entry in StepUp's list, or the row is to be skipped. */
  | { type: "stepup-file-pick"; answer: "picked" | "skip" }
  /** A person lets a held Submit through on purpose. */
  | { type: "stepup-release-submit" };

/** The shapes (never values) of the calls StepUp's page made while recording: enough to build the next feature from. */
export interface RecordingReport {
  on: boolean;
  /** True when the values typed into items were kept as well (made-up ones, by the person's choice). */
  values?: boolean;
  startedAt?: string;
  loads: Array<{ at: string; page: string }>;
  pages: string[];
  calls: Record<string, { n: number; via: string[]; status: number[]; ms?: number; kb?: number; req?: string; res?: string; headers?: string[]; bytes?: number; samples?: Record<string, string | number | boolean | null>; origins?: Record<string, string>; /** Other request shapes seen for the same call (for example a save with an item). */ reqVariants?: Array<{ req: string; origins?: Record<string, string>; samples?: Record<string, string | number | boolean | null> }>; resVariants?: Array<{ res: string; samples?: Record<string, string | number | boolean | null> }> }>;
}
