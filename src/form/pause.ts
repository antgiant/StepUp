import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";

const rl = readline.createInterface({ input: stdin, output: stdout });

/** Blocks until the user presses Enter (optionally typing something first), then returns what they typed. */
export async function waitForEnter(message: string): Promise<string> {
  const answer = await rl.question(`\n>> ${message}\n`);
  return answer.trim();
}

export async function askYesNo(message: string): Promise<boolean> {
  const answer = await waitForEnter(`${message} (yes/no)`);
  return /^y(es)?$/i.test(answer);
}

export function closePrompt(): void {
  rl.close();
}
