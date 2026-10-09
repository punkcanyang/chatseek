# Chatseek 1.7.2 交接

版本 **1.7.2**，基準 `ad8f7d1`（＝合完 1.7.1 的 main，`git merge-base HEAD origin/main`）。分支 `fix/imagegen-progress`。只做開工卡「追加 P0」的 (d)：ChatGPT 生圖進度文字被存成十幾則重複助理訊息。(b)(c) 未動。

權限仍恰好是 `["sidePanel"]`。`host_permissions`、`content_scripts.matches`、CSP 沒有改。沒有新的網路請求（不 `fetch`／XHR／`sendBeacon`／WebSocket／EventSource，不 `new Image`，不重抓圖），不點網站按鈕，不改網站 DOM，擴充碼不用 `innerHTML`。資料庫仍是版本 **4**（沒有升版）。花費 0，沒有新 npm 依賴。

## 根因（附證據）

一條路走到底，全部在 `ad8f7d1` 的程式裡：

1. **進度泡泡沒有穩定 id。** ChatGPT 的生圖進度是一個 assistant 泡泡，沒有 `data-message-id`（圖片出現前它還不是正式回覆）。`content/chatgpt.js` 的 `messageFromNode` 因此在 id 缺失時退化成 `Chatseek.hash(resolved + ":" + body.slice(0, 180))`。正文每變一次（25%→38%→51%→80%），hash 就變，於是**同一則泡泡每 tick 都拿到新 id**。
2. **`msgFp` 由 id + 正文組成**（`content/shared.js` `runCapture`），id 一變就去重失效，每 tick 都送一次 `CAPTURE_MESSAGES`。
3. **`src/db.js` `writeMessages` 以 message id 為主鍵**；新 id＝新 row。`src/message-identity.js` 的 `alignRekeyedTurns` 只在正文**前綴**變長／縮短時把舊 id 別名到新 id；進度是「非前綴改寫」（`25%`→`38%` 不是加尾巴），對不上，所以不會別名，直接留成第二、第三…則重複塊。

**重現（`scripts/progress-test.mjs` Part A，模擬 1.7.1 前的擷取路徑；`node scripts/progress-test.mjs`）**：

```
Part A  progress turn ids: 4 distinct: 4
Part A  what <= 1.7.1 stored: 5 rows; 4 progress
Part A  a progress rewrite must not count as new activity   # pageShowsNewActivity === false
```

即：同一則 assistant 泡泡，四個進度百分比 → 四個不同 hash id → 資料庫 5 則（1 則使用者 + 4 則進度），閱讀頁因此排出十幾／數十個幾乎一樣的塊。

**lastActivity**：Part A 另外斷言 `pageShowsNewActivity(...) === false`。實測 1.7.1 在這條路徑上沒有誤蓋「剛剛」（`updatedAtSource` 仍是 `page-exact`），但為了不回退，1.7.2 明確把進度 tick 排除在「觀察到新訊息」之外（見下）。

## 改動

- **新增 `src/image-progress.js`**：
  - `PROGRESS_PHRASES`：九個 `_locales` 語系（zh_TW／zh_CN／en／ja／ko／es／fr／de／pt_BR）的生圖進度片語（建立圖像／勾勒草圖／生成初稿／打磨細節…＋英文 Creating image／Sketching／Adding details…）。
  - `isProgressText(body)`：保守判定——整則**幾乎只剩進度狀態文字**（可含可選百分比／省略號）才算 true。一般含「%」的內文不會被吞。
  - `isProgressNode(node)`：明確的串流／生成中 DOM 標記（例如 `data-is-streaming`）。
  - `hasContentImage(node)`：泡泡裡是否已出現真正的內容圖片。
  - `planProgressMerges(rows)`：遷移用——把「同一對話、同位置、相鄰、只差進度文字」的 assistant 連續塊合併；一輪裡若有非進度的 assistant 收尾就保留它，否則保留該輪最後一則。
