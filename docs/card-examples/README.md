# 卡片範例與轉換指引

日期：2026-10-30。規格見 [ADR-0001](../adr/0001-portable-md-cards.md)。

> **狀態：卡片格式的解析、驗證、匯入、序列化已有函式（`src/card*.ts`），但還沒有任何 CLI／Discord 指令，也沒有檔案讀寫層。** 本指引讓你請 Agent 產生合格的卡片檔；產生後的檔案目前只能靠測試或人工檢查，bridge 還不會自動讀取它。

## 範例

| 檔案 | 用途 |
|---|---|
| [TKT-20261030-example-mantis-bug.md](TKT-20261030-example-mantis-bug.md) | **Mantis 單轉卡片**的範例（內容虛構） |
| [REQ-20261030-example-feature.md](REQ-20261030-example-feature.md) | 需求卡範例 |
| [REQ-20261030-example-minimal.md](REQ-20261030-example-minimal.md) | 只含必填欄位的最小卡，可複製後修改 |

這三個檔案由 `test/card-examples.test.ts` 檢查：必須能被 `parseCard` 讀懂、序列化後再讀回相同、匯入後為 `draft`。格式演進時範例失效，測試會失敗。

## 請 Agent 把 Mantis 單轉成卡片

把 Mantis 單的文字（Summary、Description、Steps To Reproduce、Additional Information、備註、各欄位）貼給 Agent，並告訴它「依 `docs/card-examples/README.md` 和範例轉成卡片」。

### 欄位對應

| Mantis | 卡片 |
|---|---|
| 編號 | `external.mantis`（字串，**要加引號**，例如 `"0001234"`），並寫進 `title` 與 `source` |
| Summary | `title`（1 到 120 字，單行） |
| Description | `## 描述` |
| Steps To Reproduce | `## 重現步驟` |
| Additional Information | `## 補充資訊` |
| 備註（bugnotes） | `## Mantis 備註（摘要）`，只摘要、不貼完整對話 |
| 狀態、嚴重度、優先順序、重現率、版本、平台、分類 | 內文的 `## Mantis 欄位` 表格 |
| Project | `project` |
| 附件 | 在內文列檔名；**不要**把附件內容貼進卡片 |

類型：Mantis 單用 `type: ticket`，id 前綴 `TKT-`；純需求或討論用 `type: requirement`，前綴 `REQ-`。

### 給 Agent 的規則

1. **不要捏造。** Mantis 沒寫的欄位就不寫；不確定的放進 `## 待確認`。
2. **驗收條件若是你依描述推測的，必須標明「由 Agent 推測，需要使用者確認」。** 不要把推測寫成既定事實。
3. **`status` 一律用 `draft`。** 不要寫 `ready`、`in_progress`、`done`；那些由人或 bridge 決定。
4. **id 格式**：`TKT-` 或 `REQ-`，加 8 位日期，再加英數小寫與連字號的短名稱（2 到 41 字），例如 `TKT-20261030-login-timeout`。**檔名必須是 `<id>.md`。** 中文標題不要硬轉成短名稱，用簡短英文描述事件。
5. **日期**用 `YYYY-MM-DD`，且必須是真實存在的日期。
6. **`version` 從 `1` 開始**，是正整數。
7. **frontmatter 只能用嚴格子集：**
   - 每行 `key: value`，不可多行、不可縮排續行、不可用 `-` 清單、不可用 `|` 或 `>`。
   - 陣列與物件用行內寫法：`[a, b]`、`{ k: v }`；物件的值只能是純量或純量陣列。
   - 不可重複 key；不可使用未列出的 key。
   - 值含冒號加空格、`#`、引號、逗號、方括號、大括號，或以 `-`、`&`、`*`、`!` 等開頭，或長得像數字或 `null`，**一律加雙引號**。
   - 雙引號內只能用 `\"` 與 `\\` 兩種跳脫。
8. **敏感資訊**：不要把密碼、token、客戶個資、內部網址寫進卡片。
9. 卡片不是執行紀錄：不要寫「誰在跑、跑到哪」這類執行狀態。

### 產出後自我檢查

- [ ] 檔名等於 `<id>.md`。
- [ ] 必填欄位齊全：`id`、`type`、`status`、`title`、`version`、`created`、`updated`。
- [ ] `status` 是 `draft`；沒有 `ready`、`in_progress`、`done`。
- [ ] `external.mantis` 有加引號。
- [ ] 推測的內容都標了「需要使用者確認」。
- [ ] 沒有敏感資訊。

## 目前的限制

- **沒有驗證指令。** 目前無法對單一檔案執行 `card check`。要驗證可以把檔案放進 `docs/card-examples/`（檔名須符合 `REQ-` 或 `TKT-` 開頭）並執行 `npm test`，但這會讓範例清單測試失敗，只適合臨時檢查。是否補一個驗證指令見 ADR 未決項目。
- **不支援 `x-` 自訂欄位。** 含 `x-` 開頭 key 的卡片會被 `parseCard` 拒絕（`unknown key`）。需要保留的資訊請寫在內文。見 [ISSUE-053](../known-issues.md)。
- bridge 還不會讀取或監看卡片目錄；卡片目前是人與 Agent 之間的文件。
