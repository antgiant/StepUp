import type { LedgerState, Purchase, StatementData, StatementTransaction } from "../domain/types.js";
import type { Ledger } from "../events/ledger.js";
import { requestedCents } from "../rules/readiness.js";
import { hashString } from "../util/hash.js";

export interface MatchOptions {
  /** Cents a charge may differ from the purchase total (tax/shipping rounding). Default: the larger of $1 and 2%. */
  tolerance?: (totalCents: number) => number;
  /** Receipt date -> posting date: how many days after the purchase a charge may appear. Default 30. */
  maxLagDays?: number;
  /** At or above this a match is applied without asking. Default 0.85. */
  autoThreshold?: number;
  /** Learned descriptor -> vendor words (e.g. `amzn: ["amazon"]`), so "AMZN Mktp" matches vendor "Amazon". */
  aliases?: Record<string, string[]>;
}

export interface Candidate {
  purchaseId: string;
  confidence: number;
  reasons: string[];
}

export interface TransactionMatch {
  transactionId: string;
  /** Best candidate; absent when nothing plausible was found. */
  best?: Candidate;
  alternatives: Candidate[];
  /** True only when the best candidate is strong, clearly ahead of the others, and not already claimed by a stronger charge. */
  auto: boolean;
}

const DAY = 86_400_000;
const days = (iso: string) => Math.floor(Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) / DAY);
const STOP = new Set(["the", "inc", "llc", "ltd", "co", "com", "www", "pos", "purchase", "debit", "card", "payment", "online", "store", "mktp", "mktplace"]);
const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w));

/** What a card would have been charged for a purchase: the receipt total if known, else its items with tax/shipping. */
export function purchaseTotalCents(state: LedgerState, p: Purchase): number | undefined {
  if (p.orderTotalCents !== undefined) return p.orderTotalCents;
  const items = Object.values(state.items).filter((i) => i.purchaseId === p.id && !i.archived);
  const sum = items.reduce((s, i) => s + requestedCents(i), 0);
  return sum > 0 ? sum : undefined;
}

function purchaseDate(state: LedgerState, p: Purchase): string | undefined {
  if (p.date) return p.date;
  const dates = Object.values(state.items).filter((i) => i.purchaseId === p.id && i.date).map((i) => i.date!).sort();
  return dates[0];
}

function score(state: LedgerState, p: Purchase, t: StatementTransaction, st: StatementData, opts: Required<Pick<MatchOptions, "tolerance" | "maxLagDays">> & Pick<MatchOptions, "aliases">): Candidate | undefined {
  const total = purchaseTotalCents(state, p);
  if (total === undefined) return undefined;
  const reasons: string[] = [];
  let s = 0;

  const diff = Math.abs(total - t.amountCents);
  if (diff === 0) {
    s += 0.55;
    reasons.push("exact amount");
  } else if (diff <= opts.tolerance(total)) {
    s += 0.35;
    reasons.push("amount within tolerance");
  } else return undefined;

  const pd = purchaseDate(state, p);
  if (pd) {
    const lag = days(t.postDate ?? t.date) - days(pd);
    if (lag < -3 || lag > opts.maxLagDays) return undefined;
    if (lag >= 0 && lag <= 5) {
      s += 0.25;
      reasons.push("date matches");
    } else {
      s += 0.15;
      reasons.push("date close");
    }
  }

  const descriptor = words(t.descriptor);
  const vendor = words(p.vendor ?? "");
  const vendorHit = descriptor.some((w) => vendor.some((v) => v === w || v.startsWith(w) || w.startsWith(v)) || opts.aliases?.[w]?.some((alias) => vendor.includes(alias)));
  if (vendorHit) {
    s += 0.25;
    reasons.push("vendor matches");
  }

  const last4 = st.last4 && p.paymentMethodId ? state.paymentMethods[p.paymentMethodId]?.last4 : undefined;
  if (st.last4 && last4?.length) {
    if (last4.includes(st.last4)) {
      s += 0.1;
      reasons.push("same card");
    } else {
      s -= 0.3;
      reasons.push("different card");
    }
  }
  return s > 0 ? { purchaseId: p.id, confidence: Math.round(Math.min(1, s) * 100) / 100, reasons } : undefined;
}

/**
 * Matches each charge on a statement to a purchase (order level, not per item: one charge usually covers several
 * items). Pure: returns suggestions; `linkMatches` applies the confident ones. Charges that already prove a purchase
 * are skipped, so running this again after adding a purchase only finds what is new.
 */
