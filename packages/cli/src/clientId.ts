import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { newClientId } from "@step-up/shared";

const FILE = path.resolve(process.cwd(), ".cache", "client-id.json");

/**
 * This install's event-log identity. Generated once and kept in .cache/ (gitignored). Never copy .cache/ to another
 * machine: two installs sharing a client id would write the same log and the store will refuse the second writer.
 */
export async function getClientId(): Promise<string> {
  try {
    const saved = JSON.parse(await readFile(FILE, "utf-8")) as { clientId?: string };
    if (saved.clientId) return saved.clientId;
  } catch {
    // first run
  }
  const clientId = newClientId("cli");
  await mkdir(path.dirname(FILE), { recursive: true });
  await writeFile(FILE, JSON.stringify({ clientId }, null, 2), "utf-8");
  return clientId;
}
