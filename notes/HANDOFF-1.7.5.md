# HANDOFF — Chatseek 1.7.5 原網站已刪除就封存

2026-10-11。分支 `feat/deleted-archive`，基準 main `b707eb0`（1.7.4）；使用者先後提交 `b27ec61`、`2d3fd17`、`21f70d7`、`76235a8`、`cb1509d`，已開 PR #26。**先前外部 Chrome for Testing 155 的 `test:e2e` 與 `test:e2e-sync` 已通過（使用者回報，exit 0），四張 1.7.5 範例截圖已追蹤。** 本輪以 `cb1509d` 修正 PR 第二輪獨立複審的兩項 P1：側欄標題誤當刪除證據、歷史首頁 redirect timing 誤授權。本輪產品修正尚未外部 Chrome 重跑；未 commit／push／合併，真站實測仍待完成，不能視為已發布。最新結果見文末。

## 行為與範圍

四家共用 `content/deleted.js` 只讀頁面，背景以 `src/deleted-visits.js` 的網址解析、分頁身分與背景時鐘核對。只有打開具體對話網址的頂層分頁能送出有效判定；不是用網站側欄列是否消失判斷。使用者打開、擴充的「原網站」按鈕，以及 sync-runner 導航都可提供本頁證據。網站 DOM 不改、不點網站按鈕、不打 API。

確定後僅更新已存在的 `conversations` 列：`archived=true`、`archiveSource="site-deleted"`。未知 id 不新增列；錯誤頁不走一般正文寫入。保留標題、內文、搜尋索引、圖片與最後活動時間。側欄「已封存」頁及閱讀頁顯示九語小字「原網站已刪除」，已開啟的閱讀頁也會隨 `INDEX_UPDATED` 更新。

恢復需要當下正常可見正文、擷取身分守門通過、非登入／載入／錯誤頁。只恢復 `site-deleted`；一般 ChatGPT 橫幅／歸檔清單來源不因打開正文就恢復。若刪除前已有 `chatgpt:*` 封存來源，用同一列的普通欄位 `deletedPreviousArchiveSource` 保留，正常正文恢復時仍回到原 ChatGPT 封存來源；後續明確橫幅／清單可覆蓋，手動恢復會清除。恢復前再讀當下 ChatGPT 橫幅與歸檔清單，防等待期間才出現的封存訊號。1.7.1 的「無封存訊號且有新訊息才恢復」規則不改；1.7.3 封存骨架部分不改。

## 所用訊號（推定，未經真實帳號驗證）

**四家刪除／無權限頁的文字及結構，都是依公開知識推定的人工 fixture，未使用真實帳號，也未經四家真站頁面驗證。不能宣稱已涵蓋現行所有 DOM／文案。** 同一組保守文字可用於四家，平台／id 一律由原本共用網址解析器限定。

| 平台 | 對話網址 | 正文明確結構（須可見且身分吻合） | 刪除／無權限證據 |
|---|---|---|---|
| ChatGPT | `/c/<uuid>`，含 `/g/.../c/<uuid>` | `data-message-author-role`、`data-message-id`、conversation-turn、`data-turn` | 具體對話錯誤文字；主內容 H1 的 not found／404；conversation/chat 專用 not-found/deleted/access-denied 結構 |
| Claude | `/chat/<uuid>` | user/human/assistant/ai-message testid、user/claude message 字體類別 | 同上（推定），不靠側欄消失 |
| Grok | `/c/<id>`、`/chat/<id>`，既有允許網域 | `data-turn`、message-bubble、`data-message-id`、markdown/prose | 同上（推定），不靠側欄消失 |
| Gemini | `/app/<id>`、`/gem/<gem>/<id>`，保留 `/u/N/` | `user-query`、`model-response`、query-text/model-response-text | 同上（推定），不使用網站內部 API |

明確文字以 NFKC、小寫、空白與句尾標點正規化後**整個短元素相等**，最多 240 字元，不用子字串命中對話內容。樣本包含英文 `Conversation not found`／`This conversation has been deleted`／`You do not have access to this conversation`，及以下九語代表文案（完整表在 `content/deleted.js`）：

| 語言 | 範例明確訊號 |
|---|---|
| zh-TW | 找不到這段對話、此對話已刪除、無權限存取此對話 |
| zh-CN | 找不到此会话、此对话已删除、无权访问此对话 |
| en | Conversation not found、This chat was deleted、You do not have access to this conversation |
| ja | この会話が見つかりません、このチャットは削除されました |
| ko | 대화를 찾을 수 없습니다、이 대화는 삭제되었습니다 |
| es | conversación no encontrada、esta conversación se ha eliminado |
| fr | conversation introuvable、cette conversation a été supprimée |
| de | unterhaltung nicht gefunden、diese unterhaltung wurde gelöscht |
| pt-BR | conversa não encontrada、esta conversa foi excluída |

