# Chatseek 加 Gemini 開工卡（2026-10-08）

老闆拍板：Chatseek 要加第四家 **Gemini（gemini.google.com）**，跟 ChatGPT／Claude／Grok 一樣能收聊天、存在本機，並且四家一起搜得到。

## 一句話需求

使用者在自己的 Chrome 打開 gemini.google.com 的對話，Chatseek 就把這段對話收進本機索引。之後在側欄搜關鍵字，Gemini 的對話會跟另外三家一起出現，也能只篩 Gemini。

## 誰付錢／這次花不花錢

自用功能，**預期 $0**。不上架、不收費、不買任何服務、不用 Gemini API Key。要是做到一半發現得花錢，先停下來回報，不要自己決定。

## 倉庫

- 工作目錄：`/workspace/saas-scout/chatseek`（目前 main = `0c4d3c7`，版本 1.0.2）
- GitHub：https://github.com/punkcanyang/chatseek
- 請開新分支（例如 `feat/gemini`）再發 PR，不要直接推 main。

## 工具與流程（定死）

- 開發用 **Grok Builder（Grok）**，**這個任務從頭到尾同一個 session**，不要中途另開。
- **禁止 Fast**（Cursor／Grok Builder／Codex 一律）。
- 交付後由 **Cursor Opus 5.5 複審**，複審過了才合進 main。
- 商務拓展不寫產品程式碼。

## 現有架構（照抄就好，不要重寫）

三家都是同一個套路，Gemini 也照這樣做：

- `content/shared.js`：共用工具。`Chatseek.observe()` 盯 DOM 變化、`Chatseek.runCapture()` 把側欄清單和目前對話送去背景。**只讀 DOM，不攔 fetch/XHR。**
- `content/chatgpt.js`、`content/claude.js`、`content/grok.js`：各站一支，負責 `extractSidebar()`（側欄對話清單）、`extractMessages()`（目前對話的訊息）、`capture()`。對話 id 格式是 `平台:平台內id`，訊息 id 是 `平台:對話id:訊息id`。
- `background.js`：`HOSTS` 白名單＋`validConversation()` 只認 chatgpt／claude／grok，要加 gemini。
- `src/db.js`：IndexedDB 倒排索引，不分平台，基本不用動；第 108 行的「佔位標題」正則要加 `gemini`（例如沒標題時顯示的 `Gemini`、`New chat`／`新對話`）。
- `sidepanel/`：`index.html` 篩選按鈕、`panel.js` 平台名稱（中英兩份）、`panel.css` 的 `.plat.xxx` 顏色。
- `scripts/verify.mjs`：**現在把 `gemini` 和 `google.com` 列為禁用網域**，這次要改成只放行 `https://gemini.google.com/*`，其他 google.com 仍禁止。
- `scripts/search-test.mjs`：加一筆 Gemini 測試資料，確認四家一起搜、篩 Gemini 都對。
- `README.md`、`manifest.json` 描述裡「不做 Gemini」的字眼要改掉。

## Gemini 頁面怎麼收（公開資料調研，給開發參考，以實際頁面為準）

只用公開的開源專案和腳本查過，**沒有在 box 上登入任何 Google 帳號看過真頁面**。下面是多個開源擴充／腳本共同用到的寫法：

- **網址與對話 id**：對話頁是 `https://gemini.google.com/app/<id>`（id 是十六進位字串，常見 16 碼）。多帳號會變成 `/u/1/app/<id>`；從 Gem 進去的對話可能是 `/gem/<gemId>/<id>`。新對話 `/app`（沒 id）不收。`/share/<id>` 是別人分享的公開頁，**不收**。
- **側欄對話清單**：Gemini 的側欄項目**不一定是 `<a href>`**（跟另外三家不同）。常見寫法是 `[data-test-id="conversation"]`，對話 id 藏在 `jslog` 屬性裡的 `c_<id>`；有的版本也有 `a[href*="/app/"]`。標題常在 `.conversation-title`／`[data-test-id="conversation-title"]`。兩種都要試。
- **訊息**：使用者訊息 `user-query`（自訂元素）／`.user-query`／`.query-text`；Gemini 回覆 `model-response`，正文在 `message-content`／`.markdown`／`.model-response-text`。也有版本用 `[data-message-author-role]`、`[aria-label="Gemini response"]`。用多層備援，再照 DOM 位置排序（Claude adapter 已經這樣做）。
- **要排除**：思考過程（`model-thoughts`／`.thoughts-container`）、給螢幕閱讀器的隱藏標籤（`.cdk-visually-hidden`，內容像「你說了」「You said」「Gemini 說了」）、按鈕、輸入框（Quill 的 `.ql-editor`）。
- **日期**：Gemini 側欄通常**沒有**時間或 Today／Yesterday 分組，所以多半會退回「採集時間」。這是可接受的，跟現有規則一致（有頁面時間用頁面時間，沒有用採集時間）。
- **不要做的捷徑**：Gemini 內部有 `batchexecute` 介面（像 `MaZiqc` 列清單、`hNvQHb` 讀對話）可以一次撈全部歷史。**這次不准用**：它是未公開介面、隨時改名；主動打它比單純讀頁面更像機器人，增加帳號風險；也違反 Chatseek「不掛網路請求、只讀頁面」的承諾，`verify` 也會擋。

參考來源（只讀程式碼，沒裝）：
- Nagi-ovo/gemini-voyager（`src/pages/content/export/index.ts`、`DOMContentExtractor.ts`）
- bwendell/gemini-desktop（`src/main/utils/geminiSelectors.ts`）
- Greasyfork「Gemini to Markdown」、「Gemini Conversation Folders」

