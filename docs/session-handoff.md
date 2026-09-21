# 跨 CLI Session Handoff Skill

日期：2026-09-18。需求來自[分享對話](https://chatgpt.com/share/6aacdb85-1a34-83ee-b9e5-9a6a968a3a84)：Agent 接近 quota 上限時保存進度，接手方優先讀指定 session 的原生歷史並繼續工作，包含 Gemini Antigravity（agy）。

2026-09-20 更新：Bridge 已新增 [Phase 3 Session Handoff Runtime](session-handoff-runtime.md)，提供 durable checkpoint、接手驗證、ownership 與續作。下文 2026-09-18 的 skill-only 說明與舊 bounded handoff 比較保留為歷史；Phase 3 現行行為以上述文件為準。

2026-09-18 提供 [session-handoff skill](../skills/session-handoff/SKILL.md)、[adapter 指引](../skills/session-handoff/references/adapters.md)與 [HANDOFF.md 範本](../skills/session-handoff/assets/HANDOFF.md)。它是 Agent 執行的 Markdown 流程，不是背景服務或 bridge runtime 新功能。真實跨 CLI 驗收待完成，見 [ISSUE-017](known-issues.md)。

## 與現有 bridge handoff 的差異

| 面向              | Bridge `handoff`                                               | Session-handoff skill                                                                   |
| ----------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 執行方式          | 透過 Herdr 送 prompt，來源與目的地須能解析，目的地須可接收工作 | 來源／接手 Agent 讀取 skill 執行，不依賴 Herdr／Discord                                 |
| 資料              | `agent.read recent_unwrapped` 最近終端輸出                     | 指定 session 的可讀原生歷史優先，再 fallback 到本機匯出、checkpoint＋專案檔案、終端摘錄 |
| 範圍              | 預設 40 行／最多 6,000 字元；非完整對話或模型生成的完整摘要    | 復原目標、限制、決策、失敗嘗試與待辦，明載截斷與缺漏                                    |
| 來源 quota 已耗盡 | 來源仍能被 Herdr 列出、讀取時，可轉送現有畫面                  | 接手方讀既有紀錄，不要求來源再呼叫模型產生摘要                                          |
| 預先保存          | 無通用 checkpoint                                              | HANDOFF.md 保存 session identity、工作樹、授權、驗證及下一步                            |
| 接手確認          | dispatch 成功後更新 routing，未驗證任務復原                    | 核對 cwd／HEAD／diff、writer ownership，留下接收紀錄再執行                              |
| 同時修改          | 不停止來源 Agent                                               | 確認交接範圍只有一個 writer；Markdown 紀錄不是程式鎖                                    |
| 介面影響          | 摘錄回覆到 Discord／console，再送目的 Agent                    | 本機檔案，不改 bridge routing、不發送其他 Agent 訊息                                    |
| 自動 quota 切換   | 無                                                             | 無；有可見訊號時依流程 checkpoint，未安裝 quota watcher                                 |
| 可移轉內容        | 有界可見摘錄與使用者指示                                       | 可復原任務資訊，不移轉模型記憶、hidden reasoning、process 或 quota                      |

依據：[handoffAgent](../src/main.ts)、[SPEC](../SPEC.md)。本機獨立 console 另有 workspace active selection；handoff dispatch 成功不等於所有介面均已完成選取，後續以 `current` 核對目標。

AgentPool 的 `same-session` 是重用既有 CLI；新 session 的任務／Worker 報告仍有界。Codex transcript capture 是擷取本次 prompt 的回覆。兩者均非跨 CLI 歷史移轉，見 [Agent Pool 設計](agent-pool-console.md)。

## 使用方式

以下是交給 CLI Agent 的自然語言 prompt，不是 shell 指令或通用 slash command。

來源額度快用完：

```text
請讀取 skills/session-handoff/SKILL.md，為目前任務準備交接。
保存 checkpoint、原生 session ID、工作樹狀態與下一步；完成後停止本次任務的修改，
告訴我交接檔的絕對路徑，讓另一個 CLI 接手。
```

若只要持續保存而不交出工作，改說「請維護 checkpoint，重要里程碑與長操作前更新，暫時繼續工作」。這時標為 `checkpoint-only`，不代表來源停止。

接手方：

```text
請讀取 <skill 絕對路徑>/SKILL.md，使用 session-handoff 接手
Claude Code 名為 <session-name> 的 session，workspace 是 <絕對路徑>。
交接檔在 <HANDOFF.md 絕對路徑>。優先讀取原生歷史，核對檔案與 writer 狀態後繼續。
```

沒有 checkpoint 也可提供來源 harness、session ID／名稱及 workspace，由接手方讀可存取歷史、核對狀態並補紀錄。同名 session 必須消除歧義。來源已達 quota 不需再回答；既沒有歷史也沒有任務證據時，需補充目標／匯出內容，不能宣稱完整復原。

預設產物為任務 workspace 下 `handoffs/<UTC-timestamp>-<task-slug>/HANDOFF.md`，亦可指定本機位置。本次未擷取真實 session 或產生真實交接封包，交付只有 skill 與空白範本。私人對話封包與原始匯出不應直接提交。

## 手動安裝與相容性

整個 `skills/session-handoff/` 可單獨複製，附件皆在目錄內。依使用者指定位置，稍後可自行執行；目標已存在時先比較，不直接覆蓋：

```sh
mkdir -p ~/.agent/skills
cp -R -n skills/session-handoff ~/.agent/skills/
```

本次沒有執行安裝。`~/.agent/skills` 是使用者選定的保存位置，**不是所有 CLI 保證自動搜尋的共同路徑**。未自動發現時，直接要求讀取 `~/.agent/skills/session-handoff/SKILL.md`；前提是 Agent 有讀檔權限。自動發現需依 CLI 版本配置，不能將 `$session-handoff` 或 `/session-handoff` 視為通用語法。

Claude Code、Codex、Copilot、OpenCode 的本機歷史／匯出方式與官方來源見 adapter 指引。AGY 能作來源與接手方，但 `--conversation` 只證明同 harness resume。本機 `agy --help` 未提供通用歷史 export 子命令；無可讀歷史介面時使用 checkpoint／可讀匯出。AGY 與 `gemini` CLI 分開處理，不能假設共用 history 格式。

## 驗證與限制

本次僅 skill／文件，未修改 bridge TypeScript、build 或執行中的服務。檢查紀錄見 ISSUE-017；文件驗證不等於真實跨 CLI 接手。自動 quota 監控、目的地額度選擇、Bridge 自動派送／routing 整合、通用 session 格式轉換器均未實作。

實際驗收需記錄日期、兩端版本、來源 ID、workspace／HEAD、交接檔與結果：

1. Claude Code → Copilot／Codex：找回原始限制與失敗嘗試，保留 dirty files，完成一項剩餘工作。
2. AGY → 另一 CLI、另一 CLI → AGY：分別驗證可讀來源／fallback，不以單方向成功宣稱雙向原生支援。
3. 來源已無額度且無 checkpoint：接手方讀既有歷史，不呼叫來源模型。
4. 同名 session、不同 worktree、過期 checkpoint：確認 identity，保留新修改、不退回舊摘要。
5. 來源／背景作業仍在寫入：先唯讀復原，釐清 ownership 後才修改重疊範圍。
6. 歷史遺失／截斷、目的地也無 quota：明載缺口或受阻，不宣稱完整接手。

換 CLI 不代表換 provider/account，不會重設五小時 quota。目的地仍須有額度與存取權。Skill 只能在 Agent 能執行時保存，因此不能保證毫無預警的 hard limit 前自動 checkpoint。