通用「Access denied／403」不能單憑一般 H1 判定，必須有對話專用錯誤結構。明確文案須位於主內容、錯誤容器（role=alert／error testid／error code），或無主內容時的第一個 H1。正文、引用、程式碼、表單、網站 nav／aside／navigation／history／list 與任何 a[href] 內文字不算刪除訊號；其父元素也不能繼承這些文字當證據。候選含排除節點、隱藏後代或超過 128 個後代即保守拒絕，script／style／template／noscript 也排除。掃描錯誤節點上限 2000，diag 命中數上限 40。

首頁重導採組合證據：60 秒內有該分頁的具體對話 visit、同源且為允許的首頁／新對話路徑、目前 document 的 navigation entry `name` 精確等於目前網址、`type=navigate`、`redirectCount>0`，並有健康主內容＋可見輸入框、沒有正文／登入／載入／錯誤。`performance.timeOrigin + entry.startTime` 必須嚴格晚於背景此次 visit 的時間且不在未來；背景再次核對 report 的 visitAt 等於目前 visit、navigationAt 晚於此 visit。缺少時間、同毫秒或歷史 entry 都拒絕。**這不是直接取得完整 browser redirect chain**；沒有 HTTP redirect 證據的 SPA 重導寧可漏判。正常正文會清掉 visit；所有 trusted click／keydown 都取消 redirect intent。pagehide 讓舊 document 永久失去重導資格，popstate／pageshow persisted 另取消 visit 與延遲回呼；back_forward／traverse／reload 不能充當首頁重導證據。無待判對話 visit 的首頁重導也不計入 deleted；同網址明確錯誤頁的 direct 判定不受 navigation type 限制。

## 防抖與誤判防護

- 背景自行計時：訊號至少持續 **8000ms**，至少 **3 次**觀察；相鄰計入的觀察至少相隔 **1000ms**，超過 **6000ms** 未觀察就重新起算。候選專用重檢每 **1200ms** 直接重新讀取頁面／網址／背景證據，不依賴 DOM 變化、完整擷取退避或分頁可見性；最多 **12 次**重檢、**20000ms**期限，確認後立即停止。相同候選耗盡預算後不被一般擷取重啟。任何零命中／阻擋／改網址／改對話皆重設證據。
- 登入頁／按鈕九語及常見變體、password/login form、登入 href／aria-label、驗證碼/challenge、網路錯誤、限速、offline、readyState 未 complete、aria-busy/progressbar/loading、暫時空白一律不算。登入按鈕也不能把首頁 shell 變成重導證據。
- `hidden`、`aria-hidden`、CSS display:none／visibility:hidden、不同 conversation-id、切換 URL 後仍保留的原正文節點都視為**未知狀態**，同時暫停刪除與恢復；不把它們當存在，也不拿不存在推論刪除。節點消失／重新掛載且正常身分確認後才可恢復。
- 背景重新讀取分頁現址，拒絕舊 URL 延遲回覆、iframe、來源平台不符。恢復另需目前 id 一致與正訊息數；內容端做當下身分及可見正文檢查。
- diag 僅新增 `deleted=N`，數值正規化；不含任何標題、正文、對話 id、網址。測試用人工 garden／pond 資料與人工 id。

## 測試與複審

執行環境 Node **v26.10.0**。下表是前次交接的完整測試結果；本輪靜態頁修復的新結果見文末。全部以 exit 0 為通過。

「通過腳本數」是 package.json 串接的測試程式數，**不是合併斷言總數**；各程式沒有一致斷言計數器。括號中的數字沿用實際輸出。

| 指令 | 通過腳本數 | exit | 實際驗證數字／範圍 |
|---|---:|---:|---|
| `npm run verify` | 2/2 | 0 | 守門＋ChatGPT fixture（2 則） |
| `npm run test:search` | 29/29 | 0 | 新增刪除 731 checks；panel 303；parser 85；syntax 44；攻擊樣本 314 |
| `npm run test:fixture` | 4/4 | 0 | Markdown 15 pieces；ChatGPT 2 則；Gemini 4／6 則 |
| `npm run test:integrity` | 3/3 | 0 | 42 個具名 PASS 場景 |
| `npm run test:upgrade` | 5/5 | 0 | DB 1→4、1.4、圖片、生圖進度／複審 |
| `npm run test:sync` | 1/1 | 0 | 3000 條人工佇列合併 |
| `npm run test:gemini` | 2/2 | 0 | 4 則擷取、6 則正文 capture、4 條側欄 |
| `npm run test:spa` | 5/5 | 0 | 既有 SPA ＋ 8 個複審場景＋42 個完整性場景 |
| `npm run test:skeleton` | 2/2 | 0 | 節點 cap 6000／深度 cap 60；複審 55 nodes |
| `npm run test:progress` | 2/2 | 0 | 3000 rows／500 thumbnails 遷移；8 個具名複審 PASS |
| `npm run test:deleted` | 1/1 | 0 | 731 checks；4 平台、9 語；防抖 8000ms |

