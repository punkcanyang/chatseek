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

## 老闆實測（≤5 步）

1. `chrome://extensions` 重新載入，確認版本 1.7.2，權限只有側邊欄。
2. 開一則新的 ChatGPT 對話，請它生一張圖；生圖過程中不要動。等圖出現後，打開 Chatseek 側欄（或把這則對話重新整理再回側欄看），這則生圖回合應該只有**一則** assistant 塊，不是十幾則重複。
3. 回到原本那則舊的、之前已經存成很多重複塊的生圖對話，重新整理；側欄／閱讀頁只會合併有共同持久 turnId、同對話、同位置且相鄰等足夠證據的重複列；舊列缺證據時會保留，不保證整理成一則（第一次會跑一次性整理，log 印 `[Chatseek] progress repair merged=X dropped=Y`，數字而已），圖片頁籤（含縮圖）點了要跳到正確位置。
4. 在側欄診斷區按「複製頁面結構」，確認狀態列顯示產出字元數（沒有權限提示就是成功）；貼回來給我們。
5. 回到一則**已封存**的 ChatGPT 對話頁，再按一次「複製頁面結構」，把那份骨架貼回來（1.7.1 封存偵測在真機上選擇器全 0，要靠這份骨架修，這一項最重要）。

> 第 4／5 步的骨架貼回時請確認裡面**沒有**對話內文、標題、網址、對話 id；若出現任何一句內文，請一併回報（屬於隱私 bug，優先修）。

## 已知限制

- 偵測保守：只認「整則幾乎只有進度狀態文字」或明確的生成中 DOM 標記。**未涵蓋語系**的進度文字仍可能被存；一般內文含「%」不會被吞。
- `data-is-streaming` 等標記＋短的無標點正文可能被暫時 hold，穩定後靠 mutation 重掃補回。
- `heuristicFromBlock` 有 body 長度 ≥24 的 gate，非 selector 命中的短進度文字本來就會被丟；封閉 shadow 需 `chrome.dom.openOrClosedShadowRoot`。
- 遷移的 progress alias 對「剛好是進度片語的合法 assistant 短訊」可能別名到同位置舊 row（低風險）。未涵蓋語系的舊重複塊遷移時不會被合併，會保留原狀。
- 一次性整理是啟動時 best-effort；DB 版本維持 4，若之後要改結構仍需另寫遷移與 `test:upgrade`。

## PR #19 獨立複審（Codex，2026-10-09；與 CodeWhale 寫碼 session 分開）

> **本節是第一輪複審當時的記錄，已由文末「Codex 複審第一輪 BLOCK 的修正（round 2）」取代。** 結尾的 `VERDICT: BLOCK` 指當時兩個 blocker，兩者已在 round 2 修正並 push。

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

## Codex 複審第一輪 BLOCK 的修正（round 2，2026-10-09）

> 上面「PR #19 獨立複審（Codex）」那節是第一輪複審當時的記錄，結尾的 **VERDICT: BLOCK** 與「修正未 commit」都已被本節取代；第一輪的四項回歸修正已 commit 為 `5e4527c`，其後兩個 BLOCK 在 `835947f` 修正。以下為 round 2。

### BLOCK 1：首次全庫修復不得阻塞擷取／搜尋

**原本的問題**：`background.js` 的 `CAPTURE_MESSAGES` 會 `await ensureProgressRepair()`，而 `ensureProgressRepair()` 是一次跑到完的 `while` 迴圈；在 Node fake-IndexedDB 加上完整倒排索引、3000 列／500 張縮圖的極端負載下，全庫修復約 **211 秒**，擷取就排隊等它，超過 content script 的 **15000 ms** 回應期限（`content/shared.js` 送 `CAPTURE_MESSAGES` 的 timeout）。

**怎麼修**：

