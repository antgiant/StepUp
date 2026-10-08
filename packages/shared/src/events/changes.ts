import { parseHlc } from "./hlc.js";
import type { LedgerEvent } from "./types.js";

export interface ChangeSummary {
  /** One sentence per person or program that did something, e.g. "alice@example.com: submitted 3 item(s) to StepUp; added 2 file(s)". */
  lines: string[];
  /** How many individual changes by others there were. */
  count: number;
}

/** What each kind of event means to a person, and how to count it. Anything not listed is not worth mentioning. */
const WORDS: Record<string, (n: number) => string> = {
  "item.submitted": (n) => `submitted ${n} item(s) to StepUp`,
  "item.needsAttention": (n) => `flagged ${n} item(s) as needing attention`,
  "item.statusObserved": (n) => `updated the StepUp status of ${n} item(s)`,
  "item.created": (n) => `added ${n} item(s)`,
  "item.duplicated": (n) => `added ${n} item(s)`,
  "purchase.created": (n) => `added ${n} purchase(s)`,
  "purchase.archived": (n) => `archived ${n} purchase(s)`,
  "purchase.edited": (n) => `edited ${n} purchase(s)`,
  "document.registered": (n) => `added ${n} file(s)`,
  "document.uploaded": (n) => `added ${n} file(s)`,
  "document.redacted": (n) => `made ${n} redacted copy(ies)`,
  "document.shrunk": (n) => `made ${n} smaller copy(ies) of receipts`,
  "statement.parsed": (n) => `read ${n} statement(s)`,
  "proof.autoLinked": (n) => `linked ${n} charge(s) to purchases`,
  "proof.linked": (n) => `linked ${n} charge(s) to purchases`,
  "refund.linked": (n) => `recorded ${n} refund(s)`,
  "category.added": (n) => `added ${n} categor${n === 1 ? "y" : "ies"}`,
  "category.observed": (n) => `updated ${n} categor${n === 1 ? "y" : "ies"} from StepUp`,
  "child.created": (n) => `added ${n} student(s)`,
};

/**
 * "Since you were last here": what other people (and the command line) did after `sinceMs`, from the event log.
 * Your own install's events are left out. Pure.
 */
export function summarizeChanges(events: LedgerEvent[], sinceMs: number, myClientId: string): ChangeSummary {
  const by = new Map<string, Map<string, number>>();
  let count = 0;
  for (const e of events) {
    if (e.clientId === myClientId || !e.label || !WORDS[e.label]) continue;
    let wall: number;
    try {
      wall = parseHlc(e.hlc).wall;
    } catch {
      continue;
    }
    if (wall <= sinceMs) continue;
    const who = e.actor ?? e.clientId;
    const mine = by.get(who) ?? new Map<string, number>();
    mine.set(e.label, (mine.get(e.label) ?? 0) + 1);
    by.set(who, mine);
    count++;
  }
  const lines = [...by.entries()].map(([who, labels]) => {
    // Several labels can say the same thing (two ways of adding a file); say each phrase once with the total.
    const phrases = new Map<string, number>();
    for (const [label, n] of labels) {
      const phrase = WORDS[label]!(0).replace("0", "#");
      phrases.set(phrase, (phrases.get(phrase) ?? 0) + n);
    }
    return `${who}: ${[...phrases.entries()].map(([p, n]) => p.replace("#", String(n))).join("; ")}`;
  });
  return { lines, count };
}
