# Chatseek 1.7.1 交接

版本 **1.7.1**，基準 `e3d42cc`（1.7.0）。分支 `fix/archive-detect`。權限仍恰好是 `["sidePanel"]`。`host_permissions` 與 CSP 沒有改。沒有新的網路請求，不點網站按鈕，不改網站 DOM，不重新抓圖，不用 `innerHTML`。資料庫仍是版本 4。

## 根因

三條都在 `e3d42cc` 的程式裡，並用 jsdom 對當時的函式跑過。

1. **1.4.0 的選擇器對不上現在這種橫幅和設定彈窗。** `_archiveBanner` 只查 `role=status/note`、帶 archive/banner 的 `data-testid`、`button` 和 `a`。一句寫在普通 `div` 裡的 `This conversation is archived.` 命中是 false；整段文字就是「已封存」也是 false。`role=status` 仍是 true。歸檔列表只認對話框裡**第一個**標題。設定彈窗第一個標題是 Settings、後面才是 Archived chats 時，`archiveRoot` 是 false；標題本身就是 Archived chats 時才是 true。

2. **1.6 的新路徑沒有跑封存偵測。** `captureInner` 只對頂層文件呼叫一次 `readArchiveSignals`。`readArchiveSignals` 不呼叫 `readScopes` / `readEmbedded` / `shadowHosts`。同一頁若把 `role=status` 橫幅和訊息放進開放 shadow，訊息走 `shadow [data-turn]` 收得到，橫幅仍是 false。同源 iframe 裡的同一句橫幅也是 false。

3. **恢復活躍寫得太早。** 側欄裡的 `/c/` 連結會 `markSeenActive(..., "chatgpt:sidebar")`，輸入框沒有橫幅會再標 `chatgpt:conversation`，而且側欄列優先於橫幅。送出的對話是 `archived: false`。`applyArchiveState` 看到 `archived: false` 就清掉封存旗標；同一次寫入還會 `mergeActivityTime`。所以一般擷取、同步分頁上的同一次擷取、或順便寫下的最後活動時間，都會把已封存改回活躍。從側欄消失本來就不會標成封存，這條沒有改壞。

## 改動

- 對話頁橫幅在頂層、同源 iframe、開放 shadow 都會看。頂層訊息選擇器全部是 0 時，才額外探封閉 shadow（`chrome.dom.openOrClosedShadowRoot`，沒有新權限）。選擇器之外，短的 `div` / `p` / 標題若整段是「已封存 / Archived」或多語系的「此對話已封存」，也算。取消封存按鈕只認整段文字，不點。
- 設定裡的已歸檔對話彈窗：標題不必是第一個。彈窗裡的 `/c/<id>` 只讀下來標成封存。側欄有沒有它都不取消這個結果。
- 恢復活躍只有兩條路：這一頁確認沒有橫幅，而且這次寫入出現了新訊息（`observed`）；或側欄「已封存」列上的「恢復活躍」。只打開、同步分頁看到、側欄在不在、只更新 `updatedAt`，都不改回活躍。
- 診斷多一段 `archive=banner:N,list:N`。N 是命中次數，沒有內文、標題、id、網址。
- Claude、Gemini、Grok 仍是 `supported: false`。1.6.4 最後活動時間、1.6.5 圖片頁籤、1.7.0 手動同步的寫入路徑沒有改成會清封存旗標。

## 測試

```bash
npm run verify
npm run test:search
npm run test:fixture
npm run test:upgrade
npm run test:e2e
npm run test:e2e-sync
```

`scripts/verify.mjs` 只加嚴：版本 1.7.1；診斷必須有 `archive=banner:N,list:N`，而且這兩格不能帶進內文或網址；側欄和輸入框不得再寫封存來源；新訊息恢復和手動恢復必須存在；資料庫仍是版本 4；權限仍是 `["sidePanel"]`。

## 效能

和 `e3d42cc` 比的是側欄 3000 則開啟／捲動，以及閱讀頁 3000 則掛上／捲動。數字寫在這輪跑完之後的回覆裡。封存掃描在一般有頂層訊息的頁面不探封閉 shadow；開放 shadow 和 iframe 用既有的有上限走訪。

## 截圖

範例資料，不是真的 ChatGPT 帳號。

- `docs/panel-1.7.1-archived.png`：已封存頁籤裡有 ChatGPT 對話「舊相機維修」，診斷框含 `archive=banner:1,list:2`。

## 老闆實測

1. `chrome://extensions` 重新載入，確認版本 1.7.1，權限只有側邊欄。把 ChatGPT 分頁重新整理。
2. 打開一則已封存的對話，或到設定裡打開已歸檔對話清單（不用點取消封存）。
3. 打開 Chatseek 側欄，切到「已封存」。這則對話應在裡面，標題旁有灰色「已封存」。對話頁主控台的 `[Chatseek] diag` 應有 `archive=banner:` 或 `archive=list:`，且沒有對話內文。
4. 若要改回活躍：在側欄按「恢復活躍」。只重新整理、同步、或看到側欄裡有沒有它，不應讓它離開「已封存」。網站上取消封存之後又出現新訊息，也會回到活躍。

## 已知限制

- 不從側欄消失推斷封存。歸檔清單沒打開時，讀不到裡面的連結。
- 不點網站按鈕，不捲動清單。畫面上還沒畫出來的舊對話不會標到。
- 跨源 iframe 讀不到，不會為了它加 `host_permissions`。
- 頂層已經有訊息節點時，不探封閉 shadow。橫幅若只活在那種封閉 shadow 裡，這版看不到。
- 橫幅文句對不上字表、也沒有整段文字剛好是「取消封存」的按鈕時，不猜測。
- 網站上已經取消封存、但還沒有新訊息時，索引仍保持已封存，直到手動恢復或出現新訊息。
- Claude、Gemini、Grok 沒有封存偵測。
