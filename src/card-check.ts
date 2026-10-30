import { parseCard } from "./card.js";

export const USAGE = `Usage: herdr-card-check FILE...
Checks that each Markdown card file is valid under the card format
(docs/adr/0001-portable-md-cards.md). Prints OK or FAIL per file.
Exit status: 0 all valid, 1 at least one invalid or unreadable, 2 usage error.`;

export interface CheckOutput {
  code: number;
  stdout: string;
  stderr: string;
}

function lines(entries: string[]): string {
  return entries.length ? entries.join("\n") + "\n" : "";
}

export function runCardCheck(
  args: string[],
  readFile: (path: string) => string,
): CheckOutput {
  if (args.includes("--help") || args.includes("-h"))
    return { code: 0, stdout: USAGE + "\n", stderr: "" };
  const unknown = args.find((arg) => arg.startsWith("-"));
  if (unknown !== undefined)
    return {
      code: 2,
      stdout: "",
      stderr: `Unknown option: ${unknown}\n${USAGE}\n`,
    };
  if (args.length === 0) return { code: 2, stdout: "", stderr: USAGE + "\n" };

  const ok: string[] = [];
  const failed: string[] = [];
  for (const file of args) {
    try {
      const result = parseCard(readFile(file), file);
      if (result.ok) {
        const { id, type, status, title } = result.card;
        ok.push(`OK    ${file}  ${id} ${type} ${status} "${title}"`);
      } else {
        failed.push(`FAIL  ${file}: ${result.error}`);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      failed.push(`FAIL  ${file}: cannot read: ${reason}`);
    }
  }
  return {
    code: failed.length ? 1 : 0,
    stdout: lines(ok),
    stderr: lines(failed),
  };
}
