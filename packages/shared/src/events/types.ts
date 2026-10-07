import type { EntityKind } from "../domain/types.js";

export const SCHEMA_VERSION = 1;

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type EventOp = "set" | "delete" | "restore";

/** One immutable fact appended to a client's own log. `id` equals `hlc` (unique per client clock). */
export interface LedgerEvent {
  id: string;
  hlc: string;
  clientId: string;
  /** Signed-in account or automation name (e.g. "stepup-sync"). */
  actor?: string;
  schemaVersion: number;
  op: EventOp;
  entity: EntityKind;
  entityId: string;
  /** Field patch for `set`; each field merges independently (last writer by hlc wins). */
  fields?: Record<string, Json>;
  /** Human-readable intent for history views, e.g. "item.created". */
  label?: string;
  reason?: string;
}
