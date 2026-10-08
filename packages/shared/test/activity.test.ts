import { afterEach, describe, expect, it } from "vitest";
import { configureGraph, describeRequest, graphFetch, observeActivity, setTokenProvider, type ActivityEvent } from "../src/index.js";

const G = "https://graph.microsoft.com/v1.0";

describe("activity descriptions", () => {
  it("describes requests in plain language", () => {
    expect(describeRequest("PUT", `${G}/drives/d/items/p:/receipt%20one.pdf:/content`)).toBe("Uploading receipt one.pdf…");
    expect(describeRequest("PUT", `${G}/drives/d/items/p:/abc.jsonl:/content`)).toBe("Saving your changes to OneDrive…");
    expect(describeRequest("GET", `${G}/drives/d/items/i/content`)).toBe("Downloading a file…");
    expect(describeRequest("GET", `${G}/drives/d/items/i/children?$top=200`)).toBe("Reading the folder's contents…");
    expect(describeRequest("POST", `${G}/drives/d/items/p/children`, JSON.stringify({ name: "2026-2027" }))).toBe("Creating the folder 2026-2027…");
    expect(describeRequest("POST", `${G}/drives/d/items/i/invite`)).toBe("Sending the invitation…");
    expect(describeRequest("GET", `${G}/drives/d/items/p:/events?$select=id`)).toBe("Looking for events…");
  });
});

describe("activity reporting", () => {
  afterEach(() => {
    observeActivity(undefined);
    configureGraph();
  });

  it("reports start, retry notice and end for a request", async () => {
    const events: ActivityEvent[] = [];
    observeActivity((e) => events.push(e));
    setTokenProvider(async () => "t");
    let calls = 0;
    configureGraph({
      sleep: async () => undefined,
      fetch: async () => (++calls === 1 ? new Response("", { status: 503 }) : new Response("{}", { status: 200 })),
    });
    await graphFetch("/drives/d/items/i/content");
    expect(events[0]).toMatchObject({ type: "start", label: "Downloading a file…" });
    expect(events.some((e) => e.type === "update" && e.label.includes("OneDrive is busy"))).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "end" });
  });
});
