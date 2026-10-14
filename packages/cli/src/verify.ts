import "dotenv/config";
import { clockLooksWrong, hasErrors, openLedgerFolders, serverClockSkewMs, verifyFiles, verifyLedger, type Finding } from "@step-up/shared";
import { openYearLedger } from "./ledgerYear.js";

/**
 * npm run verify -- 2026-2027 [--files] [--hash]
 *   (always)  checks the ledger makes sense: nothing points at something that isn't there, logs are clean, no duplicate files
 *   --files   also asks OneDrive whether every registered file still exists and has the size recorded
 *   --hash    also downloads each file and checks its SHA-256 (slow; implies --files)
 * Read-only. Exits with an error status if anything is inconsistent.
 */
async function main() {
  const args = process.argv.slice(2);
  const label = args.find((a) => /^\d{4}-\d{4}$/.test(a));
  if (!label) throw new Error("Usage: npm run verify -- <year> [--files] [--hash]");
  const hash = args.includes("--hash");
  const files = hash || args.includes("--files");

  const opened = await openYearLedger(label);
  const events = await opened.ledger.store.readAll();
  const findings: Finding[] = verifyLedger(opened.ledger.state, events);

  if (files) {
    const docs = Object.values(opened.ledger.state.documents).filter((d) => d.driveItemId);
    console.log(`Checking ${docs.length} file(s) in ${opened.storage.label}${hash ? " (downloading each to check its contents)" : ""}...`);
    findings.push(...(await verifyFiles(opened.storage, opened.driveId, opened.ledger.state, { hash })));
  }

  // A tiny write is the only way to learn the storage's idea of the time; do it in the reports folder, and only for the clock check.
  const folders = await openLedgerFolders(opened.storage, opened.driveId, opened.year.folderId);
  if (folders) {
    await opened.storage.write(opened.driveId, folders.reportsId, ".clock-check", new Date().toISOString());
    if (clockLooksWrong()) findings.push({ severity: "warn", code: "clock-skew", message: `This computer's clock is ${Math.round(Math.abs(serverClockSkewMs()!) / 60000)} minute(s) ${serverClockSkewMs()! > 0 ? "behind" : "ahead of"} ${opened.storage.label}'s. Edits made on different devices may be ordered wrongly.` });
  }

  const icon = { error: "ERROR", warn: "warn ", info: "info " } as const;
  console.log(`\n${opened.year.label}: ${events.length} event(s), ${Object.keys(opened.ledger.state.items).length} item(s), ${Object.keys(opened.ledger.state.documents).length} document(s)\n`);
  for (const f of findings) console.log(`${icon[f.severity]}  ${f.message}${f.ids ? `\n        e.g. ${f.ids.slice(0, 3).join(", ")}` : ""}`);
  if (hasErrors(findings)) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
