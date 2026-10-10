# Chatseek 1.7.4 搜尋語法交接

日期：2026-10-10。分支 `feat/search-syntax`；基準 main `a96c3b9`（1.7.2.3）。1.7.3 延後，直接由目前 main 開發 1.7.4。PR #25（寫碼 commit `e93c174`）；Chrome E2E 已在外部環境跑過並產生三張新截圖，另一個 Codex session 複審 APPROVE。

## 實作

- `src/search-query.js`：獨立解析器；`"完整片語"`、`chat*`、`-詞`、`-"片語"`、`-title:草稿`、`title:詞`、`title:"片語"` 可組合。正條件必須全部符合，排除條件命中即移除整段對話。一般詞可分散在同一對話的不同訊息；精確片語必須在同一標題或訊息的可見文字中連續出現。
- 一般搜尋仍走既有中英文 tokenize／倒排索引，搜尋標題及內文。引號未成對、單獨 `-`／`*`、空 `title:`、只有排除條件或超出安全上限，都完整退回一般搜尋，不報錯、不截斷輸入。
- 萬用字以向前查找字串片段比對，不編譯使用者輸入成 regex；支援前綴、中間及尾綴。英文按整個英數詞比對，中文／日文／韓文按連續字串比對。字串大小寫與 NFKC 正規化，保留原文高亮位置。
- `src/db.js`：新語法先由既有索引取候選，再唯讀驗證可見內文；沒有可用索引前綴的條件逐段讀取當前範圍的 conversationId 索引。正條件把候選縮到原範圍四分之一以下後，後續片語／萬用字直接驗證這些候選，不再讀寬範圍 posting。平台與封存範圍、上限、排序沿用既有設定。相關度沿用標題／片語／使用者／助理權重，排除條件不加分。取前兩個命中內文作暫存預覽，不寫新欄位。
- `src/preview.js`、`src/reader-view.js` 共用解析結果；片語整段、萬用字實際命中的字以黃底呈現，排除詞不高亮，title: 不高亮內文。Markdown 標記與連結目的網址不算可見內文，片語可以跨粗體及連結標籤。閱讀頁保留完整查詢並跳到命中處。
- 側欄搜尋框旁新增原生問號按鈕；DOM API 產生六條說明。點擊、Enter、Space 開關；Escape／關閉按鈕關閉並把焦點還給問號；有 aria-label、aria-controls、aria-expanded。窄側欄保留輸入框空間。九語 catalog 與 `_locales` 一致，zh_TW 使用台灣用語。
- `manifest.json` 版本改為 1.7.4；verify 原有守門保留並加強獨立模組、唯讀搜尋及可及性結構檢查。新增解析器與整合測試接入 `test:search`；既有跨 Markdown 高亮測試改用明確片語，避免 `*` 的新含意。
- ROADMAP 已補 1.7.2.3、1.7.4 狀態列；後續排程是 1.7.5 原網站刪除就封存、1.7.6 不再提示、封存偵測 1.7.7 以上。

## 安全與資料

權限恰為 `["sidePanel"]`；host_permissions、content_scripts.matches、CSP 與 `a96c3b9` 一致。DB 版本仍是 4，沒有資料遷移。沒有新增網路請求、網站寫入、付費或外部依賴。執行程式只使用 DOM API，沒有 innerHTML／outerHTML／insertAdjacentHTML。所有新增測試、基準和 E2E 都使用人工範例，沒有真實對話、帳號或金鑰。既有作者連結維持原樣。未動 `.codewhale/`、`docs/readme-assets/` 與既有未追蹤 notes 草稿。

## 測試

2026-10-10 最終逐一執行，10 個 npm 指令全部 exit 0，共 54 次腳本執行（包含不同套件重複執行的腳本）。「通過數」以 package.json 串接的腳本為單位，並非假定所有舊測試都有 assertion 計數。

| 指令 | 通過腳本數 | Exit | 秒 |
|---|---:|---:|---:|
| `npm run verify` | 2/2 | 0 | 15.48 |
| `npm run test:search` | 28/28 | 0 | 88.08 |
| `npm run test:fixture` | 4/4 | 0 | 7.27 |
| `npm run test:integrity` | 3/3 | 0 | 2.83 |
| `npm run test:upgrade` | 5/5 | 0 | 9.24 |
| `npm run test:sync` | 1/1 | 0 | 0.16 |
| `npm run test:gemini` | 2/2 | 0 | 1.51 |
| `npm run test:spa` | 5/5 | 0 | 19.76 |
| `npm run test:skeleton` | 2/2 | 0 | 9.00 |
| `npm run test:progress` | 2/2 | 0 | 8.30 |