- `src/db.js` 的修復改成**有界分批**：常數 `REPAIR_BATCH = { conversations: 2, drops: 64, budgetMs: 4000 }`。每次 `repairProgressDuplicates()` 最多處理 2 個對話、單一 readwrite 事務最多刪 64 則（`maxDrops`）、累計滿 4000 ms 就停；每次事務之間 `yieldToLoop()`（`setTimeout 0`）讓出事件迴圈。逐對話的 `repairConversationProgress` 若一個對話大於一批，會回 `remaining > 0` 並**保留同一對話的下次續做**，不是把整個對話塞進一個長事務。
- **佇列與游標持久化在 `meta` 的 `progressRepair` 列**（`persistRepairState` 記 `queue / index / merged / dropped / done`），所以中斷後可續做、可重入、**冪等**：第二次跑沒有可合併的就 `merged=0`。
- **失敗不標完成**：對話事務出錯會 `tx.abort()` 回滾，回 `done:false, stalled:true`，游標不前進，下次重試；只有全部對話跑完才寫 `done:true`。
- `background.js` 的 `CAPTURE_MESSAGES` 改成 **fire-and-forget**：`ensureProgressRepair().catch(() => null)` 之後**立刻** `upsertMessages(...)`，擷取不等修復。`onInstalled`／`onStartup` 也一樣 fire-and-forget。

**證據（`node scripts/progress-review-test.mjs --full-index`）**：

```
review capture during repair max ms 10346 full index true   # < 15000 ms 期限
review migration 3000 rows / 500 thumbnails ms 229035 event loop max gap ms 232 full index true
review PASS 3000 rows and 500 colliding thumbnails remain intact and jumpable
progress-review ok
```

`--full-index` 是 opt-in 的極端壓力案例（Node fake-IndexedDB 的完整倒排索引，真實 Chrome 原生 IDB 快很多）；不帶旗標的標準負載是 `review capture during repair max ms ~500`、event-loop 最大間隔 ~40 ms。測試斷言 `captureMs < 15000`。**已知餘裕**：極端案例在 8–10 秒之間跳動（本 session 兩次為 8110 ms／10346 ms），仍在期限內，但餘裕不算大；若日後再收到真機回報阻塞，下一步是把掃描拆成唯讀掃描＋小型寫入事務，而不是加大 batch。

### BLOCK 2：遷移合併需要「同位置」以外的證據

**原本的問題**：`planProgressMerges` 只用相同 `captureIndex` 當位置證據。但 `captureIndex` 是**分批內的位置**，跨窗口／分批擷取時不同訊息可能拿到同一個 index，於是兩則不相干的進度列會被誤合併。

**怎麼修**（`src/image-progress.js` `planProgressMerges`）：合併前要求**同一對話**、**相鄰**（依 `orderMessages(all, null)` 的時間序）、**同角色**、兩者都只差進度文字，**且** 另有位置證據：

- `sameSlot(a,b)`＝同對話＋有效且相同的 `captureIndex`；
- 額外證據＝`sameTurn(a,b)`（同一原生 turn id）**或** `anchorAt(i)`（往前找最近一則使用者訊息，其 id 當「這位置是誰的提問」的錨）；兩者都沒有就**不合併**。
- 保留對象也要求同 slot 且（有 anchor 或同 turn）；條件不足時**寧可留重複，不可誤刪**。

**證據**：`scripts/progress-review-test.mjs`

```
review PASS migration requires the same position and conversation   # 跨窗口不同位置不會被合併
review PASS one DOM turn can rewrite arbitrary prose without a new row
review PASS short legitimate replies and controls are not progress
review PASS failed migration rolls back and retries
review PASS migration preserves colliding thumbnails and their bytes
```

## 新增：側欄「複製頁面結構」診斷（P0）

真機上 1.7.1 封存偵測完全沒作用、訊息選擇器全 0。**這次不猜選擇器**：改成讓老闆把真實頁面的骨架貼回來再修。

