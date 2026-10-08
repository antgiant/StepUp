import type { EventStore, LedgerEvent } from "@step-up/shared/web";

const KEY = "stepup.events.v1";

/** Browser-local event log (localStorage). A stand-in until the OneDrive store is wired to MSAL sign-in. */
export class LocalEventStore implements EventStore {
  constructor(readonly clientId: string) {}

  private read(): LedgerEvent[] {
    try {
      return JSON.parse(localStorage.getItem(KEY) ?? "[]") as LedgerEvent[];
    } catch {
      return [];
    }
  }

  async readAll(): Promise<LedgerEvent[]> {
    return this.read();
  }

  async appendOwn(events: LedgerEvent[]): Promise<void> {
    const log = this.read();
    const have = new Set(log.map((e) => e.id));
    for (const e of events) if (!have.has(e.id)) log.push(e);
    localStorage.setItem(KEY, JSON.stringify(log));
  }
}

export function exportJsonl(events: LedgerEvent[]): string {
  return events.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

export function parseJsonl(text: string): LedgerEvent[] {
  return text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as LedgerEvent);
}