export function matchStatement(state: LedgerState, statementDocId: string, data: StatementData, options: MatchOptions = {}): TransactionMatch[] {
  const opts = {
    tolerance: options.tolerance ?? ((total: number) => Math.max(100, Math.round(total * 0.02))),
    maxLagDays: options.maxLagDays ?? 30,
    aliases: options.aliases ?? state.settings["year"]?.vendorAliases,
  };
  const threshold = options.autoThreshold ?? 0.85;
  const linked = new Set(Object.values(state.additionalDocs).filter((a) => a.documentId === statementDocId && a.transactionId).map((a) => a.transactionId!));
  const purchases = Object.values(state.purchases).filter((p) => !p.archived);

  const matches: TransactionMatch[] = [];
  for (const t of data.transactions) {
    if (t.kind !== "purchase" || linked.has(t.id)) continue;
    const ranked = purchases
      .map((p) => score(state, p, t, data, opts))
      .filter((c): c is Candidate => Boolean(c))
      .sort((a, b) => b.confidence - a.confidence || a.purchaseId.localeCompare(b.purchaseId));
    const [best, ...alternatives] = ranked;
    const clear = best !== undefined && (alternatives[0] === undefined || best.confidence - alternatives[0].confidence >= 0.1);
    matches.push({ transactionId: t.id, ...(best ? { best } : {}), alternatives, auto: Boolean(best && best.confidence >= threshold && clear) });
  }

  // A purchase is claimed by at most one automatic match: the strongest charge wins, the rest become suggestions.
  const claimed = new Set<string>();
  for (const m of [...matches].filter((x) => x.auto).sort((a, b) => b.best!.confidence - a.best!.confidence)) {
    if (claimed.has(m.best!.purchaseId)) m.auto = false;
    else claimed.add(m.best!.purchaseId);
  }
  return matches;
}

const proofId = (purchaseId: string, docId: string, transactionId: string) => `add-${hashString(`purchase:${purchaseId}::${docId}::${transactionId}`)}`;

/** Records the statement as payment proof for the purchase, remembering which charge shows it. */
export function linkTransaction(ledger: Ledger, purchaseId: string, statementDocId: string, transactionId: string, source: "auto" | "manual", confidence?: number): void {
  ledger.set(
    "additionalDoc",
    proofId(purchaseId, statementDocId, transactionId),
    { ownerKind: "purchase", ownerId: purchaseId, documentId: statementDocId, kind: "payment-proof", transactionId, source, ...(confidence !== undefined ? { confidence } : {}) },
    { label: source === "auto" ? "proof.autoLinked" : "proof.linked" }
  );
}

export function unlinkTransaction(ledger: Ledger, purchaseId: string, statementDocId: string, transactionId: string): void {
  ledger.delete("additionalDoc", proofId(purchaseId, statementDocId, transactionId), { label: "proof.unlinked" });
}

/** Applies every automatic match. Returns how many links were made. */
export function linkConfidentMatches(ledger: Ledger, statementDocId: string, matches: TransactionMatch[]): number {
  let n = 0;
  for (const m of matches) {
    if (!m.auto || !m.best) continue;
    linkTransaction(ledger, m.best.purchaseId, statementDocId, m.transactionId, "auto", m.best.confidence);
    n++;
  }
  return n;
}

/** Stores what was read from a statement on its document (private data, kept in the year's ledger only). */
export function saveStatement(ledger: Ledger, docId: string, data: StatementData): void {
  const { issuer, last4, periodStart, periodEnd, transactions } = data;
  ledger.set(
    "document",
    docId,
    { contentKind: "statement", statement: { ...(issuer ? { issuer } : {}), ...(last4 ? { last4 } : {}), ...(periodStart ? { periodStart } : {}), ...(periodEnd ? { periodEnd } : {}), transactions } as never },
    { label: "statement.parsed" }
  );
}

/** Re-runs matching for every parsed statement: call after purchases are added or changed. Returns the number of new links. */
export function relinkAllStatements(ledger: Ledger, options: MatchOptions = {}): number {
  let n = 0;
  for (const doc of Object.values(ledger.state.documents)) {
    if (!doc.statement) continue;
    n += linkConfidentMatches(ledger, doc.id, matchStatement(ledger.state, doc.id, doc.statement, options));
  }
  return n;
}

/**
 * When a person links a charge to a purchase whose vendor does not look like the descriptor, remember the pairing so the
 * next statement matches by itself. Stored with the year's settings.
 */
export function learnAlias(ledger: Ledger, descriptor: string, vendor: string | undefined): boolean {
  const vendorWords = words(vendor ?? "");
  const key = words(descriptor)[0];
  if (!key || vendorWords.length === 0) return false;
  if (vendorWords.some((v) => v === key || v.startsWith(key) || key.startsWith(v))) return false; // already matches by name
  const known = ledger.state.settings["year"]?.vendorAliases ?? {};
  const merged = [...new Set([...(known[key] ?? []), ...vendorWords])].sort();
  if (merged.join() === (known[key] ?? []).join()) return false;
  ledger.set("setting", "year", { vendorAliases: { ...known, [key]: merged } }, { label: "setting.aliasLearned" });
  return true;
}
