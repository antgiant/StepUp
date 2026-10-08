import type { Claim, LedgerState } from "../domain/types.js";
import type { Ledger } from "../events/ledger.js";
import { hashString } from "../util/hash.js";

export interface ClaimOwner {
  actor: string;
  clientId: string;
}

/** A claim lasts this long without being renewed or released (active runs renew it at every step, so a crash frees the items within this time). */
export const CLAIM_TTL_MS = 45 * 60_000;

const claimId = (itemId: string, clientId: string) => `claim-${hashString(`${itemId}|${clientId}`)}`;

const isActive = (c: Claim, now: number): boolean =>
  Boolean(c.itemId && c.clientId && c.claimedAt) && !c.released && now - Date.parse(c.claimedAt!) < (c.ttlMs ?? CLAIM_TTL_MS);

/** The claim that wins for an item right now: the earliest active one (install id breaks a tie), or undefined. */
export function winningClaim(state: LedgerState, itemId: string, now: number): Claim | undefined {
  return Object.values(state.claims)
    .filter((c) => c.itemId === itemId && isActive(c, now))
    .sort((a, b) => Date.parse(a.claimedAt!) - Date.parse(b.claimedAt!) || a.clientId!.localeCompare(b.clientId!))[0];
}

export interface ClaimConflict {
  itemId: string;
  actor: string;
  claimedAt: string;
}

/** Items someone else is filing (as opposed to this install, whose own earlier claim is simply resumed). */
export function claimedByOthers(state: LedgerState, itemIds: string[], me: ClaimOwner, now: number): ClaimConflict[] {
  const out: ClaimConflict[] = [];
  for (const itemId of itemIds) {
    const win = winningClaim(state, itemId, now);
    if (win && win.clientId !== me.clientId) out.push({ itemId, actor: win.actor ?? "someone", claimedAt: win.claimedAt! });
  }
  return out;
}

/**
 * Claims items before filing them. The claim is written and uploaded, then every log is re-read: we proceed only if our
 * claim is still the earliest for every item, so two people starting together cannot both go ahead. On a conflict our
 * claims are released and the conflicts are returned. Advisory, like the session lock: it keeps accidents out.
 */
export async function claimItems(ledger: Ledger, itemIds: string[], me: ClaimOwner, now: () => number = Date.now): Promise<{ ok: true } | { ok: false; conflicts: ClaimConflict[] }> {
  await ledger.refresh(); // someone may have released (or claimed) since this run last looked
  const early = claimedByOthers(ledger.state, itemIds, me, now());
  if (early.length > 0) return { ok: false, conflicts: early };
  const claimedAt = new Date(now()).toISOString();
  for (const itemId of itemIds) ledger.set("claim", claimId(itemId, me.clientId), { itemId, actor: me.actor, clientId: me.clientId, claimedAt, ttlMs: CLAIM_TTL_MS, released: false }, { label: "claim.taken" });
  await ledger.flush();
  await ledger.refresh(); // see everyone else's claims, including ones written at the same moment
  const conflicts = claimedByOthers(ledger.state, itemIds, me, now());
  if (conflicts.length === 0) return { ok: true };
  await releaseItems(ledger, itemIds, me);
  return { ok: false, conflicts };
}

/** Lets go of our claims (finished, skipped or failed). */
export async function releaseItems(ledger: Ledger, itemIds: string[], me: ClaimOwner): Promise<void> {
  for (const itemId of itemIds) {
    if (ledger.state.claims[claimId(itemId, me.clientId)]) ledger.set("claim", claimId(itemId, me.clientId), { released: true }, { label: "claim.released" });
  }
  await ledger.flush();
}

/** Keeps our claims alive while a run is making progress. Does nothing for items we have not claimed. */
export function renewClaims(ledger: Ledger, itemIds: string[], me: ClaimOwner, now: () => number = Date.now): void {
  const claimedAt = new Date(now()).toISOString();
  for (const itemId of itemIds) {
    const id = claimId(itemId, me.clientId);
    if (ledger.state.claims[id] && !ledger.state.claims[id]!.released) ledger.set("claim", id, { claimedAt }, { label: "claim.renewed" });
  }
}

export interface FilingActivity {
  actor: string;
  claimedAt: string;
}

/** Every item someone is filing right now (an active, winning claim), by item id. Used to show "being filed by ..." so a ready item that is mid-filing is not mistaken for an idle one. */
export function itemsBeingFiled(state: LedgerState, now: number): Record<string, FilingActivity> {
  const out: Record<string, FilingActivity> = {};
  for (const c of Object.values(state.claims)) {
    if (!c.itemId || out[c.itemId]) continue;
    const win = winningClaim(state, c.itemId, now);
    if (win) out[c.itemId] = { actor: win.actor ?? "someone", claimedAt: win.claimedAt! };
  }
  return out;
}