- **`content/chatgpt.js`**：`messageFromNode`／`heuristicFromBlock` 標上 `progress` 旗標；`packMessages` 只在 `!message.progress` 時把圖片 host 收進來（不把進度泡泡當圖片容器）。
- **`content/shared.js` `runCapture`**：過濾進度訊息（不送 `CAPTURE_MESSAGES`）；有生成中標記時 hold，等穩定（圖片出現或進度文字消失）再寫；`healthState="progress"`；`messageStats` 跳過 `msg.progress===true`。診斷新增 `progressSkipped`（計數）與 `progress=skipped:N`（只有數字，無內文／標題／id／網址）。
- **`src/message-identity.js`**：在既有的前綴 grow／shrink 別名之後，加一趟 **progress alias**：同一位置、舊 body 是進度、新 body 是它的穩定版時，把舊 id 別名到新 id，達成「同位置同一則正文變動→就地更新，不新增」。
- **`src/db.js`**（**未升版，仍為 4**）：新增 `repairConversationProgress` / `repairProgressDuplicates`，用 `meta` 的 `progressRepair` 旗標做**冪等**啟動時一次性整理。逐對話取 messages（`index("conversationId").getAll`，依 `orderMessages(all, null)` 的**時間序**，不是 order meta），把重複塊的 images／縮圖紀錄搬到保留的那則，刪掉 drop 的 message row 與 token，更新該對話的 order／`tailMessageId`／`captureBaselineTail`，只在必要時重算 `lastPreview`／`messageCount`；**不動 `updatedAt`**。log 只有計數：`[Chatseek] progress repair merged=X dropped=Y`。
- **`background.js`**：`onInstalled`／`onStartup` fire-and-forget 跑 `ensureProgressRepair()`；`CAPTURE_MESSAGES` 先 `ensureProgressRepair().catch(()=>null)` 再 `upsertMessages`。
- **`scripts/verify.mjs`** 只加嚴：版本 1.7.1→1.7.2；`src/image-progress.js` 納入網路請求掃描；新增 1.7.2 規則（export 檢查、語系涵蓋、`isProgressMessage` 使用、`runCapture` 過濾、`ensureProgressRepair` 存在、log 只含計數、`progress=skipped` 只有數字、`DB_VERSION===4`）；`PROGRESS_PHRASES` 兩處鏡像（`src/image-progress.js` 與 `content/shared.js`）交叉比對。
- **版本**：`manifest.json` → `1.7.2`（`package.json` 無 version 欄位）；`package.json` 新增 `test:progress` 並掛進 `test:search` 鏈。

## 測試

```bash
npm ci                 # node_modules 已在，略過
npm run verify         # verify ok；chatgpt-fixture ok { selector: '[data-turn]', messages: 2, emptyWarn: true }
npm run test:search    # 含 progress-test，全過
npm run test:fixture
npm run test:gemini
npm run test:upgrade
npm run test:sync
npm run test:e2e       # 需 xvfb-run
npm run test:e2e-sync  # 需 xvfb-run
```

`scripts/progress-test.mjs` 覆蓋：Part 0 分類器（多語系，含「一般內文含 %」不被吞）；Part A 根因；Part B 修後擷取（進度 tick 不觸 write path、穩定後 +1 且 `observed`）；Part C 遷移（時間序勝過 order meta、兩張圖搬到保留那則、`updatedAt` 不變、第二次跑 merged=0 冪等）；Part D 頂層／同源 iframe／開放 shadow／封閉 shadow 各 3 tick 後都只留 1 則。`scripts/e2e-chatgpt.mjs` 新增生圖模擬頁：進度逐步變化（25%→38%→51%→80%）再出現圖片，斷言進度期間 0 則 assistant row、`updatedAt` 不變、穩定後恰 1 則且無進度文字、快照已快取。

## 效能

對 `git merge-base HEAD origin/main` ＝ `ad8f7d1`。同一台機器、同一支 Chrome，headless。既有腳本：`scripts/reader-bench.mjs`、`scripts/list-bench.mjs`、`scripts/image-grid-bench.mjs`。閱讀頁／側欄連跑兩次取樣：

