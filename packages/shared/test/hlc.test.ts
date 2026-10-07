import { describe, expect, it } from "vitest";
import { HlcClock, formatHlc, parseHlc } from "../src/index.js";

describe("HlcClock", () => {
  it("round-trips format/parse", () => {
    const parts = { wall: 1_700_000_000_000, counter: 7, clientId: "dev-a" };
    expect(parseHlc(formatHlc(parts))).toEqual(parts);
  });

  it("is strictly increasing even when the wall clock stalls or goes backwards", () => {
    let t = 1000;
    const c = new HlcClock("a", { now: () => t });
    const a = c.next();
    const b = c.next();
    t = 500;
    const d = c.next();
    expect(a < b).toBe(true);
    expect(b < d).toBe(true);
  });

  it("orders local events after an observed remote event", () => {
    const remote = new HlcClock("b", { now: () => 5000 });
    const local = new HlcClock("a", { now: () => 1000, maxDriftMs: 10_000 });
    const r = remote.next();
    local.observe(r);
    expect(local.next() > r).toBe(true);
  });

  it("does not adopt a timestamp absurdly far in the future", () => {
    const local = new HlcClock("a", { now: () => 1000, maxDriftMs: 100 });
    local.observe(formatHlc({ wall: 9_999_999_999_999, counter: 0, clientId: "z" }));
    expect(local.skewDetected).toBe(true);
    expect(parseHlc(local.next()).wall).toBe(1000);
  });

  it("breaks ties between clients deterministically", () => {
    const a = new HlcClock("a", { now: () => 1000 }).next();
    const b = new HlcClock("b", { now: () => 1000 }).next();
    expect(a < b).toBe(true);
  });
});
