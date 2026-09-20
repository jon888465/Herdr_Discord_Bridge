# Phase 4 Quota / Failover Manager

2026-09-20。原始碼已實作，真實 Discord／Herdr／CLI 驗收待完成，見 ISSUE-020。

## 操作

先選 workspace，確認來源與候選都是已啟動、有 exact session metadata 的 CLI。
候選清單由操作者確認具有所需工具、模型與任務能力；Bridge 不猜測能力或自行啟動 CLI。
Console 指令如下，Discord 加 `/herdr` 前綴：

```text
failover arm <source-pane> <candidate-pane1,candidate-pane2> <goal-and-constraints>
quota report <candidate-pane1> available <destination-budget-group> 900
quota report <source-pane> limited <source-budget-group> 900
quota status [pane]
failover status [id]
failover run <id> confirm-source-stopped
failover cancel <id>
```

`arm` 保存原任務、限制、來源、候選優先序及確切 session。目標必填、最多 6,000 字元，包含未完成工作及原授權；同來源不能同時有多個未結束 policy。候選最多 16 個，不能重複 terminal 或跨 workspace。若先前已回報 limited/exhausted，arm 後需再次明確 report 才觸發 checkpoint；arm 本身不發送 prompt。

`report` 接收 `available | limited | exhausted | unknown`。明確來源 limited/exhausted 回報觸發已 armed policy 的 checkpoint，讀現存公開紀錄／檔案，不呼叫來源模型。保存成功後為 `ready`，仍可讓來源繼續，但後續檔案變動會使 checkpoint 過期；需取消舊 policy、重新 arm/report。

`run` 必須由操作者先確認來源與背景 writer 均已停止；參數是實際停止聲明，Bridge 不會停止程序。它選擇第一個合格候選，依序進行 Phase 3 唯讀復原、repository acceptance、ownership transfer、continuation。完成後將目前指令 context route 綁到目的地；其他 route 不變。`completed` 只代表取得本次 CLI report 且 sessions settled，不能當成业务需求或所有測試已驗收。

`failover status` 顯示 linked handoff ID；以 `handoff status <id>`、`handoff packet <id>` 檢視公開 evidence、receipt、owner 與實際工作報告。執行失敗後查兩份紀錄；切換後 owner 可能已是 destination，不能因 failover blocked 就繼續寫 source。

## 額度訊號與選擇契約

- 第一版是 normalized operator observation adapter：記錄 exact session、state、budget group、reportedBy、observedAt、expiresAt。不是 provider API 的量測，不估算剩餘 token、百分比或 reset time。
- 有效期預設 900 秒，可指定 30–3,600 秒。無回報、過期、系統時鐘倒退至 observation 前均視為 unknown；到期不表示 quota reset。`quota status` 對 live sessions 顯示有效回報或 unknown。
- Budget group 是操作者指定的非敏感額度池代號（1–80 個英數、底線、連字號）；同 account/subscription/provider 共享額度的 CLI 必須使用相同代號。不要填 credentials、email、API key。Bridge 無法自行驗證帳戶歸屬或回報真實性。
- Context window 剩餘量不代表 account quota；短期 request rate limit 也不證明 account budget 已耗盡。只回報已確認與該額度池有關的可用性，不知道就填 unknown，不從 CLI 任意文字猜測。
- 來源必須仍有新鮮 limited/exhausted 回報。目的地必須是 frozen allowlist 中仍相符、idle/done、有新鮮 available 回報、且與來源不同額度池的 session。不同 CLI 名稱本身不等於不同額度池。
- 候選額度池只要存在另一筆未過期 limited/exhausted/unknown 回報，就保守拒絕。可用狀態不會覆蓋同池其他 session 的衝突證據；應核對後更新各 session 回報或等其失效。
- 在讀取 live session 後選候選，verify 後及 accept 後再檢查 quota。觀察與真正 provider 接受請求之間仍有競態；額度可能在下一次呼叫耗盡，不保證完成。
- 沒候選時保留 ready，不發送 prompt；可更正 observation 後 run。開始驗證後遇錯誤就 blocked，禁止自動改選下一個候選或重送有副作用的工作。重新開始需先檢查／停止 writer、cancel，再建立新 policy/checkpoint。

## 持久化與故障

