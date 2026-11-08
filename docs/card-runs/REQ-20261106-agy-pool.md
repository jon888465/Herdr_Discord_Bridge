# 卡片處理記錄：REQ-20261106-agy-pool（把 agy 加入 agent pool）

更新日期：2026-11-06。狀態：**程式部分完成、agy 實機驗證未做**（目標導向的卡經過六次嘗試，暴露並修正了 5 個缺口；最後拆成三個 PR 合併，見「執行結果」）。

這份文件保留一張卡片從「怎麼寫」到「Lead 怎麼處理」的完整過程，作為 card 功能自動化處理流程的樣本。日後回頭看哪裡可以改進，以及比較「指定做法的卡」與「目標導向的卡」的差異。**卡片本身在 bridge 的狀態目錄（不進 git），merge 清理後會刪掉，所以兩個版本的全文都留在這裡。**

## 為什麼有兩個版本

2026-11-06 使用者要「把 agy 加入 agent pool」。

- **第一版（指定做法）：** 我（Agent）先預判風險——agy 作為 coding Worker 還沒實機驗證——於是在卡片裡替 Lead 做了設計決定：只做一個小開關（agy profile 含 `implementation` 才自動啟用），其餘問題（回覆辨識、獨立性判斷等）都不在範圍內。
- **使用者的更正：** 這些「沒驗證、會碰到的問題」**本來就是這張卡要處理的範圍**。卡片應該讓 Lead 自己去考量會碰到的問題、拆解、與其他 agent 討論並 review，最後才分配實作。
- **第二版（目標導向）：** 只寫目標與不可做的事，把「找問題 → 拆解 → 討論／review → 分配實作 → 驗證」的過程交給 Lead，並要求如實區分「已實機驗證」與「待驗收」。

## 兩種寫法的差異

| 面向                | 第一版：指定做法                                                     | 第二版：目標導向                                                                                |
| ------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 卡片說了什麼        | 要改哪個函式、怎麼判斷、要哪 4 個測試                                | 目標、Lead 要走的流程、不可做的事、驗收條件                                                     |
| 誰做設計決定        | 寫卡的人（我）事先替 Lead 決定                                       | Lead（含與其他 agent 的討論與 review）                                                          |
| 問題發現            | 我憑閱讀預判，範圍被我縮小                                           | Lead 讀程式與 known-issues 後自己列出，範圍由問題決定                                           |
| 與其他 agent 的互動 | 沒有                                                                 | 明確要求拆解與方案要被其他 agent review                                                         |
| 實機驗證            | 明寫「尚未驗證」，不嘗試                                             | 能在任務裡驗證的就驗證（例如讓 agy 擔任一輪 Worker／Reviewer）                                  |
| 風險                | 只解決我看到的問題；Lead 沒有發揮空間；真正的 agy 問題留到之後才發現 | Lead 可能範圍發散、耗時較長、設計偏離使用者預期                                                 |
| 護欄                | 寫在實作細節裡                                                       | 寫在「不可做」：不改 config.json／policy.yml、不降低守門、不 commit／push；預設行為不變只是建議 |

## 想觀察的事（日後據此改進流程）

- Lead 是否真的列出 agy 的問題清單？清單與實際碰到的問題差多少？
- 是否找了其他 agent 討論或 review？討論改變了哪些設計？
- 拆解出幾個子問題、分給誰、誰審？獨立性判斷對 agy 是否成立（agy 的 session 身分怎麼取得）？
- 耗時（撿卡→task 完成→PR→review→merge）與第一版同類卡片（ISSUE-095 約 8 分鐘到 commit）的差距。
- 有沒有守門被觸發（敏感路徑、verify、review 逾時）？目標導向的卡是否更容易偏離「預設行為不變」的建議？
- 驗證證據的品質：單元測試 vs 真的跑過 agy。
- 卡片寫法本身哪裡不足（哪些資訊 Lead 得自己去猜）。

## 執行結果