新增／擴充的明確檢查數：解析器 **85**、搜尋語法整合 **44**、panel **294**，含點擊開關、Enter／Space 原生按鈕預設動作的 JSDOM 模擬、Escape／關閉後焦點、aria 與九語非英文佔位。真正的瀏覽器鍵盤預設動作另由 E2E 驗證。i18n **9 語 × 131 keys** 一致；既有 Markdown 攻擊 **314 cases** 通過。超長 malformed 輸入也經完整預覽／閱讀頁流程確認不 throw，16 萬 CJK 命中不超過 JS 引數上限。

所有新增／修改 JS/MJS 與兩支 E2E 共 **15/15** 個 `node --check` 通過；`git diff --check` 通過。另比對基準 manifest 的 permissions、host_permissions、全部 content_scripts 與 CSP，確認只有版本變更；DB_VERSION 守門仍為 4。完整指令摘要在 `/tmp/chatseek-174-test-results.json`，逐項 log 在 `/tmp/chatseek-174-test-logs/`。

`test:e2e`、`test:e2e-sync` 是 package.json 唯二需要啟動瀏覽器／listen 的 test 指令；寫碼沙箱不能 listen，所以兩者改在外部環境執行：`test:e2e` exit 0（`e2e search syntax ok` samples=3、operators=4、screenshots=3，SPA selector／heuristic 也通過），`test:e2e-sync` exit 0。

## 效能

腳本 `scripts/search-syntax-bench.mjs` 在 Node v26.10.0 + fake-indexeddb + JSDOM 離線執行。舊版 `a96c3b9` 已展開至 `/tmp/chatseek-174-baseline`，與新版依序量測；每組暖機一次、量測五次取中位數。搜尋資料是 3000 段對話各一則訊息；閱讀頁是同一人工對話的 3000 則訊息、720px 視窗及 100 次模擬捲動。搜尋上限刻意用 3000，包含相關度排序與預覽準備，不是側欄預設的 80 筆，也不含側欄清單 DOM 掛載。

全部單位為 ms；括號是新版相對舊版增減比例，正數表示變慢。

| 類型 | 舊查詢 → 新查詢 | 清單搜尋：舊 → 新 | 閱讀頁掛載：舊 → 新 | 捲動 p95：舊 → 新 |
|---|---|---|---|---|
| 一般詞 | `blue orchid` → 同左 | 605.22 → 511.93（-15.4%） | 8.65 → 7.05（-18.5%） | 2.15 → 1.93（-10.2%） |
| 片語 | `blue orchid` → `"blue orchid"` | 539.23 → 285.03（-47.1%） | 7.43 → 7.87（+5.9%） | 1.93 → 1.68（-13.0%） |
| 萬用字 | `chatseek` → `chat*` | 20454.61 → 20424.01（-0.1%） | 11.33 → 20.07（+77.1%） | 2.26 → 2.36（+4.4%） |
| 排除 | `blue orchid` → `blue orchid -title:draft` | 602.70 → 587.45（-2.5%） | 7.78 → 15.75（+102.4%） | 2.09 → 2.04（-2.4%） |
| 標題 | `camera` → `title:camera` | 20757.07 → 30.89（-99.9%） | 6.72 → 3.26（-51.5%） | 1.44 → 1.11（-22.9%） |
| 組合 | `blue orchid` → `"blue orchid" chat* -title:draft` | 499.64 → 307.39（-38.5%） | 7.67 → 15.28（+99.2%） | 1.29 → 2.30（+78.3%） |

舊版沒有新語法，所以使用同樣範例詞的普通搜尋作對照，**不是等價查詢**。一般詞／片語舊版有 300 個結果、600 處詞高亮；新版片語是 300 處整段高亮。排除／組合新版是 276 個結果，舊版 300 個；組合閱讀頁從 600 個詞命中增加到 3300 個片語／萬用字命中。萬用字兩版都是 3000 個結果／命中，標題兩版都是 3000 個結果、閱讀頁只有 1 處標題命中。

超過 30% 的項目與處理：

- 初版組合清單搜尋 20558.79 ms，比舊版多 4014.7%；原因是先讀全域 `chat*` 寬 posting，即使片語已縮小候選。已加正條件候選縮減，最終 307.39 ms，比初版快 98.5%，不再有清單搜尋超過 30% 的退化。
- 萬用字閱讀頁掛載 +77.1%（增加 8.74 ms）：逐訊息投影可見 Markdown、按詞驗證 glob，再映射原文位置；舊版只有字面詞查找。這個成本是完整匹配與安全高亮所需，沒有編譯 regex。
- 排除閱讀頁掛載 +102.4%（增加 7.97 ms）：雖然排除詞不產生高亮，查詢仍走共享語法的可見文字／token 邏輯，驗證普通正條件並映射位置；舊版直接在原文查詞。已保留 plain 快速路徑和 ASCII／常見 CJK 正規化快速路徑。
- 組合閱讀頁掛載 +99.2%（增加 7.61 ms），捲動 p95 +78.3%（增加 1.01 ms）：要收集及繪製 3300 個命中，舊版只有 600 個，包含新增的萬用字結果；也要解析可見 Markdown。此差異包含額外功能／命中數，不能解讀為等價操作的純退化。title: 已加跳過內文的快速路徑。

