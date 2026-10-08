# Chatseek 1.6.2 交接

版本 **1.6.2**。從 `861ba8f`（1.6.1）開出，分支 `fix/chatgpt-e2e-inject`。權限仍恰好是 `["sidePanel"]`。`host_permissions` 與 CSP 沒有改。沒有 `tabs` 或 `scripting`。沒有新的網路請求，資料庫仍是版本 4。

## 根因

### 有證據的部分

老闆這次的 console 只有一行，而且檔案位置是 `shared.js:1461`。那一行是 `buildHealthReport` 的 `console.warn`，不是診斷用的 `console.log`。它在「這次擷取得到的實質訊息數是 0，而且已經過了 8 秒」時印出八個選擇器的**名字**。它不印每個選擇器的命中數。所以「八個選擇器在頂層 document 全部 0 命中」是對這一行的解讀，不是這一行印出來的事實。這一行證明的是：頂層腳本有跑，網址被當成 `/c/` 對話頁，擷取結束時實質訊息是 0。

1.6.1 的擷取在光 DOM 沒有實質訊息時，會用 `el.shadowRoot` 再走一輪開放的 shadow root，然後才呼叫 `buildHealthReport`。因此在這行出現的當下，頁面上沒有「開放 shadow 裡帶著這八個選擇器之一、而且有實質文字」的節點。Warnings 篩選會藏掉 `console.log`，所以 `[Chatseek] diag` 即使有印也不會出現在老闆看到的那一屏。

1.6.1 完全不讀 iframe 的 document。頂層的 MutationObserver 也看不到 shadow 內部或 iframe 文件的變動。健康檢查一旦送出成功，就不會再為了同一種空結果重試。這三件事都是程式裡看得到的。

另外，1.6.1 的 `validHealth` 會在整包 JSON 超過 2000 字元時直接拒絕。拒絕發生在 `console.warn` 之後，側欄就收不到 `warn`。這次的結構診斷更容易超過那個長度。1.6.2 改成保留 `warn`，只裁診斷文字。老闆那次的 payload 有沒有真的超過 2000，沒有量到，不能當成已經發生的原因。

端到端（Chrome for Testing 155，`--load-extension`，`--host-resolver-rules` 把 `chatgpt.com:443` 指到本機 HTTPS fixture）證明了這幾件：

- 頂層八個選擇器都是 0 時，同源 iframe 裡的對話會被收進來，診斷是 `used=heuristic`，`frames=` 帶 host。
- 同樣 0 命中時，開放 shadow 與封閉 shadow（`chrome.dom.openOrClosedShadowRoot`，沒有新權限）裡的對話也會被收進來。
- 跨源 iframe（fixture 用 `https://127.0.0.1/runner.html`）讀不到文件。診斷是 `frames=1:127.0.0.1:noscript`。沒有為了讀它去加 `host_permissions`。
- 空對話過了寬限期後，IndexedDB 的 `health:chatgpt.warn` 為真，側欄頁腳出現「ChatGPT page may have changed — please report (last capture …, 0 messages)」。截圖是 `docs/panel-1.6.2-empty-warn.png`。
- 同一筆診斷含 `main=top top=4 body=1-40 frames=1:127.0.0.1:noscript shadows=1:div:open skeleton=html>body>main>p~1-40`，沒有內文。截圖是 `docs/panel-1.6.2-skeleton-diag.png`。
- 拿掉內容腳本的 ping 監聽後，`chrome.tabs.sendMessage` 沒有 `loaded: true`，側欄顯示「This tab has not loaded Chatseek…」。截圖是 `docs/panel-1.6.2-inject-warn.png`。在這個環境裡對已載入的擴充呼叫 `chrome.runtime.reload()` 之後，Chrome 會用 `ERR_BLOCKED_BY_CLIENT` 擋掉新的 `chrome-extension://` 導向，service worker 也不再回應，所以端到端改成在 isolated world 移除 ping 監聽，讓側欄走同一條「沒有回應」的路徑。
- `/g/<別的 uuid>/c/<對話 uuid>` 與 `/g/g-p-…/c/<對話 uuid>` 存的是 `/c/` 後面那個 id。只有標題的列在下一次有內文時被換掉，側欄預覽不再是 title only。

### 仍是推測的部分

`runner.html` 的來源網域沒有查到。它可能是同源 iframe，也可能是 `oaiusercontent` 或其他來源。若是跨源，1.6.2 只會在診斷裡印 host 和 `noscript`，不會去讀。要讀它就得擴大 `host_permissions`，這版沒有做。

封閉 shadow 在 1.6.1 一定看不到，因為當時只用 `el.shadowRoot`。老闆那一行不能證明頁面上有封閉 shadow，只能說開放 shadow 裡沒有對得上的實質訊息。

也有可能內文是在寬限期結束、健康檢查已送出之後，才畫進 shadow 或 iframe。1.6.1 的頂層 MutationObserver 不會再被叫醒。這是時序上說得通的缺口，不是老闆那一行本身的證據。

## 這版改了什麼