時間皆為 2026-11-06 UTC。卡片 `REQ-20261106-agy-pool` 在 06:17:58 設為 `ready`，政策 L2（merge 前由 bridge 自己守門）。**結論先說：** 目標導向的卡讓 Lead 真的做出了合理的計畫（先診斷、再討論、再實作、再 review），但每一步都先撞到 bridge 規劃流程的缺口；六次嘗試裡前五次都失敗在「計畫被引擎擋下」或「卡片格式」，不是 Lead 的判斷錯誤。這些缺口都已用「自己修自己」的方式（把修正寫成卡片，由同一條自動流程跑完）補起來。

### 時間線

| #   | 時間              | 結果                                            | 原因與處理                                                                                                                                                                                                    |
| --- | ----------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 06:18:50          | assign 失敗                                     | 卡片沒有 `## 描述`（我寫成 `## 目標`）。補上後重啟。                                                                                                                                                          |
| 2   | 06:21:04–06:21:35 | task 失敗（31 秒）                              | 計畫把唯讀診斷與 writer 放同一回合：`read-only coding assignments in a writer round must depend on that writer`。另外發現卡片的「怎麼做」「不可做」段落根本沒送給 Lead（ISSUE-109）。我把它們併進 `## 描述`。 |
| 3   | 06:24:39          | assign 失敗                                     | 上次殘留的 worktree。我先關了 worktree 的 workspace 才下 `card cleanup`，cleanup 失敗，得手動移除 worktree 並補索引（ISSUE-112）。                                                                            |
| 4   | 06:28:15–06:28:45 | task 失敗（30 秒）                              | 同第 2 次的規則。判斷為提示缺口（ISSUE-103），另開卡修。                                                                                                                                                      |
| —   | 06:32–07:06       | 修提示的卡（ISSUE-103，PR #132）                | 第一次嘗試在 Lead 收不到 replan prompt 後逾時 blocked（15 分鐘，ISSUE-108，pane 只剩 6 行）；丟掉重跑後 06:57:37–07:06:27 完成並由 bridge 自己 merge（`dc9e15e`）。                                           |
| 5   | 07:10:26–07:13:22 | task 失敗（3 分鐘）                             | 兩個唯讀診斷完成，第三個 `critique` 用了 `review` 角色，被退回：`coding review has no implementation artifact`。ISSUE-104（PR #133，`be728e1`，07:16:26–07:23:16 自己跑完）。                                 |
| 6   | 07:25:10–07:29:27 | task 失敗（4 分鐘）                             | 三個診斷完成、第二回合 writer 計畫引用了診斷報告裡的 finding id：`references unknown finding d2-optin-roster`。ISSUE-105（PR #134，`495969f`，07:33:10–07:41:00）。                                           |
| —   | 07:43–07:57       | 計畫驗證失敗的重排機制（ISSUE-106，PR #135）    | review 兩次 `inconclusive`（ISSUE-110），使用者讀 diff 後手動 merge（`a64b4ff`）。                                                                                                                            |
| 7   | 07:58:47–08:51:04 | task 完成（52 分鐘）                            | 三個診斷 → writer（11.5 分鐘）→ review → verify（08:17:02 要求在 sandbox 外跑 `npm test`，使用者 08:29 選「只這一次」）→ commit、PR #136。                                                                    |
| 8   | 08:51:49          | review 沒有執行                                 | diff 73638 字元，超過 review 上限 60000（ISSUE-111）。                                                                                                                                                        |
| 9   | 08:54–09:20       | 拆成三張卡，各自一輪 review 就 pass、自己 merge | #137（`a96fda5`，選用機制）、#138（`fc7398c`，session 登記）、#139（`4e8a1d7`，reviewer 獨立性判斷）。每張約 7–9 分鐘。                                                                                       |

### 修出來的缺口

| Issue         | 內容                                                                  | 狀態                               |
| ------------- | --------------------------------------------------------------------- | ---------------------------------- |
| ISSUE-103     | 規劃提示沒說實作前的唯讀工作要放在沒有 writer 的獨立回合              | 已驗收                             |
| ISSUE-104     | 規劃提示沒說 `review` 只審已完成的實作                                | 已驗收                             |
| ISSUE-105     | 規劃提示沒說 `findingRefs` 只能引用 review 登記的 finding             | 已驗收                             |
| ISSUE-106     | 計畫驗證失敗沒有回饋 Lead 重排的機制                                  | 已修正、待驗收（沒被觸發）         |
| ISSUE-107     | agy 作為 Worker／Reviewer 的支援（三部分）                            | 已修正、待驗收（agy 從未實際跑過） |
| ISSUE-108–112 | 小 pane、卡片段落被丟棄、reviewer 不能驗測試、diff 上限、cleanup 順序 | 見各 issue                         |

