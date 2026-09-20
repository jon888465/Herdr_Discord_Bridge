# Phase 3: Session Handoff Runtime

更新：2026-09-20。原始碼／fixture 實作完成，真實跨 CLI、Herdr／Discord 驗收仍待完成，見 ISSUE-019。

## 使用流程

先選取 workspace，兩端須為已存在且 session identity 明確的 Agent；目的地可為 OpenCode、Codex、Claude、Copilot、AGY 或 Gemini 等可接受 Bridge marker 的 CLI。

```text
handoff checkpoint <source-pane> <goal-and-constraints>
handoff status [handoff-id]
handoff packet <handoff-id>
handoff verify <handoff-id> <destination-pane> confirm-source-stopped
handoff accept <handoff-id>
handoff continue <handoff-id>
handoff cancel <handoff-id>
```

Discord 加 `/herdr` 前綴。`checkpoint` 只保存資料，不呼叫來源模型；來源沒有 quota 時仍可保存現存 evidence。`goal-and-constraints` 應明確包含目標、授權邊界、尚未完成工作及下一步；不由 Bridge 猜測缺失的原始需求。

`verify` 的 `confirm-source-stopped` 是操作者對來源與背景 writer 已停止的明確聲明。Bridge 另外確認整個 workspace 的 Agent 均 idle/done、無 Team／stream reservation，再保留該 workspace 的交接控制權。若原 Team Task 尚有 reservation，先依 `team status`／`team cancel` 解決；不修改 frozen roster、不在 active Assignment 中偷偷換 owner。

目的地收到唯讀復原指令與 bundled session-handoff skill，回傳本次 marker 內的 JSON receipt，包括 checkpoint ID、HEAD、fingerprint、destination session ID、接受與否及第一個 next action。Bridge 另行核對实际 repository，不能只信任模型回覆。驗證通過仍由 source 持有邏輯 ownership；`accept` 再核對後持久移交 destination，更新此命令來源的 conversation route；`continue` 再核對一次後才派送工作。Console 的 workspace active routing 優先規則不變；接手以明確 handoff destination 為準，可用 `current` 檢查一般對話目標。

`cancel` 釋放交接紀錄的 reservation，不送 Ctrl-C、不關 pane、不重送 prompt。執行中的 verify/continue 不能被另一個 cancel command 搶先釋放；操作完成或 timeout 後若 session 仍 active，需操作者在 Herdr 核對／停止，才能 cancel。舊 `handoff <from> <to> [instruction]` 保留為有界 terminal 摘錄功能，**不是**新 ownership protocol。

## 架構與狀態

- `handoff-evidence.ts`：唯讀 Git fingerprint、session identity、公開歷史 adapter 與遮蔽常見憑證格式。
- `handoff-store.ts`：version-1 atomic after-image journal、immutable checkpoint identity、state transition、owner、receipt、派送意圖；0600 檔案與 fsync/rename。
- `session-handoff.ts`：workspace 排他、來源停止核對、唯讀 verification、accept／continue、reconcile／cancel；沿用 runTeamTurn 的 ISSUE-014 marker／transcript correlation。
- `main.ts`：console／Discord 指令、workspace／原 guild/channel/thread scope、routing 與普通 ask／approval／model／cancel guard。
- `herdr.ts`：一般 prompt 與 legacy fallback 都不重試不確定送達；atomic prompt wait 既有 retries=0 保留。

狀態：`checkpoint → verifying → verified → accepted → running → completed`。verifying/verified/accepted/running 發生不確定情況轉 `blocked`；checkpoint/verified/accepted/blocked 可在安全條件下 `cancelled`。`accepted` 是邏輯控制權移交，`completed` 是目的 turn 有相符完成報告，不保證使用者的所有業務驗收都通過。

Registry 位於 state directory 的 `session-handoffs/<id>.json`；同步產生 `<id>.HANDOFF.md` 供 skill／人工閱讀。JSON journal 為唯一權威，Markdown 為衍生封包，不是另一個 ownership lock；發生多檔寫入中斷時以 `handoff packet` 重建的內容為準。Registry 必須在 task repository 外，避免自身寫入使 dirty fingerprint 過期。不同 bot 不得共用 state directory。

重啟時所有持有 ownership 的紀錄轉 blocked，保留來源與目的 terminal reservations；已 accepted 的 owner 欄位不倒退。**不恢復舊 Promise、不重送 verification／continuation、不自動宣稱接手完成。** 處理後 cancel，再建立新 checkpoint。

