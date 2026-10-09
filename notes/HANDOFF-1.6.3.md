# Chatseek 1.6.3 交接

版本 **1.6.3**。基準 `530acd0`（1.6.2）。分支 `fix/image-cache-new-path`。權限仍恰好是 `["sidePanel"]`。`host_permissions` 與 CSP 沒有改。沒有新的網路請求，不重新抓圖，資料庫仍是版本 4。

## 根因

老闆在 1.6.2 看到的兩件事，程式裡都對得上，不是推測。

### 閱讀頁在圖片的位置什麼都沒有

閱讀頁只在 IndexedDB 有該則的圖片列時，才在對應偏移畫縮圖或佔位。`content/shared.js` 的 DOM→Markdown 遇到 `<img>` 只把偏移記進 map，不寫任何標記。沒有圖片列，那個位置就不會留下文字，也不會留下佔位。

1.6.2 的文字擷取會走進備援、同源 iframe、開放 shadow、封閉 shadow。`content/images.js` 沒有跟著走：

- `listedImages` 只對 Gemini 呼叫 `collectShadowImages`。ChatGPT、Claude、Grok 的圖只做訊息節點上的 `querySelectorAll("img")`。這個呼叫不穿 shadow，也不穿 iframe。
- `collectShadowImages` 只讀 `node.shadowRoot`。封閉 shadow 在 1.6.2 的文字路徑用 `chrome.dom.openOrClosedShadowRoot`（沒有新權限），圖片路徑沒有呼叫它。
- 訊息節點若在外層、圖在它裡面的同源 iframe，`querySelectorAll` 進不去。`blocked()` 還把選擇器寫成包含 `iframe`，外層掃到的圖會被直接丟掉，連佔位都不寫。
- `blocked()` 對 `button` 和 `[role="button"]` 一律 `return true`。這是略過，不是佔位。ChatGPT 生圖通常包在按鈕裡（點了開燈箱）。既有測試把按鈕裡的圖一律當成工具列圖示丟掉，所以選擇器路徑就算抓到了整則訊息，生圖也不會入庫。
- 備援區塊是「文字夠長的子節點」。只有圖、幾乎沒有旁邊文字的相鄰區塊會被 `skipHeuristic`（少於 24 字）丟掉。圖不在文字區塊的後代裡時，圖片掃描看不到它。
- 跨源圖若真的被掃到，`getImageData` 的 `SecurityError` 會存成 `uncached`，閱讀頁應顯示「原網站限制」。老闆看到的是完全空白，所以不是畫完之後被 taint，而是圖沒有進庫。
- 還沒載完的圖只掛 `load`，不寫列。這次閱讀頁在圖載完之前是空的。轉檔逾時被收成 `uncached`，和「原網站限制」同一句，沒有獨立的 timeout。
- 長邊小於 64px 就丟。開工卡的裝飾圖門檻是 48px。這不是「完全空白」的主因。

### 側欄底部沒有「圖片快取」

`#imageCache` 這個元素一直在，不是只在大於 0 時才掛上 DOM。標籤文字要等非同步讀取成功才寫進去：

- HTML 裡的 span 一開始是空的。`applyStatic` 只有在 `dataset.bytes` 已經有值時才填「圖片快取 …」。
- `refreshImageCache()` 寫在對話列表 `refresh()` 的成功路徑末尾。列表拋錯時不會填這一行，span 保持空白，畫面上就沒有「圖片快取」這幾個字。
- 讀取失敗時寫的是通用錯誤句，不是「圖片快取 —」。
- 用量是 0 時，`formatByteSize(0)` 是「0 B」，不是「0 KB」。清除按鈕在 0 時仍然可按。

沒有用 `navigator.storage.estimate`。用量來自 IndexedDB `meta.imageBytes`。讀取失敗被 catch 住之後，快取標籤不會留在畫面上。

端到端在真的 Chrome 裡又量到第二件事。內容腳本把縮圖的 `ArrayBuffer` 用 `chrome.runtime.sendMessage` 送給 service worker 時，對面收到的是空的普通物件，`byteLength` 是 0。`normalizeImageRecord` 因此把這筆丟掉。背景仍回 `ok: true`，內容腳本照樣把診斷記成已快取。所以就算圖有被掃到、也轉成了縮圖，IndexedDB 還是沒有那一列，閱讀頁一樣空白。佔位沒有 bytes，這條路徑不受影響。這次改成送數字陣列，並且只有真正寫入的筆數大於 0 才算進診斷。

