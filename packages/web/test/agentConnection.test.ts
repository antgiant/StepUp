import { describe, expect, it } from "vitest";
import { AGENT_PROTOCOL } from "../src/agent/protocol.js";
import { SILENCE_MS, connectionState } from "../src/agentConnection.js";
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
