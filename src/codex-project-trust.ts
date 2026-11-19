// codex 的專案信任：`~/.codex/config.toml` 裡的 `[projects."<dir>"]` 加 `trust_level = "trusted"`（ISSUE-174）。
// 純函式：新增只在檔尾追加一個資料表；移除只刪我們追加的那個「標頭＋trust_level」區塊，其餘位元組不動。

const header = (dir: string) => `[projects."${dir}"]`;
const TRUST_LINE = 'trust_level = "trusted"';

/** 加入或移除 dir 的信任；沒變更回傳 null。看不懂的格式一律丟錯，不猜。 */
export function editCodexProjectTrust(original: string, dir: string, add: boolean): string | null {
  // eslint-disable-next-line no-control-regex
  if (/["\\\u0000-\u001f]/.test(dir)) throw new Error("dir has characters that TOML would need escaped");
  // `[projects]` 或 `projects = {...}` 形式再追加 `[projects."dir"]` 會變成重複定義，不處理。
  if (/^\s*\[projects\]\s*(#.*)?$/m.test(original) || /^\s*projects\s*=/m.test(original)) throw new Error("projects is defined in a form this editor does not edit");
  const lines = original.split("\n");
  const at = lines.findIndex((line) => line.trim() === header(dir));
  if (add) {
    // 同一個標頭已存在（含尾端註解）就不再追加，免得重複定義讓 codex 讀不了設定。
    if (lines.some((line) => line.trim().startsWith(header(dir)))) return null;
    const body = original === "" || original.endsWith("\n") ? original : `${original}\n`;
    return `${body}${body === "" ? "" : "\n"}${header(dir)}\n${TRUST_LINE}\n`;
  }
  if (at < 0) return null;
  // 只移除「標頭＋trust_level＋（空行／檔尾／下一個資料表）」，有別的內容就不碰。
  if (lines[at + 1]?.trim() !== TRUST_LINE) return null;
  const after = lines[at + 2]?.trim();
  if (after !== undefined && after !== "" && !after.startsWith("[")) return null;
  const from = at > 0 && lines[at - 1]!.trim() === "" ? at - 1 : at;
  return [...lines.slice(0, from), ...lines.slice(at + 2)].join("\n");
}
