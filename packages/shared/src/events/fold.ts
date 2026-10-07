import type { LedgerState } from "../domain/types.js";
import { SCHEMA_VERSION, type Json, type LedgerEvent } from "./types.js";

/** Bump when fold semantics change; snapshots with a different version are rebuilt from the logs. */
export const FOLD_VERSION = 1;

interface FieldCell {
  v: Json;
  hlc: string;
}

export interface EntityRec {
  fields: Record<string, FieldCell>;
  firstHlc?: string;
  lastDelete?: string;
  lastRestore?: string;
}

/** Serializable merged state (also the snapshot payload). Plain JSON on purpose. */
export interface RawState {
  foldVersion: number;
  entities: Record<string, Record<string, EntityRec>>;
  /** Ids of events skipped because their schemaVersion is newer than this code understands. */
  skipped: Record<string, true>;
}

export function emptyRaw(): RawState {
  return { foldVersion: FOLD_VERSION, entities: {}, skipped: {} };
}

function maxStr(a: string | undefined, b: string): string {
  return a === undefined || b > a ? b : a;
}

/** Mutating single-event merge (used by foldEvents and for cheap optimistic local writes). */
export function applyEventInPlace(state: RawState, e: LedgerEvent): void {
  if (e.schemaVersion > SCHEMA_VERSION) {
    state.skipped[e.id] = true;
    return;
  }
  const kind = (state.entities[e.entity] ??= {});
  const rec = (kind[e.entityId] ??= { fields: {} });
  rec.firstHlc = rec.firstHlc === undefined || e.hlc < rec.firstHlc ? e.hlc : rec.firstHlc;
  if (e.op === "set") {
    for (const [name, v] of Object.entries(e.fields ?? {})) {
      const cur = rec.fields[name];
      if (!cur || e.hlc > cur.hlc) rec.fields[name] = { v, hlc: e.hlc };
    }
  } else if (e.op === "delete") {
    rec.lastDelete = maxStr(rec.lastDelete, e.hlc);
  } else if (e.op === "restore") {
    rec.lastRestore = maxStr(rec.lastRestore, e.hlc);
  }
}

/**
 * Deterministic merge. The result depends only on the *set* of events: order-independent and
 * idempotent (replaying an event is a no-op), so any client reading any set of logs converges.
 * Pass `base` (a snapshot's raw state) to fold only newer events on top of it.
 */
export function foldEvents(events: Iterable<LedgerEvent>, base?: RawState): RawState {
  const state = base && base.foldVersion === FOLD_VERSION ? structuredClone(base) : emptyRaw();
  for (const e of events) applyEventInPlace(state, e);
  return state;
}

/** Delete wins until an explicit later restore; plain field sets never resurrect a deleted entity. */
export function isDeleted(rec: EntityRec): boolean {
  if (rec.lastDelete === undefined) return false;
  return rec.lastRestore === undefined || rec.lastRestore < rec.lastDelete;
}

const KIND_TO_KEY = {
  child: "children",
  paymentMethod: "paymentMethods",
  purchase: "purchases",
  item: "items",
  document: "documents",
  additionalDoc: "additionalDocs",
  submission: "submissions",
  setting: "settings",
} as const;

export function materialize(raw: RawState): LedgerState {
  const out: LedgerState = {
    children: {},
    paymentMethods: {},
    purchases: {},
    items: {},
    documents: {},
    additionalDocs: {},
    submissions: {},
    settings: {},
  };
  for (const [kind, key] of Object.entries(KIND_TO_KEY)) {
    const recs = raw.entities[kind] ?? {};
    const target = out[key] as Record<string, unknown>;
    for (const [id, rec] of Object.entries(recs)) {
      if (isDeleted(rec)) continue;
      const obj: Record<string, unknown> = { id };
      for (const [name, cell] of Object.entries(rec.fields)) obj[name] = cell.v;
      target[id] = obj;
    }
  }
  return out;
}

/** Per-client high-water marks so a reader can load a snapshot and apply only newer events from each log. */
export interface LedgerSnapshot {
  foldVersion: number;
  highWater: Record<string, string>;
  raw: RawState;
}

export function makeSnapshot(events: Iterable<LedgerEvent>, base?: LedgerSnapshot): LedgerSnapshot {
  const list = [...events];
  const raw = foldEvents(list, base?.raw);
  const highWater = { ...(base?.highWater ?? {}) };
  for (const e of list) if (!highWater[e.clientId] || e.hlc > highWater[e.clientId]) highWater[e.clientId] = e.hlc;
  return { foldVersion: FOLD_VERSION, highWater, raw };
}

/** Events not yet reflected in the snapshot. */
export function tailEvents(all: Iterable<LedgerEvent>, snapshot: LedgerSnapshot): LedgerEvent[] {
  const tail: LedgerEvent[] = [];
  for (const e of all) if (e.hlc > (snapshot.highWater[e.clientId] ?? "")) tail.push(e);
  return tail;
}
