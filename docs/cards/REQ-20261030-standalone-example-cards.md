---
id: REQ-20261030-standalone-example-cards
type: requirement
status: refined
title: 把範例用的卡片變成獨立的 MD 檔
version: 2
created: 2026-10-30
updated: 2026-10-31
source: 使用者在對話中的要求與澄清（2026-10-30）
project: Herdr_Discord_Bridge
links: { related_docs: [docs/card-examples/README.md, docs/adr/0001-portable-md-cards.md], related_issues: [ISSUE-054] }
---

# 把範例用的卡片變成獨立的 MD 檔

## 描述

使用者要求：把範例用的卡片變成獨立的 MD 檔。

澄清（使用者，2026-10-30）：「獨立」的意思是每個範例**就是一張獨立的卡片**，而不是「說明加範例」混在一起的檔案。README 仍然要保留連結到這些範例。

## 處理前的現況（2026-10-30 檢查）

- `docs/card-examples/` 已有三張範例卡，各自是一個 `.md` 檔：`REQ-20261030-example-feature.md`、`REQ-20261030-example-minimal.md`、`TKT-20261030-example-mantis-bug.md`。
- 其中夾雜給讀者看的說明文字：
  - `TKT-20261030-example-mantis-bug.md` 與 `REQ-20261030-example-feature.md` 開頭各有一段引用區塊，說明「本檔是…範例，內容為虛構」；Mantis 範例的那段還連結到同目錄的 `README.md`。
  - `TKT-20261030-example-mantis-bug.md` 的「驗收條件」前有一句「以下由 Agent 依描述推測，需要使用者確認」。
  - 兩個檔案的 `source` 欄位寫了「本檔為格式範例，內容虛構」。
- 轉換規則與欄位對應寫在 `docs/card-examples/README.md`，README 以連結列出三張範例。
- 三張範例都通過 `scripts/herdr-card-check`，並由 `test/card-examples.test.ts` 檢查。

## 驗收條件

使用者已確認的部分：

- [ ] 每張範例卡只含卡片內容，沒有「本檔是範例」或「轉換規則見 README」這類說明段落。
- [ ] `docs/card-examples/README.md` 仍保留指向每張範例卡的連結。

以下由 Agent 推測，**需要使用者確認**：

- [ ] 三張範例卡仍通過 `scripts/herdr-card-check`，`test/card-examples.test.ts` 仍通過。
- [ ] 範例卡不再含指向 `README.md` 的連結，單獨複製出去內容仍完整。

## 非目標

- 不改變卡片格式（ADR-0001）與解析規則。
- 不改變範例的內容主題（Mantis 單、需求、最小卡）。

## 待確認

- 「這是虛構範例」的標示要去哪裡：
  1. 完全移除，只靠檔名與標題的「範例：」前綴辨識。
  2. 保留在 `source` 欄位（它是卡片的一部分，不算說明段落）。
  3. 改放在 README 裡說明。
- `test/card-examples.test.ts` 依賴 `docs/card-examples/` 的位置與檔名，本需求預設不搬動檔案。
- 是否要新增一張可直接複製的空白樣板卡（目前 `REQ-20261030-example-minimal.md` 兼任此用途）。

## 執行結果（2026-10-31，Agent 實作，待使用者驗收）

- 已刪除 `TKT-20261030-example-mantis-bug.md` 與 `REQ-20261030-example-feature.md` 開頭的「本檔是…範例」引用區塊。Mantis 範例因此不再連結到 `README.md`。
- **刻意保留**兩處，因為它們屬於卡片內容，不是對讀者的說明：
  - 兩個範例 `source` 欄位中的「（虛構範例）」（已由「本檔為格式範例，內容虛構」縮短，去掉對讀者說話的語氣）。這是 Agent 對「虛構標示放哪裡」的**預設選擇（選項 2）**，使用者尚未回覆；若要改，只需改 `source` 與對應測試。
  - Mantis 範例「驗收條件」前的「由 Agent 依描述推測，需要使用者確認」。轉換指引規定真實轉出的卡片必須這樣標示，範例需示範它。若使用者認為這也算說明，需要同時決定指引如何示範。
- `docs/card-examples/README.md` 仍連結三張範例，並新增說明：範例是獨立卡片、虛構標示在 `source`。
- `test/card-examples.test.ts` 新增檢查：內文無引用區塊、無「本檔」、無 README 參照、無相對 `.md` 連結；README 連結每張範例；有 `source` 的範例須標示虛構。修改前紅燈（2 項失敗）。
- 驗收條件的勾選留給使用者；Agent 不替使用者勾選。
