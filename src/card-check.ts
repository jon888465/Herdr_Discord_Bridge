import {
  IMPORT_MAX_FILE_BYTES,
  LEDGER_MAX_FILE_BYTES,
  parseCard,
} from "./card.js";

export const USAGE = `Usage: herdr-card-check [--ledger] FILE...
Checks that each Markdown card file is valid under the card format
(docs/adr/0001-portable-md-cards.md). Prints OK or FAIL per file.
Files larger than 512 KiB are refused; --ledger raises the limit to 1 MiB
for operational (ledger) cards (docs/adr/0002-operational-cards-in-plugin-state.md).
A ready card without a notify field gets a WARN line (stderr, exit status unchanged):
the bridge only notifies a Discord thread or Agent that the card records.
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
  readFile: (path: string, maxBytes: number) => string,
): CheckOutput {
  if (args.includes("--help") || args.includes("-h"))
    return { code: 0, stdout: USAGE + "\n", stderr: "" };
  const ledger = args.includes("--ledger");
  const files = args.filter((arg) => arg !== "--ledger");
  const maxFileBytes = ledger ? LEDGER_MAX_FILE_BYTES : IMPORT_MAX_FILE_BYTES;
  const unknown = files.find((arg) => arg.startsWith("-"));
  if (unknown !== undefined)
    return {
      code: 2,
      stdout: "",
      stderr: `Unknown option: ${unknown}\n${USAGE}\n`,
    };
  if (files.length === 0) return { code: 2, stdout: "", stderr: USAGE + "\n" };

  const ok: string[] = [];
  const failed: string[] = [];
  const warned: string[] = [];
  for (const file of files) {
    try {
      const result = parseCard(readFile(file, maxFileBytes), file, {
        maxFileBytes,
      });
      if (result.ok) {
        const { id, type, status, title } = result.card;
        ok.push(`OK    ${file}  ${id} ${type} ${status} "${title}"`);
        // ready 的卡會被 bridge 撿起；沒有 notify 就不知道要通知誰（ISSUE-121）。
        if (status === "ready" && !result.card.notify)
          warned.push(
            `WARN  ${file}: ready 的卡片沒有 notify 欄位，bridge 不會通知任何人（Discord 來源填 notify: discord:<thread id>；Agent 來源填 notify: agent:<pane>:<terminal>:<agent>）`,
          );
      } else {
        failed.push(`FAIL  ${file}: ${result.error}`);
        if (result.error.includes("invalid lead")) warned.push(`WARN  ${file}: ${result.error}`);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      failed.push(`FAIL  ${file}: cannot read: ${reason}`);
    }
  }
  return {
    code: failed.length ? 1 : 0,
    stdout: lines(ok),
    stderr: lines([...failed, ...warned]),
  };
}