| | 1.7.2 | ad8f7d1 |
| --- | --- | --- |
| 閱讀頁 3000 則掛上 | 492 ms（626 後） | 528 ms（509 前） |
| 閱讀頁跳轉 | 4.93 ms | 5.14 ms |
| 閱讀頁捲動 p50 / p95 / max | 3.8 / 6.7 / 21.7 ms | 3.9 / 7.2 / 14.7 ms |
| 側欄 3000 則開啟（三次中位） | 396 ms（420 / 391 / 396） | 393 ms（417 / 355 / 393） |
| 側欄捲動 p95 | 4 ms | 1 ms |
| 圖片頁籤 500 張開啟（三次中位）／捲動 p95 | 45 ms / 3.3 ms（16 格） | 45 ms / 3.2 ms |

閱讀頁兩次都落在雜訊範圍（第一次 1.7.2 較慢、第二次較快），1.7.2 沒有新增閱讀頁路徑。側欄捲動 4 ms vs 1 ms 是 3 次取樣的最大那次的抖動，絕對值都在個位數毫秒。500 張縮圖持平。以上為本機量測，實機仍請老闆抽驗。

## 截圖

範例資料，不是真實對話。

- `docs/reader-1.7.2-image-progress.png`：閱讀頁的一則生圖回合（「生圖：楓葉與山脊」）只剩**一則** assistant 塊＋一張圖，畫面沒有出現 25%／38%／51%／80% 的進度文字。

## 老闆實測（≤4 步）

1. `chrome://extensions` 重新載入，確認版本 1.7.2，權限只有側邊欄。
2. 開一則新的 ChatGPT 對話，請它生一張圖；生圖過程中不要動。
3. 等圖出現後，打開 Chatseek 側欄（或把這則對話重新整理再回側欄看），這則生圖回合應該只有**一則** assistant 塊，不是十幾則重複。
4. 回到原本那則舊的、之前已經存成很多重複塊的生圖對話，重新整理；側欄／閱讀頁應該已被整理成一則（第一次會跑一次性整理，log 印 `[Chatseek] progress repair merged=X dropped=Y`，數字而已）。

## 已知限制

- 偵測保守：只認「整則幾乎只有進度狀態文字」或明確的生成中 DOM 標記。**未涵蓋語系**的進度文字仍可能被存；一般內文含「%」不會被吞。
- `data-is-streaming` 等標記＋短的無標點正文可能被暫時 hold，穩定後靠 mutation 重掃補回。
- `heuristicFromBlock` 有 body 長度 ≥24 的 gate，非 selector 命中的短進度文字本來就會被丟；封閉 shadow 需 `chrome.dom.openOrClosedShadowRoot`。
- 遷移的 progress alias 對「剛好是進度片語的合法 assistant 短訊」可能別名到同位置舊 row（低風險）。未涵蓋語系的舊重複塊遷移時不會被合併，會保留原狀。
- 一次性整理是啟動時 best-effort；DB 版本維持 4，若之後要改結構仍需另寫遷移與 `test:upgrade`。

## PR #19 獨立複審（Codex，2026-10-09；與 CodeWhale 寫碼 session 分開）

複審起點 `31965c9`，基準 `ad8f7d1`。以下修正留在工作目錄，**沒有 commit／push**。先前各節是寫碼者交接；本節記錄複審後的狀態，不是 STATUS READY。

### 實際發現並修正

新增回歸測試先在原 PR 上確認四項失敗：不同 captureIndex 的進度列被誤合併、合法短答 `Drawing` 被當進度、同一 DOM 訊息非前綴改寫後從 2 列變 3 列、三張 index=0 的縮圖遷移後只剩一張。另修正圖片出現但沒有正文／仍留舊狀態文字的擷取，以及等長且尾 80 字相同的正文改寫被 fingerprint 跳過。