### 兩種寫法的實際差異

- **指定做法（第一版）從沒送出。**如果送出，只會得到一個小開關，而 agy 的 session 登記與 reviewer 獨立性問題（ISSUE-107 第 2、3 部分）會留到之後才發現。
- **目標導向（第二、三版）產出了：**Lead 自己列出的 agy 缺口（診斷報告見 `docs/card-runs/REQ-20261106-agy-pool-diagnoses.md`）、一份經過討論與獨立 review 的實作，代價是約 3 小時、六次嘗試、人工介入多次（卡片格式、清理、權限請求、讀 diff 後 merge）。
- 代價大部分花在**自動化流程本身的缺口**，而不是 Lead 的能力。這些缺口現在補了，下一張同類的卡應該少很多摩擦；ISSUE-106 的重排機制還沒被實機驗證。
- 目標導向的卡**也可能產生過大的 diff**，需要一開始就要求「diff 小於 40000 字元」或「分段交付」（ISSUE-111）。

### 「想觀察的事」的結論

- Lead 有列出 agy 的問題清單，且和後來實作的內容對得上（session 登記、reviewer 獨立性、opt-in 機制、capability 語意），見診斷報告。
- 有找其他 agent 討論：三個診斷 + 一個 `diagnose` 角色的 critique（交給 reviewer profile）；critique 指出的設計取捨（opt-in、不放寬守門）實際進了實作。
- 子問題與分派：二診斷平行（claude、codex helper）→ critique（reviewer）→ writer（claude）→ review（reviewer）→ verify（helper）。
- 獨立性：agy 從未擔任過任何角色，所以「agy 的 session 身分能不能取得」只在程式層面處理，沒有實機證據。
- 守門被觸發：敏感路徑（第一張 ISSUE-095 的卡）、review 逾時（第一次修提示的卡）、review 兩次 inconclusive、diff 上限、sandbox 外測試的權限請求。
- 驗證證據品質：單元測試與 CI 通過，**agy 實機驗證零**。

### 卡片寫法的改進建議（供之後的卡參考）

1. 所有要給 Lead 的內容都放在 `## 描述` 底下（ISSUE-109）。
2. 驗收條件只放 reviewer 讀 diff 能判斷的；測試與 build 交給 verify 與 CI（ISSUE-110）。
3. 明確寫 diff 大小上限（建議 40000 字元），預期超過就先拆成多張卡（ISSUE-111）。
4. 目標導向的卡要附「參考實作」的來源（例如前一次嘗試的分支），並限制只取範圍內的檔案，拆分時效果好。
5. 長任務的監看不要只設 30 分鐘：到期時要主動檢查狀態（這次有一次漏看了 10 分鐘的權限請求）。

### 仍未完成

- agy 作為 **reviewer** 的實機驗證（writer 已驗，見下節）；ISSUE-107 是否「已驗收」由使用者決定。
- ISSUE-106（計畫重排）、ISSUE-098／099／100 沒被觸發。
- ISSUE-108（小 pane、Lead 沒收到 prompt）、ISSUE-109 到 112 待決定。
- PR #136（舊的大 PR）仍開著，等使用者決定關閉；遠端分支 `card/REQ-20261106-agy-pool` 與卡片檔 `REQ-20261106-agy-pool.md` 保留作為比對。

## 附錄：兩版卡片全文

### 第一版（指定做法，未送出）

> 這一版寫好但**沒有**放進卡片目錄；使用者指出範圍問題後改寫成第二版。