**流程（不加任何權限）**：側欄診斷區按鈕「複製頁面結構」（九個 `_locales`：zh_TW／zh_CN／en／ja／ko／es／fr／de／pt_BR；`COPY_PAGE_SKELETON`）→ `sidepanel/panel.js` 沿用既有「複製診斷」模式，用 `chrome.tabs.query({active:true,windowId})`＋`chrome.tabs.sendMessage(tabId, {type:"COPY_PAGE_SKELETON"})` 找目前分頁（**沒有**加 `tabs`／`scripting`／`clipboardWrite`；`chrome.tabs.query`／`sendMessage` 在 `sidePanel` 權限下可用，與 1.7.1 `pingInjection()` 相同）→ content script 在頁面內用 `Chatseek.buildPageSkeleton(document)` 產生骨架，走既有 `chrome.runtime.onMessage` 管道回 `{ok,text,chars,nodes,truncated}` → `panel.js` `navigator.clipboard.writeText`，失敗時走既有手動複製退路（如實顯示骨架到可選取的 textarea）。狀態列顯示產出**字元數**。

**骨架產生器（`content/shared.js` `Chatseek.buildPageSkeleton`，`SKELETON_NODES = 6000`、`SKELETON_DEPTH = 60`）**：

- 涵蓋**頂層文件**、**開放與封閉 shadow**（`adoptedRoot(node, true)`；封閉 shadow 走 `chrome.dom.openOrClosedShadowRoot`，若可用；封閉根印 `#shadow`；開放根直接展開）、**同源 iframe**（印 `#same-origin-frame`）。**跨源 iframe** 只記網域：`#cross-origin host=<hostname>`。
- 每個節點只記：**標籤名、深度、子節點數**、**屬性名**；屬性值只保留符合「≤32 字且只含 `[A-Za-z0-9_:-]`、不像 uuid／長雜湊」的**短列舉值**（例如 `role`、`data-testid`、`data-message-author-role`、`data-turn`），其餘一律 `x`；`aria-label`、`title`、`alt`、`placeholder`、`href`、`src`、`id`、`value`（以及 `name`、`content`、`srcdoc`、`style`、`data-*-id` 類）一律 `x`；`class` 只留每個 class 的前綴（第一個 `-`／`_` 前或前 20 字），最多 3 個、每個最多 20 字，像雜湊的 class 改成 `h`；文字節點只記**字數**（`#text(N)`），文字本身換成 `x`。
- **保護**：輸出不含任何內文、標題、網址、對話 id、帳號資訊，也**不輸出 `location`**；連續同構兄弟節點收成一行 `×N`；上限 6000 節點、深度 60，超過在首行標 `truncated=true`。首行 `# chatseek page skeleton v1 nodes=N depth<=60 truncated=...`。

**守門（`scripts/verify.mjs` 只加強）**：

- 靜態：`buildPageSkeleton`／`COPY_PAGE_SKELETON`／`SKELETON_NODES=6000`／`SKELETON_DEPTH=60`／`#cross-origin`／`#same-origin-frame` 存在；骨架段禁 `location.(href|origin)`、`innerHTML`、`chrome.scripting|executeScript|insertCSS`；`panel.js`／`index.html` 有按鈕與 handler 且禁 `chrome.scripting`。
- **執行期（jsdom 攻擊 fixture）**：一個塞滿網址／uuid／email／中英文內文／`aria-label` 帶句子／`title`／`alt`／`href`／`src`／`data-message-id` uuid／長雜湊 class／iframe `srcdoc` 內文／shadow 內文的 document，跑真骨架產生器，斷言輸出**完全不含**這些字串，且**保留**結構（`role=main`、`data-message-author-role=assistant`）。
- `scripts/skeleton-test.mjs`（`test:skeleton`，掛進 `test:search`）：Part A/B/C 節點數與字元數、Part D 同構兄弟 `×N` 收斂與 6000／深度 60 截斷、Part E 監聽器載入路徑。

**e2e**：`scripts/e2e-chatgpt.mjs` 在模擬**已歸檔**對話頁按側欄「複製頁面結構」（stub `navigator.clipboard.writeText`），斷言回傳骨架含 `# chatseek page skeleton v1`／`nodes=`／`data-message-author-role=assistant`，**不含** fixture 內文、uuid、任何 `://` 網址，且狀態列有字元數。

**範例骨架與截圖（都是範例資料，不是真實對話）**：

