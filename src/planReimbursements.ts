import "dotenv/config";
import { closePrompt, waitForEnter } from "./form/pause.js";
import { resolveShareLink } from "./graph/onedrive.js";
import { buildGroups, loadUnfiledRows } from "./reimbursements.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name} in .env`);
  return value;
}

async function main() {
  const excelRef = await resolveShareLink(requireEnv("ONEDRIVE_EXCEL_URL"));

  const rows = await loadUnfiledRows(excelRef);
  console.log(`Found ${rows.length} row(s) with Status = "Unfiled (Ready to Submit)".`);

  const groups = await buildGroups(rows, async (row, candidates) => {
    console.log(`\nRow ID ${row.data["ID"]} ("${row.data["Item"]}") has ${candidates.length} documentation files and no single obvious invoice/order/receipt match:`);
    candidates.forEach((f, i) => console.log(`  [${i}] ${f}`));
    const answer = await waitForEnter("Type the number of the file that should be uploaded first (the main receipt) for this row:");
    const idx = Number(answer);
    if (Number.isNaN(idx) || !candidates[idx]) throw new Error(`Invalid selection "${answer}".`);
    return candidates[idx];
  });

  console.log(`\nBuilt ${groups.length} submission group(s):\n`);
  for (const g of groups) {
    console.log(`- Child: ${g.child || "(blank)"} | Main receipt: ${g.mainReceiptFile}`);
    for (const r of g.rows) {
      console.log(
        `    ID ${r.data["ID"]}: "${r.data["Item"]}" — $${r.data["Amount"] || "?"} (${r.data["Category"] || "no category"})`
      );
    }
    if (g.additionalFiles.length > 0) {
      console.log(`    Additional documents: ${g.additionalFiles.join(", ")}`);
    }
  }

  closePrompt();
}

main().catch((err) => {
  console.error("\nPlanning failed:", err.message ?? err);
  process.exit(1);
});