## 這版改了什麼

權限仍恰好是 `["sidePanel"]`。`host_permissions` 與 CSP 沒有改。沒有新的網路請求，不重新抓圖，不存圖片網址，不用 `innerHTML`。資料庫仍是版本 4。

- 選擇器路徑、文字密度備援、同源 iframe、開放與封閉 shadow（`chrome.dom.openOrClosedShadowRoot`，沒有新權限）裡的 `<img>` 都會進圖片掃描。`<picture>` / srcset 用已經畫出來的 `currentSrc`。跨源 iframe 沒有 `contentDocument`，不抓。
- 實質圖片（長邊至少 48px，排除頭像、圖示、裝飾圖）一定寫一列：縮圖，或佔位。佔位原因是 `uncached`（原網站限制）、`oversized`（檔案過大）、`timeout`（轉檔逾時）、`not-loaded`（圖還沒載完）。還沒載完的圖之後載入會再掃一次，把佔位換成縮圖。按鈕裡的大圖不再被當成工具列圖示丟掉。
- 備援區塊旁邊、幾乎沒有文字的相鄰區塊（最多前後各兩層，且不是側欄或 artifact）會一起掃。Claude 仍只收使用者上傳，不收助理圖，也不打開 artifact iframe。
- 診斷多一段 `imgs=detected/saved/placeholder fail=tainted:N,too-big:N,timeout:N,not-loaded:N`。放在診斷前段，裁切後還在。不含網址、alt、內文。「複製診斷」讀的是同一行。
- 側欄「圖片快取」在讀取結束後一定出現。0 顯示「圖片快取 0 KB」，清除按鈕停用。讀取失敗顯示「圖片快取 —」，清除按鈕停用。
- 九種語言補上「轉檔逾時」和「圖還沒載完」。
- 縮圖的位元組改以數字陣列送進 service worker。只有 `saved > 0` 才算進診斷。

## 複審再補

同一條分支上又補了這些，根因仍是上面那兩段。

- 清除快取若把整列刪掉，閱讀頁就沒有偏移可畫，圖片位置會變空白。現在只拿掉位元組，把已快取的列改成 `cleared`，閱讀頁顯示「已清除」佔位。側欄清除後會送 `IMAGE_CACHE_UPDATED`，開著的閱讀頁會換掉舊縮圖，晚載入的圖也能從 `not-loaded` 補上。
- 按鈕和同源 iframe 在 Markdown 走訪時原本被整段跳過，圖的偏移會掉到文末。現在只記偏移、不把按鈕文字或網址寫進 Markdown。封閉 shadow 裡的圖記在宿主的位置。
- 子頁框的內容腳本不再排程收圖，頂層走訪同源 iframe。若外層訊息和頁框裡的訊息都會看到同一張 `<img>`，留給含有該節點的那一則，不寫兩次。
- 同一張圖送失敗最多 4 次，之後停止。走訪每 64 個節點讓出主執行緒，佇列一則一則處理。
- `alt` 裡的網址會清掉，`prompt` 裡的圖片網址（含 blob、data:image、常見圖檔與 oaiusercontent）也清掉。`url` / `src` / `href` / `currentSrc` 仍不入庫。`verify.mjs` 會拿一筆帶網址的列來擋。

數字陣列、base64、Blob URL：維持數字陣列。`ArrayBuffer` 過 `runtime.sendMessage` 會變成空物件，所以不能直接送位元組。150KB 的數字清單大約是十五萬個小整數，結構化複製大約 1MB 出頭，一次只送一張，service worker 會檢查是陣列、長度 ≤150KB、每個值是 0–255 的整數。base64 會短一點（大約 200KB 的字串），也不用新權限，但現有路徑已經過驗證，沒有換成它。Blob URL 屬於頁面來源，service worker 要讀它就得 fetch，這次不允許，所以不用。

## 測試與效能

```bash
npm run verify
npm run test:search
npm run test:fixture
npm run test:gemini
npm run test:upgrade
npm run test:e2e
node scripts/screenshot-images.mjs
node scripts/reader-bench.mjs /workspace /tmp/chatseek-162
```

以上都過。`scripts/verify.mjs` 只加嚴：版本 1.6.3、封閉 shadow、48px、`imgs=`、`0 KB`、清除按鈕停用、縮圖必須以位元組清單過訊息且不得超過 150KB、子頁框不得再收、重試有上限、走訪要讓出、圖片網址不得入庫、清除後要留佔位。i18n 九種語言、84 個鍵。

