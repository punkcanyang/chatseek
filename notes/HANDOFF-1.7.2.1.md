# Chatseek 1.7.2.1 交接（熱修：SPA 切換串內文）

基準 main `213dde2`（1.7.2）。分支 `fix/spa-switch`。開工卡 `docs/plan/cards/开工卡-Chatseek-1.7.2.1-P0-SPA切換串內文-2026-10-09.md`。

## 進度

- [x] 2026-10-09 22:3x 開分支、開工卡、本檔（产品开发）
- [x] CodeWhale 寫碼 22:20 開工、22:24 依老闆改定中止（只讀檔，無改動）
- [x] Codex 規劃＋寫碼 session `01a1210c-fb71-7843-8450-8ec2eb84558e`（gpt-6.1-sol high，非 Fast）
- [x] 舊版真實碼重現＋根因
- [x] 1–3：頁面身分、等待後 URL 再查、content／DB 5 秒守門
- [x] 日期根因（含跨 URL JSON 快取重現）、九語收錄時間
- [x] 保守污染修復、完整性重驗、DB／虛擬窗口測試
- [x] SPA e2e／獨立截圖腳本、Searching 狀態列競態修正
- [x] 1.7.2 實測文案與 ROADMAP 更新
- [x] 外部 Chrome e2e（test:e2e、test:e2e-sync 各連跑 2 次全過）、截圖、效能對照（产品开发在 sandbox 外跑，2026-10-09 23:40–23:58）
- [x] Codex 複審 session `01a12161-9f1f-7190-a0d3-2b221e06c49f`（gpt-6.1-sol high，非 Fast；與寫碼不同 session），PR #20；結論適用包含下方未提交修正的工作樹
- [ ] 合 main

## 根因（原初步判讀已由真實舊碼測試證實）

- `content/chatgpt.js` `messageIdFor`：沒有原生 `data-message-id` 的節點（真機選擇器全 0 → 走 heuristic）拿到 `chatgpt:<convId>:<hash>:dom<N>`，scope 帶新網址的 convId，所以 A 的殘留節點在 URL 換成 B 後拿到**新的** B 前綴 id。
- `content/shared.js` `runCapture` 的 SPA 防護只比 id 後綴（`state.lastMsgKeys`）；dom 序號 id 每次都不同，防護失效 → A 的內文以 B 的 id 寫入。

## 重現證據

`node scripts/spa-switch-test.mjs --baseline-only` 載入 `git show 213dde2:content/{shared,chatgpt}.js` 與該 commit 的 DB 及依賴；selector、heuristic 均印出 `BUG reproduced, A body stored in B`（斷言資料庫 B 真的含 A 內文）。URL 改成 B，但訊息節點沒換；新 scope 導致 dom id 改變，原本 lastMsgKeys 後綴防護失效。防護依賴上次成功寫入，在 A 尚未寫入時同樣無保護。selector 重現是「有 role/turn 選擇器、無原生訊息 id」；heuristic 重現最接近老闆真機全 0 的情況。observe 的 1200ms URL 輪詢／800ms debounce 只延後擷取，不能證明頁面重繪。

## 日期根因與修法

`attachPageTime` 依序找側欄附近精確時間、依對話 id 的 DOM 內 JSON 時間、日期分組；`applyStoredTime` 把成功解析的來源傳給 DB。若三者都沒有，`mergeActivityTime` 初始化成 `first-seen`，`upsertMessages` 首次收錄不算 observed（只有先前尾訊息在頁上且確實新增才算）。`formatActivityLabel` 原本對 first-seen／沒有可信上界的 sidebar-rank **刻意**輸出 unknownSaved，故正常收錄也顯示「日期未知（收錄於 …）」。SPA 污染也不能憑空產生網站時間。重現 fixture 無 time／分組／JSON，DB 確認為 first-seen；不是時區或 DB 版號問題。

修為九語「收錄於 / Saved …」，仍使用真實 firstSeenAt，不用 2020 的合成排序值冒充日期。來源仍 first-seen；sidebar-rank 的可信「早於」與 page-bucket「約」保留；page-exact／observed 的排序、可信度與 1.6.4 新尾訊息規則不變。已知：沒有老闆真站 DOM 的日期資料，無法斷言現行 ChatGPT 所有帳號是否有分組或 JSON 日期；我們只讀 DOM、不呼叫站內 API。本版不把第一次打開歷史對話當成「剛剛」。