- `docs/skeleton-1.7.2-sample.txt`：由範例 fixture 產生的骨架，內含 `#shadow`（封閉 shadow）、`#cross-origin host=example.com`、`#same-origin-frame`。
- `docs/panel-1.7.2-copy-structure.png`：側欄按完按鈕後顯示字元數的截圖。
- `docs/reader-1.7.2-image-progress.png`：閱讀頁生圖回合只剩一則＋一張圖，沒有進度文字。

## round 2 測試（全部實跑）

```bash
npm run verify         # verify ok；chatgpt-fixture ok { selector: '[data-turn]', messages: 2, emptyWarn: true }
npm run test:search    # 全過；含 progress ok / progress-review ok / skeleton ok / sync-test ok
npm run test:fixture   # chatgpt-fixture / markdown-capture / gemini-fixture / gemini-capture 全過
npm run test:gemini    # 全過
npm run test:upgrade   # 全過（含 test:progress 兩個腳本）
npm run test:sync      # sync-test ok { merged: 3000, mergeMs: 20 }
npm run test:progress  # progress ok / progress-review ok
xvfb-run -a npm run test:e2e       # e2e chatgpt ok（含骨架診斷區塊）
xvfb-run -a npm run test:e2e-sync  # 全過（userStayed: true）
node scripts/progress-review-test.mjs --full-index  # 見 BLOCK 1
```

## round 2 效能（對 `ad8f7d1`）

同一台機器、同一支 Chrome、headless；baseline worktree `/tmp/pre172`＝`git merge-base HEAD origin/main`＝`ad8f7d1`。

| 指標 | 1.7.2 | ad8f7d1 |
| --- | --- | --- |
| 閱讀頁 3000 則掛上 | 592 ms | 528 ms |
| 閱讀頁跳轉 | 5.49 ms | 4.95 ms |
| 閱讀頁捲動 p50 / p95 / max | 4.0 / 7.8 / 28.1 ms | 3.7 / 6.7 / 17.9 ms |
| 側欄 3000 則開啟（三次中位） | 453 ms（512 / 416 / 453） | 502 ms（515 / 461 / 502） |
| 側欄捲動 p95 | 7 ms | 2 ms |
| 圖片頁籤 500 張開啟 / 捲動 p95 | 46–56 ms / 3.9–4.4 ms | 45 ms / 3.2 ms（1.7.1 量） |
| 首次修復進行中擷取回應（極端 full-index fake-IDB） | 8110–10346 ms（< 15000 期限） | 211000+ ms（會超期） |
| 首次修復進行中擷取回應（標準負載） | ~500 ms | n/a |

閱讀頁／側欄差異都在單次取樣的雜訊範圍（毫秒級抖動），1.7.2 沒有新增閱讀頁或側欄清單路徑。1.7.2 的主要新增成本是**啟動時一次性的背景修復**，已分批且有界，不阻塞擷取與搜尋。

## round 2 已知限制

- 遷移合併保守：證據不足（跨窗口／缺 captureIndex／缺 turn 與 anchor）**寧可留重複不合併**。
- 骨架上限 6000 節點、深度 60，超過標 `truncated=true`；跨源 iframe 只記網域（`host=<hostname>`），路徑一律 `x`。
- 首次全庫修復在極端 fake-IDB 負載下的擷取餘裕約 8–10 秒（< 15 秒但不大）；真實 Chrome 原生 IDB 快很多，仍需真機確認。
- BLOCK 1 的修復是分小批事務；修復期間若同時擷取，兩者靠 IDB 事務排隊協調，不保證零等待。

## Codex 第二輪獨立複審（2026-10-09；HEAD 6968c0d 後未提交修正）

本節覆蓋上文 round 2 的「turn／anchor 已足夠」與「骨架不外洩」結論。比對完整
`ad8f7d1..HEAD` 與 `5e4527c..HEAD`，不跑 Chrome、不 commit、不 push。

### 重現與修正

- `planProgressMerges` 在前方有 user 時，竟可合併明確不同 `turnId` 的相鄰 assistant；
  遙遠的 user 也能授權合併。`alignRekeyedTurns` 的 progress alias 則會把窗口 slot 0
  的另一則合法新回答覆寫到舊進度列。兩條路徑現在都要求共同、非空、持久化的 `turnId`，
  且仍須同對話、同 slot、相鄰。寫入路徑傳遞並保留既有 turn 證據。
  live DOM 重建的 neighbour anchor 也只認穩定 id；相同 prompt 字樣不能授權
  把另一窗口的 assistant 當成同一則。原有只替換 assistant、user 節點不變的更新測試仍過。