新增 `scripts/deleted-test.mjs`，納入 `test:search` 並可單跑 `test:deleted`。四家正負頁面、九語與登入變體、8 秒防抖／長間隔重設、重導／手動返回／舊 navigation entry、hidden/CSS/SPA 殘留、未知 id 真正 adapter 不寫入、正文恢復、ChatGPT 來源共存／晚到橫幅、九語閱讀頁與即時標示、DB 4、diag 去識別化均有回歸。側欄九語小字另由 panel-test 檢查，catalog 與九個 `_locales` 由 i18n-test／verify 對齊。

獨立 Codex session `/root/review_175`：第一輪 BLOCK 的手動返回、隱藏正文、四種語言登入按鈕問題皆修；本輪複審 **PASS**，獨立 deleted-test **619 checks**（最後表單／導覽／側邊登入補強另唯讀複查；主 session 最終 **731 checks**）、兩項 node --check、git diff --check 與 manifest 保護欄位對照通過。複審未跑真站／Chrome E2E，提醒重導證據的限制如上。

## E2E 與外部執行

`scripts/e2e-chatgpt.mjs` 增加人工 ChatGPT fixture：正常頁先收錄兩則→同網址改成「Conversation not found」→等待穩定封存→側欄已封存與英文小字→恢復同一正常正文→回活躍。另確認兩則原訊息與活動時間保留。已輸出 `docs/panel-1.7.5-deleted.png`，全部人工資料。

沙箱不能 listen，這裡只做 node --check。使用者以 Chrome for Testing 155 外部驗證 `76235a8`：完整 `test:e2e` 與 `test:e2e-sync` 均 exit 0，包括 SPA selector／heuristic、搜尋語法、刪除封存與恢復。兩次先前失敗與根因見本文後段。外部執行方式：

```bash
CHROME_PATH=/tmp/cft/chrome/linux-155.0.8059.39/chrome-linux64/chrome npm run test:e2e
CHROME_PATH=/tmp/cft/chrome/linux-155.0.8059.39/chrome-linux64/chrome npm run test:e2e-sync
```

使用者外部執行後的範例截圖已由 `cb1509d` 追蹤；本輪沒有重寫或暫存進 Git：

- [刪除封存側欄](../docs/panel-1.7.5-deleted.png)：405×1180。
- [SPA 範例側欄](../docs/panel-1.7.5-spa.png)：405×1199。
- [SPA 範例閱讀頁 A](../docs/reader-1.7.5-spa-A.png)：900×720。
- [SPA 範例閱讀頁 B](../docs/reader-1.7.5-spa-B.png)：900×720。

SPA 截圖依 manifest 版號產生，因此這次檔名是 1.7.5。若外部 e2e 也覆寫 tracked 舊版截圖，應還原舊檔，保留上述本版人工範例。本輪沒有改任何圖片與 `docs/readme-assets/`。

## 效能

對 main `b707eb0`（1.7.4）以同一 `scripts/search-syntax-bench.mjs` 依序量測，Node v26.10.0 + fake-indexeddb + JSDOM。暖機一次、五次量測取中位數；閱讀頁 3000 則人工訊息、720px 視窗、100 次模擬捲動，捲動數字為每輪 p95 再取中位數。清單搜尋是 3000 段各一則訊息、query `blue orchid`、300 結果／600 高亮，limit 3000；**不含實際側欄清單 DOM 掛載**。500 張縮圖使用人工 cached 佔位。這些數字不包含圖片解碼、Chrome layout／paint，不能當成真 Chrome 效能。

| 項目 | 1.7.4 ms | 1.7.5 ms | 變動 |
|---|---:|---:|---:|
| 3000 段清單搜尋 | 475.61 | 478.05 | +0.5% |
| 3000 則閱讀頁掛載 | 7.63 | 7.25 | -5.0% |
| 3000 則閱讀頁捲動 p95 | 1.60 | 1.77 | +10.6% |
| 500 張縮圖掛載 | 3.86 | 3.41 | -11.7% |
| 500 張縮圖捲動 p95 | 2.12 | 1.81 | -14.6% |

沒有超過 30% 的變慢；差異包含離線計時波動。本次未改搜尋或圖片演算法。Chrome 側欄完整 DOM／實際 layout、capture 新增證據掃描的真站成本仍待外部量測。既有瀏覽器效能腳本需要 listen，此沙箱無法執行。

```bash
node scripts/search-syntax-bench.mjs /tmp/chatseek-175-baseline --ordinary
node scripts/search-syntax-bench.mjs --ordinary
node scripts/search-syntax-bench.mjs /tmp/chatseek-175-baseline --images
node scripts/search-syntax-bench.mjs --images
```

baseline 是 read-only `git archive b707eb0` 解開到 `/tmp/chatseek-175-baseline`；沒有改 Git branch／index。

## 保護欄位與限制

permissions 恰好 `["sidePanel"]`；與 main `b707eb0` 對照 host_permissions、content_scripts.matches、CSP／注入時機／world 均不變，只增加共用 content script 檔名。DB **4**，沒有新 index／migration。verify 只新增守門、版本改 **1.7.5**；無網路請求、無 HTML 字串注入、無真實資料、花費 **$0**。不動未追蹤舊 notes、`.codewhale/`、`docs/readme-assets/`。

