import type { EntityKind, LedgerState } from "../domain/types.js";
import { applyEventInPlace, foldEvents, materialize, type RawState } from "./fold.js";
import type { HlcClock } from "./hlc.js";
import type { EventStore } from "./store.js";
import { SCHEMA_VERSION, type Json, type LedgerEvent } from "./types.js";

export interface LedgerWriteOptions {
  label?: string;
  reason?: string;
}

/**
 * Local view of a year's ledger. Writes are applied optimistically and queued; `flush` appends them to
 * this client's own log; `refresh` re-reads every log and re-folds (keeping unflushed local events).
 */
export class Ledger {
  private pending: LedgerEvent[] = [];
  private raw: RawState = foldEvents([]);
  private cached?: LedgerState;

  constructor(
    readonly store: EventStore,
    readonly clock: HlcClock,
    private readonly actor?: string
  ) {}

  get state(): LedgerState {
    return (this.cached ??= materialize(this.raw));
  }

  get unflushedCount(): number {
    return this.pending.length;
  }

  /** Called whenever the set of unflushed events changes, so a host can keep it somewhere that survives a reload or a lost connection. */
  onPendingChange?: (pending: readonly LedgerEvent[]) => void;

  /** Takes back events saved by `onPendingChange` in an earlier session. Replays are harmless (events are idempotent by id). */
  restorePending(events: LedgerEvent[]): void {
    const have = new Set(this.pending.map((e) => e.id));
    const fresh = events.filter((e) => !have.has(e.id));
    if (fresh.length === 0) return;
    for (const e of fresh) {
      this.clock.observe(e.hlc);
      applyEventInPlace(this.raw, e);
    }
    this.pending.push(...fresh);
    this.cached = undefined;
    this.onPendingChange?.(this.pending);
  }

  async refresh(): Promise<void> {
    this.loadKnown(await this.store.readAll());
  }

  /** Replaces the folded view with `events` (from the network or a local cache) plus unflushed local edits. No I/O. */
  loadKnown(events: LedgerEvent[]): void {
    for (const e of events) this.clock.observe(e.hlc);
    this.raw = foldEvents([...events, ...this.pending]);
    this.cached = undefined;
  }

  set(entity: EntityKind, entityId: string, fields: Record<string, Json>, opts: LedgerWriteOptions = {}): LedgerEvent {
    return this.write("set", entity, entityId, fields, opts);
  }

  delete(entity: EntityKind, entityId: string, opts: LedgerWriteOptions = {}): LedgerEvent {
    return this.write("delete", entity, entityId, undefined, opts);
  }

  restore(entity: EntityKind, entityId: string, opts: LedgerWriteOptions = {}): LedgerEvent {
    return this.write("restore", entity, entityId, undefined, opts);
  }

  async flush(): Promise<void> {
    if (this.pending.length === 0) return;
    const batch = [...this.pending];
    await this.store.appendOwn(batch);
    const flushed = new Set(batch.map((e) => e.id));
    this.pending = this.pending.filter((e) => !flushed.has(e.id));
    this.onPendingChange?.(this.pending);
  }

  private write(
    op: LedgerEvent["op"],
    entity: EntityKind,
    entityId: string,
    fields: Record<string, Json> | undefined,
    opts: LedgerWriteOptions
  ): LedgerEvent {
    const hlc = this.clock.next();
    const event: LedgerEvent = {
      id: hlc,
      hlc,
      clientId: this.clock.clientId,
      actor: this.actor,
      schemaVersion: SCHEMA_VERSION,
      op,
      entity,
      entityId,
      ...(fields ? { fields } : {}),
      ...(opts.label ? { label: opts.label } : {}),
      ...(opts.reason ? { reason: opts.reason } : {}),
    };
    this.pending.push(event);
    applyEventInPlace(this.raw, event);
    this.cached = undefined;
    this.onPendingChange?.(this.pending);
    return event;
  }
}
