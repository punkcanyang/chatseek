# Chatseek 1.7.2.1 交接（熱修：SPA 切換串內文）

基準 main `213dde2`（1.7.2）。分支 `fix/spa-switch`。開工卡 `docs/plan/cards/开工卡-Chatseek-1.7.2.1-P0-SPA切換串內文-2026-10-09.md`。

## 進度

- [x] 2026-10-09 22:3x 開分支、開工卡、本檔（产品开发）
- [x] CodeWhale 寫碼 22:20 開工、22:24 依老闆改定中止（只讀檔，無改動）
- [ ] Codex 規劃＋寫碼 session `01a1210c-fb71-7843-8450-8ec2eb84558e`（gpt-6.1-sol high，非 Fast）
- [ ] Codex 複審（另開 session，gpt-6.1-sol high）
- [ ] 合 main

## 初步判讀（产品开发讀碼，待寫碼者用測試證實）

- `content/chatgpt.js` `messageIdFor`：沒有原生 `data-message-id` 的節點（真機選擇器全 0 → 走 heuristic）拿到 `chatgpt:<convId>:<hash>:dom<N>`，scope 帶新網址的 convId，所以 A 的殘留節點在 URL 換成 B 後拿到**新的** B 前綴 id。
- `content/shared.js` `runCapture` 的 SPA 防護只比 id 後綴（`state.lastMsgKeys`）；dom 序號 id 每次都不同，防護失效 → A 的內文以 B 的 id 寫入。

## 重現證據

`node scripts/spa-switch-test.mjs --baseline-only` 載入 `git show 213dde2:content/{shared,chatgpt}.js` 與該 commit 的 DB 及依賴；selector、heuristic 均印出 `BUG reproduced, A body stored in B`（斷言資料庫 B 真的含 A 內文）。URL 改成 B，但訊息節點沒換；新 scope 導致 dom id 改變，原本 lastMsgKeys 後綴防護失效。防護依賴上次成功寫入，在 A 尚未寫入時同樣無保護。observe 的 1200ms URL 輪詢／800ms debounce 只延後擷取，不能證明頁面重繪。

## 日期根因與修法

`attachPageTime` 依序找側欄附近精確時間、依對話 id 的 DOM 內 JSON 時間、日期分組；`applyStoredTime` 把成功解析的來源傳給 DB。若三者都沒有，`mergeActivityTime` 初始化成 `first-seen`，`upsertMessages` 首次收錄不算 observed（只有先前尾訊息在頁上且確實新增才算）。`formatActivityLabel` 原本對 first-seen／沒有可信上界的 sidebar-rank **刻意**輸出 unknownSaved，故正常收錄也顯示「日期未知（收錄於 …）」。SPA 污染也不能憑空產生網站時間。重現 fixture 無 time／分組／JSON，DB 確認為 first-seen；不是時區或 DB 版號問題。

修為九語「收錄於 / Saved …」，仍使用真實 firstSeenAt，不用 2020 的合成排序值冒充日期。來源仍 first-seen；sidebar-rank 的可信「早於」與 page-bucket「約」保留；page-exact／observed 的排序、可信度與 1.6.4 新尾訊息規則不變。已知：沒有老闆真站 DOM 的日期資料，無法斷言現行 ChatGPT 所有帳號是否有分組或 JSON 日期；我們只讀 DOM、不呼叫站內 API。本版不把第一次打開歷史對話當成「剛剛」。
