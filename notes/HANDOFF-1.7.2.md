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
