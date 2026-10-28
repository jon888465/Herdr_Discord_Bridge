# Hook／協定通道提案：TUI 留在 Herdr，bridge 另走結構化事件

更新日期：2026-10-28。狀態：**Claude `Stop` 與 `PermissionRequest` 已實作、部署並經使用者驗收（2026-10-28）；Codex Stop、agy Stop 已驗收；pi 擴充與遠端 machine（agy）已驗收**。以下「已查」只代表讀過文件或二進位字串，「已驗證」才表示在本機實測過。已驗證項目見下方「Claude 實測結果」，其餘皆未驗證。

## 目標

CLI 的 TUI 繼續留在 Herdr pane（使用者可直接看與操作），bridge 同時取得結構化的「回合結束」「最終回覆」與「權限請求」，不必只靠 `herdr pane read` 的畫面擷取判斷。畫面擷取造成過 ISSUE-036／040／044（完成誤判、重複貼出、截短）。

## 硬性約束：Parser 路徑永遠保留

- 螢幕 parser（`cli-adapter.ts`、`streamAgent` 現有擷取與強制收尾）是**備用通道，不移除、不降級**。
- 每個 agent 的通道可選（暫定設定 `transport: "auto" | "hook" | "parser"`）：`auto` 在 hook 事件於時限內到達時用 hook，否則退回 parser；`parser` 強制舊行為。
- 以下情況必須退回 parser：CLI 沒有對應 hook、hook 未安裝或版本不符、hook 事件逾時未到、遠端 machine 無法回報、bridge 重啟期間遺失事件。
- 即使全部 agent 都驗證可用 hook，也不得刪除 parser；兩者結果不一致時以明確標記回報，不靜默擇一。
- 新增或調整行為時同步 `SPEC.md`、`docs/known-issues.md`，並分開記錄「原始碼／測試」與「live 驗收」。

## 已查：各 CLI 能力

| CLI                     | 完成事件                                                                                                                                                                                                                               | 權限請求                                                                                                                                                                                                                                                                                                                        | 備註                                                                                                                                                                  |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude                  | `Stop` hook，輸入含 `last_assistant_message`、`transcript_path`、`background_tasks`（已讀官方 hooks 文件）                                                                                                                             | `PermissionRequest` hook 可回傳 `decision.behavior` allow／deny，含 `updatedInput`、`updatedPermissions`；`PreToolUse` 亦可決定（已讀文件）                                                                                                                                                                                     | command 型 hook 預設逾時 600 秒；也有 `http` 型 hook，可直接 POST 給 bridge。使用者中斷（interrupt）時不觸發 `Stop`；API 錯誤走 `StopFailure`。逾時的 hook 不產生決定 |
| Codex                   | `Stop`（輸入含 `last_assistant_message`、`transcript_path`、`turn_id`；exit 0 時不可輸出純文字，空輸出視為成功）；已讀官方 hooks 文件（2026-10-28），規格與 Claude 幾乎相同，**未實測**。另有 app-server 協定（共用 thread，見 spike） | `PermissionRequest`：輸出格式同 Claude（`decision.behavior` allow／deny，deny 可帶 `message`；不得回 `updatedInput`／`updatedPermissions`／`interrupt`）；無 hook 決定時走原本核准流程；只在需要核准的指令觸發。**新增或修改的 hook 須在 Codex `/hooks` 審查並信任後才會執行**（信任紀錄存在 `config.toml` 的 `[hooks.state]`） | `~/.codex/hooks.json` 目前只註冊 Herdr 的 `SessionStart`；config 已有 `hooks = true`                                                                                  |
| agy | 有 hooks（`~/.gemini/config/hooks.json`，事件 `SessionStart`／`PreInvocation`／`PostInvocation`／`PreToolUse`／`PostToolUse`／`Stop`；已讀二進位內嵌文件並**實測** `Stop`／`PostInvocation`／`SessionStart`）。`Stop` 輸入含 `conversationId`、`terminationReason`、`fullyIdle`、`transcriptPath`，**不含最終回覆**，要讀 transcript 的最後一個沒有 tool_calls 的 `PLANNER_RESPONSE`；hook 必須在 stdout 輸出 JSON 物件。`PreToolUse` 可回 `allow`／`deny`／`ask`／`force_ask`，但每次工具呼叫都會觸發、無法區分是否需要核准，且在 `-p` 模式沒有觸發，所以權限仍走 parser |
| pi | 有擴充 API（TypeScript，`~/.pi/agent/extensions/`；已讀本機 pi 1.3.0 內建文件與型別）：`agent_end`（含 messages）、`agent_settled`（含 `aborted`）、`tool_call`（可 block）。pi 沒有內建權限提示，權限只存在於使用者自己裝的擴充，所以只做完成通知 |
| opencode／grok | Herdr 已安裝 state hook／擴充，但事件種類**未查** |