已知限制：真站文案／DOM 未驗證；只接受精確短文案與保守結構，因此未知語言／改版／無結構錯誤可能漏判。SPA 無可核對 HTTP redirect、worker 重啟失去 pending visit、跨來源重導、60 秒外重導均保守漏判。隱藏或舊正文長留會延後判定／恢復；正文僅在 shadow／iframe 而頂層無可見正文時，這版共用 helper 不據此恢復。`redirectCount` 可能因瀏覽器隱私限制為零，會漏判。HTTP redirect chain 並非直接取得，組合證據仍須真站／外部 E2E 驗证。原有手動同步遇錯誤的暫停規則不變。

## 老闆實測（≤6 步）

1. 在自己的 Chrome 載入 1.7.5，先打開一段可丟棄的範例對話讓擴充收錄。
2. 在原網站刪掉該範例，再打開其原網址；等至少 8 秒，核對「已封存」小字與 `deleted=N`，本機正文仍在。
3. 對其他三家以同樣可丟棄資料重做；若沒判定，回傳只含命中數的診斷，勿回傳真實內容。
4. 核對登入／驗證／離線／手動回首頁都不封存；已有 ChatGPT 封存橫幅的對話正常讀取也不被恢復。
5. 用外部 fixture e2e 核對同網址恢復正文後回活躍、小字消失及範例截圖。


## 外部 E2E run1 timeout 修復（基準 `2d3fd17`）

外部 Chrome for Testing 155 的 SPA selector／heuristic、search syntax 通過；`stable deleted fixture archives the existing conversation` 在 30 秒 timeout。外部診斷有 `deleted=1`，證明明確錯誤文案已命中。**單一 diag 行不是只觀察一次的證據**：產品刻意將同一 deleted 命中數去重。

根因在排程的組合：

1. 先前候選 timer 呼叫 `requestRescan()`；該函式會跳過 `document.hidden` 的分頁。手動同步及 e2e 切到閱讀頁／側欄時，對話分頁可正好是 hidden。
2. 一般 `observe` 收到 capture 返回 false 後，重試退避是 3／6／12 秒，再加 800ms debounce。第二段觀察間隔約 6.8 秒，超過背景 **6 秒**允許間隔，證據被重新起算，不能累積完整 8 秒。沒有 DOM 變化就缺少額外喚醒。
3. 同網址錯誤文案走 direct 判定，沒有要求 navigation type=navigate 或 redirectCount；**reload 不是此失敗的根因**。

產品修正僅在 `content/deleted.js`：有候選與具體 context id 時，用獨立 timeout 再呼叫刪除判定，重新讀 DOM／網址／背景 context，不重跑全文擷取、也不通過隱藏頁的 `requestRescan`。1200ms、最多 12 次／20 秒；背景 8 秒／3 次／6 秒 gap 完全不變。confirmed／零訊號／阻擋／URL 改變／trusted 互動／pagehide／runtime 失效停止；epoch 與候選物件身分阻止延遲回呼再啟動，耗盡預算的同一 key 不重啟。頁面訊號在等待背景 context 後讀取，避免等待期間的舊快照。

`verify.mjs` 新增加界線檢查，未放寬任何守門。`scripts/deleted-test.mjs` 使用真正 shared observer 與四家 adapter、虛擬計時器、hidden document、navigation type=reload／redirectCount=0，沒有手動重複呼叫判定、沒有 DOM mutation。完整 8 秒前不封存，12 秒內封存；並檢查正文／活動保留、確認後停止、登入／隱藏舊正文／手動回首頁／pagehide／orphan／空白取消、12 次及20秒預算與不重啟。

同一新增回歸切換為 `2d3fd17` 的舊 helper 時，**exit 1**：`chatgpt: static hidden reload archives within 12 seconds`；修正後 **775 checks、exit 0**（原 731＋新增 44）。舊碼重現只用臨時檔，測完刪除，沒有改 e2e 的等待時間、fixture、斷言或三種誤判防護。

獨立 session `/root/review_175` 本輪複審 **PASS**，獨立 775 checks／node --check 通過。全部人工資料，無權限／host／CSP／DB 變動；版本保持 1.7.5，DB 4。

以下是 `21f70d7` 修復時的歷史結果，最新結果見本文末節。該輪 Node v26.10.0，verify 與 package.json 全部 10 個離線 `test:*` 皆 exit 0；通過數是串接腳本數，不是斷言總數。

| 指令 | 通過腳本數 | exit |
|---|---:|---:|
| `npm run verify` | 2/2 | 0 |
| `npm run test:skeleton` | 2/2 | 0 |
| `npm run test:search` | 29/29 | 0 |
| `npm run test:progress` | 2/2 | 0 |
| `npm run test:sync` | 1/1 | 0 |
| `npm run test:upgrade` | 5/5 | 0 |
| `npm run test:fixture` | 4/4 | 0 |
| `npm run test:gemini` | 2/2 | 0 |
| `npm run test:spa` | 5/5 | 0 |
| `npm run test:integrity` | 3/3 | 0 |
| `npm run test:deleted` | 1/1 | 0 |

