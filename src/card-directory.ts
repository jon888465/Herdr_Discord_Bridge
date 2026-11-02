import fs from "node:fs";

export type DirectoryCheck =
  { ok: true; exists: boolean } | { ok: false; error: string };

/**
 * 營運卡片目錄的建立與權限檢查（ADR-0002 決定 1、使用者 2026-11-02 選擇「拒絕並提示」）。
 *
 * - 不存在：只讀時回報不存在；要寫入時以 0700 建立。
 * - 已存在但群組或其他人有任何權限、是符號連結、或不是目錄：拒絕，並告訴使用者怎麼處理。
 *   **不會自動修改既有目錄的權限**，也不在不安全的狀態下寫入。
 */
export function ensureCardsDirectory(
  directory: string,
  options: { create: boolean },
): DirectoryCheck {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (!options.create) return { ok: true, exists: false };
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    return { ok: true, exists: true };
  }
  if (stat.isSymbolicLink())
    return {
      ok: false,
      error: `the cards directory ${directory} is a symbolic link; refusing to use it`,
    };
  if (!stat.isDirectory())
    return {
      ok: false,
      error: `${directory} exists but is not a directory`,
    };
  const mode = stat.mode & 0o777;
  if (process.platform !== "win32" && (mode & 0o077) !== 0)
    return {
      ok: false,
      error: `the cards directory is readable by others (mode ${mode.toString(8)}); run: chmod 700 ${directory}`,
    };
  return { ok: true, exists: true };
}
