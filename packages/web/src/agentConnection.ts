import { AGENT_PROTOCOL } from "./agent/protocol.js";

/** What the app last heard from the agent on StepUp's page. */
export interface AgentSeen {
  at: number;
  version: number;
  page: string;
  /** The agent said it is going away (the page was reloaded or closed). */
  gone?: boolean;
}

export type ConnectionState =
  /** No StepUp page has connected (or the app was reloaded and none has spoken since). */
  | { kind: "none" }
  | { kind: "connected"; page: string; seenAt: number }
  /** The StepUp page was reloaded or closed, or went quiet. The bookmark has to be clicked again there. */
  | { kind: "lost"; why: "closed" | "reloaded" | "silent"; seenAt: number }
  /** The script on StepUp's page is older than this app expects: click the bookmark again to load the latest. */
  | { kind: "outdated"; version: number; seenAt: number };

/** The agent sends "alive" every 20 s; this much silence (three missed) means the page is gone. */
export const SILENCE_MS = 65_000;

/** The one place the person's question "is StepUp connected?" is answered. Pure so it can be tested. */
export function connectionState(now: number, windowClosed: boolean, seen: AgentSeen | undefined): ConnectionState {
  if (!seen) return { kind: "none" };
  if (windowClosed) return { kind: "lost", why: "closed", seenAt: seen.at };
  if (seen.gone) return { kind: "lost", why: "reloaded", seenAt: seen.at };
  if (seen.version < AGENT_PROTOCOL) return { kind: "outdated", version: seen.version, seenAt: seen.at };
  if (now - seen.at > SILENCE_MS) return { kind: "lost", why: "silent", seenAt: seen.at };
  return { kind: "connected", page: seen.page, seenAt: seen.at };
}

/** Words for the connection panel. */
export function connectionWords(s: ConnectionState): string {
  switch (s.kind) {
    case "none":
      return "No StepUp page is connected. Click the bookmark on StepUp's Dashboard.";
    case "connected":
      return "A StepUp page is connected: while it stays open, this app learns from what you do there.";
    case "outdated":
      return "The script on StepUp's page is out of date. Click the bookmark again on StepUp to load the latest.";
    case "lost":
      return s.why === "closed"
        ? "The StepUp page was closed. Open StepUp's Dashboard and click the bookmark again."
        : s.why === "reloaded"
          ? "The StepUp page was reloaded, which ends the connection. Click the bookmark again on StepUp."
          : "Nothing has been heard from the StepUp page for a while (it may be asleep or closed). Click the bookmark again on StepUp.";
  }
}