```markdown
# --coding 沒指定 Worker 時，自動把使用者標為可實作的 agy profile 加入候選

## 描述

E14：`--coding` 沒有指定任何 Worker 時，bridge 會自動啟用 `agentProfiles` 裡 `AUTO_CODING_KINDS = ["claude", "codex"]` 的 profile（至少兩個）。agy 不在其中。不能直接把 `"agy"` 加進 `AUTO_CODING_KINDS`（會改變已驗證流程）。要求改成由使用者自己選用：

- `src/coding-roster.ts` 的 `autoEnableCodingProfiles`：原本 claude／codex 規則完全不變；`kind` 是 `agy` 的 profile，只有 `capabilities` 含 `implementation` 時才一併自動啟用。merge 後在使用者自己加上 `implementation` 之前，行為與現在完全相同。
- 讓 `AutoPool` 的 profile 型別帶 `capabilities`，「至少要有兩個」的規則不變。
- 更新檔頭註解與 `assertCodingRoster` 錯誤訊息，同步 SPEC／README。
- 新增單元測試 (a) 只有 analysis 不啟用 (b) 含 implementation 時一併啟用 (c) 只有一個符合時回空 (d) 既有行為不變。
- known-issues 記錄決定、修正範圍、測試結果，並寫明 agy 作為 Worker 尚未實機驗證。
- 不要修改 config.json、policy.yml；不要 commit、不要 push。

## 驗收條件

- 只有 analysis 的 agy 不會被自動啟用；含 implementation 的會；claude／codex 規則與「至少兩個」不變
- 單元測試修正前失敗、修正後通過；build、lint 通過
- 文件與實作一致，並寫明 agy 尚未實機驗證
```

### 第二版（目標導向，2026-11-06 06:17:58Z 設為 `ready`）

```markdown
---
id: REQ-20261106-agy-pool
type: requirement
status: draft
title: 讓 agy 能正式加入 agent pool，作為 --coding 的 Worker／Reviewer 候選
version: 1
created: 2026-11-06
updated: 2026-11-06
project: local:Herdr_Discord_Bridge
---

# 讓 agy 能正式加入 agent pool，作為 --coding 的 Worker／Reviewer 候選

## 描述

### 目標

使用者的 `config.json` 已有 agy profile（`kind: agy`，目前 `capabilities` 只有 `analysis`），但 `--coding` 沒指定 Worker 時只會自動啟用 claude／codex（`src/coding-roster.ts` 的 `AUTO_CODING_KINDS`，註解寫「agy、pi 還沒驗」）。使用者要把 agy 正式加入 agent pool：讓 Lead 在 `--coding` 時能把 agy 當成候選，由 Lead 依任務決定誰寫、誰審（E14）。

## 怎麼做：這張卡要處理「讓 agy 真的可用」的全部問題，不只是改清單

agy 作為 coding Worker／Reviewer 還沒有實機驗證，我（使用者）不預先指定做法或限制範圍。請 Lead 負責：

1. **先找出會碰到的問題**：讀 `docs/known-issues.md` 的 E14／ISSUE-085／088／089／090／091／094／098／099 與 agy 相關條目、`src/cli-adapter.ts`（antigravity adapter）、`src/hook-agy.ts`、`src/handoff-evidence.ts`、`src/team-turn.ts`、`src/team-task-engine.ts`、`src/agent-pool.ts`、`src/review-pane.ts`（`REVIEWER_KINDS` 已含 agy）、`src/coding-roster.ts`，判斷 agy 走 `--coding` 全流程（啟動就緒、收 prompt、回報格式、transcript／最終回覆辨識、session 身分與「與作者不同 session」的獨立性判斷、verify 回報、reviewer 回覆解析）時有哪些環節對 claude／codex 有特別處理而 agy 沒有，哪些已經通用。
2. **拆解問題，並與其他 agent 討論、請其 review 你的拆解與方案**（團隊裡的其他 agent；Lead 可自行決定找誰、討論幾輪），不要一個人定案。
3. **最後才分配實作**：每個子問題指派給適合的 Worker，並走一般的獨立 review 與 verify。
4. 預設不要讓 agy 在沒有證據前變成「自動啟用」：若判斷需要，採「使用者在 `config.json` 的 agy profile 加上 `implementation`／`review` capability 才啟用」之類的選用機制，讓 merge 後的預設行為與現在一致，由使用者決定何時打開。這是建議不是限制，Lead 有更好的設計可以採用，但要在 known-issues 寫明理由。
5. 能在這個任務裡實際驗證的就實際驗證（例如讓 agy 在這個任務中擔任 Worker 或 Reviewer 跑一輪並記錄證據）；驗不到的要如實寫成「待驗收」與缺少的條件，不可把單元測試通過寫成實機驗收。

## 不可做

- 不要修改任何 `config.json`、`policy.yml`（使用者的信任邊界）；需要使用者改設定的地方寫進文件與回報。
- 不要降低既有驗收標準或守門（獨立 review、verify、`card merge` 的條件）。
- 不要 commit、不要 push（bridge 會處理）。

## 驗收條件

- [ ] Lead 的規劃有列出 agy 會碰到的問題清單，並記錄與其他 agent 討論／review 的結論（可放在 `docs/known-issues.md` 的對應 issue）
- [ ] agy 能依使用者設定成為 `--coding` 的候選；既有 claude／codex 的行為與預設（使用者未改設定時）不變
- [ ] 新增單元測試涵蓋新行為（修正前失敗、修正後通過）；`npm run build`、`npm run lint` 與相關測試全數通過
- [ ] `docs/known-issues.md`（E14 相關 issue 或新增 ISSUE-103）、`SPEC.md`、`README.md`、`README.zh-TW.md`、`src/coding-roster.ts` 的註解與錯誤訊息彼此一致，並明確區分「已實機驗證」與「待驗收」
```

