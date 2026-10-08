import { SCHEMA_VERSION, type LedgerEvent } from "./types.js";

/** Rewrites an event from one schema version to the next. */
export type Migration = (e: LedgerEvent) => LedgerEvent;

/**
 * Old events are never edited on disk (the logs are the audit trail); instead they are upgraded in memory as they are
 * read, so code written for today's shape can fold events written years ago. Register the step for each schema bump here,
 * keyed by the version it upgrades FROM, in the same change that raises `SCHEMA_VERSION`.
 */
export const MIGRATIONS: Record<number, Migration> = {};

export function upcastEvent(e: LedgerEvent, migrations: Record<number, Migration> = MIGRATIONS, target = SCHEMA_VERSION): LedgerEvent {
  let cur = e;
  while (cur.schemaVersion < target) {
    const step = migrations[cur.schemaVersion];
    cur = step ? { ...step(cur), schemaVersion: cur.schemaVersion + 1 } : { ...cur, schemaVersion: cur.schemaVersion + 1 }; // no step registered: the shapes are compatible
  }
  return cur;
}
