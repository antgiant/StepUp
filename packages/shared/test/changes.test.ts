import { describe, expect, it } from "vitest";
import { formatHlc, summarizeChanges, type LedgerEvent } from "../src/index.js";

const ev = (wall: number, clientId: string, label: string, actor?: string): LedgerEvent => ({
  id: formatHlc({ wall, counter: 0, clientId }),
  hlc: formatHlc({ wall, counter: 0, clientId }),
  clientId,
  ...(actor ? { actor } : {}),
  schemaVersion: 1,
  op: "set",
  entity: "item",
  entityId: "i",
  label,
});

describe("summarizeChanges", () => {
  const events = [
    ev(1000, "cli-a", "item.submitted", "alice"), // before: ignored
    ev(2000, "cli-a", "item.submitted", "alice"),
    ev(2001, "cli-a", "item.submitted", "alice"),
    ev(2002, "cli-a", "document.uploaded", "alice"),
    ev(2003, "cli-a", "document.registered", "alice"),
    ev(2004, "cli-a", "claim.taken", "alice"), // noise: not mentioned
    ev(2005, "web-b", "purchase.created", "bob"),
    ev(2006, "web-me", "purchase.created", "me"), // mine: ignored
  ];

  it("counts what others did since the time, per person, and leaves out your own and the noise", () => {
    const s = summarizeChanges(events, 1500, "web-me");
    expect(s.count).toBe(5);
    expect(s.lines).toEqual(["alice: submitted 2 item(s) to StepUp; added 2 file(s)", "bob: added 1 purchase(s)"]);
  });

  it("says nothing when nothing happened", () => {
    expect(summarizeChanges(events, 9999, "web-me")).toEqual({ lines: [], count: 0 });
  });
});