### 第三版（併入 `## 描述`，06:23:35Z 設為 `ready`；之後只改了驗收條件裡 ISSUE 編號的文字）

> 與第二版內容相同，只是把「怎麼做」「不可做」降成 `###` 子標題放進 `## 描述`，因為卡片只有 `## 描述` 與 `## 驗收條件` 會送給 Lead（ISSUE-109）。

```markdown
---
id: REQ-20261106-agy-pool
type: requirement
status: ready
title: 讓 agy 能正式加入 agent pool，作為 --coding 的 Worker／Reviewer 候選
version: 1
created: 2026-11-06
updated: 2026-11-06
project: local:Herdr_Discord_Bridge
projects: [local:Herdr_Discord_Bridge]
tasks:
  [
    task-06eb2e97-7b7b-496e-b1b7-a10d722c343b,
    task-f10f36ba-f01d-4ed3-94fc-8f4c17d7bbb6,
  ]
---

# 讓 agy 能正式加入 agent pool，作為 --coding 的 Worker／Reviewer 候選

## 描述

### 目標

使用者的 `config.json` 已有 agy profile（`kind: agy`，目前 `capabilities` 只有 `analysis`），但 `--coding` 沒指定 Worker 時只會自動啟用 claude／codex（`src/coding-roster.ts` 的 `AUTO_CODING_KINDS`，註解寫「agy、pi 還沒驗」）。使用者要把 agy 正式加入 agent pool：讓 Lead 在 `--coding` 時能把 agy 當成候選，由 Lead 依任務決定誰寫、誰審（E14）。

### 怎麼做：這張卡要處理「讓 agy 真的可用」的全部問題，不只是改清單

agy 作為 coding Worker／Reviewer 還沒有實機驗證，我（使用者）不預先指定做法或限制範圍。請 Lead 負責：

1. **先找出會碰到的問題**：讀 `docs/known-issues.md` 的 E14／ISSUE-085／088／089／090／091／094／098／099 與 agy 相關條目、`src/cli-adapter.ts`（antigravity adapter）、`src/hook-agy.ts`、`src/handoff-evidence.ts`、`src/team-turn.ts`、`src/team-task-engine.ts`、`src/agent-pool.ts`、`src/review-pane.ts`（`REVIEWER_KINDS` 已含 agy）、`src/coding-roster.ts`，判斷 agy 走 `--coding` 全流程（啟動就緒、收 prompt、回報格式、transcript／最終回覆辨識、session 身分與「與作者不同 session」的獨立性判斷、verify 回報、reviewer 回覆解析）時有哪些環節對 claude／codex 有特別處理而 agy 沒有，哪些已經通用。
2. **拆解問題，並與其他 agent 討論、請其 review 你的拆解與方案**（團隊裡的其他 agent；Lead 可自行決定找誰、討論幾輪），不要一個人定案。
3. **最後才分配實作**：每個子問題指派給適合的 Worker，並走一般的獨立 review 與 verify。
4. 預設不要讓 agy 在沒有證據前變成「自動啟用」：若判斷需要，採「使用者在 `config.json` 的 agy profile 加上 `implementation`／`review` capability 才啟用」之類的選用機制，讓 merge 後的預設行為與現在一致，由使用者決定何時打開。這是建議不是限制，Lead 有更好的設計可以採用，但要在 known-issues 寫明理由。
5. 能在這個任務裡實際驗證的就實際驗證（例如讓 agy 在這個任務中擔任 Worker 或 Reviewer 跑一輪並記錄證據）；驗不到的要如實寫成「待驗收」與缺少的條件，不可把單元測試通過寫成實機驗收。

### 不可做

- 不要修改任何 `config.json`、`policy.yml`（使用者的信任邊界）；需要使用者改設定的地方寫進文件與回報。
- 不要降低既有驗收標準或守門（獨立 review、verify、`card merge` 的條件）。
- 不要 commit、不要 push（bridge 會處理）。

## 驗收條件

- [ ] Lead 的規劃有列出 agy 會碰到的問題清單，並記錄與其他 agent 討論／review 的結論（可放在 `docs/known-issues.md` 的對應 issue）
- [ ] agy 能依使用者設定成為 `--coding` 的候選；既有 claude／codex 的行為與預設（使用者未改設定時）不變
- [ ] 新增單元測試涵蓋新行為（修正前失敗、修正後通過）；`npm run build`、`npm run lint` 與相關測試全數通過
- [ ] `docs/known-issues.md`（E14 相關 issue 或新增下一個可用編號的 issue（ISSUE-103 已被規劃提示的修正使用））、`SPEC.md`、`README.md`、`README.zh-TW.md`、`src/coding-roster.ts` 的註解與錯誤訊息彼此一致，並明確區分「已實機驗證」與「待驗收」

## 流程紀錄

- 2026-11-06T06:18:50Z | failed | 失敗：autopick_failed；原因：assign：卡片沒有「## 描述」段落（或內容是空的）；請補上描述後再指派 | ev:autopick-assign-1793945930073
- 2026-11-06T06:21:03Z | worktree_created | 建立 worktree local:~/.herdr/worktrees/Herdr_Discord_Bridge/card-req-20261106-agy-pool 分支 card/REQ-20261106-agy-pool 基準 da34ca29b0b3 | ev:w32-worktree-created
- 2026-11-06T06:21:04Z | assigned | 指派給 claude（local） | ev:task-06eb2e97-7b7b-496e-b1b7-a10d722c343b-assigned
- 2026-11-06T06:21:04Z | started | 開始執行 task task-06eb2e97-7b7b-496e-b1b7-a10d722c343b | ev:task-06eb2e97-7b7b-496e-b1b7-a10d722c343b-started
- 2026-11-06T06:21:35Z | failed | 失敗：autopick_stopped；原因：task：task 沒有完成：failed：read-only coding assignments in a writer round must depend on that writer | ev:autopick-task-1793946095980
- 2026-11-06T06:21:35Z | failed | 失敗：task_failed；原因：read-only coding assignments in a writer round must depend on that writer | ev:task-06eb2e97-7b7b-496e-b1b7-a10d722c343b-6
- 2026-11-06T06:24:39Z | failed | 失敗：autopick_failed；原因：assign：卡片 REQ-20261106-agy-pool 已有作用中的 worktree；先用 `card cleanup REQ-20261106-agy-pool` 清掉，或直接在目前路由的 workspace 用 `card assign REQ-20261106-agy-pool` | ev:autopick-assign-1793946279562
- 2026-11-06T06:28:14Z | worktree_created | 建立 worktree local:~/.herdr/worktrees/Herdr_Discord_Bridge/card-req-20261106-agy-pool 分支 card/REQ-20261106-agy-pool 基準 da34ca29b0b3 | ev:w35-worktree-created
- 2026-11-06T06:28:15Z | assigned | 指派給 claude（local） | ev:task-f10f36ba-f01d-4ed3-94fc-8f4c17d7bbb6-assigned
- 2026-11-06T06:28:15Z | started | 開始執行 task task-f10f36ba-f01d-4ed3-94fc-8f4c17d7bbb6 | ev:task-f10f36ba-f01d-4ed3-94fc-8f4c17d7bbb6-started
- 2026-11-06T06:28:45Z | failed | 失敗：autopick_stopped；原因：task：task 沒有完成：failed：read-only coding assignments in a writer round must depend on that writer | ev:autopick-task-1793946525398
- 2026-11-06T06:28:45Z | failed | 失敗：task_failed；原因：read-only coding assignments in a writer round must depend on that writer | ev:task-f10f36ba-f01d-4ed3-94fc-8f4c17d7bbb6-6
- 2026-11-06T07:08:52Z | cleanup_done | 清理完成：removed | ev:w35-cleanup-removed

## 異動專案

### local:Herdr_Discord_Bridge

- 機器：local
- repo：~/git_wk/Herdr_Discord_Bridge
- 分支：card/REQ-20261106-agy-pool
- worktree：~/.herdr/worktrees/Herdr_Discord_Bridge/card-req-20261106-agy-pool
- worktree 狀態：已清理（分支保留）
- base：da34ca29b0b3
```