### JSON 時間快取的第二項根因

`content/chatgpt.js` 的 `jsonTimes` 原本單一 Map 快取 15 秒，沒有按 document／href 分開；A 沒時間時，B 在 15 秒內提供正確 JSON 也會沿用 A 的空 Map。新增舊版真實碼斷言輸出：

```
baseline 213dde2 selector: BUG reproduced, A body stored in B
baseline 213dde2 heuristic: BUG reproduced, A body stored in B
baseline 213dde2 date: B JSON time missed by cross-URL 15-second cache
```

新版按 document／href 與待確認切換失效快取；`pageTimesFromDocument(doc)` 也確實使用傳入的文件，未傳入時仍是頂層 document。測試 B 在 15 秒內給 JSON update_time，DB 的 updatedAt 必須等於該毫秒、來源為 page-exact；無 time／分組／JSON 的對照必須為 first-seen，文案是「收錄於 …」。這證明程式可漏讀可用日期，**不宣稱老闆那兩頁一定有 JSON 日期**；真站是否有分組／JSON 仍待他的 DOM 實測。

## 改動與守門規則

1. `content/chatgpt.js` 回傳訊息节点 references；擷取起始保留 href，所有 awaited 擷取／結構診斷後再比對。第一次擷取前同步記錄畫面；之後每次安全觀察都更新基線，包括進度與 DB 失敗，避免只保護「最後成功寫入」那批節點。
2. `content/shared.js` 的 pageIdentity 保存 WeakSet＋整段正文 hash。URL 變更後，舊節點或新舊混合仍 hold；訊息節點全部換掉才通過轉場檢查，同文仍受兩端五秒守門，但不永久漏收。切回仍未離開的原始畫面可以重用其已確認基線。可用標記包括選中 link 的 aria-current、data-active、active 父節點內 link、canonical、og:url、訊息祖先 data-conversation-id；每種有一致／不一致 fixture。任何可取得標記衝突就 hold。擷取開始與每個訊息 chunk 送出前都再查；背景另外比對 browser 提供的 sender URL。
3. content 記錄最近五秒正文 hash／convId／實際 ack 時間。background 把整段 hash 交 DB（舊格式缺 hash 時算 chunk hash）；DB 的 meta `spa:recent` 守門持久化並與訊息寫入同一事務完成，入口序列化，先檢查才改對話列。每次清掉五秒外紀錄，不用容易漏擋的「只留上一筆」或固定數量淘汰。`src/spa-identity.js` 與 Chatseek.hash 同 FNV-1a、body-only JSON 邊界，verify 比對鏡像。不同對話被擋回 `{ok:true, held:true}`，不通知 index 更新、不當錯誤、不鎖 message fingerprint、不觸發 0 則警告。原 observe 的 false 重試仍是 3 秒倍增、上限 60 秒；mutation／URL 事件可提早重試。
4. 污染修復不升 DB。必須是已驗身分、非進度、非空、**單一 chunk** 的完整快照。完整證據是所有節點 aria-setsize 等於總數且 aria-posinset 從 1 連續；或 DOM 內 application/json 的同對話 mapping/current_node 選定祖先鏈，所有 user／assistant 文字依次完全匹配。JSON 只掃 2MB、深度 12、20000 物件、5000 祖先節點；循環、少渲染一則、其他對話、進度／busy／virtualized 都不成立。health／sidebar await 後，實際送出時再擷取驗一次完整性；部分變完整也不被 unchanged fingerprint 略過。
5. 先走既有訊息對齊／rekey，搬移圖片與索引，再在完整快照下清理新頁 id／正文都沒有的 synthetic 舊列。synthetic id 必須完整符合 `<convId>:<hex hash>:dom<N>`，多一段原生 id 前綴不能誤中。原生列即使全文與另一對話相同也保留，因為正常複製或分支可同文；不能據此授權刪除。刪除與寫入在同一事務，清 token、圖片 metadata／blob／byte counter、order／尾指標／錯誤預覽，再寫正確頁面。已驗完整快照可覆蓋同 id 的較長污染正文並重建預覽，部分窗口仍保留較長正文。完整修復不把歷史訊息當成新活動。
6. 九語日期文案改成明確收錄時間；既有「早於／約／剛剛」與最後活動排序不改。manifest 為 1.7.2.1；verify 加版本、模組網路掃描、hash 鏡像與兩端守門存在性檢查。
7. `sidepanel/panel.js` 的 copy 結果保留 5 秒，期間 refresh 不用 loading（Searching…）覆蓋或隱藏它。根因是 INDEX_UPDATED／搜尋刷新與非同步 clipboard 同用 #status；Node panel 測試先複製，再搜尋＋INDEX_UPDATED，斷言字元數仍顯示。e2e 也等字元數真正出現，不把 clipboard 已收到文字當作 UI 已完成。1.7.2 老闆第 3 步已改成「足夠共同 turnId 證據才合，缺證據保留」。

