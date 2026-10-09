# AGENTS.md — 在 Chatseek 工作的規矩

給任何 coding agent（Cursor、Grok Build CLI、Codex、DeepSeek／CodeWhale…）。不需要聊天紀錄，照這份做。

## 這是什麼

Chatseek：Chrome 側欄擴充（MV3），把老闆在 ChatGPT、Claude、Grok、Gemini 網頁上打開過的對話收進本機 IndexedDB，可以搜、可以在擴充自己的閱讀頁讀。只讀網頁，不連網。

## 先讀

1. `docs/plan/ROADMAP.md`：出過什麼、現在在做什麼（1.7.1）。
2. `docs/plan/cards/`：開工卡，**卡就是規格**。做哪一版就讀哪張。
3. `docs/plan/BACKLOG.md`：已知限制、要老闆拍板的事。
4. `notes/HANDOFF-<版本>.md`：每版開發交接（根因、改動、測試、限制）。

## 誰負責

- **老闆**（Punkcan）：拍板、實機測試（只在他自己的 Chrome）。
- **商務拓展**：寫規格／開工卡、驗收、把結果轉給老闆。
- **产品开发**：實作、開 PR、找複審、合併。
- 規格有疑問、要加權限、要花錢：停下來回報商務拓展，不要自己決定。

## 硬規矩（違反就不能合）

1. `manifest.json` 的 `permissions` 恰好是 `["sidePanel"]`。`host_permissions`、`content_scripts.matches`、CSP 不改。要加任何權限（tabs、alarms、scripting、unlimitedStorage、新 host…）一律停下，老闆批准才做。
2. **不發任何網路請求**：不 `fetch`／XHR／`sendBeacon`／WebSocket／EventSource，不用 CDN，不重新抓圖。`scripts/verify.mjs` 會擋，它只能加強、不能放寬。
3. **對網站只讀**：不點網站按鈕、不改網站 DOM、不打網站內部 API（例如 Gemini `batchexecute`），不要 API Key。唯一例外是 1.7.0 手動同步：只在自己開的同步分頁裡依序導航到側欄已有的對話網址，仍不點按鈕。
4. 不用 `innerHTML` 塞未消毒內容。診斷（diag、複製診斷）只放命中數，**不含內文、標題、對話 id、網址**。
5. 資料庫版本（目前 4）盡量不升；要升就寫遷移和 `test:upgrade` 測試。
6. **不在共享機器上登入老闆的真實帳號**。真站測試一律由老闆在自己的 Chrome 做；開發用 `fixtures/`、本機模擬頁、Chrome for Testing（不連外網）。
7. 花費 $0。任何要花錢的（含 Chrome Web Store US$5）先問。repo 保持 private。
8. 不碰 code 以外的東西：不推 secret，不改別人的分支。

## 怎麼工作

- **分支 + PR**：從最新 `main` 開分支（`fix/…`、`feat/…`），一版一個 PR。`manifest.json` 版本號跟著改。
- **同一件事同一個 session** 做完，不中途換。任何工具都**不用 Fast 模式**（例如 Grok 4.7 用 high）。
- **複審**：由**不同的 session／模型**審，Opus 5.5 有額度就用，沒有就 Grok 4.7 high（非 Fast）另開 session。PR 說明寫明是誰審的。
- 開發者不自己合自己沒複審過的 PR。

## 測試（`package.json` 裡的名字）

```bash
npm ci
npm run verify          # 權限／網路請求守門 + ChatGPT fixture
npm run test:search     # 搜尋、活動時間、預覽、排序、封存、i18n、閱讀頁、Markdown（含攻擊樣本）、圖片、同步…
npm run test:fixture    # ChatGPT／Gemini 擷取 fixture、Markdown 擷取
npm run test:gemini
npm run test:upgrade    # IndexedDB 升級
npm run test:sync
npm run test:e2e        # Chrome for Testing 載入擴充，跑本機 chatgpt.com 模擬頁
npm run test:e2e-sync
npm run screenshot      # 側欄範例資料截圖
```

PR 前全部要過。效能對上一個 main commit 量：3000 則閱讀頁掛載／捲動 p95、側欄 3000 則清單、500 張縮圖。

## READY 的標準（PR 說明裡要有）

1. 根因（修 bug 時要給證據）與改了什麼。
2. 權限、網路請求、DB 版本、花費的確認。
3. 複審模型與 session。
4. 測試結果與效能對照。
5. **範例資料**截圖放 `docs/`（不能是老闆的真實對話）。
6. **老闆實測步驟 ≤6 步**（開工卡另有規定就照卡，例如 ≤4）。
7. 已知限制。
8. 寫 `notes/HANDOFF-<版本>.md`。

合併後**叫商務拓展**：發一則「STATUS READY：Chatseek <版本>」，附 PR 連結、merge commit、上面 1–7。沒有 agent 間訊息管道時，把同樣內容留在 PR 說明，請老闆轉。
