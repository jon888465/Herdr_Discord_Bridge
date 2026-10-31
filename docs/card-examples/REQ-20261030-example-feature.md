---
id: REQ-20261030-example-feature
type: requirement
status: discussing
title: 範例：新增匯出報表功能
version: 2
created: 2026-10-28
updated: 2026-10-30
source: 與使用者的討論（虛構範例）
project: example-project
links: { related_docs: [docs/example-design.md], related_issues: [ISSUE-001] }
external: { notion: null, github: null, mantis: null }
---

# 範例：新增匯出報表功能

## 背景

使用者希望能把每月報表匯出成 CSV，交給財務核對。

## 描述

在報表頁新增「匯出 CSV」按鈕，匯出目前篩選條件下的全部資料。

## 驗收條件

- [ ] 按下按鈕會下載 CSV 檔。
- [ ] 欄位順序與畫面一致。
- [ ] 資料超過 10 萬列時不會逾時（需確認上限）。

## 非目標

- 不做 Excel 格式。
- 不做排程自動寄送。

## 風險

- 大量資料可能占用過多記憶體。

## 待確認

- 檔案編碼要 UTF-8 還是 Big5。
- 是否需要權限控管。
