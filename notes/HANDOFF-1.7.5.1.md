# HANDOFF — Chatseek 1.7.5.1 同步與閱讀頁審查修正

2026-10-22（UTC+8）。基準為最新 `origin/main`：`ea9dfb1`（1.7.5／PR #26）。分支 `fix/sync-reader-review`，使用者授權處理本次審查發現的全部四項問題。本版實作與離線／閱讀頁瀏覽器驗證完成，完整擴充 E2E 受環境管理政策阻擋；保持草稿，不合併或宣稱發布。原訂 1.7.6 的移除確認框功能不包含在本次修正。

## 根因與修改

1. **日期未知被跳過同步**：`finiteOrNull(null)` 原本經 `Number(null)` 變成 0；內容腳本及背景 scrubber 正好以 null 表示未知日期，最後誤判為比本機舊。現在 null／undefined／空白字串保留為 null。四平台的未知日期／有效新舊日期均有回歸。
2. **錯誤對話回報被計入成功**：同步原本只確認回報屬於該平台，沒有核對佇列目標。現在 opening 階段比對共用解析器的對話 ID；短暫殘留頁面等待目標出現，超過 report deadline 停為 uncertain，不增加 captured、不推進 index。首頁重導也不能冒充目標，驗證碼等原有停止規則優先。
3. **已開啟閱讀頁正文不更新**：原本 INDEX_UPDATED 只改時間與封存標記，再次點開也只聚焦原頁。現在訊息、順序、rekey／清理或 progress repair 真正改變時，在同一交易更新普通欄位 `contentRevision`，不用升 DB。閱讀頁先讀對話列，版本或必要標頭不同才讀完整快照；只有日期／封存變更不重讀正文。通知串列合併、聚焦補查、缺失／重建狀態、舊圖片非同步結果丟棄一併處理。重建視圖保留訊息 ID 與相對捲動位置、保留同訊息最近搜尋命中，並釋放舊 ResizeObserver。側欄移除、清空與手動恢復會通知其他擴充頁。
4. **休息期間反覆保存完整佇列**：原本每 250ms tick 都保存整個 session。現在只有狀態物件改變才保存；只有保存成功才更新已持久化標記，失敗後下次 tick 會重試。5,000 筆佇列、40 次休息 tick 的實際 IndexedDB 寫入從 40 次降至 0，暫停／恢復／重啟仍正確。

## 驗證

Node 24.19.0；依原 lockfile 執行 `npm ci` 成功，未變更依賴。完整離線測試全部 exit 0：

- `npm run verify`
- `npm run test:search`（32 個腳本，含兩個新增回歸）
- `npm run test:fixture`
- `npm run test:gemini`
- `npm run test:upgrade`
- `npm run test:sync`
- 最後微任務刷新補強後重跑 verify、test:reader-refresh、test:sync、既有 reader-test，均通過。
- `git diff --check` 與變更 JavaScript 語法檢查通過。

新增 `test:reader-refresh` 使用實際 reader 模組、JSDOM 與 IndexedDB，涵蓋同則數編輯、舊版列補版本、追加訊息及搜尋命中、純標頭通知不讀正文、移除／清空／重新收錄、捲動錨點與命中保留。`sync-review-test` 使用真實 runner＋IndexedDB，覆蓋四平台未知日期、錯誤目標／首頁、短暫殘留、期限停止、5,000 筆佇列零重複寫入、失敗重試、worker 重啟。

`npm run test:e2e-reader-refresh` 以 Chromium 151.0.7922.173、本機 HTTP 範例與實際 reader／DB 模組驗證真實 layout，**PASS**：前插舊訊息、正文編輯後錨點仍是 Sample day 67、偏移 **0px**；新增命中可跳轉；刪除後舊正文消失。這是閱讀頁整合測試，沒有冒充擴充載入或真站驗收。

`npm run screenshot` 使用同一 Chromium 通過；舊版截圖輸出至 `/tmp/chatseek-review-shots`，未覆寫歷史檔案。新增範例圖：[reader-1.7.5.1-refresh.png](../docs/reader-1.7.5.1-refresh.png)，只有人工旅遊範例內容。

**完整擴充 E2E 未通過環境前置條件**：`test:e2e`／`test:e2e-sync` 使用系統 Chromium 嘗試載入時，Puppeteer 回報 `Extensions.loadUnpacked: Loading of unpacked extensions is disabled by the administrator.` 未修改管理政策，也未放寬斷言。官方 Chrome for Testing 下載目錄在此環境不存在，取得下載資訊的網路請求亦被代理拒絕（403）。必須在允許載入開發擴充的外部環境補跑；腳本支援 `HEADLESS=1`，預設仍為有介面模式。Puppeteer 使用正式 `enableExtensions: [root]` 載入 API；Chrome 路徑仍由 `CHROME_PATH` 指定。

## 效能對照

同一台機器、系統 Chromium，基準為 `ea9dfb1` 的隔離快照；各瀏覽器 benchmark 三次取中位數。這些是小樣本觀察，不將執行環境波動宣稱為穩定提速。

| 項目 | 基準 | 修正後 |
|---|---:|---:|
| 3,000 則閱讀頁掛載 | 143ms | 116ms |
| 閱讀頁捲動 p95 | 11.1ms | 11.4ms |
| 3,000 筆側欄庫開啟（顯示前 80 筆） | 286ms | 223ms |
| 側欄捲動 p95 | 3ms | 6ms |
| 500 張縮圖開啟 | 76ms | 53ms |
| 縮圖捲動 p95 | 10.4ms | 7.5ms |
| 5,000 筆同步佇列，40 次無狀態變化 tick 的寫入 | 40 | 0 |

閱讀頁／側欄捲動 p95 略升，均如實列出；此輪未改側欄列表渲染演算法。測試 log 在 `/tmp/chatseek-review-*.log`，不提交臨時 log。

## 複審及範圍確認

依 AGENTS.md 使用不同 Codex session `/root/review_sync_reader` 唯讀複審兩輪，皆 **PASS，未發現新的 P1/P2**。審查者獨立跑過新增兩個回歸測試及 diff／語法檢查。此環境無可呼叫的 Opus／Grok reviewer，使用相同 Codex 模型的不同 session，未使用 Fast 模式。

版本 **1.7.5.1**；permissions 仍恰好 `["sidePanel"]`，host／content script matches／CSP 原樣；DB **4**；產品未新增網路請求；未新增套件；費用 **$0**。所有 fixture、截圖與測試內容均為範例資料，未登入任何真實帳號。

## 外部實測（最多六步）

1. 在允許開發擴充的環境，用 Chrome for Testing 執行 `npm run test:e2e` 與 `npm run test:e2e-sync`，記錄 exit code。
2. 在自己的 Chrome 重新載入 1.7.5.1，再重新整理原網站分頁。
3. 對側欄沒有日期的已收錄測試對話開始同步，確認不會直接顯示略過。
4. 同步等待目標時將同步分頁導到另一段測試對話，確認不誤算成功，持續不符會停止。
5. 開啟本機閱讀頁並捲到中段；在原網站增加／編輯訊息，確認閱讀頁更新、位置保留，搜尋可跳到新命中。
6. 從側欄移除該測試對話，確認已開啟閱讀頁變成找不到；再開原網站對話重新收錄，閱讀頁可恢復。

## 限制

完整擴充 E2E 與真站測試仍待外部補齊；不要把草稿視為 READY 或已發布。訊息被實際擷取寫入前，閱讀頁無法顯示尚未收錄的內容。網站 DOM、長對話僅讀已渲染內容、跨域圖片等既有限制不變。