## 規矩確認

- 相對 `213dde2` 的 manifest diff 只有版本 1.7.2 → 1.7.2.1：permissions 恰好 `["sidePanel"]`，host_permissions／matches／CSP 不變。
- DB_VERSION 仍 **4**；原有版本 1／2 升 4 測試保留；新 repair 是一般 capture 事務，不另做升版或全庫掃描。
- 無新 npm 依賴、無任何擴充網路請求／CDN／new Image、無網站 DOM 修改／點擊、diag 未增加內文／id／網址。測試模擬頁自己的 SPA 控制不屬於擴充寫網站 DOM。
- $0、沒有真實登入、沒有外連真站。寫碼 session 沒有 git commit／push／merge；WIP checkpoint commits 由老闆在 sandbox 外建立。未複審、未合 main，不能宣告 STATUS READY。

## 測試

新增 `test:spa`，也掛進 test:search。`spa-switch-test.mjs` 使用 jsdom＋fake-indexeddb，舊版所有 module 透過 `git show 213dde2:<path>` 載入並使用隔離 DB 名稱；不是手工造一個「舊邏輯」。新版覆蓋 selector／heuristic、A 未成功寫入、延遲重繪／殘留 DOM／新舊混合、快速切換、history.back/popstate、各種標記矛盾、獨立多分頁背景守門／過期、等待後網址變更、空切換不警告、失敗寫入後基線、污染修復／索引與圖片／正常原生資料保留、JSON 選定分支完整性、partial→full 重試與日期快取。

最終命令與 exit 結果另記本節文末。測試使用現成 node_modules，未重新下載或加依賴。

## Chrome e2e／截圖

`scripts/e2e-chatgpt.mjs` 新增本機 HTTPS SPA 頁：pushState 立刻換 URL、五秒後換 DOM，返回鍵四秒後重繪，快速 B→C；selector／heuristic 兩組。直接讀擴充 IndexedDB，逐一斷言 A／B／C 各恰一則正確正文、來源 first-seen。範例閱讀頁與側欄也斷言收錄日期／正文正確後才截圖。

本 sandbox 嘗試 `xvfb-run -a npm run test:e2e` 及 `test:e2e-sync`，均在 localhost fixture server 的 `listen EPERM: operation not permitted 127.0.0.1` 停下；尚未跑到 Chrome 擷取斷言。新增腳本已通過 `node --check`，不能宣称 Chrome e2e 已通過。

外部只要單獨跑 SPA／截圖：

```bash
xvfb-run -a node scripts/screenshot-1.7.2.1.mjs
```

等同 `e2e-chatgpt.mjs --spa-only`，產物全是合成範例：

- `docs/panel-1.7.2.1-spa.png`
- `docs/reader-1.7.2.1-spa-A.png`
- `docs/reader-1.7.2.1-spa-B.png`

本 session **未產生這三張 PNG**；外部完整 e2e 也會產生它們。腳本重用既有 Chrome for Testing 路徑；需要時設定 CHROME_PATH，沒有下載／登入步驟。

## 效能（基準 213dde2）

新增熱路徑成本是正文 hash、頁面身分掃描、短期限 meta 讀写；完整性證據成立的單批擷取再驗一次，修復只在有候選舊列時做。reader-view／Markdown renderer／image-grid 沒改，仍須依規格量 Chrome，不能以「沒改」代替效能數據。

已從 `git archive 213dde2` 建立 `/tmp/chatseek-baseline-213dde2`（不是改 main 或別人的分支），實試：

```bash
node scripts/reader-bench.mjs "$PWD" /tmp/chatseek-baseline-213dde2
node scripts/list-bench.mjs "$PWD" /tmp/chatseek-baseline-213dde2
node scripts/image-grid-bench.mjs
```