其中 `test:search` 與 `test:deleted` 均含 **775 checks**（新增 44）；panel 303、parser 85、syntax 44、Markdown 攻擊樣本314。`node --check content/deleted.js`、`scripts/deleted-test.mjs`、`scripts/e2e-chatgpt.mjs`、`scripts/e2e-sync.mjs` 與 `git diff --check` 通過。

當時 Chrome `test:e2e` 與 `test:e2e-sync` 在沙箱僅做 node --check，沒有 listen／實跑或生成／覆寫截圖；後續外部通過結果見下節。嚴重背景 timer 節流或 service worker 回應延遲仍可能耗盡預算而漏判；保持原本保守防抖，不擅自放寬觀察間隔或判定門檻。此前 3000 則／500 縮圖離線效能表為前次實作的量測，本輪沒有重測；正常無候選頁不新增排程，候選最多12次只讀證據核對，真 Chrome 成本仍待外部驗證。

## 外部背景側欄 click timeout（修正已提交為 `76235a8`）

`21f70d7` 已讓靜態錯誤頁在防抖後取得 `archived=true`／`site-deleted`。後續 CfT 155 卡在背景 `panel.click('[data-scope="archived"]')` 的 `Runtime.callFunctionOn`，不是資料庫判定失敗。Puppeteer 25.12.0 的 `ElementHandle.click()` 先跑 `scrollIntoViewIfNeeded()`／`isIntersectingViewport()`，其中 evaluate 的 Promise 等待 IntersectionObserver 回呼；這個 Promise 未完成不等於 renderer 無法執行其他 JS。

使用者外部插樁取得：

| 時機 | hidden | intersectionDelivered | INDEX_UPDATED 次數 | 清單替換次數 |
|---|---|---|---:|---:|
| before focus | true | false | 2 | 2 |
| after focus | false | true | 2 | 4 |

背景時 plain evaluate 能回傳，廣播維持兩次，切到前景後 IO 交付且真實 click、完整 E2E 通過，**確認根因是測試背景分頁的 IntersectionObserver 等待，不是 renderer 卡死或產品刷新風暴**。e2e 將側欄 HTML 開成獨立普通分頁，真實 Chrome 側欄則與網站並排可見；`clickForeground()` 先 `bringToFront()` 再使用原本 Puppeteer click，讓測試互動符合實際可見 UI。沒有改 fixture／防抖門檻／等待上限或狀態斷言。

四家實際 shared observer／adapter 的離線回歸亦確認：靜態錯誤頁只廣播兩次（health 一次、封存一次），再等 60 秒與40次並發確認不追加；40次並發恢復只一筆 changed、一次廣播。`deleted-test` 共 **795 checks**。實際安裝的 Puppeteer 配合模擬 IO 交付的 `e2e-ui-test` 為 **8 checks**；此模擬原本只證明等待路徑，CfT 根因現在由上述外部結果補齊。

## panel 回歸 timeout 修正（本輪基準 `76235a8`）

`active scope responds after recovery` 是新增測試的錯誤假設。較早的排序案例留下 `count asc`；85筆零訊息填充列會先於一則訊息的「Sample deleted garden」。原測試清空 query、恢復後就要求範例必須出現在清單，但側欄 idle 清單固定只顯示排序後前80筆。

使用同一 fixture 的臨時診斷重現：活躍查詢 **92筆**，該範例零基排序 **87（第88筆）**，資料庫 `archived=false`、畫面 **80筆**、活躍控制的 `aria-selected=true`。證明 DB 恢復、scope 切換、刷新都已成功，缺少範例是正常的筆數上限；增加 timeout 或改產品刷新不會讓第88筆出現在前80筆。

僅修 `scripts/panel-test.mjs`：保持100次 INDEX_UPDATED 合併、刷新停止、封存小字與恢復回歸；恢復後先比對活躍 DOM 全部80列與真 DB 排序結果前80筆，確認超出上限的範例仍屬活躍，再以其範例標題搜尋，驗證活躍列出現且封存標籤／小字消失。沒有清掉排序或減少填充資料，也沒有放寬斷言。產品碼與三種誤判防護不變；權限／host／CSP／DB版本仍未變。

本輪 Node v26.10.0；verify 與 package.json 全部 **11個離線 `test:*`** 皆 exit 0。下表計數是指令串接的腳本數，不是斷言總數。

| 指令 | 通過腳本數 | exit |
|---|---:|---:|
| `npm run verify` | 2/2 | 0 |
| `npm run test:search` | 30/30 | 0 |
| `npm run test:fixture` | 4/4 | 0 |
| `npm run test:integrity` | 3/3 | 0 |
| `npm run test:upgrade` | 5/5 | 0 |
| `npm run test:sync` | 1/1 | 0 |
| `npm run test:gemini` | 2/2 | 0 |
| `npm run test:spa` | 5/5 | 0 |
| `npm run test:skeleton` | 2/2 | 0 |
| `npm run test:progress` | 2/2 | 0 |
| `npm run test:deleted` | 1/1 | 0 |
| `npm run test:e2e-ui` | 1/1 | 0 |