端到端用 Chrome for Testing 155.0.8059.39，`--load-extension`，`--host-resolver-rules` 把 `chatgpt.com:443` 和 `files.oaiusercontent.com:443` 指到本機 HTTPS。沒有加 `host_permissions`。同一支腳本蓋過的案例：

- 選擇器路徑：兩張同源圖進縮圖，按鈕裡的大圖也收；跨源、沒有 CORS 的圖是 `uncached`。診斷 `imgs=3/2/1 fail=tainted:1,too-big:0,timeout:0,not-loaded:0`，沒有網址。
- 備援區塊旁邊只有圖的兄弟節點、開放 shadow、封閉 shadow、同源 iframe，各收進一張縮圖。
- 圖還沒回應時先寫 `not-loaded`，回應之後同一則改成縮圖。
- 側欄先是「Image cache 0 KB」且清除停用，有縮圖之後變成 1 KB 且清除可按。
- 閱讀頁同一則裡有兩張縮圖和「原網站限制」；另一則是「檔案過大」。

「檔案過大」在這台 Chrome 上要每一檔品質都超過 150KB 才會出現。512px 的雜訊圖壓到 webp q=0.2 大約 100KB，會變成縮圖，不會變成佔位。端到端為了走到這條路徑，在內容腳本的 isolated world 把寬高至少 400 的 canvas `toBlob` 換成 160KB。這不是放寬產品的上限。跨源的 ChatGPT 生圖會走「原網站限制」。同源、壓得下去的圖會變成縮圖。

3000 則、沒有圖片的閱讀頁，同一台機器、Chrome 148、各跑 3 次取中位數。先跑 `530acd0` 再跑這版：兩邊掛載都是 43ms、跳轉都是 2.46ms；這版捲動 p50 1.6ms / p95 2.9ms / 最大 5.0ms，`530acd0` 是 p50 1.7ms / p95 3.0ms / 最大 6.9ms。兩邊都是命中 900、畫面上 3 則、136 個節點。沒有變慢。

## 截圖

端到端是真的擴充套件，介面跟 Chrome 語言，這次是英文：

- `docs/panel-1.6.3-image-cache-zero.png`：頁腳「Image cache 0 KB」，清除按鈕停用。
- `docs/panel-1.6.3-image-cache.png`：同一頁腳在收進縮圖後是 1 KB，清除可按。
- `docs/panel-1.6.3-diag-imgs.png`：複製出來的診斷含 `imgs=3/2/1 fail=tainted:1,too-big:0,timeout:0,not-loaded:0`，沒有網址。
- `docs/reader-1.6.3-placeholders.png`：兩張縮圖，加上「the original site doesn’t allow it」。
- `docs/reader-1.6.3-images.png`：「the file is too large」。

範例資料是繁體中文，四種佔位都在同一則：

- `docs/reader-1.6.3-examples.png`：縮圖、原網站限制、檔案過大、轉檔逾時、圖還沒載完。
- `docs/reader-1.6.3-thumb.png`：同一則的近照。
- `docs/panel-1.6.3-image-cache-zero-zh.png`：「圖片快取 0 KB」。
- `docs/panel-1.6.3-image-cache-zh.png`：「圖片快取 5.0 KB」。
- `docs/panel-1.6.3-diag-imgs-zh.png`：`imgs=5/1/4 fail=tainted:1,too-big:1,timeout:1,not-loaded:1`。

## 老闆實測

1. 到 `chrome://extensions` 重新載入，確認版本 1.6.3，權限只有側邊欄。已經開著的 ChatGPT 分頁重新整理。
2. 打開一則有圖的對話。側欄頁腳要出現「圖片快取 0 KB」或更大的數字。是 0 的時候「清除圖片快取」不能按。
3. 打開這則的閱讀頁。每個圖片位置要是縮圖，或「原網站限制／檔案過大／轉檔逾時／圖還沒載完」其中一句。不能是空白。網路面板不該為了這些圖多出新的圖片請求。
4. 按「複製診斷」。那一行要有 `imgs=` 和 `fail=tainted:`，不能有網址、alt 或對話內文。
5. 各打開一則 Claude、Gemini、Grok。不該要求新權限。Claude 仍不收助理圖。Gemini、Grok 原本看得到的圖還在。