reader／list 在 Chrome 啟動時 `setsockopt: Operation not permitted`；500 張縮圖腳本在本機 listen EPERM。**沒有可報告的掛載／捲動 p95 對照數值**。外部請跑前兩行（同一台機器與 Chrome，必要時來回各跑兩次）；500 張基準可把 node_modules 連到 baseline 後，跑 `/tmp/chatseek-baseline-213dde2/scripts/image-grid-bench.mjs` 與本分支腳本各一次。外部若沒有該 temp 目錄，重新 git archive 到 /tmp 即可。

## 已知限制

- 頁面對話標記沒有保證每個 ChatGPT 帳號都有。無標記的 SPA 切換須訊息節點真的換掉；網站若重用整批原節點，即使改字也會保守 hold，重新載入對話頁可建立新文件基線。相同全文的不同對話在 5 秒內被保守擋住，新 DOM 稍後重試可收錄；原節點或新舊混合在五秒後仍擋住。
- 不保證真機污染列一律自動清乾淨：沒有 aria 總數／位置或可驗證完整 JSON、虛擬窗口、進度、拆成多個 chunk、缺席的原生 id，都保留舊列，避免誤刪。通過身分檢查的新正文會照常收錄；若仍有舊錯誤列，需要老闆回報真站結構以補完整性證據，不能假裝已全部修復。
- JSON 完整性只支援純文字選定祖先鏈；圖片／多模態或 Markdown 與 JSON 字串差異大時不採為完整證據。JSON 日期解析保留既有 DOM-only 路徑，不碰網站 API。
- 初次載入沒有之前的画面／標記時無法從空白基線證明網站已給錯頁；本修防的是已觀察到的 SPA 轉場。header canonical/og 長期滯留別串時也會 hold，寧可少收。
- Chrome e2e、截圖與效能未在 sandbox 完成；另一個 Codex session 的独立複審仍未做。本 session 自查與回歸測試不算複審。

## 老闆實測（≤5 步）

1. 在自己的 Chrome 重新載入擴充，確認 1.7.2.1、權限只有側邊欄。
2. 打開兩段不同 ChatGPT 對話 A／B，輪流切換、快速連切、返回鍵；每段載入穩定後看 Chatseek 閱讀頁，確認 A／B 內文各自正確、沒有串進上一段。
3. 重新打開先前被污染的那兩段，確認新內文被收錄／覆蓋，舊錯誤塊在可確認完整頁時清掉；若仍留錯誤塊請回報（缺完整性證據保留是已知限制，不要把它當已清完）。
4. 沒網站日期的兩段應顯示「收錄於 …」而非「日期未知」；有日期的仍可顯示網站活動時間／約／早於。重新打開歷史對話不應變「剛剛」，真正新增訊息後最後活動才往前。
5. 再開一段長對話捲動，只渲染部分时原本已收的正常訊息不能消失；切換等待中不應出現 0 則警告。需要回報時複製診斷／結構，確認字元數不被 Searching… 蓋掉，輸出不含真實內文／標題／id／網址。

## 最終 Node 驗證結果（本寫碼 session 實跑）

| 指令 | 結果／輸出摘要 |
| --- | --- |
| `npm run verify` | exit 0；`verify ok`、`chatgpt-fixture ok`（2 則、emptyWarn true）。 |
| `npm run test:search` | exit 0；搜尋／activity／升級／panel／archive／九語／reader／Markdown 攻擊／圖片／progress／skeleton／sync／SPA 全鏈通過，尾端 `spa-switch ok`。 |
| `npm run test:fixture` | exit 0；ChatGPT、Markdown、Gemini fixture／capture 全過。 |
| `npm run test:gemini` | exit 0；4 則 fixture、6 則 capture，observed 與 sidebar-rank 回歸通過。 |
| `npm run test:upgrade` | exit 0；from 1／2 to 4、image-cache、progress 與 progress-review 全過。 |
| `npm run test:sync` | exit 0；`sync-test ok { merged: 3000, mergeMs: 33 }`。 |
| `npm run test:spa` | exit 0；舊碼兩條串文 bug＋15 秒日期快取重現，新版全部回歸通過（最後額外隔離兩個 baseline DB case 與明確混合舊新 DOM 斷言也通過）。 |
| `git diff --check` | exit 0；無 whitespace 問題。 |
| `node --check scripts/e2e-chatgpt.mjs`／`scripts/screenshot-1.7.2.1.mjs` | exit 0；語法驗證，**不等於 Chrome 執行通過**。 |

