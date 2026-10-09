# Chatseek 1.7.1 交接

版本 **1.7.1**，基準 `e3d42cc`（1.7.0）。分支 `fix/archive-detect`。權限仍恰好是 `["sidePanel"]`。`host_permissions` 與 CSP 沒有改。沒有新的網路請求，不點網站按鈕，不改網站 DOM，不重新抓圖，不用 `innerHTML`。資料庫仍是版本 4。

## 根因

三條都在 `e3d42cc` 的程式裡，並用 jsdom 對當時的函式跑過。

1. **1.4.0 的選擇器對不上現在這種橫幅和設定彈窗。** `_archiveBanner` 只查 `role=status/note`、帶 archive/banner 的 `data-testid`、`button` 和 `a`。一句寫在普通 `div` 裡的 `This conversation is archived.` 命中是 false；整段文字就是「已封存」也是 false。`role=status` 仍是 true。歸檔列表只認對話框裡**第一個**標題。設定彈窗第一個標題是 Settings、後面才是 Archived chats 時，`archiveRoot` 是 false；標題本身就是 Archived chats 時才是 true。

2. **1.6 的新路徑沒有跑封存偵測。** `captureInner` 只對頂層文件呼叫一次 `readArchiveSignals`。`readArchiveSignals` 不呼叫 `readScopes` / `readEmbedded` / `shadowHosts`。同一頁若把 `role=status` 橫幅和訊息放進開放 shadow，訊息走 `shadow [data-turn]` 收得到，橫幅仍是 false。同源 iframe 裡的同一句橫幅也是 false。

3. **恢復活躍寫得太早。** 側欄裡的 `/c/` 連結會 `markSeenActive(..., "chatgpt:sidebar")`，輸入框沒有橫幅會再標 `chatgpt:conversation`，而且側欄列優先於橫幅。送出的對話是 `archived: false`。`applyArchiveState` 看到 `archived: false` 就清掉封存旗標；同一次寫入還會 `mergeActivityTime`。所以一般擷取、同步分頁上的同一次擷取、或順便寫下的最後活動時間，都會把已封存改回活躍。從側欄消失本來就不會標成封存，這條沒有改壞。

## 改動

- 對話頁橫幅在頂層、同源 iframe、開放和封閉 shadow 都會看（`chrome.dom.openOrClosedShadowRoot`，沒有新權限），包含 shadow 內的 iframe。頂層有訊息也不能跳過封閉 shadow：橫幅可能在另一個根。選擇器之外，短的 `div` / `p` / 標題若整段是「已封存 / Archived」或多語系的「此對話已封存」，也算。取消封存按鈕只認整段文字，不點。
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

和 `e3d42cc` 比的是側欄 3000 則（畫面只畫 80 列）開啟／捲動，以及閱讀頁 3000 則掛上／捲動。同一台機器、同一支 Chrome 連跑。

| | 1.7.1 | e3d42cc |
| --- | --- | --- |
| 側欄開啟（三次中位） | 111 ms（130 / 111 / 107） | 114 ms（114 / 113 / 120） |
| 側欄捲動 p95 | 1 ms | 1 ms |
| 閱讀頁掛上 | 43 ms | 40 ms |
| 閱讀頁跳轉 | 2.46 ms | 2.35 ms |
| 閱讀頁捲動 p50 / p95 / max | 1.5 / 2.8 / 5.3 ms | 1.5 / 2.7 / 4.5 ms |

以上是原實作的量測，尚未涵蓋本次 Codex 複審修正。修正後封存掃描也探封閉 shadow；仍沿用單次 shadow 走訪最多 2500 個節點／20 個根的限制，封存額外 scope 最多 40 個。需由老闆重跑 Chrome 效能對照，包含 500 張縮圖；不能把上表當作修正後的結果。

## 截圖

範例資料，不是真的 ChatGPT 帳號。

- `docs/panel-1.7.1-archived.png`：已封存頁籤裡有 ChatGPT 對話「舊相機維修」，診斷框含 `archive=banner:1,list:2`。

