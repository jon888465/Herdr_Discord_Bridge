# ADR-0001：可攜 Markdown 卡片格式

日期：2026-10-30。狀態：**已採納（Accepted，2026-10-30 使用者同意五項決定）**。實作進度見文末「實作狀態」。來源卡片：[REQ-20261030-card-to-merge](../cards/REQ-20261030-card-to-merge.md)。

> 本文定義格式與規則。**目前只有純函式 `parseCard`（`src/card.ts`）、`importCard`（`src/card-import.ts`）與 `serializeCard`（`src/card-serialize.ts`）存在**；Mantis 匯出、寫檔、刪除語意與任何 CLI／Discord 指令都尚未實作，不得在 README／SPEC 寫成可用。

## 背景

使用者希望需求與工作單可攜、可版控、可隨手刪除，並能匯出到 Mantis、日後對接 Notion／Trello。現有 Durable Task Engine 是 atomic journal（SPEC「Phase 1 Durable Task Engine」），不是 SQLite；runtime 依賴只有 `discord.js`，沒有 YAML 套件；repo 先前沒有 ADR 慣例，本文是第一份。

## 決策

### 1. 一張卡 = 一個 `.md` 檔，檔案是需求的真相來源

- 路徑：`<cards 目錄>/<id>.md`，**檔名必須等於 id**。預設 cards 目錄為專案內 `docs/cards/`，可設定；是否納入 git 由使用者以 `.gitignore` 決定。
- 版本歷史交給 git，不另建版本表。`version` 只在需求語意大改時由人遞增。

### 2. 執行態不進卡片

誰在跑、哪台機器、哪個 session、重試次數都留在現有 journal。卡片只放：需求、驗收條件、關聯、結果摘要。

### 3. Frontmatter 採受限子集，不引入 YAML 套件

卡片內容會餵給 Agent，匯入來源（Notion、他人檔案）不可信，且依賴要保持精簡。因此自行解析一個**嚴格子集**，超出就拒絕（fail closed，與 SPEC 一致）：

- 以 `---` 開始與結束；每行 `key: value`；`#` 後為行內註解。
- 值只允許：字串（無引號或雙引號）、整數、日期 `YYYY-MM-DD`、`null`、行內陣列 `[a, b]`、行內物件 `{ k: v, k2: v2 }`（物件的值只能是純量或純量陣列）。
- 禁止：多行值、錨點／別名、tag、合併鍵、物件內再放物件或陣列內再放陣列、重複 key、未知頂層 key（可用 `x-` 前綴自訂）。
- frontmatter 上限 8 KiB，整檔上限 256 KiB（與現有 artifact 讀取上限一致）。

替代方案：引入 `yaml` 套件。優點是完整相容；缺點是多一個依賴與較大的攻擊面，且卡片用不到 YAML 的進階功能。若日後需要巢狀結構再重議。

### 4. 欄位

必填：

| 欄位 | 規則 |
|---|---|
| `id` | `^(REQ|TKT)-\d{8}-[a-z0-9][a-z0-9-]{1,40}$`，由日期加短名稱組成，不用遞增編號（多機器不會撞號） |
| `type` | `requirement` 或 `ticket` |
| `status` | 見下 |
| `title` | 單行，1–120 字 |
| `version` | 正整數 |
| `created`、`updated` | `YYYY-MM-DD` |

選填：`source`、`project`、`links`（`{ related_docs: [...], related_issues: [...], parent: <id> }`）、`external`（`{ notion: ..., github: ..., mantis: ... }`，值為字串或 `null`）。

內文第一個 `#` 為標題（應與 `title` 相同），其後章節慣例為：描述、驗收條件（`- [ ]` 清單）、非目標、風險、待確認、執行結果。

### 5. 狀態與寫入權

單一 enum：`draft`、`discussing`、`refined`、`recorded`、`ready`、`in_progress`、`done`、`cancelled`。

- 人與 Lead 可改 `draft` 到 `ready`、`cancelled`。
- 只有 bridge 寫 `in_progress`、`done`，並只寫 `status`、`updated` 與附加到「執行結果」章節；不改其他內容。
- 這些狀態是卡片層級的粗略狀態，**不等於** Team Task 或 Assignment 狀態（見 CONTEXT.md），兩者不混用。

### 6. 寫入安全

bridge 寫卡片時：先記讀取時的內容雜湊，寫入前再比對，不同就放棄並回報（不覆蓋人的修改）；以暫存檔加 rename 原子寫入；只寫在 cards 目錄內，拒絕符號連結與路徑跳脫。

### 7. 刪除語意

- 狀態為 `done`／`cancelled`／`draft` 的卡被刪：不影響系統。
- 對應任務**執行中**（`in_progress`）卡被刪：任務暫停並詢問使用者，不自動繼續也不自動取消。

