import { describe, expect, it } from "vitest";
import { BOOKMARKLET_FILE, STEPUP_ORIGIN, agentMessageFrom, isStepUpHello, loaderCode, loaderHref, stepUpListFrom } from "../src/stepUpBridge.js";

const APP = "https://app.example";

describe("the loader", () => {
  it("the loader adds the app's current script to the page, and says so if it cannot load", () => {
    const added: Array<{ src: string; onerror?: () => void }> = [];
    const alerts: string[] = [];
    const document = {
      createElement: () => ({ src: "" } as { src: string; onerror?: () => void }),
      head: { appendChild: (el: { src: string; onerror?: () => void }) => added.push(el) },
    };
    new Function("document", "alert", `return ${loaderCode(`${APP}/sub/`)}`)(document, (m: string) => alerts.push(m));
    expect(added).toHaveLength(1);
    expect(added[0]!.src).toMatch(new RegExp(`^${APP}/sub/${BOOKMARKLET_FILE.replace(".", "\\.")}\\?v=\\d+$`));
    added[0]!.onerror?.();
    expect(alerts[0]).toMatch(/could not be loaded/);
  });

  it("is a javascript: link that decodes back to the same source, and stays small", () => {
    const href = loaderHref(APP + "/");
    expect(href.startsWith("javascript:")).toBe(true);
    expect(decodeURIComponent(href.slice("javascript:".length))).toBe(loaderCode(APP + "/"));
    expect(loaderCode("https://stepup.example/").length).toBeLessThan(500);
  });
});

describe("receiving", () => {
  it("accepts only known agent messages from StepUp's page", () => {
    expect(agentMessageFrom(STEPUP_ORIGIN, { type: "stepup-hello", version: 1 })).toEqual({ type: "stepup-hello", version: 1 });
    expect(agentMessageFrom("https://evil.example", { type: "stepup-hello", version: 1 })).toBeUndefined();
    expect(agentMessageFrom(STEPUP_ORIGIN, { type: "stepup-learned", kind: "vendors", entries: [{ id: "a", name: "A", businessProfileId: "b" }, { nope: 1 }, null] })).toEqual({
      type: "stepup-learned", kind: "vendors", entries: [{ id: "a", name: "A", businessProfileId: "b" }],
    });
    expect(agentMessageFrom(STEPUP_ORIGIN, { type: "stepup-learned", kind: "categories", cache: 5 })).toBeUndefined();
    expect(agentMessageFrom(STEPUP_ORIGIN, { type: "run-something", code: "alert(1)" })).toBeUndefined();
    expect(agentMessageFrom(STEPUP_ORIGIN, null)).toBeUndefined();
  });

  it("accepts the list only from StepUp's page, in the right shape", () => {
    const msg = { type: "stepup-list", results: [{ Id: "a" }] };
    expect(stepUpListFrom(STEPUP_ORIGIN, msg)).toHaveLength(1);
    expect(stepUpListFrom("https://evil.example", msg)).toBeUndefined();
    expect(stepUpListFrom(STEPUP_ORIGIN, { type: "stepup-list", results: [] })).toBeUndefined();
    expect(stepUpListFrom(STEPUP_ORIGIN, { type: "other", results: [{}] })).toBeUndefined();
    expect(stepUpListFrom(STEPUP_ORIGIN, "text")).toBeUndefined();
  });
  it("answers hello only from StepUp's page", () => {
    expect(isStepUpHello(STEPUP_ORIGIN, { type: "stepup-hello" })).toBe(true);
    expect(isStepUpHello("https://evil.example", { type: "stepup-hello" })).toBe(false);
  });
});