## 老闆實測

1. `chrome://extensions` 重新載入，確認版本 1.7.1，權限只有側邊欄。把 ChatGPT 分頁重新整理。
2. 打開一則已封存的對話，或到設定裡打開已歸檔對話清單（不用點取消封存）。
3. 打開 Chatseek 側欄，切到「已封存」。這則對話應在裡面，標題旁有灰色「已封存」。對話頁主控台的 `[Chatseek] diag` 應有 `archive=banner:N,list:N`，至少一個命中數大於 0，且沒有對話內文。
4. 若要改回活躍：在側欄按「恢復活躍」。只重新整理、同步、或看到側欄裡有沒有它，不應讓它離開「已封存」。網站上取消封存之後又出現新訊息，也會回到活躍。

## 已知限制

- 不從側欄消失推斷封存。歸檔清單沒打開時，讀不到裡面的連結。
- 不點網站按鈕，不捲動清單。畫面上還沒畫出來的舊對話不會標到。
- 跨源 iframe 讀不到，不會為了它加 `host_permissions`。
- 封閉 shadow API 不可用、或根超過走訪上限時仍可能漏判。
- 對完全沒有訊息標記、Markdown／prose 類別或說話者標題的匿名文字塊，只能依橫幅文句辨識；正文若整段剛好是橫幅文字，仍有歧義。已排除已知訊息結構、其外層容器、輸入框、側欄、隱藏節點，以及跨 shadow／iframe 的這些祖先。
- 橫幅文句對不上字表、也沒有整段文字剛好是「取消封存」的按鈕時，不猜測。
- 網站上已經取消封存、但還沒有新訊息時，索引仍保持已封存，直到手動恢復或出現新訊息。
- Claude、Gemini、Grok 沒有封存偵測。

## PR #17 獨立複審修正（Codex，本 session）

範圍只有開工卡 (a)，未做 (b)(c)(d)。寫碼者為另一個 Cursor grok-4.7 session；本次未 commit、未 push。

複審工具：**Codex CLI 0.162.0**；模型 **gpt-6.1-sol**，reasoning **high**，**非 Fast**。獨立複審 session：`01a12001-f5c8-7d42-8ec7-327b9f780046`；本次最後確認延續同一 session。

原實作有以下可用離線 DOM 重現的問題：

1. `_archiveBannerHits` 只排除訊息節點本身／祖先，沒有排除包住訊息的外層 `div`；`_TRANSCRIPT_SELECTOR` 也漏了 `data-turn-id`、`data-message-content`、Markdown 等結構。訊息、輸入框或側欄標題含封存文句，會被誤當橫幅。修正訊息結構、跨 shadow／iframe 祖先排除與容器排除，並收緊完整文句比對；修正韓語 `보관됨` 字表。
2. 頂層命中訊息就不探封閉 shadow，漏掉另一個根的橫幅；shadow 內的 iframe 也沒掃。改為有上限的混合 scope 走訪，頂層有訊息仍檢查封閉根。
3. 頁面有橫幅但訊息還沒載入、且對話已在側欄時，`runCapture` 跳過對話列的封存寫入。現在即使零訊息也保留明確封存訊號。
4. 擷取和 DB 寫入會讓出執行權，原本沒有在恢復前重查晚到橫幅／歸檔清單或 SPA 導航。現於恢復前再次確認；恢復寫入失敗時保留 observed 證據重試，重試仍須重查頁面。
5. 健康報告 fingerprint 沒算 archive 命中數，只有封存變化時，側欄複製診斷可能沿用上一筆最多 60 秒。現在封存命中數變化會立即刷新報告。

回歸測試在 `scripts/archive-test.mjs`；Chrome fixture 在 `scripts/e2e-chatgpt.mjs` 加了「頂層訊息＋封閉 shadow 橫幅」。原有 DB 活動時間測試改為不帶 archived 欄位，確實驗證 lastActivity 寫入保留封存狀態。