- 載入時頂層頁框印一次 `[Chatseek] loaded v=… platform=…`。
- ChatGPT 的 content script 才加 `all_frames`、`match_about_blank`、`match_origin_as_fallback`。子頁框只 `postMessage({source:"chatseek-frame"})`，不自己寫入。
- 選擇器都沒有實質訊息時，用文字密度在頂層、開放 shadow、封閉 shadow、同源 iframe 裡找區塊。角色認得出來就用，否則記成 unknown，入庫時 unknown 與 assistant 一樣存成 assistant。側欄、composer、footer 排除。選擇器名稱是 `heuristic`。
- 空的對話頁約每 2 秒再掃，並對 shadow root 與同源 iframe 掛 MutationObserver。
- 診斷多一段結構，不含文字：`main`、頂層元素數、頂層正文長度區間（不含 script/style）、iframe 數量與 host（沒有路徑與查詢字串）以及 `script` 或 `noscript`、shadow host 的 tag 與 open/closed、文字量前幾名的祖先鏈（tag、屬性名、洗過的 testid/class）。`health=warn` 時這行也走 `console.warn`，Warnings 篩選看得到。
- 對話 id 是路徑裡 `/c/` 後面的 UUID。查詢字串不算。
- `messageCount` 不是正數的舊列會先刪掉舊訊息與 token，再寫入新內文，不受 1.6.1 的前綴保護擋住。已有內文的列仍受前綴保護。
- 側欄對四個聊天 host ping `CHATSEEK_PING`。約 1.5 秒沒有回應就顯示九種語言的「此分頁未載入 Chatseek…」。不加權限。
- 背景不再因為健康檢查 JSON 太大而丟掉警告。`sender.tab.url` 空的時候改看 `sender.url`。

## 測試與效能

```bash
npm run verify
npm run test:search
npm run test:fixture
npm run test:gemini
npm run test:upgrade
npm run test:e2e
node scripts/reader-bench.mjs
```

以上都過。`scripts/verify.mjs` 只加嚴：版本 1.6.2、權限仍是 `sidePanel`、只有 ChatGPT 內容腳本有 frame matching、沒有新的 host、診斷不得含內文或 UUID、封閉 shadow 與 ping 必須存在。

端到端用 Chrome for Testing 155.0.8059.39。官方 Chrome 148 已不能 `--load-extension`。

3000 則閱讀頁的程式和 `861ba8f` 相同。同一台機器、同一次瀏覽器、各跑 3 次取中位數：這版掛載 50ms、跳轉 2.65ms、捲動 p50 1.7ms / p95 3.0ms / 最大 6.0ms；緊接著的 `861ba8f` 是掛載 42ms、跳轉 2.39ms、捲動 p50 1.5ms / p95 2.8ms / 最大 4.9ms。兩邊都是命中 900、畫面上 3 則、136 個節點。差落在同一台機器的抖動裡，閱讀頁演算法沒有改。

## 截圖

端到端實跑側欄，不是假資料：

- `docs/panel-1.6.2-empty-warn.png`：八個選擇器 0 命中、過了寬限期，頁腳紅字警告。
- `docs/panel-1.6.2-skeleton-diag.png`：同一筆診斷的結構行，含 skeleton。
- `docs/panel-1.6.2-inject-warn.png`：分頁沒有回應 ping 時的載入警告，下面仍有健康檢查警告。

## 複審修正

複審在同一個分支補了這些，沒有加權限，也沒有新的網路請求：

- 空對話重掃從 2 秒倍增到 30 秒，最多 8 次。分頁隱藏時不排程。換網址才重新計次。
- shadow / iframe 的觀察只開在 ChatGPT 頂層頁框。Claude、Gemini、Grok 仍只看 light DOM，共用的 open shadow 掃描也不探封閉 shadow。
- 頂層選擇器已有實質內文時，不再掃 shadow、iframe，也不跑 heuristic，診斷走輕量路徑。嵌入掃描用 TreeWalker，每 64 個元素讓出一次主執行緒。
- 備援排除側欄、頁尾、對話列表、輸入框和旁邊的提示、按鈕、cookie 與升級橫幅。相同內文只留一則。有選擇器結果時不用備援蓋掉。
- class / testid 去掉 hex hash 和超過 24 字的片段。診斷行只在內容變了才再印，`at=` 變了不算。
- 側欄 ping 先確認是四家網站才送 `CHATSEEK_PING`。

## 請你在自己的 Chrome 裡看

1. 打開 `chrome://extensions`，重新載入 Chatseek，確認版本是 **1.6.2**，權限說明只剩側邊欄。把原本只有標題的 ChatGPT 分頁重新整理。
2. 打開那段 `/c/…` 對話。側欄該列應有內文預覽，閱讀頁不該只剩標題。
3. 該分頁的 console 應有 `[Chatseek] loaded v=1.6.2 platform=chatgpt`，以及一行 `[Chatseek] diag`。若仍是 0 則訊息，把整行貼回來。裡面會有 `hits=`、`main=`、`top=`、`body=`、`frames=`、`shadows=`、`skeleton=`，不該有對話內文。
4. `frames=` 若是 `某個 host:noscript`，而且 host 不是 `chatgpt.com`，表示對話在我們讀不到的 iframe。先不要加權限，把那個 host 交回來。
5. 已有標題的對話若約 8 秒後仍是 0 則，側欄頁腳要出現警告。新對話、首頁、暫存對話不該警告。
6. Claude、Gemini、Grok 各打開一段看過的對話。不該多出權限，也不該重新去抓圖片。
