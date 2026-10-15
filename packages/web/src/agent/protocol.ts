import type { CategoryCache, StepUpBalance, StepUpStudent, VendorEntry } from "@step-up/shared/web";

/**
 * Bumped when the agent's messages change in a way an older copy of the script (or an older open app tab) would not
 * understand. The app compares it with the version an agent reports and tells the person to click the bookmark again when
 * the script on StepUp's page is older. 2: adds the periodic "alive" and the "bye" messages.
 */
export const AGENT_PROTOCOL = 2;

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
  | { type: "stepup-recording"; report: RecordingReport };

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
  | { type: "stepup-report" };

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
