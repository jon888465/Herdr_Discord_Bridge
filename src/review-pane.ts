// reviewer 用的新 pane 的開啟與關閉（追蹤清單 F5 階段 3c，使用者 2026-11-04 決定：review 與 coding 的 Agent
// 一律新開 pane、用完關閉）。這一層只管 pane 的生命週期與種類的選擇，不啟動 Agent、不送 prompt。
//
// 安全規則：
// - 只關「自己開的」pane：開啟時記下 terminal id，關閉前重新讀 pane、確認還是同一個 terminal 才關；
//   pane 已經不在就當成已關閉；其他任何情況都回報原因，**不丟錯誤**（呼叫端要告訴使用者，不能因為關閉失敗
//   而吞掉 review 的結果）。
// - 新 pane 可能在獨立 tab；只對核對過的 pane 呼叫 pane.close，不關整個 tab。
// - 開啟時拿不到 terminal id 就拒絕：之後無法安全關閉。

import { HerdrError } from "./herdr.js";
import type { AgentStartPort } from "./agent-start.js";
import { createAgentPane } from "./pane-split.js";

/** 沒有指定種類時的偏好順序；預設選第一個「和作者不同」的。 */
export const REVIEWER_KINDS: readonly string[] = ["claude", "codex", "agy"];

const KIND = /^[a-z][a-z0-9_-]{0,31}$/;

/**
 * 選 reviewer 的種類。預設和作者不同種類（使用者 2026-11-04：盡量不同，沒有可用才用同種類）；
 * `requested` 由使用者明確指定，照用，並回報是不是和作者同種類。種類是否真的能啟動由 `agent.start` 決定，
 * 失敗時回報並停下，不自動換種類。
 */
export function chooseReviewerKind(input: {
  authorKind?: string;
  requested?: string;
}):
  { ok: true; kind: string; sameKind: boolean } | { ok: false; error: string } {
  if (input.requested !== undefined) {
    if (!KIND.test(input.requested))
      return {
        ok: false,
        error: `不合法的 Agent 種類 "${input.requested}"（只接受小寫英數與 _ -，最多 32 字元）`,
      };
    return {
      ok: true,
      kind: input.requested,
      sameKind: input.requested === input.authorKind,
    };
  }
  const kind =
    REVIEWER_KINDS.find((candidate) => candidate !== input.authorKind) ??
    REVIEWER_KINDS[0];
  return { ok: true, kind, sameKind: kind === input.authorKind };
}

/** 開新 pane；版面不足時改開同 workspace 的 tab，cwd 不變、不搶焦點。 */
export async function openReviewerPane(
  port: AgentStartPort,
  input: { basePaneId: string; workspaceId: string; cwd: string },
): Promise<{ paneId: string; terminalId: string }> {
  const result = await createAgentPane(port, input);
  const pane = result.pane;
  if (
    !pane ||
    typeof pane.pane_id !== "string" ||
    pane.pane_id === "" ||
    pane.workspace_id !== input.workspaceId ||
    typeof pane.terminal_id !== "string" ||
    pane.terminal_id === ""
  )
    throw new Error(
      "pane creation returned unexpected workspace/identity; 不會使用這個 pane，請手動檢查",
    );
  return { paneId: pane.pane_id, terminalId: pane.terminal_id };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

/** 關閉自己開的 reviewer pane。永遠不丟錯誤；回報有沒有關成功與原因。 */
export async function closeReviewerPane(
  port: AgentStartPort,
  input: { paneId: string; terminalId: string },
): Promise<{ closed: boolean; note?: string }> {
  if (!input.paneId || !input.terminalId)
    return { closed: false, note: "缺少 pane id 或 terminal id，不關閉" };
  try {
    const current = (await port.request("pane.get", {
      pane_id: input.paneId,
    })) as { pane?: { terminal_id?: unknown } };
    if (current.pane?.terminal_id !== input.terminalId)
      return {
        closed: false,
        note: `pane ${input.paneId} 目前不是我們開的 terminal，不關閉`,
      };
  } catch (error) {
    if (error instanceof HerdrError && /not_found/.test(error.code))
      return { closed: true };
    return { closed: false, note: `讀取 pane 失敗：${describe(error)}` };
  }
  try {
    await port.request("pane.close", { pane_id: input.paneId });
    return { closed: true };
  } catch (error) {
    return { closed: false, note: `關閉 pane 失敗：${describe(error)}` };
  }
}