panel 回歸 **310 checks**，主 session 單獨跑兩次及完整 test:search 都通過；獨立 session `/root/review_175` 本輪複審 **PASS**、另跑310 checks／diff檢查通過。deleted **795 checks**、e2e-ui **8 checks**；兩項瀏覽器 e2e 的 node --check 及 git diff --check 亦通過。完整結果留在 `/tmp/chatseek-175-recovery-tests.json` 與同前綴測試 log（不提交）。本輪未重新啟動 Chrome／listen，也未重測效能：產品碼沒有改變，上面的效能表為前次量測。

## PR #26 第二輪複審 P1 修復（本輪基準 `cb1509d`）

外部獨立複審 **REQUEST_CHANGES** 的兩項 P1 均為產品誤判，沒有放寬測試或防抖門檻。新增測試使用四家真正 adapter／shared observer、background 與 IndexedDB，靜態頁不製造 DOM mutation，觀察 14 秒，超過原本 8 秒門檻。

1. **側欄標題繼承。** 舊 helper 掃全頁 p/div，精確文案可來自另一段對話的側欄連結，甚至從其父元素的 textContent 命中。新增四家負例切回舊碼會 exit 1：`chatgpt: unmarked link is not deletion evidence after debounce`。修正 `content/deleted.js`：只接受主內容／錯誤容器／無 main 時第一個 H1；排除 a[href]、aside/nav/navigation、history/sidebar、清單／樹與對話標題，以及含這些後代的父元素。獨立再複查另外指出 quote、input、CSS 隱藏後代及 script/template 的父元素繼承，已一併排除；候選超過 128 個後代即拒絕。選擇器涵蓋大小寫變體與 Gemini conversation 清單標記。實際錯誤頁 main/p、主內容外 role=alert、無 main 的主要 H1 正例仍能封存。
2. **歷史首頁 navigation entry。** visit 只記 id／平台，沒有核對 PerformanceNavigationTiming 產生時間，歷史 redirectCount 可授權後來的對話；頁內可信 click／keydown 也看不到瀏覽器上一頁。保留第一項修正、套回舊時間判定，新增回歸 exit 1：`claude: old entry cannot reuse homepage redirect timing`。修正 `content/deleted.js`、`src/deleted-visits.js`：entry 必須為 navigate，絕對時間嚴格晚於本次 visit；背景再次核對同一 visitAt 與非未來 navigationAt。back_forward／traverse／reload、舊／同時／缺失／未來 entry、visit 被換掉均不授權。pagehide 退役舊 document，pageshow persisted／popstate 取消 visit、候選與延遲 context 回覆；不靠網站 DOM 事件猜測瀏覽器按鈕。

四家「本次新重導」正例還揭露既有 `background.js` 的 `ACTIVE_LOCATION` 會在首頁先清掉 pending visit，使真正 ChatGPT／Gemini observer 無法判定重導。已改為僅保留 `deletedVisitContext` 確認的近期、同源、合法首頁 visit；仍清除首頁的網站對焦追蹤，任何封存寫入仍須通過新時間核對與原防抖。四家真正 observer 的新重導正例均通過，沒有靠改 fixture 呼叫順序或跳過 ACTIVE_LOCATION 規避產品問題。

`scripts/deleted-test.mjs` 現為 **1455 checks（原 795＋新增 660）**，含四家側欄／連結／清單／繼承文字負例、歷史首頁／BFCache／popstate 與延遲回覆負例、背景二次時間核對、新重導及有效錯誤容器正例；既有手動首頁、隱藏／SPA 舊正文、九語登入、未知 id、恢復與 ChatGPT 封存共存、廣播去重與有界重檢全保留。

修後獨立 Codex session `/root/review_175` 再複查 **PASS**：獨立 deleted-test **1455 checks、exit 0**，三個產品檔案 node --check、git diff --check 通過，未改檔。JSDOM 對刻意無效 CSS 攻擊樣本輸出八行 `Could not parse CSS stylesheet`，不是測試失敗。

本輪版本仍 **1.7.5**、DB **4**；manifest／verify／權限／host／CSP 未改，無網路請求／HTML 字串注入／真實資料。未改既有未追蹤草稿、`.codewhale/`、`docs/readme-assets/` 或任何圖片，也未 commit／push／合併。

本輪限制：嚴格大於 visit 的時間檢查會拒絕同毫秒或導航早於背景收到通知的重導，缺少 timing、BFCache 復用、SPA 重導也寧可漏判。複雜錯誤頁若混有連結／隱藏後代或超過 128 個後代，候選可能被拒絕；其他合法短元素仍可命中。文字／DOM 仍僅公開知識推定，未經真實帳號驗證。上文 CfT 通過及四張截圖是**先前版本**證據，不能作本輪 P1 防護的 Chrome 通過證據；本輪只做兩支瀏覽器 e2e 的 node --check，BFCache／首頁 guard 仍待外部 Chrome 重跑。上文效能表也是先前量測，本輪沒有重測新增證據掃描的 Chrome 成本。

