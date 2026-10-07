import type { LedgerEvent } from "./types.js";

/**
 * Storage for event logs. Each client appends only to its own log (one writer per file); reads see every
 * client's log. Implementations: in-memory (tests) and OneDrive (Graph).
 */
export interface EventStore {
  readonly clientId: string;
  /** All events from every client's log (including this client's). */
  readAll(): Promise<LedgerEvent[]>;
  /** Appends to this client's own log. Must be idempotent per event id. */
  appendOwn(events: LedgerEvent[]): Promise<void>;
}

/** Shared backing for in-memory stores, standing in for the OneDrive `events/` folder. */
export class MemoryBackend {
  readonly logs = new Map<string, LedgerEvent[]>();
}

export class MemoryEventStore implements EventStore {
  constructor(private readonly backend: MemoryBackend, readonly clientId: string) {}

  async readAll(): Promise<LedgerEvent[]> {
    return [...this.backend.logs.values()].flatMap((log) => log.map((e) => structuredClone(e)));
  }

  async appendOwn(events: LedgerEvent[]): Promise<void> {
    const log = this.backend.logs.get(this.clientId) ?? [];
    const have = new Set(log.map((e) => e.id));
    for (const e of events) if (!have.has(e.id)) log.push(structuredClone(e));
    this.backend.logs.set(this.clientId, log);
  }
}