## 做什麼（只做清單內）

1. 新增 `content/gemini.js`，結構照 `claude.js`／`grok.js`：側欄清單、目前對話訊息、`capture()`、`Chatseek.observe(capture)`。
2. `manifest.json`：`host_permissions` 加 `https://gemini.google.com/*`；`content_scripts` 加一組 `["content/shared.js", "content/gemini.js"]`；描述改成四家。
3. `background.js`：`HOSTS` 加 gemini、`validConversation()` 認得 gemini。
4. 側欄：篩選按鈕加「Gemini」，`panel.js` 中英文平台名稱、`panel.css` 加 `.plat.gemini` 顏色。
5. `scripts/verify.mjs`：只放行 `https://gemini.google.com/*`，其他 google.com 子網域仍視為違規；`content/gemini.js` 也要進「不准攔 fetch/XHR」的檢查清單。
6. `scripts/search-test.mjs`：加 Gemini 測試資料；最好再加一份**離線 HTML 樣本**（照上面公開的元素結構手寫，或拿 `/share/` 公開分享頁的訊息結構做樣本，不需登入），測 `extractMessages()` 能分出使用者／Gemini、不會把思考過程和「你說了」收進去。
7. `README.md` 改成四家；版本升到 `1.1.0`；`notes/` 寫一份短 CHANGELOG 和交接（改了什麼、怎麼測、已知限制）。

## 不做

- 不打 Gemini 內部 `batchexecute`／任何網路請求，不攔 fetch/XHR，不要 API Key。
- 不做「一鍵收全部歷史」、不做匯入 Google Takeout。
- 不收 `/share/` 公開分享頁、不收 Gem 編輯頁、不收 Canvas／圖片內容（Canvas 有文字可以順手收，但不阻塞）。
- 不碰另外三家的收集邏輯（除非是共用檔案必要的小改）。
- 不上架、不收費。
- **不在 box 上登入任何 Google／Gemini 帳號**（包括老闆主號和 auraelement 測試號）。Claude 測試號就是在 box 機房 IP 登入後被凍結的，老闆擔心 Google 帳號也被封。

## 交貨長什麼樣

- 一個 PR（分支 → main），裡面有 `content/gemini.js` 和上面列的小改。
- 裝好後，在 gemini.google.com 打開幾段對話，Chatseek 側欄：
  - 搜對話裡出現過的詞，會找到那段 Gemini 對話，標籤顯示「Gemini」，點了會開回那段對話。
  - 跟 ChatGPT／Grok（和 Claude）的結果混在一起顯示；按「Gemini」篩選只剩 Gemini。

## 驗收標準（全部達到才算 READY，只交文件不算）

1. `npm run verify` 和 `npm run test:search` 通過；search-test 裡有 Gemini 資料，四家一起搜、只篩 Gemini 都對。
2. 離線樣本測試：使用者訊息和 Gemini 回覆都收到、角色正確、順序正確；思考過程、「你說了／You said」這類隱藏標籤、按鈕文字**沒有**被收進去。
3. `verify` 仍然擋其他 google.com 網域和 perplexity／deepseek。
4. 舊的 ChatGPT／Grok 自動測試不退步。
5. Cursor Opus 5.5 複審通過，PR 合進 main。
6. **實機驗收由老闆在自己電腦上用自己的 Google 帳號做**（box 不登入）：
   - 載入／重新載入擴充 → 重新整理 gemini.google.com 分頁 → 打開 3 段以上舊對話。
   - 搜其中一段裡的特殊詞，命中那段，標籤是 Gemini，點了能開回去。
   - 搜一個不存在的詞，顯示沒有符合。
   - 關掉側欄再開、或重新載入擴充後，剛才的索引還在。
   - 日期不是整欄空白（沒有頁面時間就顯示採集時間）。
   - 老闆截圖回傳就算通過。

## 風險

- **Gemini 頁面結構常變**：元素名稱、`jslog` 格式改了就會收不到。對策：多層備援選擇器、找不到時安靜跳過不報錯；交接文件寫清楚「哪幾個選擇器最可能壞」，之後壞了好修。
- **一定要登入才有歷史**：沒登入看不到側欄和對話 id；關掉「Gemini 應用程式活動記錄」或用「臨時對話」時，網址可能沒有 id、對話也不會被保存，這些情況**不收**是正常的。
- **開發階段看不到真頁面**：box 不登入 Google，所以開發只能靠公開資料和離線樣本，第一次實機可能需要再修一輪。這是預期內的，請在交接裡講清楚。
- **帳號安全**：Chatseek 只讀使用者自己瀏覽器裡已經畫出來的內容，不發額外請求，跟另外三家一樣，對帳號的風險跟「自己開網頁看」差不多。真正的風險是在 box 登入，所以這次一律不在 box 登入。
- **地區**：老闆在中國大陸，打開 Gemini 需要能連上 Google，這是老闆電腦本來就有的使用環境，跟擴充無關。
- **多帳號網址**：`/u/1/app/<id>` 存成 `/app/<id>` 的話，點回去可能開到預設帳號。請盡量保留原本的帳號前綴，做不到就寫進已知限制。

## 交回

1. 產品開發用 Grok Builder（同一 session、禁止 Fast）做完 → 自測 `verify`／`test:search` 通過 → 發 PR。
2. 叫 Cursor Opus 5.5 複審，修完複審意見後合進 main。
3. 叫醒商務拓展（ee0fb700），附：PR 連結、改了什麼、老闆實機怎麼測（照上面第 6 點，寫成老闆看得懂的步驟）、已知限制。
4. 商務拓展再請老闆在自己電腦上實測，老闆截圖確認才算完成。
