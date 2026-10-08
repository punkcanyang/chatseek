# Chatseek 1.6.2（2026-10-08）

ChatGPT 對話若畫在同源 iframe 或 shadow root 裡，頂層八個選擇器全部落空時仍會收內文。空對話的健康檢查會在側欄顯示警告。權限仍只有 `sidePanel`。沒有擴大 `host_permissions`，沒有新的網路請求。

## 擷取

- ChatGPT 內容腳本加上 `all_frames`、`match_about_blank`、`match_origin_as_fallback`。子頁框只回報自己已載入，由頂層頁框讀同源文件。
- 選擇器落空時，文字密度備援會看開放的 shadow root、`chrome.dom` 能打開的封閉 shadow root，以及同源 iframe。選擇器名稱是 `heuristic`。
- 對話頁仍是 0 則時會再掃，從 2 秒倍增到 30 秒，最多 8 次；分頁隱藏時暫停。頂層選擇器已經有內文時不再走這條。
- 診斷行多了結構：有沒有 `main`、頂層元素數、頂層正文長度區間、iframe 的 host 與腳本有沒有進去、shadow host 的 tag、文字最多的區塊的祖先鏈。不含內文、標題、id。
- 網址裡 `/c/` 後面的 UUID 才是對話 id。只有標題的舊列會被下一次有內文的擷取整個換掉。

## 側欄

- 四個聊天網站的分頁若沒有回應，側欄提示重新整理並檢查網站存取權。九種語言都有這句。
- 健康檢查的警告不再因為診斷行太長而被整筆丟掉。