進度：Node 驗證與交接完成；外部 e2e／PNG／效能／另一個 session 複審仍未完成。不合併、不宣告 READY。

## 外部驗證（产品开发在 sandbox 外實跑，2026-10-09 UTC+8）

| 指令 | 結果 |
| --- | --- |
| `xvfb-run -a npm run test:e2e` ×2 | 兩次 exit 0；`SPA selector e2e ok: A/B/C, delayed DOM and history.back`、`SPA heuristic e2e ok: A/B/C, delayed DOM and history.back`、`e2e chatgpt ok`（複製頁面結構字元數斷言兩次都過，沒被 Searching… 蓋掉） |
| `xvfb-run -a npm run test:e2e-sync` ×2 | 兩次 exit 0 |
| verify／test:search／test:fixture／test:gemini／test:upgrade／test:sync／test:spa | 全部 exit 0（重跑一次） |

截圖（範例資料）：`docs/panel-1.7.2.1-spa.png`、`docs/reader-1.7.2.1-spa-A.png`、`docs/reader-1.7.2.1-spa-B.png`；副本在 `/workspace/chatseek-shots/1.7.2.1/`。側欄 A／B／C 各自正確預覽，日期顯示「收錄於 10/09 23:42」。

效能（同機同 Chrome，headless，基準 `git archive 213dde2`）：

| | 1.7.2.1 | 213dde2 |
| --- | --- | --- |
| 閱讀頁 3000 則掛上（兩輪，順序互換） | 611 / 528 ms | 487 / 507 ms |
| 閱讀頁捲動 p95 | 7.7 / 6.9 ms | 8.2 / 7.5 ms |
| 側欄清單開啟中位（兩輪） | 611 / 363 ms | 519 / 401 ms |
| 側欄捲動 p95 | 9 / 2 ms | 6 / 1 ms |

reader-view／清單碼未改，兩輪互有高低，第一輪先跑的一方偏慢，屬冷啟動雜訊。

## 獨立複審（2026-10-10 UTC+8）

依老闆指定對 `git diff 213dde2..HEAD` 審查，再用自己的 `scripts/spa-review-test.mjs` 嘗試刪掉正常資料。沒有 commit、push、merge；以下修正必須由产品开发納入 PR，原 HEAD 不能直接合併。

原 HEAD 的五項問題已用實際 capture／DB 測試先重現，再做最小修正：

| 問題 | 重現／修正 |
| --- | --- |
| 原生 `native:dead:dom999` id 被誤認為 synthetic，連圖片一起刪掉 | synthetic 判斷改成移除完整 conversation 前綴後，餘下必須恰好是 `<hash>:dom<N>`。`spa-review-test.mjs:57` 保留原生列、metadata 與 blob。 |
| 兩段正常同文對話改選分支後，舊原生列被當作跨串污染刪掉 | 移除「另一串全文相同就刪原生列」的推論。`spa-review-test.mjs:70` 確認正常分支、圖片及另一串都保留。 |
| synthetic 正常訊息增長後，新完整快照先刪舊列，縮圖在 rekey 前消失 | 改成先做既有對齊／rekey、搬圖片與索引，再清缺席列。`spa-review-test.mjs:86` 確認 image blob、byte counter、訊息順序保留。 |
| 無頁面標記的正常同文 SPA 對話永久漏收 | 新訊息節點全部替換可通過轉場；兩端五秒 hash 守門保持。`spa-review-test.mjs:105` 確認五秒後殘留原節點仍擋，新 DOM 同文可收，同串更新可收。 |
| 同原生 id 的正確完整正文是污染長文的前綴時，poorerBody 拒絕覆蓋 | 僅已验身分／完整單批快照可覆蓋較短正文並重建預覽；部分窗口規則不變。`spa-review-test.mjs:137` 確認正文修好且不冒充新活動。 |

逐項結論：

