import { readFile } from "node:fs/promises";
import { foldEvents, materialize, planSubmissions, type LedgerEvent, type LedgerState, type RulesContext } from "@step-up/shared";
import { openYearLedger } from "./ledgerYear.js";

/** Read-only plan from a local events file (e.g. the importer's data/import/<year>/events.jsonl). */
export async function planFromEventsFile(file: string): Promise<void> {
  const events = (await readFile(file, "utf-8")).split("\n").filter(Boolean).map((l) => JSON.parse(l) as LedgerEvent);
  printPlan(materialize(foldEvents(events)));
}

/** Read-only plan from a ledger year in OneDrive. */
export async function planFromYear(label: string): Promise<void> {
  const { ledger } = await openYearLedger(label);
  printPlan(ledger.state);
}

/**
 * Category rules are not in the event log yet (shared reference data arrives in Phase 3b), so every
 * category is treated as known, active and eligible; category-related blockers are not evaluated here.
 */
function printPlan(state: LedgerState): void {
  const ctx: RulesContext = {
    today: new Date().toISOString().slice(0, 10),
    category: (id) => ({ id, path: [], requiresServiceDate: false, eligibleScholarships: [], isActive: true }),
  };
  const plan = planSubmissions(state, ctx);

  console.log(`${plan.groups.length} submission group(s) ready, ${plan.blocked.length} item(s) blocked, ${plan.skipped} already filed/forfeited.\n`);
  for (const g of plan.groups) {
    console.log(`- Child: ${g.childName} | Main receipt: ${g.receipt.filename ?? g.receipt.id}`);
    for (const i of g.items) console.log(`    ${i.id}: "${i.description}" — $${((i.amountCents ?? 0) / 100).toFixed(2)}`);
    if (g.additionalDocs.length > 0) console.log(`    Additional documents: ${g.additionalDocs.map((d) => d.filename ?? d.id).join(", ")}`);
  }
  if (plan.blocked.length > 0) {
    console.log("\nBlocked:");
    for (const b of plan.blocked) console.log(`  ${b.item.id} (${b.status}): ${b.reasons.map((r) => r.message).join("; ")}`);
  }
}
