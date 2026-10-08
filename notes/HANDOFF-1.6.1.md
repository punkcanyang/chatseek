# Chatseek 1.6.1 交接

版本 **1.6.1**。從 `7329cea`（1.6.0）開出。權限仍恰好是 `["sidePanel"]`。沒有加 `host_permissions`、`clipboardWrite`、`tabs` 或 `unlimitedStorage`。沒有新的網路請求，CSP 沒改。資料庫仍是版本 4，舊索引不用遷移；下次打開那段對話會重收並覆蓋內文。

## 根因

1.6.0 的內容腳本有載入。`manifest.json` 的 matches 含 `chatgpt.com` 與 `chat.openai.com`，順序是 `shared.js`、`images.js`、平台腳本，`document_idle`。`images.js` 在載入時不會拋錯，只是排隊。

老闆的 console 沒有任何 `[Chatseek]` 行，是因為 1.6.0 唯一會印出的那行是健康檢查的 `console.warn`，而且要同時滿足：網址是對話頁、訊息數是 0、而且空窗已經超過 8 秒。`observe()` 把擷取的拒絕吃掉，只排下一次重試，不寫 log。

內文沒收進來，是 ChatGPT 擷取停在第一個「有節點」的選擇器。`[data-message-author-role]` 若只包著說話者標籤「ChatGPT」或 Copy 按鈕，1.6.0 會把它當成訊息（`isUiNoise` 不把「ChatGPT」當噪音），或濾成空字串後就不再看後面的 `[data-turn]`、`conversation-turn`、`[data-message-content]`。訊息數大於 0 時健康檢查不警告，所以 console 完全沒有 `[Chatseek]`。標題仍從 `document.title` 或側欄進來，閱讀頁就只剩標題或空白。

1.6.0 的圖片程式在正常路徑不會打斷文字：編碼在 `setTimeout` 裡，而且自己有 catch。但 `scheduleMessageImages` 寫在 `runCapture` 前面，又沒有 try/catch。圖片路徑一旦同步拋錯，文字和健康檢查都不會跑，同樣沒有 `[Chatseek]` 行。1.6.1 先寫文字，再排圖片，圖片錯誤只留下錯誤名稱。

## 這版改了什麼

- 健康檢查：對話頁 0 則訊息時先等 8 秒。選擇器打到空殼也等這段，避免頁面還在畫就誤報；過了寬限期仍是 0 則才警告。首頁、暫存對話，以及標題是「ChatGPT／新對話」這類、而且選擇器 0 命中的新對話，不警告。每次掃描會印一行 `[Chatseek] diag`（第一次立刻印，之後最多 4 秒一行）。
- ChatGPT 逐層合併。一層只有空殼時，後面有內文的層仍會收。同一個 turn 裡較短的內層不會蓋掉較完整的外層。開放的 shadow root 只在光 DOM 沒有實質訊息時才看。半截內文（舊內文的前綴，或頁面則數變少時的新 id）不會蓋掉已存的完整訊息。
- ChatGPT、Claude、Gemini、Grok 的助手訊息用 DOM 走訪轉成 Markdown（標題、有序與無序清單含巢狀、程式碼與語言、行內程式碼、表格、粗體、斜體、http(s) 連結、引用、分隔線）。使用者訊息保持純文字和換行。不讀寫 `innerHTML`。
- 搜尋索引用去掉 Markdown 符號後的純文字，所以 `**`、`#` 和網址不會灌進命中數。閱讀頁仍用 1.5.1 的渲染。
- 側欄九種語言都有「複製診斷」。按下去用這次點擊的 `navigator.clipboard.writeText`，失敗就出現可選取的文字框。不加 `clipboardWrite`。
- 診斷行只含版本、平台、路徑種類、各選擇器命中數、使用者／助手則數、字元數、圖片快取／佔位數、健康結果、錯誤名稱與第一個 stack frame、時間。不含標題、內文、提示詞、alt、對話 id。

## 測試

```bash
npm run verify
npm run test:search
npm run test:fixture
npm run test:gemini
npm run test:upgrade
node scripts/reader-bench.mjs
```

`scripts/verify.mjs` 只加嚴：診斷字串不得含內文欄位、擷取模組不得用 `innerHTML`、圖片錯誤不得中斷文字、空殼在寬限期內不得警告、寬限期後必須警告、新對話不得警告。

3000 則閱讀頁（`node scripts/reader-bench.mjs`，與 `7329cea` 各跑三次取中位數，同一台機器）：命中數都是 900，畫面上都是 3 則、136 個節點。1.6.1 掛載 46ms、跳轉 2.9ms、捲動 p50 2ms / p95 3.6ms / 最大 6.5ms。1.6.0 掛載 47ms、跳轉 2.89ms、捲動 p50 2ms / p95 3.5ms / 最大 6.4ms。先前寫的 41ms 對 46ms 是不同次測量的落差，閱讀頁這條路徑沒有改掛載演算法。長對話的 DOM 走訪每約 12ms 讓出主執行緒一次。

示例截圖（假資料，不是登入後的聊天）：

- `docs/reader-1.6.1-markdown.png`
- `docs/panel-1.6.1-diag.png`
- `docs/panel-1.6.1-diag-text.png`

## 請你在自己的 Chrome 裡看

1. 打開 `chrome://extensions`，重新載入 Chatseek，確認版本是 **1.6.1**。權限說明應只剩側邊欄。把原本只有標題或空白的 ChatGPT 分頁重新整理。
2. 打開那段對話的閱讀頁。標題、清單、程式碼、表格、粗體和連結應在內文裡，不該只剩標題。
3. 在該分頁的 DevTools console 應看到一行 `[Chatseek] diag`。裡面是命中數，不該有對話內文。
4. 新對話、首頁、還在載入的頁面不該跳警告。若一段已有標題的對話過了約 8 秒仍是 0 則訊息，側欄才出現警告。
5. 側欄點「複製診斷」，把貼上的文字交給商務拓展。若剪貼簿寫不進去，從下方文字框選取再複製。
6. Claude、Gemini、Grok 各打開一段看過的對話。舊索引會在下次打開時重收。不該多出權限，也不該重新去抓圖片。