- **重要限制**：1.7.1 真實舊列通常只有 `captureIndex`，沒有 `turnId`。
  這批資料沒有足夠證據，故不自動合併；前方有 user 也不例外。
  這是第二輪指定的「證據不足不合併」，不能宣稱所有歷史重複都已清乾淨。
  `progress-test` Part A 仍執行真實 `ad8f7d1` 原碼，重現 5 列／4 則進度；
  Part C 分別驗證缺證據的舊列保留、有共同 turn 證據的列合併。
- 新的獨立 `skeleton-review-test` 在修前重現 UUID、帳號名、中英文 class、
  data-* 短值、帶資料的屬性名及自訂標籤外洩。短字串符合字元規則並不代表它是列舉值。
  現在只有固定結構詞及各屬性的已知列舉值能保留；未知屬性名為 `data-x`／`attr-x`，
  自訂標籤為 `element-x`，未知 class 前綴為 `x`，雜湊為 `h`。
  既有自動 diag 的 class／標籤／屬性名也共用遮罩；網域中的 UUID／長雜湊標籤遮為 `x`。
- 兄弟收斂改比較完整去識別化子樹，保留代表子樹的子節點；不同內層、frame、shadow
  不再被淺層 signature 隱藏。shadow 的 light DOM 與 shadow DOM 都讀取。
  6000 上限計算實際走訪（含被收斂的兄弟與忽略的註解），深度上限包含文字節點。
  另加每元素 64 屬性的界限，超出同樣標 `truncated=true`；相對 frame URL 不再虛構網域。
- 剪貼簿失敗的手動複製路徑也顯示字元數。九語按鈕、成功文案、原有 fallback 保留。

### 獨立驗證

- 對抗樣本覆蓋中英日文內文／標題、帳號／email／UUID、相對 `/c/<id>`、query、fragment、
  data-* 值與名稱、style、srcdoc、SVG title、input value、script/style/noscript、textarea、
  contenteditable、自訂元素、class、跨源 iframe 路徑、location；均不進入輸出。
  保留跨源裸網域（規格允許），不讀 frame 內文；未知結構名稱保守遮罩，可能少掉 selector 線索。
- 此對抗測試直接掛進 `verify.mjs`，也納入 `test:skeleton`／`test:search`。
  `verify` 相對基準僅更新版號、增加掃描範圍及加嚴守門；沒有刪原有安全斷言。
- full-index fake-IDB：3000 則／500 張縮圖、完整 tokenMap，修復期間 5 次擷取最慢
  **9706 ms < 15000 ms**；整體修復 **221088 ms**，event-loop 最大間隔 **173 ms**。
  最终版與 500 張縮圖／位元組／跳轉索引保留，索引清除正確、時間不變、再次修復無刪除。
  此次分批修復演算法未再改動；補上的 alias 限制另有真實 DB 寫入回歸測試。
- `verify`、`test:search`、`test:fixture`、`test:gemini`、`test:upgrade`、`test:sync` 均通過。
  Node panel 測試涵蓋九語、側欄所屬窗口、剪貼簿成功與手動複製字元數。
  1.6.4 活動與重算 id、1.6.5 圖片跳轉、1.7.0 同步、1.7.1 封存／恢復規則回歸通過。

權限仍恰好 `["sidePanel"]`，host/matches/CSP 與 ad8f7d1 相同；DB 仍 4；
無新增依賴、網路請求、網站 DOM 修改或付費服務。這版仍不修真機全 0 的選擇器。
Chrome e2e／真機由老闆跑；既有截圖由寫碼者產生，複審未重拍。
64 刪除是每事務的列數界限，4 秒不是可中斷的硬期限：每批仍讀整則對話，
超出此次 3000 則壓力樣本的超大對話仍需量測。永久 DB 故障會停在該對話並待下次重試。