- `content/chatgpt.js`：優先原生訊息／turn id，無 id 時用 WeakMap 保持同一 DOM turn 的身份；元素被換掉時，限同對話、等長可見窗口、有同位置不變的鄰居才沿用位置。不同訊息的同文仍分開。純圖片回覆用 `🖼` 保持可寫入的正文與圖片 host，圖片出現時移除整則舊進度狀態（不改网站 DOM）。
- `content/shared.js`、`src/image-progress.js`：保護 `Drawing` 等單字合法短答；不把一般 `aria-valuenow` 控件或空 figure 當生成／圖片證據。進度旗標不套到明確的 user 訊息。正文比對增加完整字串參照，避免等長首部改寫漏寫。
- `src/image-progress.js`、`src/message-identity.js`：遷移必須同對話、相鄰、有效且相同的 captureIndex；缺少位置資料則保留。舊進度轉穩定版的別名只處理 assistant 與已知位置，不用新進度去蓋合法舊正文。
- `src/db.js`：縮圖 index 相撞分配空 slot，保留位元組與原有 byte counter；整個對話事務出錯時回滾，任何失敗都不標全庫修復完成，下次可重試。改成逐對話一次讀圖片 metadata，避免逐刪除列反覆開空 cursor；遷移不改 updatedAt／updatedAtSource／封存狀態。
- `src/reader-url.js`：閱讀頁跳轉接受遷移保留下來的第 24 個以後 slot（有整數上限）；現場擷取仍最多 24 張，沒有加擷取量、權限或網路請求。
- `scripts/progress-test.mjs`：根因不再只依靠手工 seed。直接從 git 讀 `ad8f7d1` 的擷取與 DB／identity 模組，僅隔離 DB 名稱，實際寫出 **5 列，其中 4 列進度**。舊列 fixture 改為實際寫碼者會存的相同 captureIndex。
- 新增 `scripts/progress-review-test.mjs`：上述四項回歸、替換 DOM 元素、等長首部改寫、純圖片、使用者文字、失敗回滾重試、索引清理、3000 列／500 張縮圖與所有 slot 跳轉、刪掉 repair flag 後再跑仍冪等。
- `package.json`：review 測試加入 test:search／test:upgrade／test:progress，依賴未改。
- `scripts/verify.mjs`：逐行對基準只加強，另把 message-identity 加入網路掃描、模組掃描禁止 new Image，原檢查未移除。

### 驗證與限制

授權的 `verify`、`test:search`、`test:fixture`、`test:gemini`、`test:upgrade`、`test:sync` 均通過；新增 review 回歸也通過。manifest 深比對確認 permissions 恰好 `["sidePanel"]`，hosts／content_scripts（含 matches）／CSP 與基準相同；依賴與 lockfile 相同，DB 仍 4，花費 $0。擴充執行碼的禁用網路、HTML 注入與點擊掃描零命中。

**尚有阻擋項：遷移的首次等待沒有界限。** 標準 sparse-index 負載（3000 列／500 張 1-byte 假縮圖）在 fake IndexedDB 約 6–8 秒，event-loop 最大間隔約 32–45 ms。加入完整倒排索引後，同樣負載測得 **211451 ms**，event-loop 最大間隔 **90 ms**，功能仍正確。這是 Node／fake IndexedDB 數據，不能等同 Chrome 原生 IndexedDB；但 `background.js` 的 CAPTURE_MESSAGES 會先等待**全庫** ensureProgressRepair，而 content/shared.js 的 send 回應期限是 **15000 ms**。單對話事務也同時鎖住 conversations/messages/tokenMap/meta/images，其他資料操作可能等待該事務。

完整索引案例可重現：`node scripts/progress-review-test.mjs --full-index`。保留為 opt-in 壓力測試，索引正確性另有小 fixture，沒有刪掉壓力案例來掩蓋耗時。需要以 Chrome 原生 IndexedDB 確認首次擷取／搜尋不被長時間阻塞，或把修復改成有界的事務與等待；在此之前複審 **VERDICT: BLOCK**。Chrome e2e／e2e-sync、瀏覽器效能重測及實機測試依老闆指示由老闆跑，本 session 沒跑，也沒有重新宣稱先前截圖與效能數據驗證了複審改動。

剩餘保守限制：未涵蓋語系／與狀態完全同文的合法 assistant 短句仍無法單靠文字判別；無位置的舊列不合併。DOM 全換、無原生 id 又無鄰居證據時，不冒險跨窗口覆蓋舊訊息。旧 captureIndex 是分批内位置，不是全对话绝对位置；窗口／分批发生变化时，位置证据仍有限，需要实机样本验证。