Herdr 現有 `herdr-agent-state.sh` 只處理 `SessionStart`（回報 session id 與 transcript 路徑），是單向回報，檔頭註明自訂 hook 應放在旁邊而非修改該檔。

## 設計草案

1. bridge 在本機開一個 hook 事件入口（unix socket 或 loopback，需驗證來源，避免任意程序偽造回合結束）。
2. 於各 CLI 設定旁加自訂 hook（不改 Herdr 管理的檔案），事件帶 `pane_id`（`HERDR_PANE_ID`）、session id、事件名稱與內容，轉給 bridge。
3. `Stop`：以 `last_assistant_message` 當最終回覆並標記完成；bridge 與現有 turn 關聯（prompt／session）後貼 Discord。
4. 權限：`PermissionRequest` hook 把請求轉給 bridge，在 Discord 顯示並等待使用者選擇，再把決定回給 hook；TUI 端同時是否還顯示提示、使用者在 TUI 先按掉時如何撤銷 Discord 請求，需實測。
5. 遠端 machine：hook 在遠端執行，需透過既有 SSH 轉發通道回報；首版可只支援本機。

## Claude 實測結果（2026-10-28，本機 macOS，claude 於 Herdr 臨時 pane，以 `--settings` 檔註冊 hook；測試檔已清除）

已驗證：

1. `Stop` hook 確實觸發。輸入含 `session_id`、`transcript_path`、`prompt_id`、`permission_mode`、`last_assistant_message`（測試回覆 `DONE` 與畫面一致）、`background_tasks`、`session_crons`。
2. `PermissionRequest` hook 在 `--permission-mode default` 下觸發，輸入含 `tool_name`、`tool_input`（Bash 的 command／description）、`prompt_id`。在 auto mode（本機預設）下不會出現權限提示，也就不會觸發。
3. hook 等待期間，**TUI 同時顯示權限提示**（使用者可在 TUI 直接決定）。
4. hook 回傳 `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}` 後，TUI 提示自動消失並執行該工具（檔案已建立）。deny 路徑未測。
5. 使用者在 TUI 先按 Enter 決定時，工具照常執行；但等待中的 hook 行程**不會被取消**，至少 20 秒後仍存活，直到它自己逾時。bridge 必須自行處理孤兒等待（hook 設合理 timeout、收到 TUI 先決定時放棄並撤銷 Discord 請求）。

未驗證：deny 與 `updatedPermissions`、hook 逾時後 TUI 的行為、`http` 型 hook、bridge 以外程序偽造事件的防護、`Stop` 事件與 bridge 現有 turn 的關聯（可用 `prompt_id`／session）、遠端 machine。Codex／agy／pi 仍完全未測。

## 權限請求與 TUI 先決定（設計約束）

parser 路徑已有處理：agent 離開 `blocked` 時 `handleTransition` 作廢待回覆的請求並貼恢復通知，之後 Discord 才回答會被 `deliverApproval` 拒絕（「agent is no longer blocked」）。已貼出的通知訊息不會被刪除。hook 路徑多一個問題：等待決定的 hook 行程不會被 CLI 取消。`PermissionRequest` 實作時須：hook 設合理 timeout；沿用 `blocked` 離開事件作廢 Discord 請求，同時讓 bridge 結束對該 hook 的等待並關閉連線；hook 在 bridge 無回應或逾時時不輸出決定（回到 TUI 原流程），不得預設 allow。

## 待驗證項目（依序）

1. Claude `Stop` hook 在本機實際觸發、`last_assistant_message` 內容與 parser 擷取一致，且與 `※ recap` 等畫面雜訊無關。
2. Claude `PermissionRequest` hook 等待 Discord 回覆期間：TUI 是否同時出現提示、逾時行為、使用者在 TUI 先決定時的互動。
3. Codex hook 事件的輸入／輸出格式與是否能等待外部決定；對照 app-server 路徑。
4. agy、pi 等的 hook 事件清單；沒有的維持 parser。
5. hook 事件遺失（bridge 重啟、socket 斷）時退回 parser 的流程與重複貼出保護（延續 ISSUE-044 的去重）。
6. 遠端 machine 的事件回報。

## 非目標

不把 bridge 改成 ACP client；ACP／OpenAB 式「每個 thread 自己起一個 agent 行程」與保留 TUI 的目標不同（OpenAB 的各 ACP 轉接程式皆另起 session）。僅在日後要做「不開 TUI 的純 bridge 模式」時再評估重用現成轉接程式。
