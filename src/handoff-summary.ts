import { stripAnsi } from "./format.js";
import { redactSecrets } from "./redact.js";

/**
 * 交接用的有界摘要：去 ANSI、遮蔽機敏內容、去掉空行，超過 maxChars 時保留最後的部分。
 * 順序刻意是「先遮蔽再截斷」：先截斷會把金鑰切成兩半，之後規則就比對不到，內容會漏出去。
 */
export function boundedHandoffSummary(
  output: string,
  maxChars: number,
): string {
  const clean = redactSecrets(stripAnsi(output)).trim();
  if (!clean) return "";
  const lines = clean.split(/\r?\n/).filter((line) => line.trim());
  let summary = lines.join("\n");
  if (summary.length > maxChars) {
    const omission = "… [older handoff output omitted] …\n";
    summary =
      maxChars <= omission.length
        ? summary.slice(-maxChars)
        : `${omission}${summary.slice(-(maxChars - omission.length))}`;
  }
  return summary;
}
