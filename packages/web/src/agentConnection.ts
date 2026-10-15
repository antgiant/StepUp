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

/** One StepUp page that has spoken to this app. Several can: a second tab, or an older script that is still running. */
export interface AgentEntry {
  origin: string;
  seen: AgentSeen;
  /** When the bookmark was last clicked there (its hello). */
  helloAt: number;
  closed: boolean;
}

/** Whether rank `a` beats rank `b`, comparing the first number that differs. */
const later = (a: number[], b: number[]): boolean => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return (a[i] ?? 0) > (b[i] ?? 0);
  return false;
};

/**
 * Which connected page the app talks to. A page that is alive and not out of date wins; among those, the one whose
 * bookmark was clicked last. Without any alive page, the most recently heard one is shown (so the person is told why).
 */
export function chooseAgent<K>(entries: Map<K, AgentEntry>, now: number): K | undefined {
  let best: { key: K; rank: number[] } | undefined;
  for (const [key, e] of entries) {
    const alive = !e.closed && !e.seen.gone && now - e.seen.at <= SILENCE_MS;
    const current = e.seen.version >= AGENT_PROTOCOL;
    const rank = [alive ? 1 : 0, alive && current ? 1 : 0, alive ? e.seen.version : 0, e.helloAt, e.seen.at];
    if (!best || later(rank, best.rank)) best = { key, rank };
  }
  return best?.key;
}

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
