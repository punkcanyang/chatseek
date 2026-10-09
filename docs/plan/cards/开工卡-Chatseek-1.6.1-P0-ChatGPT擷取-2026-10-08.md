# Chatseek 1.6.1 P0：ChatGPT 內文沒收進來＋四家保留 Markdown＋複製診斷

來源：商務拓展轉老闆實機回報（2026-10-08 23:17）。基準：main 7329cea（1.6.0）。分支：fix/capture-markdown-diag。版本升 1.6.1。

## 現象
- 老闆實機 1.6.0：ChatGPT 對話只有標題或空白，內文沒收進來，閱讀頁因此沒有 Markdown 可渲染。
- 老闆 console 沒有任何 [Chatseek] 開頭的行，只有 ChatGPT 自己的 runner.html／Statsig 錯誤，以及其他擴充的 inpage.js 錯誤。健康檢查也可能沒有觸發。

## 要查的事（先找到根因，寫進 notes/HANDOFF-1.6.1.md）
1. content script 在 chatgpt.com 到底有沒有載入、有沒有在早期拋錯：manifest 的 matches 和 js 順序、模組載入、1.6.0 新加的圖片程式有沒有在載入或第一次掃描時拋錯，把整段擷取弄斷。
2. ChatGPT 現行 DOM 的訊息選擇器是否失效：data-message-author-role、data-turn、article[data-testid^="conversation-turn"]、section 等。要做多層後備，任何一層命中就要能取到內文。用公開資料和現有 fixture 做新舊兩種 DOM 的 fixture。
3. 健康檢查為什麼沒有提示：條件、時機、只有標題沒內文的情況算不算失敗。修到「有標題但 0 則訊息」或「選擇器全部 0 命中」時一定會提示。
4. 圖片擷取的任何錯誤都不得影響文字擷取，要用 try/catch 隔離，文字先存。

## Markdown 保留（四家：ChatGPT、Claude、Gemini、Grok）
- 擷取時從 DOM 轉回 Markdown，不要只存 innerText：標題、有序和無序清單（含巢狀）、程式碼區塊（保留語言）、行內 code、表格、粗體、斜體、連結、引用、分隔線。
- 使用者訊息通常是純文字，保留換行即可。
- 純 DOM 走訪，不得用 innerHTML 讀寫，也不得 eval。
- 搜尋和命中計算用去掉 Markdown 符號後的純文字，不讓 `**`、`#`、網址把命中數算歪。閱讀頁沿用 1.5.1 的安全 Markdown 渲染器。
- 舊資料不必遷移：下次打開該對話時重新擷取並覆蓋。

## 診斷
- 側欄加一個「複製診斷」按鈕，九種語言都要有。點了以後把診斷文字複製到剪貼簿；不行的話就顯示在可選取的文字框裡，讓老闆手動複製。不得加 clipboardWrite 或任何權限。
- content script 每次掃描在 console 印一行 `[Chatseek] diag ...`，加防抖，不要洗版。
- 診斷內容只能有：擴充版本、平台、網址路徑的類型（不含對話 id 和內文）、各選擇器的命中數、訊息數（user／assistant）、擷取到的字數總和、圖片數（快取／佔位）、健康檢查結果、最後錯誤的訊息名稱與堆疊的第一行、時間。
- 診斷絕對不能含對話內文、標題、提示詞或 alt。

## 硬規矩（照舊）
- 權限仍恰好是 ["sidePanel"]。host_permissions、CSP 都不動，不加 unlimitedStorage、tabs、clipboardWrite。
- 不新增任何網路請求，不攔截 fetch／XHR，不打 Gemini batchexecute，不登入任何帳號，花費 $0。
- 1.6.0 的圖片規矩照舊：不重新抓圖、不用 new Image、不改 crossOrigin、不存圖片網址。
- scripts/verify.mjs 只能加強，不能放寬。要加檢查：診斷字串不得包含內文欄位、擷取模組不得使用 innerHTML、圖片錯誤不得中斷文字擷取。
- 如果一定要加權限或網路請求才能做，就停下來回報，不要自己加。

## 交付
- PR 到 main，標題寫 1.6.1，內附根因。
- 新舊 ChatGPT DOM fixture，以及四家 Markdown 往返測試（標題、清單、程式碼、表格、粗體、連結）。所有既有測試都要通過，3000 則效能不能退步。
- 截圖用範例資料：閱讀頁 ChatGPT 的 Markdown（含表格和程式碼）、側欄的「複製診斷」、診斷文字範例。
- 老闆實測步驟最多 6 步，要包含「按複製診斷後貼給商務拓展」。