## Repository acceptance

目前只支援同機、同 Herdr workspace、同 canonical Git working tree。Bridge 分別從 Herdr 回報的兩端 cwd 讀取 Git root、HEAD、branch、porcelain status、staged/unstaged binary diff 雜湊，以及 untracked regular files／symlink 的內容或連結目標雜湊。Registry 不保存原始 diff 或 untracked 檔案內容。Dirty 檔名相同但內容變更也會拒絕；不 reset、stash、checkout、覆寫或搬移工作樹。

拒絕 submodule repositories，避免只用 submodule dirty flag 錯認內容未變。Ignored files 不包含在 fingerprint；外部資料、資料庫與背景程序必須由操作者另行確認。最多 10,000 untracked files、總計 32 MiB；Git 子程序上限 15 秒／32 MiB output，超限明示失敗。檔案系統與 Herdr 沒有跨程序原子鎖；唯讀指令是模型契約，並非 OS sandbox。驗證前後可偵測多數變更，無法保證外部 writer 沒有短暫修改再還原。

## Session adapters 與公開匯出

| 來源                                   | Runtime 實作                                                                                                                            | 缺漏                                                                               |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Codex                                  | 在配置的 CODEX_HOME/sessions 中找唯一 exact session ID JSONL，核對 session_meta cwd，選 public event_msg user／commentary／final_answer | 支援格式、4 MiB 讀取與 catalog 上限內；不代表完整歷史，不讀 reasoning/tool payload |
| Claude、Copilot、OpenCode、AGY、Gemini | 明確 public-export-v1 或 checkpoint/artifact fallback                                                                                   | 未自動解碼各 CLI 原生 DB／私有格式，不呼叫來源模型或 export CLI                    |
| 其他 CLI                               | 同一公開匯出契約或 checkpoint fallback                                                                                                  | 目的地需遵守現有 Bridge marker；版本相容待 live 驗收                               |

AGY 與 Gemini 分開識別，沒有把 AGY 當成 Gemini CLI 的 history。缺失、歧義、不支援或過大的 Codex native history 會標示 partial fallback；不自行選最近一次對話。所有模式保留 exact source session identity；未知身份不可接手。

需要匯入公開訊息時，在 task repository 內準備 UTF-8 JSON（最多 4 MiB）：

```json
{
  "schemaVersion": 1,
  "harness": "opencode",
  "sessionId": "exact-source-session-id",
  "cwd": "/absolute/repository/root",
  "messages": [
    { "role": "user", "text": "目標與限制" },
    {
      "role": "assistant",
      "channel": "final",
      "text": "已完成工作、驗證與剩餘事項"
    }
  ]
}
```

```text
handoff checkpoint-file <source-pane> <relative-export.json> <goal-and-constraints>
```

這是 **Bridge 定義的公開匯出 schema**，不是宣稱所有 CLI 原生 export 都長這樣。僅 user 與 assistant commentary/final text 進入封包，其他 role/channel 忽略；檢查 harness、exact session ID、canonical cwd。symlink 不可逃出 repository。保留首尾有界文字（32,000 字元），標示缺漏，不複製全部 terminal 歷史或 hidden reasoning。常見 token／private-key 字串遮蔽不是完整 DLP；勿將私人 runtime checkpoint 或 raw exports 提交到公開 Git。

## Live acceptance／Phase 4 邊界

必要 live 記錄：bridge commit、兩端 CLI／Herdr 版本、session IDs、handoff ID、repo／HEAD／dirty 狀態、source/background writer 停止證據、receipt 與 continuation 結果。

1. AGY → OpenCode 以 checkpoint fallback；Codex → 另一 CLI 以可用 native public evidence；來源不再回答也可準備 checkpoint。
2. dirty worktree／untracked 工作保留；模型回報錯誤 HEAD、不同 cwd、session replaced、另一個 Worker 還 working 時拒絕。
3. verify 不執行任務；accept 前 source owner 不變；continue 只一次，完成才釋放。
4. verify／continue response loss、timeout、blocked、cancel／restart，保持 quarantine，不重送副作用。
5. 原動態 Team、多問題回覆、ISSUE-014、conversation／attach／watch 回歸。

未包含 Phase 4 Quota / Failover Manager：沒有自動 quota 偵測、目的地 provider 額度判斷、帳戶切換或自動 failover；不改登入與憑證。未部署／重啟使用者 Bridge；fixture 不等於 live acceptance。