`stateDirectory()/quota-failover.json` 使用 schema v1、單調 sequence、完整 after-image journal、temp write/fsync/rename；權限 0600。保存 quota 與 policy 狀態／不可變來源、候選、goal、origin；linked checkpoint 與 destination 一旦指定不得替換。無法保存時 fail closed，該 store instance 禁止後續 mutation，先修復儲存並重啟檢查。

狀態：`armed → checkpointing → ready → running → completed`；中途失敗為 blocked。armed/ready/blocked 可取消；取消已開始的 handoff 必須符合 Phase 3 settled-workspace 要求，不發送 Ctrl-C。正在 checkpoint/run/cancel 時拒絕同 policy 其他動作。

先保存 checkpoint intent 才建立 checkpoint；先保存 failover intent/destination 才驗證接手。重啟將 checkpointing/running quarantine 為 blocked，不 replay；armed/ready 留存但沒有自動執行，quota 仍受 TTL 限制，run 仍核對 Git/identity/owner。Phase 3 在啟動时先恢復 workspace reservation。

Checkpoint 與 policy 屬兩個獨立 journals。若在 checkpoint 落盤後、policy 連結保存前崩潰，可能留下無 policy link 的 checkpoint；以 `handoff status` 檢查並明確 cancel，不能自動猜測是哪份或 replay。Continuation 完成但 failover 最後紀錄保存失敗也可能不同步；以 linked handoff evidence 檢查後處理，不重送工作。

上限 1,024 個 session observations、256 個歷史 policies；到達上限拒絕新增。尚無 retention/compaction 或跨程序 state-directory lock，不能靠刪掉 journal 解除未知 ownership。沿用 Bridge instance lock 限制。

## 權限與現行範圍

Discord policy status/run/cancel 限原 guild/channel/thread；console 限目前授權 workspace。Quota 是該 workspace 的共享觀察，同 workspace 的既有授權操作者可回報；由此觸發其他 context policy 的 checkpoint 時，不在回覆中洩漏其 ID／goal。仍須回到 policy 原 context（或同 workspace console）執行 run。

Phase 3 的同機、同 canonical Git tree、HEAD/branch/staged/unstaged/untracked fingerprint、exact session、receiver receipt、Bridge workspace reservation 仍是必要條件。Ignored files／外部資料未涵蓋，submodule 拒絕。Active Team 必須先結束／取消；不替換 frozen Lead/roster。來源消失、identity unknown、workspace 有工作中 Agent、檔案變動時拒絕驗證。外部 writer 的停止仍須人工確認。

不自動登入、切帳號、改 credentials/billing、推測 provider budget、建立未知 session 或自動合併／部署。尚無 provider-specific telemetry watcher、百分比門檻、scheduled reset、Team mid-turn migration；這些不是已實作的功能。其他 CLI 原生歷史支援仍以 [Phase 3 adapters](session-handoff-runtime.md) 為準；`session-handoff` skill 本身仍獨立可用。

## 驗證與 live acceptance

自動化 fixtures／測試紀錄見 [ISSUE-020](known-issues.md)。所有 tests 只使用 temporary Git、fake Herdr/Discord、fake clock，不代表真實 provider quota 或模型接手成功。本輪未部署／重啟 Bridge，running version 未核對，舊訊息與舊工作不補送。

在授權的實機上另驗收：

1. 兩個確切 session、已確認不同額度池；arm 並回報来源 limited，核對 checkpoint 不使用來源模型。
2. 確認停止 source/背景工作，run 後核對兩次目的地 prompt、receipt、原 dirty files、owner、目前 route 與工作報告。
3. 候選 unavailable/unknown/stale/同額度池／同池衝突／身份替換時拒絕；沒有其他 CLI 偷跑。
4. 真實 quota exhaustion／CLI blocked／socket acknowledgement 遺失時 blocked，無重試其他 session；settled 後才 cancel。
5. 在 checkpointing、verification、accepted、continuation 各時点重啟：觀察 quarantine、reservation、不 replay 與兩個 journal 的對照結果。
6. Discord 原 thread scope、console workspace scope、active Team／外部 writer 的阻擋；AGY／OpenCode／Codex 的實際版本、adapter coverage 與缺漏逐一記錄。
