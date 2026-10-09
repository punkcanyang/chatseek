# Chatseek 1.6.3 P1：老闆實測 1.6.2，ChatGPT 內文 OK，但圖片快取完全沒作用

基準：main 530acd0（1.6.2）。分支：fix/image-cache-new-path。版本升 1.6.3。

## 老闆看到的
- 閱讀頁在圖片的位置什麼都沒有：沒有縮圖，也沒有「圖片未快取／原網站限制／檔案過大」佔位。
- 側欄底部沒有「圖片快取」大小區塊。
- 推測：1.6.1 改成 DOM→Markdown、1.6.2 加了文字密度備援和 iframe／shadow 後，images.js 沒接上新的擷取路徑（備援路徑、iframe／shadow 裡的 <img> 沒掃到），所以連佔位都沒產生。側欄快取大小區塊可能根本沒渲染（例如只在 >0 時顯示，或 storage estimate 失敗被吞掉）。
- 注意：ChatGPT 生圖通常放在跨源網址（例如 files.oaiusercontent.com、chatgpt.com/backend-api/estuary 等），畫到 canvas 很可能被 taint。那種情況下就應該出「原網站限制」佔位，不是什麼都不顯示。

## 必做
1. **新路徑都要跑圖片擷取**：選擇器路徑、文字密度備援（heuristic）、同源 iframe、open／closed shadow 裡的 <img>（含 <picture>／srcset 選中的 currentSrc）都要被偵測到，並依出現位置寫進該則訊息的 Markdown 圖片位置（不存網址，用快取 key 或佔位標記）。先找出根因，寫進 notes/HANDOFF-1.6.3.md。
2. **偵測到就一定有結果**：每張偵測到的實質圖片（排除頭像、icon、小於 48px 的裝飾圖），結果只能是「已快取縮圖」或「佔位」，佔位原因分 tainted（原網站限制）／too-big（檔案過大）／timeout（轉檔逾時）／not-loaded（圖還沒載完，之後重掃要能補）。閱讀頁一定渲染出縮圖或佔位，不准空白。
3. **側欄快取大小一律顯示**：0 也顯示「圖片快取 0 KB」，清除按鈕在 0 時可停用。讀取失敗也要顯示「—」而不是整塊不見。
4. **diag 加 imgs=**：格式 `imgs=偵測/已存/佔位 fail=tainted:N,too-big:N,timeout:N,not-loaded:N`。不含網址、alt、內文。「複製診斷」也要有。
5. **端到端測試**：沿用 1.6.2 的 Chrome for Testing＋host-resolver 端到端測試，新增 ChatGPT 生圖 DOM 的 fixture：(a) 同源圖→要有縮圖；(b) 跨源無 CORS 圖→「原網站限制」佔位；(c) 超大圖→「檔案過大」佔位；(d) 圖在文字密度備援路徑和 shadow／同源 iframe 裡；(e) 圖晚載入（lazy）。驗證閱讀頁看得到縮圖或佔位、側欄顯示快取大小（含 0）、diag 的 imgs= 數字正確。Claude／Gemini／Grok 的圖片行為不得退步。

## 硬規矩（照舊）
- 權限恰好 ["sidePanel"]，host_permissions、CSP 不動。不加權限、不新增網路請求、不重新抓圖（不 fetch、不 new Image、不改 crossOrigin、不存圖片網址），不用 innerHTML，$0。
- 只能用頁面上已經載入完的 <img> 元素畫到 canvas。
- scripts/verify.mjs 只能加強。診斷不得含內文、標題、id、提示詞、alt、網址。
- 一定要加權限或網路請求才能做時，停下來回報，不要自己加。

## 交付
- PR 到 main，內附根因。端到端測試和既有測試都要通過，3000 則效能不能退步。
- 截圖（範例資料）：閱讀頁的縮圖＋各種佔位、側欄快取大小（0 和 >0）、含 imgs= 的診斷文字。
- 老闆實測最多 5 步。
