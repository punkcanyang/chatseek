# Chatseek 1.6.0 圖片快取（老闆選 A，2026-10-08）
起點：1.5.1 合併後的 main。開發：Cursor 雲端 grok-4.7 high 非 Fast。複審：claude-opus-5-5（額度錯誤改 grok-4.7 high 非 Fast，另開 session）。$0。

## 做法
- 只在使用者打開那段對話、頁面已經載出圖片時才存。不預存，不背景抓。
- content script 把已載入的 <img>（complete && naturalWidth>0）畫到 canvas，縮成長邊 512 的 WebP（不支援就用 JPEG）。每張上限約 150KB，超過就降品質，還超過就不存。
- 存進 IndexedDB（新 store，schema 升版，舊資料要能升級）。同時存提示詞、alt、在對話裡的位置（屬於哪一則訊息、第幾張）。
- 閱讀頁在原位置顯示縮圖，點了用「同一段對話只留一個分頁」邏輯回原網站。不存、也不連圖片網址本身，因為簽名網址會過期。
- 顯示時把縮圖轉成 data: 網址，CSP 不改。
- 存不了的圖（跨網域、canvas 被汙染、toBlob 拋 SecurityError）：照樣存提示詞和 alt，標記 uncached。閱讀頁原位顯示「圖片未快取（原網站限制）」，加回原網站的連結。九語系都要翻。
- 側欄設定：顯示圖片快取總佔用空間，加「清除圖片快取」按鈕（要先確認）。
- 從索引移除對話時，連同它的圖一起刪。
- 四家各自的圖片 DOM 都要對：ChatGPT、Claude（使用者上傳的圖；artifact iframe 不碰）、Gemini、Grok。只抓訊息裡生成或上傳的圖，排除頭像、icon、UI 圖。

## 硬規矩
- permissions 必須恰好是 ["sidePanel"]。host_permissions 不擴張，不加 unlimitedStorage。
- 不發任何新網路請求：不 fetch 圖、不設 crossOrigin 重載、不 new Image(src)。只讀頁面上已載入的元素。
- 不攔截 fetch/XHR，不打內部 API。
- verify 只能補強：加檢查「content script 不得 fetch、不得新建 Image 載入、不得改 crossOrigin」。
- 3000 則長對話的捲動和擷取效能不退步。存圖要非同步、節流，不卡頁面。

## 交付
- PR、測試（含 canvas 被汙染時降級、大小上限、清除快取、移除對話連帶刪圖、升級）。
- docs/ 截圖用範例資料：閱讀頁有縮圖、閱讀頁佔位、設定頁佔用空間與清除按鈕。
- 四家實測表欄位（交老闆實測填）：平台｜圖片來源網域｜能否快取（是／否／部分）｜佔位顯示正常｜點擊回原網站正常｜備註。
- 給老闆的實測步驟，最多 8 步。
