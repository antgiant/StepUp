import { describe, expect, it } from "vitest";
import { AGENT_PROTOCOL } from "../src/agent/protocol.js";
import { SILENCE_MS, chooseAgent, connectionState, type AgentEntry } from "../src/agentConnection.js";
import { agentMessageFrom, STEPUP_ORIGIN } from "../src/stepUpBridge.js";

const seen = (over: Partial<{ at: number; version: number; page: string; gone: boolean }> = {}) => ({ at: 1000, version: AGENT_PROTOCOL, page: "apply/Dashboard", ...over });

describe("what the connection panel says", () => {
  it("is none until something is heard", () => {
    expect(connectionState(5000, false, undefined).kind).toBe("none");
  });
  it("is connected while the agent keeps being heard", () => {
    expect(connectionState(1000 + SILENCE_MS, false, seen()).kind).toBe("connected");
  });
  it("is lost when the window is closed, the page said goodbye, or it went quiet", () => {
    expect(connectionState(2000, true, seen())).toMatchObject({ kind: "lost", why: "closed" });
    expect(connectionState(2000, false, seen({ gone: true }))).toMatchObject({ kind: "lost", why: "reloaded" });
    expect(connectionState(1000 + SILENCE_MS + 1, false, seen())).toMatchObject({ kind: "lost", why: "silent" });
  });
  it("says the script is out of date when its version is older", () => {
    expect(connectionState(2000, false, seen({ version: AGENT_PROTOCOL - 1 })).kind).toBe("outdated");
  });
});

describe("the new messages from the agent", () => {
  it("accepts alive and bye only from StepUp", () => {
    expect(agentMessageFrom(STEPUP_ORIGIN, { type: "stepup-alive", version: 2, page: "p" })).toEqual({ type: "stepup-alive", version: 2, page: "p" });
    expect(agentMessageFrom(STEPUP_ORIGIN, { type: "stepup-bye" })).toEqual({ type: "stepup-bye" });
    expect(agentMessageFrom("https://evil.example", { type: "stepup-alive", version: 2, page: "p" })).toBeUndefined();
  });
});

describe("which of several StepUp pages the app talks to", () => {
  const entry = (over: Partial<AgentEntry["seen"]> & { helloAt?: number; closed?: boolean } = {}): AgentEntry => ({
    seen: { at: 1000, version: AGENT_PROTOCOL, page: "p", ...(over.gone ? { gone: true } : {}), ...(over.version !== undefined ? { version: over.version } : {}), ...(over.at !== undefined ? { at: over.at } : {}) },
    helloAt: over.helloAt ?? 0,
    closed: over.closed ?? false,
    origin: "https://apply.example",
  });

  it("prefers a page with the current script over an older one, whichever spoke last", () => {
    const m = new Map<string, AgentEntry>([["old", entry({ version: AGENT_PROTOCOL - 1, at: 1500, helloAt: 900 })], ["new", entry({ at: 1000, helloAt: 800 })]]);
    expect(chooseAgent(m, 2000)).toBe("new");
  });
  it("among equal pages takes the one whose bookmark was clicked last", () => {
    const m = new Map<string, AgentEntry>([["a", entry({ helloAt: 100 })], ["b", entry({ helloAt: 200 })]]);
    expect(chooseAgent(m, 2000)).toBe("b");
  });
  it("skips closed, gone and silent pages, and still names one when none is alive", () => {
    const m = new Map<string, AgentEntry>([["closed", entry({ closed: true, at: 1900 })], ["quiet", entry({ at: 1 })]]);
    expect(chooseAgent(m, 1000 + SILENCE_MS * 2)).toBe("closed");
    expect(chooseAgent(new Map(), 0)).toBeUndefined();
  });
});
