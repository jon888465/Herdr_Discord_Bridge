# 卡片角色指定（REQ-20261110-card-role-assignment）

更新：2026-11-10。原始碼實作；實機尚未驗收，執行中的 bridge 未重啟。

## 範圍與語法

本卡依 Lead 決定交付 machine 宣告、驗證與 **local 強制執行**。已配置 remote 仍在撿卡前拒絕「卡片流程尚未支援 machine X」，不存在的 machine 則報不存在；不提供跨機器工作副本、版本同步或 remote 派工。這是目前卡片架構限制，不代表矩陣的遠端格已通過。

<!-- prettier-ignore -->
```yaml
lead: codex
roles: {implement: "local:claude:sonnet", diagnose: "local:codex", review: "local:codex", verify: "local:claude", reviewer: "local:agy", fixer: "local:claude"}
```

`roles` 是一層 inline map，不支援巢狀／多行 YAML。六個鍵如範例；`review` 是 Team coding role，`reviewer` 是 card review／loop，彼此獨立。值為 `<machine>:<agent>:<model>`；只拆前兩個冒號，model 可含冒號。`":claude"` 只指定 agent、`"::sonnet"` 只指定 model、`"local"` 只指定 machine。空 map、全空值、重複／未知角色、非字串、未知欄位拒絕。舊 `lead:` 不變。

沒有 roles 的卡片沿用舊 parser 結果、序列化、預設、roster、事件文字與 hash、best-effort 紀錄。未宣告的角色保留原選擇；宣告角色只約束有寫的維度，machine 省略仍在 local 執行；model 省略沿用選中 profile 的配置或 CLI 預設；若可觀察到實際 model，保留該值並標 observed，只有 profile.model 存在才要求相等，不推測未知 model。宣告不要求每個角色都必須被派工，但不能把實作搬到非 coding／Lead synthesis 繞過 acceptance gate；有 roles 的 assign 必須帶 --coding。

## 開放與 model

只接受 claude、codex、agy、pi。新宣告必須找到已配置、已開放 profile：claude／codex 可用；agy 要 implementation 或 review capability；pi Worker（implement／diagnose／review／verify）尚未開放，pi reviewer／fixer 要上述 capability。未宣告卡的自動入池與手選行為不變。

model 是**管理者配置允許清單**：依 kind 與已開放 profile.model 比對，並沿用同一份 profile 的 modelFlag、args，不能只驗 model 後另猜啟動參數。這不保證供應商存在該 model 或帳號有權使用；CLI 拒絕保留實際錯誤，不 fallback。model 英數起頭，可含 `_ . / : + -`，最多 80 字；控制字元、空白、前導 `-` 拒絕。profile 的 resume／continue／session 綁定與 model 覆寫參數在新宣告流程拒絕；不改全域配置。

省略 agent 而指定 model 時先收斂同種類合法候選，Lead 只能選相符 target；review／fix 預設種類不相容時選合法 model 候選，明確 CLI 不相容則拒絕。

## 守門與快照

1. parser／herdr-card-check 擋結構錯誤。
2. autopick 只對 ready 且 autopickFor 政策選用專案的 eligible 卡，在 picked／開 workspace 前驗六角色；draft、done、未 opt-in 專案不產生角色拒絕事件或通知；manual assign 在建 worktree 前驗。autopick 開 Lead 前重讀指定卡，角色／Lead／ready 改變就拒絕；assign 建 worktree 後在 startTask 再比較角色宣告。
3. 每次 task、review、fix 開始凍結 roles 與候選 profile；config 是程序載入的配置，改設定要重啟。後續不接受 Lead 修改約束；loop 每輪讀當時卡片重新驗證。政策與既有 PR／CI／merge gate 繼續各自驗證。
4. Lead prompt 帶約束與候選 id／kind／model（不附 profile args）。validateAssignmentPlan 以 coding.role、bridge roster 檢查整份計畫；任何違規零 acquire，沿用有限重規劃與 plan_rejected。
5. 宣告角色使用 role:<role>:<profile> target，每個 assignment 新開 pane／session，沿用該 profile，不讀寫 AgentPool 既有 session binding。不共用不同角色／model 的 session；相同 profile id 的啟動也獨立。layout 啟動序列化，執行仍受既有 writer 與 dependency gate。
6. readiness 後重讀 actual actor，驗 machine／kind／pane／terminal／已知 session；指定 model 要 launch 或 observed 證據，未知 model 的既有 session 不算符合。每次實際 prompt 嘗試前（含 agent_not_ready 拒收後的重試）再次查 terminal／session／model，beforeDispatch 仍只記事件一次；不改 Team codex／agy 的延後 session 觀察規則。
7. 有 roles 的 Worker／reviewer／fixer 必須先成功寫角色紀錄才能送 prompt。派工前失敗零 prompt、關閉已知 owned terminal 的新 pane，確認正常完成後也可關閉；執行中 blocked、逾時、取消時未確認停止或送達不明則保留 pane／session，交由既有任務停止與清理規則處理，pending 問題可回覆原 session 續接。指定角色的新 session 不取得 pool lease，Engine task reservation 依既有終態釋放；未宣告角色沿用的 pool binding 遇 strict 紀錄失敗時，只釋放該 owner 的單一 profile lease，保留既有 pane／binding，不影響其他 Worker。terminal 被換掉不關閉，記 console 提醒；新啟動 blocked 或 readiness 未確認的 Worker 保留 pane 給人處理。

