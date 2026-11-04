// 敏感路徑（追蹤清單 F6，使用者 2026-11-04 決定）：PR 動到這些路徑時，不論 review 結果，
// 將來的 L2 自動 merge 一律退回人工。因為沒有第二個身分（G2 不做、CODEOWNERS 無法代勞），
// 這是 bridge 端的替代保護。
//
// 清單放在程式裡，**而且這個檔案本身也在清單內**：否則 Agent 可以先改清單、再 merge。
// 之後要調整清單，由使用者要求並經人工 merge。結尾是 `/` 的項目是目錄前綴，其餘是精確的檔案路徑
// （`package.json` 只指 repo 根目錄那一個）。比對不分大小寫，因為檢出可能在不分大小寫的檔案系統上。

export const SENSITIVE_PATHS: readonly string[] = [
  ".github/",
  "AGENTS.md",
  "package.json",
  "scripts/",
  "SPEC.md",
  "src/policy.ts",
  "src/github.ts",
  "src/sensitive-paths.ts",
];

function normalize(file: string): string | undefined {
  const parts: string[] = [];
  for (const part of file.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") return undefined;
    parts.push(part);
  }
  return parts.join("/").toLowerCase();
}

function isSensitive(file: string): boolean {
  const normalized = normalize(file);
  // 會爬出 repo 的路徑無法判斷，保守視為敏感。
  if (normalized === undefined) return true;
  return SENSITIVE_PATHS.some((entry) => {
    const rule = entry.toLowerCase();
    return rule.endsWith("/")
      ? normalized.startsWith(rule)
      : normalized === rule;
  });
}

/** 回傳輸入中屬於敏感路徑的檔案（保留原樣與輸入順序、去重）。 */
export function sensitivePathsIn(files: readonly string[]): string[] {
  const found: string[] = [];
  for (const file of files)
    if (isSensitive(file) && !found.includes(file)) found.push(file);
  return found;
}
