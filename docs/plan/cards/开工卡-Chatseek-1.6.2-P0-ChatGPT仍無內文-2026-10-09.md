# Chatseek 1.6.2 P0：老闆實測 1.6.1，ChatGPT 依舊只有標題、沒有內文

基準：main 861ba8f（1.6.1）。分支：fix/chatgpt-e2e-inject。版本升 1.6.2。

## 已知
- 老闆在 1.6.0 時 console 完全沒有 [Chatseek] 行。1.6.1 第一次掃描就應該 console.log 一行 diag，若仍然沒有，就是腳本沒注入或載入時就死了。
- 可能的原因：網站存取權被限制、載入的是舊資料夾、重新載入擴充後分頁沒有重新整理（舊腳本變成孤兒）、選擇器對不上現行 DOM、存庫時被舊的「只有標題」紀錄擋住、側欄或閱讀頁讀錯 key。
- 我們無法登入 ChatGPT。

## 必做
1. **真瀏覽器端到端測試（最重要）**：用 Chromium 或 Chrome for Testing 加 `--load-extension` 載入真擴充。用 `--host-resolver-rules` 把 chatgpt.com 指到本機 HTTPS 伺服器（自簽憑證，加 `--ignore-certificate-errors`），提供新、舊兩種 ChatGPT DOM 的 fixture 頁，網址形狀包括 `/c/<uuid>`、`/g/<gizmo>/c/<uuid>`、`/g/g-p-<id>/c/<uuid>`（專案）。
   - 驗證完整流程：內容腳本注入、擷取、寫進 IndexedDB、側欄顯示訊息數、閱讀頁看得到 Markdown 內文。
   - 再模擬「先有一筆只有標題的舊紀錄」，確認內文會補進去。
   - 有任何一層斷掉，就找出根因並修好，寫進 notes/HANDOFF-1.6.2.md。這個測試要加成 npm script。
2. **注入可見**：腳本一載入就 console.log `[Chatseek] loaded v=… platform=…`，每個分頁只印一次。
3. **側欄偵測注入**：側欄對目前作用中的、四家其中一家的分頁做 ping，用 chrome.tabs.sendMessage，不加權限。約 1.5 秒沒回應就顯示警告：「此分頁未載入 Chatseek：請重新整理分頁，並確認擴充的網站存取權允許此網站」。九種語言都要有。
4. **8 秒規則**：在對話頁重新整理並打開對話後，若 8 秒仍沒有內文（0 則，或全部都不是實質內容），側欄一定要顯示警告，console 一定要印 `[Chatseek] diag`。新對話、首頁、暫存對話不算。
5. **結構診斷**：在診斷和 diag 行加上 skeleton，不含任何文字。內容是 main 底下文字量前幾名的區塊，各自從祖先往下的 tag 加屬性名稱，以及經過清洗的 data-testid 或 class token（只保留 `[a-z-]` 片段，去掉數字、uuid、hash），再加上字數區間。用途是讓老闆貼一次，我們就能對上現行 DOM。
6. **文字密度備援**：所有選擇器都拿不到實質內文時，在 main 或對話捲動容器裡依文字密度和兄弟節點結構取出訊息區塊。輪次能判斷就判斷，判斷不了就標記為 assistant 或 unknown。selector 名稱寫 heuristic，並且不能把側欄、輸入框、頁尾收進來。
7. **網址形狀**：確認 /g/…/c/…、專案、帶查詢字串的網址都抓得到 conversation id，側欄和閱讀頁讀的是同一個 key。
8. **舊紀錄覆寫**：只有標題、0 則訊息的紀錄，一律可以被任何實質擷取覆寫。1.6.1 的「前綴保護」不能擋住這種情況。

## 硬規矩（照舊）
- 權限仍恰好是 ["sidePanel"]，host_permissions 和 CSP 不動。不加 tabs、scripting 權限，不新增網路請求，不攔截 fetch，不用 innerHTML，$0。
- scripts/verify.mjs 只能加強。診斷不得含內文、標題、id、提示詞或 alt。
- 一定要加權限或網路請求才能做時，停下來回報。

## 交付
- PR 到 main，內附根因。端到端測試和既有測試都要通過，3000 則效能不能退步。
- 截圖（範例資料）：側欄的「未載入」警告、8 秒無內文警告、含結構診斷的診斷文字。
- 老闆實測最多 6 步。
