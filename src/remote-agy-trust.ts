// remote reviewer 的 agy 預先信任。pod 沒有 node：本機編輯 JSON，遠端只跑固定腳本；值只走位置參數。

import { createHash } from "node:crypto";
import { editTrustedWorkspaces } from "./agy-worktree-trust.js";
// 與 remote-checkout 互相 import：模組層級只用字面值。
import { assertRemoteValue, markerContent, NAME, RemoteFailure, type RemoteExec } from "./remote-checkout.js";

const SHORT_MS = 30_000;
const MAX_B64 = 96 * 1024;
const SETTINGS = '"$HOME/.gemini/antigravity-cli/settings.json"';

/** 輸出第一行是遠端 sha256，其後是原內容；設定檔是符號連結 exit 16、不存在 exit 18。 */
export const TRUST_READ_SCRIPT = `f=${SETTINGS}; [ -L "$f" ] && exit 16; [ -f "$f" ] || exit 18; s=$(sha256sum < "$f") || exit 17; printf '%s\\n' "\${s%% *}"; cat -- "$f"`;

// $1 root、$2 dir、$3 目錄名、$4 marker、$5 add|remove、$6 原 sha256、$7 新內容 base64；檢查同 REMOVE_SCRIPT。
// 持鎖後驗雜湊、備份（600，留 5 份）、mktemp＋mv。退出碼：11–14 同 REMOVE_SCRIPT、15 被改動、16 符號連結、17 寫入失敗、19 鎖逾時。
export const TRUST_WRITE_SCRIPT =
  'r=$(realpath -- "$1") && [ "$r" = "$1" ] && cd -P -- "$r" || exit 11; [ -L "$3" ] && exit 12; ' +
  `if [ -e "$3" ]; then d=$(realpath -- "$3") && [ "$d" = "$2" ] || exit 12; [ -L "$3/.git" ] && exit 12; m=$(cat -- "$3/.git/hdb-card-review") || exit 13; [ "$m" = "$4" ] || exit 14; ` +
  'elif [ "$5" = add ]; then exit 13; fi; ' +
  `f=${SETTINGS}; [ -L "$f" ] && exit 16; w=$6; h() { s=$(sha256sum < "$f") && [ "\${s%% *}" = "$w" ]; }; ` +
  // mkdir 鎖：逾時 exit 19；超過 1 分鐘的殘留鎖回收，未過期的不碰。
  'umask 077; b=.hdb-agy-settings-backups; [ -L "$b" ] && exit 17; mkdir -p -- "$b" || exit 17; l="$b/lock"; n=0; ' +
  'until mkdir -- "$l" 2>/dev/null; do n=$((n+1)); [ "$n" -gt 6 ] && exit 19; if [ -n "$(find "$l" -maxdepth 0 -mmin +1 2>/dev/null)" ]; then rmdir -- "$l" 2>/dev/null; else sleep 1; fi; done; ' +
  `trap 'rmdir -- "$l" 2>/dev/null' EXIT; trap 'exit 1' HUP INT TERM; h || exit 15; cp -- "$f" "$b/settings-$(date +%Y%m%d%H%M%S)-$$.json" || exit 17; ` +
  'ls -1 -- "$b" | sort -r | tail -n +6 | while read -r o; do rm -f -- "$b/$o"; done; ' +
  't=$(mktemp "$f.XXXXXX") || exit 17; if cp -p -- "$f" "$t" && printf %s "$7" | base64 -d > "$t" && h && mv -f -- "$t" "$f"; then exit 0; fi; ' +
  'rm -f -- "$t"; h || exit 15; exit 17';

const REFUSED: Record<number, string> = {
  11: "root 是符號連結",
  12: "既有目錄是符號連結",
  13: "既有目錄沒有 marker",
  14: "既有目錄 marker 不符",
  16: "agy 設定檔是符號連結",
  18: "agy 設定檔不存在",
  19: "取得 agy 設定檔鎖逾時",
};
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** 加入或移除 pod 的 trustedWorkspaces；回傳是否改了設定檔。雜湊不符或被改動就重讀（最多 4 次）。 */
export async function editRemoteAgyTrust(exec: RemoteExec, input: { root: string; dir: string; cardHash: string }, add: boolean): Promise<boolean> {
  const root = assertRemoteValue("root", input.root).replace(/\/+$/, "");
  const dir = assertRemoteValue("dir", input.dir);
  const marker = markerContent(assertRemoteValue("cardHash", input.cardHash));
  const name = dir.slice(root.length + 1);
  if (!root.startsWith("/") || !dir.startsWith(`${root}/`) || !NAME.test(name)) throw new RemoteFailure("拒絕信任 root 以外的目錄");
  for (let attempt = 0; attempt < 4; attempt++) {
    const read = await exec(["sh", "-c", TRUST_READ_SCRIPT, "sh"], SHORT_MS);
    if (read.code !== 0) throw new RemoteFailure(REFUSED[read.code] ?? "讀取 agy 設定檔失敗", `exit ${read.code}`);
    const newline = read.stdout.indexOf("\n");
    const hash = read.stdout.slice(0, newline);
    const original = read.stdout.slice(newline + 1);
    if (newline < 0 || !/^[0-9a-f]{64}$/.test(hash) || sha256(original) !== hash) throw new RemoteFailure("agy 設定檔讀回內容與雜湊不符");
    let next: string | null;
    try {
      next = editTrustedWorkspaces(original, dir, add);
    } catch (error) {
      throw new RemoteFailure("agy 設定檔格式不符", String(error));
    }
    if (next === null) return false;
    const b64 = Buffer.from(next, "utf8").toString("base64");
    if (b64.length > MAX_B64) throw new RemoteFailure("agy 設定檔過大");
    // 寫入階段任何 exec 失敗（含 timeout 124／137）都可能已寫入：一律狀態不明。
    const { code } = await exec(["sh", "-c", TRUST_WRITE_SCRIPT, "sh", root, dir, name, marker, add ? "add" : "remove", hash, b64], SHORT_MS).catch((error: unknown) => {
      throw error instanceof RemoteFailure ? new RemoteFailure(error.label, error.detail, true) : new RemoteFailure("寫入 agy 設定檔失敗", String(error), true);
    });
    if (code === 0) return true;
    if (code !== 15) throw new RemoteFailure(REFUSED[code] ?? "寫入 agy 設定檔失敗", `exit ${code}`);
  }
  throw new RemoteFailure("agy 設定檔一直在變");
}