本輪 Node v26.10.0，完整離線測試全部 exit 0。「通過腳本數」依 package.json 串接的程式計算；斷言數另列於下方。每個指令均直接執行並保留完整 log。

| 指令 | 通過腳本數 | exit |
|---|---:|---:|
| `npm run verify` | 2/2 | 0 |
| `npm run test:search` | 30/30 | 0 |
| `npm run test:fixture` | 4/4 | 0 |
| `npm run test:integrity` | 3/3 | 0 |
| `npm run test:upgrade` | 5/5 | 0 |
| `npm run test:sync` | 1/1 | 0 |
| `npm run test:gemini` | 2/2 | 0 |
| `npm run test:spa` | 5/5 | 0 |
| `npm run test:skeleton` | 2/2 | 0 |
| `npm run test:progress` | 2/2 | 0 |
| `npm run test:deleted` | 1/1 | 0 |
| `npm run test:e2e-ui` | 1/1 | 0 |

完整 test:search 與單跑 test:deleted 均為 **1455 checks**；panel **310 checks**、e2e-ui **8 checks**。`node --check` 三個產品檔案、deleted-test 與兩支 `scripts/e2e-chatgpt.mjs`／`scripts/e2e-sync.mjs` **6/6 通過**；`git diff --check` 通過。log 在 `/tmp/chatseek-175-p1-*.log`，不提交。瀏覽器 test:e2e／test:e2e-sync 本輪未在沙箱執行；外部重跑方式仍使用上文的 CfT 155 兩條指令。

## 第三輪複審 P1 修復（基準 871ff92）

PR #26 第三輪獨立複審 **REQUEST_CHANGES** 指出上一輪正文收集誤用了刪除文案的 `TITLE_CONTEXT`。該選擇器包含所有 ol／ul／role=list 等清單，已識別的對話正文在清單內就被先丟掉，不能進入 `ambiguous` 的隱藏／舊 SPA 正文防護。同頁主內容出現明確刪除文案時，因而把「正文未知」誤當「沒有正文」並封存。

修正僅在 `content/deleted.js`：正文收集與 `visibleTranscript()` 改用狹義 `TRANSCRIPT_NAV`（nav／aside／role=navigation），保留一般清單內已識別的正文，繼續依 hidden／aria-hidden／CSS 可見性、頁面身分與 SPA residual 檢查決定 body／blocked。廣泛 `TITLE_CONTEXT` 繼續只用於刪除文案候選；側欄／連結／歷史清單與父元素繼承文案的排除完全保留。歷史 redirect timing、BFCache／popstate、背景二次 visit 時間核對、8 秒多次觀察、有界重檢與廣播去重均未改。

`scripts/deleted-test.mjs` 新增 **264 checks**：四平台各自將正常正文包入 ol/li、ul/li、role=list/listitem，分別用 hidden、aria-hidden、display:none、visibility:hidden 隱藏，主內容顯示 `Conversation not found`。共 **48 個隱藏正文場景**使用真正 adapter／observer／background／DB 觀察 **14000ms**，確認沒有封存、blocked=true、body=false、hits=0、homeReady=false、未送正刪除證據、原本訊息與活動時間保留；另有 **12 組可見正文及 URL 切換殘留檢查**，確認清單正文仍能識別且舊 SPA 節點不能授權刪除。所有舊斷言與門檻原樣保留。

新增回歸先在未改產品碼的 `871ff92` 執行，**exit 1**：`chatgpt: ol hidden transcript cannot archive after 14 seconds`（`/tmp/chatseek-175-r3-before.log`）；修後單跑 **1719 checks、exit 0**（1455＋264），四平台九語、防抖 8000ms。只有人工範例資料，沒有帳號或真實內容。JSDOM 既有無效 CSS 攻擊樣本的八行 stylesheet warning 仍不影響 exit。

獨立 Codex session `/root/review_175_r3` 唯讀複查 **PASS**，獨立跑 deleted-test **1719 checks、exit 0**，核對舊碼失敗 log；兩個改動 JS 的 node --check 與 git diff --check 通過。確認刪除候選排除、歷史 navigation／BFCache 與背景時間核對均未改。

限制：這是已識別正文的保護修復，不擴大四家正文選擇器；未知 DOM 仍可能漏判。隱藏／殘留正文若一直不移除，會保守阻擋刪除及恢復；一般歷史清單若包含看似正文的結構，也可能造成漏判。四家錯誤頁文案仍為公開知識推定，未經真實帳號驗證；本輪未啟動瀏覽器 e2e 或重新量測效能，不能沿用先前 CfT 結果宣稱本輪 Chrome 已通過。