### 8. 匯入匯出

- **匯出 Mantis**：輸出純文字或 md，欄位對應 Mantis 的 Summary（`title`）、Description（描述）、Steps To Reproduce（若有）、Additional Information（驗收條件、關聯）。不呼叫 Mantis API，使用者自行貼上建單。
- **匯入**：驗證 frontmatter 與大小；缺 `id` 時依規則產生；**狀態一律強制為 `draft`**，不信任來源的 `status`；清空 `external`；內文只當資料，不當指令。已存在同 `id` 時拒絕，不覆蓋。
- Notion／Trello 只做匯出入，不做雙向同步；`external` 欄位預留對照。

## 後果

- 好處：可攜、可 diff、可隨手刪、Agent 易讀寫、匯入不會因來源內容而自動執行。
- 代價：自寫解析器要有完整測試；子集限制使用者無法用任意 YAML 寫法；需維護與外部工具（Obsidian、Notion 匯出）的相容說明。

## 驗收條件（實作時）

- 解析器對下列輸入都有測試：合法卡片、缺必填、重複 key、未知 key、多行值、錨點／別名、超大 frontmatter、id 與檔名不符、日期格式錯。
- 匯入：來源 `status: in_progress` 的檔案匯入後為 `draft`；同 id 衝突被拒；路徑跳脫與符號連結被拒。
- 寫入：讀寫之間檔案被改時，bridge 放棄寫入；寫入失敗不留下半截檔。
- 執行中卡被刪的暫停行為有測試。
- 匯出的 Mantis 文字有範例輸出測試。
- 既有 `team ask`、Vibe Coding、Discord／CLI 指令回歸不變。

## 未決

- 指令名稱與入口（CLI、Discord）尚未定，實作前於此補充。
- cards 目錄放專案內還是 bridge 目錄：本文預設專案內並可設定，使用者尚未最終確認。
- 是否需要 JSON Schema 或編輯器提示檔供外部工具驗證。
- Mantis 欄位對應需用實際 Mantis 表單核對。

## 實作狀態（2026-10-30）

- **已實作**：
  - `parseCard(text, filename?)`（`src/card.ts`），純函式，不讀寫檔案。涵蓋：受限 frontmatter 子集、必填欄位、id 格式與檔名比對、`type`／`status` 列舉、日期、`version`、標題長度、`links`／`external` 結構、frontmatter 8 KiB 與整檔 256 KiB 上限、CRLF 與開頭 BOM 容錯。內部拆為 `readCardDocument`（結構）與 `buildCard`（語意）。
  - `importCard(text, { slug?, today, existingIds })`（`src/card-import.ts`），純函式：狀態一律強制為 `draft`；清空 `external`；已存在的 id 拒絕、不覆蓋；缺 `id` 時由 `type`（REQ／TKT）、`today` 與**呼叫者明確給的 `slug`** 產生，不從標題推導；有 `id` 時忽略 `slug`；回傳 `filename` 與 `notes`（記錄被改動的項目）。沒有呼叫端。
  - `serializeCard(card)`（`src/card-serialize.ts`），純函式：`Card` 轉成 md 文字。鍵順序固定（與輸入物件的屬性順序無關）；字串只在安全時用裸寫，否則加雙引號，規則比本專案解析器更保守（例如開頭的 `#`、`-`、`%`、`@` 也加引號，避免其他 YAML 工具讀錯）；陣列與物件用行內寫法。**寫出前先用 `parseCard` 讀回並比對，內容不同就回傳失敗**（例如標題含換行、`status` 不合法、本文含 CR），確保不會產生讀不回來的檔案。尚未寫入檔案，沒有呼叫端。
- **測試**：`test/card.test.ts` 57 項（含真實規劃卡必須可解析）、`test/card-import.test.ts` 15 項、`test/card-serialize.test.ts` 36 項（含 `docs/cards` 內每張卡 parse、serialize、parse 往返相等且重複序列化文字不變）。全套 `npm test`（2026-10-30，本機 macOS、Node v26.12.0）394 項：393 通過、0 失敗、1 略過；這不是 CI 結果。開發過程抓到並修正兩個缺陷：`today` 只檢查格式、未檢查日期是否真實存在；`type` 以 `in` 判斷會把 `constructor` 等原型鏈名稱當成有效值（改用 `Object.hasOwn`）。
- **尚未實作**：Mantis 匯出、bridge 寫檔（雜湊比對、原子寫入、符號連結與路徑跳脫防護）、從檔案系統讀取並提供 `existingIds`、執行中卡被刪的暫停、指令入口。驗收條件中這些項目仍是待做。
- **實作後與原文的差異**：物件值允許純量陣列（`links` 需要）；`status` 註解中的 `approved` 已不在列舉內，規劃卡已同步修正；規劃卡原缺必填的 `title`，一併補上。