另以 `--images` 做 500 張範例縮圖佔位的 JSDOM 對照（同樣暖機一次、五次中位數）：掛載 3.68 → 4.40 ms（+19.6%），捲動 p95 1.83 → 2.01 ms（+9.8%）。沒有改圖片路徑。這是 DOM／虛擬窗口處理，**不包含圖片解碼、瀏覽器 layout 或 paint**。原有 `reader-bench.mjs`、`list-bench.mjs`、`image-grid-bench.mjs` 需要 listen，故本輪採卡片允許的 Node 小基準；Chrome 真實效能待外部環境確認。

重現（先準備基準 checkout，再依序執行）：

```bash
node scripts/search-syntax-bench.mjs /tmp/chatseek-174-baseline
node scripts/search-syntax-bench.mjs
node scripts/search-syntax-bench.mjs /tmp/chatseek-174-baseline --images
node scripts/search-syntax-bench.mjs --images
```

## 複審

另一個 Codex session `/root/review_174` 唯讀複審，第三輪 PASS；最後的密集 CJK 高亮防護與效能優化也再次 PASS。優化獨立重現通過 24 種正負條件排列及 3 個負片語／空候選案例。已依複審補正：片語候選包含部分詞、正／負片語完整性；雙空白片語先以原文匹配再映射顯示；極長無效查詢的高亮與標題比對不用動態 regex；程式碼 URL 遵守原索引政策；韓文 Jamo 與 Greek 大小寫正規化；E2E 先驗標題命中，再跳到訊息 110。複審由不同 session 的 Codex 執行。獨立 session 通過不代表 Chrome E2E 已執行。

## 外部 E2E 與截圖

在能 listen、具備可用 DISPLAY 的外部環境執行：

```bash
CHROME_PATH=/tmp/cft/chrome/linux-155.0.8059.39/chrome-linux64/chrome npm run test:e2e
CHROME_PATH=/tmp/cft/chrome/linux-155.0.8059.39/chrome-linux64/chrome npm run test:e2e-sync
```

`test:e2e` 使用本機 HTTPS ChatGPT fixture，攔截非本機請求，不登入、不連真站。新增三段人工對話，查詢 `title:camera "blue orchid" chat* -title:draft`，驗證清單只有一筆、片語與萬用字高亮、Enter／Space／Escape、320px 側欄、完整 q 傳到閱讀頁，下一個命中跳至第 110 則訊息。成功應輸出 `e2e search syntax ok`（samples=3、operators=4、screenshots=3），並產生：

- `docs/panel-1.7.4-search-syntax.png`
- `docs/panel-1.7.4-search-help.png`
- `docs/reader-1.7.4-jump.png`

三張檔案已產生並隨 PR 提交（另附 1.7.4 的 SPA 截圖）。既有 E2E 也會覆寫舊截圖；只保留新的 1.7.4 三張，還原被覆寫的既有 PNG，勿還原整個 docs 以免丟失 ROADMAP 修改。

## 老闆實測（5 步）

1. 重新載入 1.7.4，開啟側欄，確認問號在窄側欄也可用。
2. 用本機範例對話試一般詞、`"完整片語"` 和 `chat*`，確認標題及內文都能搜尋。
3. 組合 `title:camera "blue orchid" chat* -title:draft`，確認排除草稿、片語整段及 chatseek 黃底、相關度排序合理。
4. 開閱讀頁，以「下一個命中」確認跳到內文，排除詞不高亮；試未配對引號、單獨 `-`／`*`，確認靜默退回一般搜尋。
5. 切換語言，按問號或 Enter／Space，讀說明；按 Escape，確認關閉並回到問號焦點。

## 已知限制

- 超過 4096 字元、32 個條件或單個 glob 超過 128 字元會退回一般搜尋。精確片語不跨訊息、不自動把多個空白當一個空白；英文大小寫與 NFKC 視為相同。
- 萬用字匹配整個英文英數詞或整段連續 CJK 字串；例如中文中間字串需用 `*相機*`。引號中的星號是字面文字，沒有括號、OR 或 regex 語法。
- 無索引前綴的 leading／infix glob、短片語或符號片語需掃描當前範圍的各段訊息；大量長內文仍比一般倒排索引慢。此版沒有 DB 升級或額外儲存索引。
- 舊版儲存的 360 字預覽已經縮短／合併空白，無法證明精確片語；新語法只高亮經完整內文確認的預覽，避免誤標。
- Node 基準不含瀏覽器 layout、paint、圖片解碼；不能替代 Chrome 的實機掛載與捲動效能。外部 Chrome E2E、三張截圖和老闆實測仍待回傳結果。