版本 **1.7.5**、permissions 恰好 **["sidePanel"]**、DB **4**；manifest／host／CSP／verify／background 未改，沒有網路請求、HTML 字串注入或新 schema。不改圖片、未追蹤草稿、`.codewhale/`、`docs/readme-assets/`、xsched，不做 1.7.6。未 commit／push，交由主控處理。

本輪 Node v26.10.0，verify 與全部 **11 個離線 `test:*`** 均直接執行、**exit 0**。下表是指令串接的通過腳本數，斷言數另列。

| 指令 | 通過腳本數 | exit |
|---|---:|---:|
| `npm run verify` | 2/2 | 0 |
| `npm run test:search` | 30/30 | 0 |
| `npm run test:fixture` | 4/4 | 0 |
| `npm run test:integrity` | 3/3 | 0 |
| `npm run test:upgrade` | 5/5 | 0 |
| `npm run test:sync` | 1/1 | 0 |
| `npm run test:gemini` | 2/2 | 0 |
| `npm run test:spa` | 5/5 | 0 |
| `npm run test:skeleton` | 2/2 | 0 |
| `npm run test:progress` | 2/2 | 0 |
| `npm run test:deleted` | 1/1 | 0 |
| `npm run test:e2e-ui` | 1/1 | 0 |

完整 test:search 與單跑 test:deleted 均 **1719 checks**，panel **310 checks**、e2e-ui **8 checks**。修改的兩個 JS 及 `scripts/e2e-chatgpt.mjs`／`scripts/e2e-sync.mjs` 的 node --check **4/4 通過**，git diff --check 通過。完整 log 位於 `/tmp/chatseek-175-r3-*.log`，不提交；瀏覽器 e2e 仍由外部環境執行。

## 暫停（2026-10-11 11:10，商務拓展排程）
PR #26 先不合。第 3 輪複審（01a1250f）REQUEST_CHANGES 唯一必修未完成：
- P1：content/deleted.js:60 以 TITLE_CONTEXT 排除所有 ol／ul／role="list"，正文若在這些容器（如 <ol hidden><li>）會在 ambiguous 檢查前被丟棄；主內容顯示 Conversation not found 時四家都誤封存為 site-deleted（cb1509d 是 blocked）。
- 修法：區分歷史側欄（nav／aside／已知側欄容器）與正文清單；保留隱藏／殘留正文阻擋；deleted-test.mjs 補四家 <ol hidden><li> 與 role="list" 回歸。
- 本 commit 含上一次中斷留下的未完成修改（未經測試）。
- 注意：Codex 01a12503 曾因被中斷留下「already has an active writer」鎖，接續前要先處理（或另開新寫碼 session 並記錄）。

## 暫停後接續確認（基準 a94baed，僅第三輪 01a1250f 的 P1）

依使用者接續指示重新讀取上節並檢查 WIP。`a94baed` 已包含正確的狹義 `TRANSCRIPT_NAV` 與四家回歸，直接沿用；正文收集及可見性檢查不再使用廣泛 `TITLE_CONTEXT`，ol／ul／role=list 中已識別正文仍參與 hidden／aria-hidden／CSS 可見性與 SPA residual 阻擋。刪除候選的側欄標題排除、歷史 redirect timing 及其他原有防護保留。本次沒有新增產品碼或測試修改，只補本節實際驗證紀錄；本次接續 session 可正常寫入工作區，未遇到前述 active writer 鎖。

Node v26.10.0，本次直接執行使用者指定的三個指令，全部 **exit 0**：

| 指令 | 通過數字 | exit |
|---|---|---:|
| `npm run verify` | 2/2 腳本（守門＋ChatGPT fixture） | 0 |
| `npm run test:deleted` | 1719 checks；4 平台、9 語、防抖 8000ms | 0 |
| `npm run test:search` | 30/30 腳本；含 deleted 1719、panel 310、e2e-ui 8 checks | 0 |

四家清單正文回歸涵蓋 ol/li、ul/li、role=list/listitem × 四種隱藏形式，實際 adapter／observer／background／DB 觀察 14 秒，確認 blocked、零刪除證據、不封存、正文及活動時間保留；可見與殘留正文回歸也通過。原有側欄標題與 redirect 負例一起通過，未放寬斷言或門檻。獨立 Codex session `/root/review_175_resume` 唯讀複查 **PASS**，獨立 deleted-test **1719 checks、exit 0**。兩個 JS 的 node --check 與 git diff --check 通過。新 log：`/tmp/chatseek-175-resume-*.log`，不提交；本次只重跑上述三個指令，其他測試結果仍是前次紀錄。

本項 P1 的接續驗證已完成；PR #26 仍交由外部主控處理，不 commit／push／merge。DB **4**、版本 **1.7.5**、permissions **["sidePanel"]**、host／CSP 原樣，未新增網路請求或 HTML 字串注入，不改圖片／未追蹤草稿／其他功能。已識別的隱藏或殘留正文仍會保守阻擋，未知正文 DOM 與真站驗證限制照舊。