1. 通過：殘留／混合／空切換都 hold，五秒後原節點仍不寫；重試退避 3 秒倍增到 60 秒，不出 0 則警告。證據 `content/shared.js:1008`、`:148`；自己跑 `test:spa`。
2. 修後通過：content 與持久化 DB 各自守五秒，held 不鎖 fingerprint；真 background 舊格式 fallback／worker 重載／同串更新也過。證據 `content/shared.js:1104`、`src/db.js:389`、`scripts/spa-review-test.mjs:168`；自己跑 `test:spa`。
3. 通過：所有擷取路徑共用 pageIdentity，extract／diag await 後比 href，每個 chunk 前再檢查，background 比 browser sender URL。證據 `content/chatgpt.js:500`、`:517`、`content/shared.js:1315`、`background.js:324`；自己跑 `test:spa`，另加 selector／heuristic health await 中切 URL 的對抗測試。
4. 通過：舊版跨 URL 日期快取確實漏讀 B JSON；無站上時間時標明 firstSeenAt 收錄時間，來源與排序未偽裝。證據 `content/chatgpt.js:59`、`src/activity-time.js:481`；自己跑 `test:spa`、`test:search` 的 activity／九語測試、`test:gemini`。
5. 修後通過（保守限制見下）：先對齊再刪，只清已驗完整單批的 synthetic 缺席列；原生正常分支、部分／長窗口、另一串、縮圖及索引受保護。證據 `src/db.js:625`、`:665`、`scripts/spa-review-test.mjs:57`；自己跑 `test:spa`、`test:upgrade`／`test:search` 的圖片與 3000 列／500 縮圖整理對抗測試。另補舊列圖片 byte counter／blob 斷言。
6. 通過：基準是 git show 載入真 213dde2 content／DB／依賴，selector、heuristic 均斷言 B DB 含 A 正文；新版延遲／混合／快速／back 不串文。Chrome SPA 段查 DB 各串恰一則且全文正確，不只查 UI 文字。證據 `scripts/spa-switch-test.mjs:46`、`scripts/e2e-chatgpt.mjs:687`；自己跑 `test:spa` 與 e2e 語法檢查。Chrome 兩種 e2e 各兩次通過是上節產品開發的外部證據，未冒稱本複審實跑。
7. 通過：manifest 只有版本差異、permissions 精確 sidePanel、DB 4、無新依賴／網路／網站 DOM 寫入／未消毒 innerHTML。逐行 verify diff 除精確版號外均為新增掃描與斷言，舊守門不減。證據 `manifest.json:32`、`src/db.js:17`、`scripts/verify.mjs:289`、`:1342`；自己跑 `verify`、`test:upgrade`，$0。
8. 通過：activity、圖片清單、sync、archive、progress、skeleton 回歸均過；1.7.2 老闆第 3 步與現有共同 turnId 證據規則相符；copy 結果五秒內不被搜尋刷新覆蓋。證據 `notes/HANDOFF-1.7.2.md:84`、`sidepanel/panel.js:860`、`scripts/panel-test.mjs:678`；自己跑 `test:search`、`test:sync`。
9. 通過：production diff 限於 SPA 身分／hash、污染修復、日期與卡中指定的 copy 狀態競態；無額外功能或新依賴。證據開工卡「要修／順手」、`package.json:19`；完整 diff 審讀與 `git diff --check`。

本複審最终實跑：`npm run verify`、`test:search`、`test:fixture`、`test:gemini`、`test:upgrade`、`test:sync`、`test:spa` 全部 exit 0；獨立新增八組對抗測試全過。`git diff --check` 與 `node --check scripts/e2e-chatgpt.mjs` 亦 exit 0。使用既有 node_modules，無下載、真站登入或費用。

剩餘限制：缺完整證據／多 chunk 的污染舊列及缺席原生 id 保留；同 id 已驗完整正文可覆蓋。網站重用原訊息節點、標記長期衝突時保守不收，須重新載入。外部 Chrome／截圖／效能記錄是修前 PR HEAD 的結果，本複審修正後未重跑 Chrome；交接中尚無 500 張縮圖 Chrome 效能對 main 的實測數字，Node 的 500 圖資料完整性測試不能替代它。閱讀頁兩輪掛載值均略高於基準，冷啟動雜訊只是可能解釋，不能由兩輪確認效能無回退。

複審結論：本工作樹程式審查修後通過；修正必須納入 PR。整體 VERDICT: BLOCK，理由是修後 Chrome 驗證仍缺、AGENTS.md 要求的 500 張縮圖 Chrome 效能對 main 對照未記錄；舊 HEAD 的外部通過與 Node 資料完整性測試不能充當這兩項證據。按老闆指示不在 sandbox 硬跑 Chrome，未 commit／push／合 main，未宣告 STATUS READY。
