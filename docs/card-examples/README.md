# 卡片範例與轉換指引

日期：2026-10-30。規格見 [ADR-0001](../adr/0001-portable-md-cards.md)。

> **狀態：卡片格式的解析、驗證、匯入、序列化已有函式（`src/card*.ts`），另有單檔驗證指令 `herdr-card-check`（待使用者驗收，ISSUE-054）。還沒有 Discord 指令，也沒有檔案讀寫層，bridge 不會自動讀取卡片。** 本指引讓你請 Agent 產生合格的卡片檔，並用驗證指令自我檢查。

## 範例

| 檔案 | 用途 |
|---|---|
| [TKT-20261030-example-mantis-bug.md](TKT-20261030-example-mantis-bug.md) | **Mantis 單轉卡片**的範例（內容虛構） |
| [REQ-20261030-example-feature.md](REQ-20261030-example-feature.md) | 需求卡範例 |
| [REQ-20261030-example-minimal.md](REQ-20261030-example-minimal.md) | 只含必填欄位的最小卡，可複製後修改 |

每個範例都**就是一張獨立的卡片**：檔案內只有卡片本身，沒有「本檔是範例」之類的說明段落，也不連結回本檔，可以單獨複製使用。說明都寫在這份 README。範例內容是虛構的，這一點標示在卡片的 `source` 欄位（有 `source` 的範例），不寫在內文。

這三個檔案由 `test/card-examples.test.ts` 檢查：必須能被 `parseCard` 讀懂、序列化後再讀回相同、匯入後為 `draft`；內文不得含說明用的引用區塊、「本檔」字樣、README 參照或指向其他檔案的相對連結；本 README 必須連結到每一張範例。格式演進時範例失效，測試會失敗。

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

- [ ] **執行 `scripts/herdr-card-check <檔案>`，結果必須是 `OK`**（見下方「驗證指令」）。
- [ ] 檔名等於 `<id>.md`。
- [ ] 必填欄位齊全：`id`、`type`、`status`、`title`、`version`、`created`、`updated`。
- [ ] `status` 是 `draft`；沒有 `ready`、`in_progress`、`done`。
- [ ] `external.mantis` 有加引號。
- [ ] 推測的內容都標了「需要使用者確認」。
- [ ] 沒有敏感資訊。

## 驗證指令

```
scripts/herdr-card-check FILE...
```

逐一檢查檔案是否合格，輸出每個檔案的 `OK`（附 id、類型、狀態、標題）或 `FAIL`（附原因）。結束碼：`0` 全部合格、`1` 至少一個不合格或讀不到、`2` 用法錯誤。可一次給多個檔案；失敗不會中斷後面的檔案。超過 256 KiB 的檔案不讀取，直接判為不合格。

```
$ scripts/herdr-card-check docs/card-examples/REQ-*.md docs/card-examples/TKT-*.md
OK    docs/card-examples/TKT-20261030-example-mantis-bug.md  TKT-20261030-example-mantis-bug ticket draft "範例：…"
$ scripts/herdr-card-check bad.md
FAIL  bad.md: "external.mantis" must be a string or null
```

注意：
- 要先 `npm run build`（指令執行編譯後的 `dist/`）。可連結到 PATH：`ln -s "$PWD/scripts/herdr-card-check" ~/.local/bin/herdr-card-check`。
- **不要用 `*.md` 萬用字元**：同目錄的 `README.md` 不是卡片，會被判為不合格。用 `REQ-*.md TKT-*.md`。
- 它只檢查格式（`parseCard` 的規則），不會判斷內容是否正確、推測是否合理、有沒有敏感資訊；那些仍要人看。

## 目前的限制

- **不支援 `x-` 自訂欄位。** 含 `x-` 開頭 key 的卡片會被 `parseCard` 拒絕（`unknown key`）。需要保留的資訊請寫在內文。見 [ISSUE-053](../known-issues.md)。
- bridge 還不會讀取或監看卡片目錄；卡片目前是人與 Agent 之間的文件。