複審驗證：最終程式修改後，Node 六組 `verify`、`test:search`、`test:fixture`、`test:gemini`、`test:upgrade`、`test:sync` 全部實跑通過（exit 0）；`git diff --check` 與 e2e 腳本語法檢查通過。manifest 除版號外與 `e3d42cc` 相同，package／lock 檔相同，DB schema 不變、版本 4，未增加費用或依賴。

依產品開發於本 session 的回報：對複審修正後、尚未 commit 的工作樹先跑 `npm ci`，再跑上述六組 Node 測試，全部 exit 0；Chrome for Testing **155.0.8059.39** 下的 `test:e2e`、`test:e2e-sync` 也全部 exit 0，包含新增的 **BANNER_MIXED**（頂層訊息＋封閉 shadow 橫幅）fixture。Chrome e2e 已由產品開發實跑通過；重新產生的舊版截圖已還原。

最後重新檢查工作樹 diff，未發現需要再補程式或測試的問題；本次只更新複審紀錄。程式複審結論：**可合併**。修正後效能對照數字由產品開發另行量測補入；老闆真站實測仍照上述四步進行。既有範例截圖保留。

## 工具切換交接（2026-10-09 17:35 UTC+8）

Cursor 額度已用完，老闆定：用完就交接、切換。之後不再用 Cursor。

- **已完成（本分支）**：(a) ChatGPT 封存偵測，`0cdaff7`；效能紀錄 `5d19f0d`。版號 1.7.1 只代表封存偵測。
- **未完成**（Cursor agent 後續做的沒有推上來，視同沒做）：
  - (d) **P0** ChatGPT 生圖進度文字重複入庫 → 改出 **1.7.2**，分支 `fix/imagegen-progress`，從合完 1.7.1 的 main 開。
  - (b) 原網站已刪除 → 已封存（小字「原網站已刪除」，`deleted=N`）→ 下一輪。
  - (c) 「從索引移除」確認框文案＋「不再提示」＋設定還原 → 下一輪。
- **工具與模型**：
  - 寫碼：CodeWhale（`~/.local/bin/codewhale`），模型只用 `deepseek-flash`（V4.1-Flash），不用 `deepseek-v4-pro`。`--auto` 代理模式。
  - 複審：Codex CLI 0.162.0，`-m gpt-6.1-sol -c model_reasoning_effort=high`，非 Fast（不設 `service_tier=fast`）。
  - 寫與審分開 session；同一件事同一個 session（`codewhale exec --resume <id>`／`codex exec resume <id>`）。session id 記在共享機 `/workspace/bd-punkcan/codewhale-sessions.md`。
  - 任一工具報額度／登入／模型錯誤：停下回報商務拓展，不換工具或模型。
- **下一步**：
  1. Codex 複審 PR #17 → 修在本分支 → 全部測試實跑通過 → `merge --no-ff` 進 main。
  2. CodeWhale 做 (d) 出 1.7.2 PR；另一個 Codex session 複審、合併。
  3. 下一輪：(b)(c)。

## 複審修正後效能（2026-10-09 18:40 UTC+8，產品開發實跑）

同一台共享機、同一時段連跑（機器同時有其他工作，絕對值比上表高，看相對）。基準 `5dc3ad7`（＝ e3d42cc 程式＋文件）。

| | 1.7.1（複審後） | 5dc3ad7 |
| --- | --- | --- |
| 閱讀頁 3000 則掛上 | 604 ms | 569 ms |
| 閱讀頁捲動 p50 / p95 | 4.6 / 8.9 ms | 4.6 / 9.3 ms |
| 側欄 3000 則開啟（三次中位） | 536 ms | 562 ms |
| 側欄捲動 p95 | 9 ms | 12 ms |
| 圖片頁籤 500 張開啟（三次中位）／捲動 p95 | 58 ms / 7.7 ms | — |

前三輪重複跑的閱讀頁掛上 1.7.1 與基準互有高低（基準 514–596 ms），差距在雜訊內。