card review 的 --agent、card fix 的 --agent，以及 loop 的 --agent／--fix-agent 不能覆蓋卡片明確 agent；一致可接受，不一致在開 pane 前拒絕。autopick reviewer 偏好是 default，卡片有 reviewer 宣告時不再傳衝突 CLI。每輪新 pane、fresh launch；禁止 resume。若已觀察到與作者相同 session，拒絕；未知 session 不假稱已證明獨立。Team 原有 codex／agy 結果端 session gate 不變。

## 流程紀錄

無 roles 卡的模板、hash 完全不變。有 roles 的 Worker／reviewer／fixer 用 v2 固定模板，保留 role／agent／model／machine 前綴供 card show 摘要：

```text
impl-1：claude（sonnet）；machine=local；task=task-…；v=2,cr=i,s=C,ss=CCD,me=L
```

codingRole：`cr=i/d/r/v`＝implement／diagnose／review／verify；reviewer／fixer 為 `-`。assignmentId 由 role 還原，不重複印：一般同 role；若原 id 是 lead（或 assignment- 前綴的 lead），role 多加一個 assignment-，還原移除一個前綴。source：`s=C/L/D/I`＝card／lead／default／CLI。selectionSources：`ss` 三碼依序 machine／agent／model，使用相同代碼。modelEvidence：`me=L/O/U`＝launch／observed／unknown。未知 model 不寫 model 值。

v2 僅 local 與四種 agent；role 最多64、model80、task64、round最大1000000，完整組合仍不超300字。profileId 不重複印入 v2，完整配置候選在 durable task。parser／serializer／輪替沿用300字與既有格式；model 不截斷。v2 hash 加入來源 metadata，避免舊的少 metadata 紀錄先寫後吃掉新資訊；同一完整事件仍去重。role_assigned 表示已準備派工身分，**不代表 prompt 已送達或任務完成**；後續失敗另記。

## 無法解析的卡片

正常 CardStore.readLog／appendLog 要 parse 成功，因此獨立寫 `<cards>/.role-rejections/<id>.json`（0700目錄／0600檔、原子替換），不修改壞卡。card show 解析失敗時顯示診斷原因、delivery、attempts。重啟後仍能查；修正後檔案變更產生新 fingerprint，不把舊原因當新結果。

只從合法 filename、一般非 symlink 且≤1MiB的檔案、≤8KiB header、唯一且與 filename 相符的 id、唯一 ready 與可嚴格解析的 notify 取路由；不猜 malformed／重複的 id／notify。超限、symlink、不可讀、缺可信路由仍保存診斷、console 可見，不向不確定目的地傳送。卡片來源與格式不合法不會被重寫成有效卡。

先持久化再送通知。寫入失敗每次掃描重試並 console 報錯；送達失敗保留 pending／attempts，下一次掃描及重啟續試，成功才 sent。Agent 忙碌／blocked 也屬待送；與正常 notifier 共用完整選單檢查（含 allow once、skip until next version、Do you want、選擇選項）；送前兩次核對 pane／terminal／kind／idle，每次讀畫面後再讀身分及狀態，讀取期間替換／轉忙碌不送。通知送達但 sent 寫入失敗可能重複，採至少一次語意，不宣稱 exactly once。沒有可信路由記 no_trusted_route，修復卡片後再處理。有效卡拒絕帳本寫入失敗不加入程序去重集合，下一輪重試。

## 驗證與待辦

自動化測試證據統一記 ISSUE-138。既有測試不得改動；新增測試驗解析、允許清單、前置拒絕、計畫／實際身分守門、來源容量、快照、壞卡重試、strict 失敗清理與 fresh session。build／單元測試不代表實機驗收。

merge、重啟新版後需跑三張真卡：兩角色不同 agent 且一角色指定 model（pane／啟動紀錄獨立佐證）、無效 agent／model 在撿前拒絕且通知正確、Lead 故意不符計畫被擋且無違規 Worker prompt。保存卡 id、日期、環境、role_assigned 原文與結果到 known-issues 與角色矩陣；完成前不標已驗收。

w1 階段自動化證據（2026-11-10）：typecheck、lint、npm test（含 build）、git diff --check 通過；1682 項、1681 pass、0 fail、1 既有 skipped。新增47項；未修改既有測試。這仍不是三張實機卡的驗收結果。

r1 修正自動化證據（2026-11-10，w2）：新增27項回歸測試，targeted 27/27 pass；typecheck、lint、完整 npm test（含 build）與 git diff --check 通過，1709項／1708 pass／0 fail／1既有 skipped。原有測試含 w1 新增測試未修改；完整歷史見 ISSUE-138。沒有部署或實機驗收證據。
