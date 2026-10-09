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

## 這版改了什麼

權限仍恰好是 `["sidePanel"]`。`host_permissions` 與 CSP 沒有改。沒有新的網路請求，不重新抓圖，不存圖片網址，不用 `innerHTML`。資料庫仍是版本 4。

- 選擇器路徑、文字密度備援、同源 iframe、開放與封閉 shadow（`chrome.dom.openOrClosedShadowRoot`，沒有新權限）裡的 `<img>` 都會進圖片掃描。`<picture>` / srcset 用已經畫出來的 `currentSrc`。跨源 iframe 沒有 `contentDocument`，不抓。
- 實質圖片（長邊至少 48px，排除頭像、圖示、裝飾圖）一定寫一列：縮圖，或佔位。佔位原因是 `uncached`（原網站限制）、`oversized`（檔案過大）、`timeout`（轉檔逾時）、`not-loaded`（圖還沒載完）。還沒載完的圖之後載入會再掃一次，把佔位換成縮圖。按鈕裡的大圖不再被當成工具列圖示丟掉。
- 備援區塊旁邊、幾乎沒有文字的相鄰區塊（最多前後各兩層，且不是側欄或 artifact）會一起掃。Claude 仍只收使用者上傳，不收助理圖，也不打開 artifact iframe。
- 診斷多一段 `imgs=detected/saved/placeholder fail=tainted:N,too-big:N,timeout:N,not-loaded:N`。放在診斷前段，裁切後還在。不含網址、alt、內文。「複製診斷」讀的是同一行。
- 側欄「圖片快取」在讀取結束後一定出現。0 顯示「圖片快取 0 KB」，清除按鈕停用。讀取失敗顯示「圖片快取 —」，清除按鈕停用。
- 九種語言補上「轉檔逾時」和「圖還沒載完」。
