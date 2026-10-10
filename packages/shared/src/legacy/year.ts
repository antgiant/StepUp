import type { EntityKind } from "../domain/types.js";
import { Ledger } from "../events/ledger.js";
import { HlcClock } from "../events/hlc.js";
import type { EventStore } from "../events/store.js";
import type { LedgerEvent } from "../events/types.js";
import { buildLegacyImport, type LegacyImportResult, type LegacyInput } from "../import/legacy.js";
import { LEGACY_CHOICES_FILE } from "../workspace/workspace.js";
import { findChild, readTextFile, writeFile } from "../graph/files.js";


/** Thrown by anything that tries to change a year that Excel still owns. */
export class ReadOnlyYearError extends Error {
  constructor() {
    super("This year is shown from its Excel workbook and cannot be changed here. Make the change in Excel.");
  }
}

class FixedStore implements EventStore {
  readonly clientId = "legacy-view";
  constructor(private events: LedgerEvent[]) {}
  set(events: LedgerEvent[]) {
    this.events = events;
  }
  async readAll() {
    return this.events;
  }
  async appendOwn(): Promise<void> {
    throw new ReadOnlyYearError();
  }
}

/**
 * A ledger view over a year that is read from an Excel workbook. It exists only in memory and every way of changing it
 * throws, so no screen can write to a year Excel is the authority for.
 */
export class LegacyLedger extends Ledger {
  private readonly fixed: FixedStore;
  constructor(events: LedgerEvent[]) {
    const fixed = new FixedStore(events);
    super(fixed, new HlcClock(fixed.clientId), "legacy-view");
    this.fixed = fixed;
    this.loadKnown(events);
  }
  /** Shows a newer reading of the workbook. */
  replace(events: LedgerEvent[]): void {
    this.fixed.set(events);
    this.loadKnown(events);
  }
  override set(_entity: EntityKind, _id: string, ..._rest: unknown[]): never {
    throw new ReadOnlyYearError();
  }
  override delete(_entity: EntityKind, _id: string, ..._rest: unknown[]): never {
    throw new ReadOnlyYearError();
  }
  override restore(_entity: EntityKind, _id: string, ..._rest: unknown[]): never {
    throw new ReadOnlyYearError();
  }
  override async flush(): Promise<void> {
    /* nothing is ever pending */
  }
}

/** A purchase whose receipt could not be told apart from the files named on its rows. */
export interface UnclearReceipt {
  purchaseId: string;
  /** File names, sorted. Together they are the key a person's answer is remembered under. */
  candidates: string[];
  key: string;
}

export type ReceiptChoices = Record<string, string>;

export interface LegacyYear {
  input: LegacyInput;
  choices: ReceiptChoices;
  result: LegacyImportResult;
  unclear: UnclearReceipt[];
}

export const choiceKey = (candidates: readonly string[]): string => [...candidates].sort().join(" ");

/** Derives the read-only year from what was read out of Excel plus the person's remembered receipt answers. */
export function deriveLegacyYear(input: Omit<LegacyInput, "mode" | "receiptChoices">, choices: ReceiptChoices): LegacyYear {
  const full: LegacyInput = { ...input, mode: "view", receiptChoices: choices };
  const result = buildLegacyImport(full);
  const seen = new Set<string>();
  const unclear: UnclearReceipt[] = [];
  for (const a of result.report.ambiguousReceipts) {
    if (a.chosen) continue;
    const purchaseId = result.state.items[a.itemId]?.purchaseId;
    if (!purchaseId || seen.has(purchaseId)) continue;
    seen.add(purchaseId);
    const candidates = [...a.candidates].sort();
    unclear.push({ purchaseId, candidates, key: choiceKey(candidates) });
  }
  return { input: full, choices, result, unclear };
}

/** The remembered answers beside the workbook (in the year folder). Missing or unreadable means none. */
export async function readReceiptChoices(driveId: string, yearFolderId: string): Promise<ReceiptChoices> {
  const file = await findChild(driveId, yearFolderId, LEGACY_CHOICES_FILE);
  if (!file) return {};
  try {
    const parsed = JSON.parse((await readTextFile(driveId, file.id)).text) as { receiptChoices?: ReceiptChoices };
    return parsed.receiptChoices && typeof parsed.receiptChoices === "object" ? parsed.receiptChoices : {};
  } catch {
    return {};
  }
}

export async function writeReceiptChoices(driveId: string, yearFolderId: string, choices: ReceiptChoices): Promise<void> {
  const body = { note: "Answers to 'which file is the receipt?' for a year viewed from its Excel workbook. Safe to delete.", receiptChoices: choices };
  await writeFile(driveId, yearFolderId, LEGACY_CHOICES_FILE, JSON.stringify(body, null, 1));
}