### 拆分後的三張卡（08:54–09:20，各自一個 PR）

完整全文放在 bridge 狀態目錄的卡片檔（`REQ-20261106-agy-1-roster`、`REQ-20261106-agy-2-session`、`REQ-20261106-agy-3-reviewer`，不進 git）。共同設計：把 `card/REQ-20261106-agy-pool` 當參考實作，只取範圍內的檔案；每張 diff 小於 40000 字元；驗收條件只放 reviewer 讀 diff 能判斷的；各自寫進 ISSUE-107 的對應部分。

1. `agy-1-roster`：`src/coding-roster.ts` 的選用機制（agy profile 的 `capabilities` 含 `implementation` 或 `review` 才自動入池）、測試、文件。
2. `agy-2-session`：`src/team-turn.ts`、`src/agent-pool.ts` 的 `refreshSession`、`src/team-orchestration.ts` 的 `onWorkerSession`、`src/main.ts` 接線、測試。
3. `agy-3-reviewer`：`src/team-task-engine.ts` 的 `sessionDeferredKind` 與入帳身分、測試；入帳時未知作者、未知 reviewer、同 session 一律 fail closed。

## 後續：agy 實機驗證卡（2026-11-06）

使用者在 agy profile 的 `capabilities` 加上 `implementation` 後，建了無害的卡 `REQ-20261106-agy-verify`（在 `docs/known-issues.md` 的 ISSUE-107 加一段，要求 implement 由 `profile:agy` 擔任、失敗要明說不得改派）。

| # | 時間（UTC） | 結果 | 原因與處理 |
|---|---|---|---|
| 1 | 09:43:34–09:44:31 | task 失敗（約 1 分鐘） | agy 停在信任資料夾提示，profile 啟動不就緒（ISSUE-113）。使用者授權後我在 pane 送 Enter，agy 把這個 worktree 路徑加入信任清單。 |
| 2 | 11:04:17–11:07:19 | task 完成，PR #141 於 11:09:48 由 bridge squash merge（`2d3b2ce`） | 清理（先 `card cleanup`，再刪分支、關 workspace）後重跑。writer 是 agy（session `0c50ac78-…` 已登記），reviewer 是 codex（不同 session）pass，verify 由 claude 執行。 |

觀察：Lead 的計畫完全照卡片要求（implement 給 agy、review、verify 給其他 Worker），沒有多餘的診斷回合；agy 的實作約 1.5 分鐘，diff 只有 +2 行。**這證明了 writer 路徑與 session 登記，沒有證明 agy 擔任 reviewer。**另外，agy 每張卡的 worktree 都要手動信任一次，這是自動化的缺口（ISSUE-113）。
