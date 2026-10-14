import type { CategoryCache, StepUpBalance, StepUpStudent, VendorEntry } from "@step-up/shared/web";

/** Messages between the agent (running on StepUp's page) and this app, over `postMessage`. Both sides check the origin. */
export type AgentToApp =
  | { type: "stepup-hello"; version: number }
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
  /** Ask the agent to read the student list again now (it does this on every click as well). */
  | { type: "stepup-refresh-students" }
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
  calls: Record<string, { n: number; via: string[]; status: number[]; ms?: number; kb?: number; req?: string; res?: string; headers?: string[]; bytes?: number; samples?: Record<string, string | number | boolean | null>; origins?: Record<string, string> }>;
}
