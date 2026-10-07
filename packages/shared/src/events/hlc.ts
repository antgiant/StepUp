/**
 * Hybrid logical clock. Timestamps are fixed-width strings `wall-counter-clientId` so plain string
 * comparison gives a total order that is identical on every device, even with skewed wall clocks.
 */
const WALL_WIDTH = 13;
const COUNTER_WIDTH = 5;

export interface HlcParts {
  wall: number;
  counter: number;
  clientId: string;
}

export function formatHlc(p: HlcParts): string {
  return `${String(p.wall).padStart(WALL_WIDTH, "0")}-${String(p.counter).padStart(COUNTER_WIDTH, "0")}-${p.clientId}`;
}

export function parseHlc(hlc: string): HlcParts {
  const wall = Number(hlc.slice(0, WALL_WIDTH));
  const counter = Number(hlc.slice(WALL_WIDTH + 1, WALL_WIDTH + 1 + COUNTER_WIDTH));
  const clientId = hlc.slice(WALL_WIDTH + COUNTER_WIDTH + 2);
  if (!Number.isFinite(wall) || !Number.isFinite(counter) || hlc[WALL_WIDTH] !== "-" || !clientId) {
    throw new Error(`Malformed HLC: ${hlc}`);
  }
  return { wall, counter, clientId };
}

export interface HlcOptions {
  now?: () => number;
  /** Remote timestamps further ahead of the local clock than this are not adopted (protects against a badly wrong device clock). */
  maxDriftMs?: number;
}

export class HlcClock {
  private wall = 0;
  private counter = 0;
  /** Set when a remote timestamp was ignored because it was too far in the future. */
  skewDetected = false;
  private readonly now: () => number;
  private readonly maxDriftMs: number;

  constructor(readonly clientId: string, options: HlcOptions = {}) {
    if (!clientId || clientId.includes("\n")) throw new Error("clientId required");
    this.now = options.now ?? Date.now;
    this.maxDriftMs = options.maxDriftMs ?? 24 * 60 * 60 * 1000;
  }

  /** Returns a new timestamp strictly greater than every timestamp this clock has issued or observed. */
  next(): string {
    const t = this.now();
    if (t > this.wall) {
      this.wall = t;
      this.counter = 0;
    } else {
      this.counter += 1;
    }
    return formatHlc({ wall: this.wall, counter: this.counter, clientId: this.clientId });
  }

  /** Adopts a remote timestamp so later local timestamps sort after it. */
  observe(remote: string): void {
    const r = parseHlc(remote);
    if (r.wall > this.now() + this.maxDriftMs) {
      this.skewDetected = true;
      return;
    }
    if (r.wall > this.wall) {
      this.wall = r.wall;
      this.counter = r.counter;
    } else if (r.wall === this.wall && r.counter > this.counter) {
      this.counter = r.counter;
    }
  }
}
