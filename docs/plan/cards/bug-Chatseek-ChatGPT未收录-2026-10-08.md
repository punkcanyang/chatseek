# 問題單：Chatseek ① ChatGPT 對話沒收進來 ② 日期混亂（2026-10-08）

- 回報：老闆，10/08 上午自己電腦實測
- 初查：商務拓展（只讀程式碼、跑測試、jsdom 模擬，**沒改產品程式碼、沒 commit、沒登入任何帳號**）
- 版本：`punkcanyang/chatseek` main `0c4d3c7`（v1.0.2，9/25 合入的 Opus PR #1）
- 注意：產品開發正在 `feat/gemini` 分支／Cursor 雲端做 Gemini。本單兩個問題的修法 **Gemini 也要照同一套規則**（見最後一節）。

> 標記說明：**【確認】**＝讀程式碼或模擬實際跑出來的；**【推測】**＝合理但沒在真實 ChatGPT 頁面驗證（box 上不能登入，看不到登入後的 DOM）。

---

## 第一部分：ChatGPT 對話沒有收錄

### 現象
老闆在自己電腦用 ChatGPT 聊完，Chatseek 側欄裡沒有這段對話（或搜不到內容）。細節待補：是「整條對話都沒出現」，還是「有標題、搜不到內文」。

### 已排除
- **網域白名單沒問題**【確認】：`manifest.json` 的 content_scripts、host_permissions，以及 `background.js` 的寄件來源檢查，都同時有 `chatgpt.com` 和 `chat.openai.com`。
- **Opus PR #1（0c4d3c7）沒動到 ChatGPT 選擇器**【確認】：`content/chatgpt.js` 只改了兩處，一是標題去尾巴改用 `stripTitleSuffix`，二是 `capture()` 改成回傳成功與否（給失敗重試用）。`shared.js` 增加的是重試、孤兒腳本停止、SPA 換頁防串台、日期過濾，都不影響「抓不抓得到」。
- **仓內測試全過**【確認】：`npm run verify` → `verify ok`；`npm run test:search` → `search-test ok`（工作目錄缺 `node_modules`，是複製到 /tmp 後 `npm ci` 再跑的）。不過這兩支測試都**沒有模擬 ChatGPT 頁面 DOM**，所以過了不代表真站能收。
- **舊版 DOM 收得到**【確認】：用 jsdom 模擬經典 ChatGPT 結構（`a[href*="/c/"]` 側欄＋`[data-message-author-role]` 訊息），`/c/<id>` 和專案路徑 `/g/g-p-…/c/<id>` 都能正確收到標題與兩則訊息。

### 最可能原因（按可能性排）

1. **【推測｜高】測試環境或頁面不在收錄範圍內**。程式只在網址含 `/c/<UUID>` 時收內文，模擬結果【確認】如下：
   - 首頁 `/` 上剛開的新對話：網址還沒變成 `/c/<id>` 之前，**不收內文**（側欄標題照收）。
   - 臨時聊天 `?temporary-chat=true`：**完全不收**（符合預期，但老闆可能不知道）。
   - **ChatGPT Work** 的對話：網址格式沒有公開文件，如果不是 `/c/<id>`（例如 `/work/...`），**完全不收**。官方 9 月起把 Chat／Work 合進同一個 Recents。
   - 用的是 **ChatGPT 桌面 App**，不是 Chrome 分頁：擴充功能根本跑不進去。
   - 擴充功能安裝或重新載入之後，**沒重新整理已經開著的 ChatGPT 分頁**：Chrome 不會把內容腳本補進舊分頁，這頁就完全不收。審計 P2-4 已經記過這一條。
   - `chrome://extensions` 裡 Chatseek 的「網站存取權」被設成「點擊時」或沒包含 chatgpt.com，內容腳本也不會跑。

2. **【推測｜中高】ChatGPT 網頁改版，選擇器沒對上，而且失敗時一點聲音都沒有**。
   - 時間點對得上：Chatseek 最後一次改選擇器是 9/23–9/25。公開資料提到 ChatGPT 網頁**9 月底大改版**（第三方整理稱 late September 2026 web redesign，之後錯誤訊息文字也換了），**10/08（今天）**又開始推 **GPT-6 + Intelligent UI**，回覆會混進互動元件和圖表，而且「邊想邊答、答完再補充」。
   - 程式依序試三組：`[data-message-author-role]` → `[data-testid^="conversation-turn"]` → `main article`。三組都沒對上的話，**訊息數就是 0，只存一筆標題，也沒有任何 console 提示**【確認：程式碼裡沒有任何診斷輸出】。老闆看到的就會是「搜不到內容」或「好像沒收到」。
   - 側欄如果不再用 `<a href="/c/...">`（例如改成按鈕加路由），標題清單也會整批收不到【推測】。
   - 次要問題【確認】：如果新版 DOM 只有 `data-turn="assistant"`、沒有 `data-message-author-role`，**助手訊息會被誤標成 user**。不影響搜尋，只影響角色標記。

3. **【確認｜中】長對話只收到畫面上已經渲染的部分**。ChatGPT 8/21 起長對話「分段載入」，Chatseek 只讀 DOM，沒捲到的舊訊息不會進索引，搜舊內容就會落空。

4. **【確認｜低到中】搜尋分詞漏字，看起來像沒收**。審計 P2-1：`gpt-4o` 只會剩 `gpt`；`4o`、單一字母、`C++`、帶重音字母都搜不到內文。老闆如果用這類詞測，會以為沒收進來。

### 建議修法（交產品開發，順序即優先順序）
1. **先加「收錄健康檢查」**，這也是先前說要打磨「收得穩」的第一步：
   - 內容腳本每次收錄回報**計數**（不含內文）：平台、路徑型態（`/c/`／首頁／其他）、側欄抓到幾筆、訊息抓到幾則、命中哪一組選擇器。
   - 側欄底部顯示「ChatGPT：最後收錄 10:32，3 則訊息」。在 `/c/` 頁面上連續抓到 0 則時，顯示「ChatGPT 頁面可能改版，請回報」。
   - 開發者工具 console 只印 `[Chatseek] chatgpt: 0 messages on /c/ page, selectors tried: …`，**不印內文**。
2. **依老闆提供的真實 DOM 更新選擇器**：增加 `[data-turn]`、`section/article[data-testid*="conversation-turn"]`、`[data-message-id]` 等備援；角色依序讀 `data-message-author-role` → `data-turn`；Intelligent UI 的互動區塊至少要收到文字。
3. **網址規則**：先拿老闆的實際網址確認 Work 或其他路徑的格式，再擴充 `conversationIdFromLocation`（只要路徑裡有對話 id 就收，不限 `/c/`）。
4. **舊分頁補注入**：安裝或更新時用 `chrome.scripting` 把腳本補進已開的 ChatGPT／Claude／Grok 分頁，需要加 `scripting` 權限（屬於權限變更，請老闆點頭）；不想加權限的話，至少在側欄提示「請重新整理 ChatGPT 分頁」。
5. **補一支 jsdom 測試**：用老闆提供的匿名化 DOM 片段當 fixture，之後 ChatGPT 再改版，測試會先紅。

### 驗收步驟（老闆在自己電腦、用主號）
1. `chrome://extensions` → Chatseek 版本是修正版；網站存取權為「在所有網站上」或至少包含 chatgpt.com。
2. 重新整理所有 ChatGPT 分頁。
3. 開一個**新對話**送出一句含獨特詞的話（例如 `zebrafox1008`），等回覆完成、網址變成 `/c/...`。
4. 打開 Chatseek 側欄：最上面出現這條對話；搜 `zebrafox1008` 有命中；健康檢查顯示 ChatGPT 最後收錄時間是剛剛、訊息數 ≥ 2。
5. 打開一條**舊對話**，往上捲到底，再搜裡面一個舊段落的詞，要能命中。
6. 專案裡的對話、（有 Work 的話）Work 對話各測一次。臨時聊天應該**不收**，側欄要說明原因。
7. 開發者工具 console 沒有 Chatseek 錯誤；在 `/c/` 頁面上沒有出現「0 messages」警告。

### 需要老闆補的資訊
1. **測試的實際網址**（把對話 id 遮掉也可以，只要路徑格式，例如 `chatgpt.com/c/xxxx`、`/g/.../c/xxxx`、`/work/...` 或首頁）。是在 Chrome 分頁還是 ChatGPT 桌面 App？是 Chat 還是 Work？有沒有開臨時聊天？
2. `chrome://extensions` 裡 Chatseek 的**版本號**、**網站存取權**設定、有沒有紅色「錯誤」按鈕（有的話截圖）。
3. 裝好或重新載入 Chatseek 之後，**有沒有重新整理 ChatGPT 分頁**。
4. 現象細節：Chatseek 側欄裡有沒有這條對話的**標題**？有標題、搜不到內文，還是完全沒有？用什麼關鍵字搜的？
5. 在 ChatGPT 對話頁按 F12 → Console，**截圖有 `Chatseek` 字樣或紅字的錯誤**。
6. （最有用）在對話頁 Console 貼這三行，把輸出數字截圖給我們。只會印出數量，不含對話內容：
   ```js
   ['[data-message-author-role]','[data-testid^="conversation-turn"]','main article','[data-turn]','[data-message-id]','a[href*="/c/"]'].map(s=>s+' = '+document.querySelectorAll(s).length).join('\n')
   ```
   如果訊息類選擇器都是 0，再對一則訊息按右鍵「檢查」，截圖那一段 HTML（可以先把文字遮掉）。

---

## 第二部分：日期混亂，要改成按「最後對話時間」顯示與排序

### 老闆要的規則
側欄每條對話顯示並排序的時間，是**這條對話最後一則訊息的時間**（平台的 update_time），**不是收錄進 Chatseek 的時間**。拿不到真實時間時要有備援規則，並在 UI 標明是推估。

### 現況：存哪個欄位、顯示和排序用哪個【確認】
三家共用同一套邏輯（`content/shared.js` → `background.js` → `src/db.js` → `sidepanel/panel.js`）：

| 項目 | 現況 |
|---|---|
| 存的欄位 | 對話表只有 `updatedAt`、`createdAt` 兩個時間；訊息表有 `capturedAt`（收錄時間，沒有拿來用）。**沒有欄位記錄時間是從哪裡來的**（精確、分組推估，還是收錄時間）。 |
| 時間來源優先序 | ① 側欄那一列上的 `time[datetime]`／`data-*time*`／短的相對時間字 → ② 頁內 JSON（`script[type=application/json]`、`__NEXT_DATA__` 裡的 `update_time` 等）→ ③ 側欄分組標題（Today／Previous 7 Days…，取區間中點）→ ④ 都沒有：**`Date.now()`，也就是收錄時間** |
| 顯示 | `panel.js` 一律顯示 `conv.updatedAt`：7 天內顯示相對時間，更早顯示日期，滑鼠移上去顯示完整時間 |
| 排序 | 沒有搜尋詞時用 IndexedDB 的 `updatedAt` 索引倒序；有搜尋詞時也是依 `updatedAt` 排序 |

### 造成混亂的具體 bug
1. **【確認】拿不到頁面時間就寫入收錄時間，事後完全分不出來**。第一次掃側欄時，整批對話都拿到同一個「現在」，順序等於亂排，平台側欄原本「最近的排最上面」的順序也丟了。
2. **【確認】繼續聊天不會更新時間**。`writeMessages` 只有在「還沒有合法時間」時才補 `Date.now()`。一條對話只要曾經存過任何時間（包括收錄時間），之後再有新訊息，時間都**停在第一次收錄那天**。用 fake-indexeddb 實測：新訊息寫入後 `updatedAt` 沒變。
3. **【確認】粗略的分組時間會蓋掉精確時間**。實測：先存精確時間 10/07 18:00，之後某次只拿到「Previous 30 Days」分組，`updatedAt` 就被改成 9/23（區間中點）。
4. **【確認】「Today」被當成今天中午 12:00**。早上 9 點看到的「Today」會比現在晚 3 小時，排序和「剛剛」的顯示都會錯。
5. **【確認】有些時間字解析不了**：`Last message 3 hours ago`（Claude 全部對話頁的寫法）、繁體 `3 小時前`，`parsePageTime` 都回傳 null。目前只認簡體「小时／分钟」，而且不接受前綴文字。
6. **【確認】ChatGPT 很可能整欄都沒有真實時間**：jsdom 模擬裡，側欄只有「Chats」標題時，所有對話都是「無日期」，落到收錄時間。另外，ChatGPT 現在把頁面資料塞在 React Router 的串流腳本裡，不是 `"update_time": 數字` 這種 JSON 寫法，`pageTimesFromDocument` 的正規式多半抓不到【推測】。
7. 審計 P2-7（已知）：「2h」這類相對時間每輪算出來都不一樣，側欄指紋每輪都變，整批重送。

### 各家頁面能不能只讀頁面拿到最後對話時間（不打內部介面）

| 平台 | 可用的唯讀來源 | 狀態 |
|---|---|---|
| ChatGPT | 側欄**目前大概沒有**日期分組（只有 Recents／Chats，可置頂）；訊息旁邊沒有顯示時間；頁內串流資料**可能**帶有「目前這條對話」的 `update_time`（Unix 秒），但格式不是一般 JSON。**側欄順序本身就是依最近活動排的**（置頂區除外）。 | 都是【推測】，要看老闆貼的 DOM。精確時間大概只能靠「看到新訊息的時間」和「側欄順序」 |
| Claude | 左側 Recents 沒有時間；**`claude.ai/recents`（全部對話）頁每列有「Last message N hours ago」**，用唯讀 DOM 就讀得到（目前解析失敗，見 bug 5）。訊息上不確定有沒有時間 | 【推測】，帳號解凍後或老闆實測時確認 |
| Grok | 側欄或歷史清單可能有 Today／Yesterday 分組，或每列有「2h／3d」短標籤（程式已經支援） | 【推測】，要實站確認 |
| Gemini（開發中） | 側欄「最近」通常沒有時間（Gemini 開工卡也是這樣寫）；不可以去讀 myactivity.google.com（不同網域，而且等於另外讀帳號資料） | 【推測】 |

結論：**精確的最後對話時間在多數平台上拿不到**，所以備援規則比解析器更重要。

### 建議修法（資料模型＋規則）
1. **加一個「時間來源」欄位**，`updatedAt` 繼續當排序鍵，不用改索引，也不用升 `DB_VERSION`：
   - `updatedAt`：目前對「最後對話時間」的最佳估計
   - `updatedAtSource`：`page-exact`（頁面上的精確時間或 update_time）＞ `observed`（Chatseek 親眼看到新訊息出現的時間）＞ `page-bucket`（分組或相對時間推估）＞ `sidebar-rank`（依側欄順序內插）＞ `first-seen`（只知道收錄時間）
   - 另外存 `firstSeenAt`（第一次收錄的時間），只給「收錄於」的說明用，**不拿來排序**
2. **合併規則：來源等級高的不會被低的蓋掉**。同一等級時，`page-exact`／`observed` 取比較新的；`page-bucket` 只能把時間夾進區間裡（例如「Today」最多到現在，不准變成未來時間）。
3. **`observed` 規則，也是主要備援**：一條**已經在資料庫裡、而且已經有訊息**的對話，在尾端出現新的訊息 id（或偵測到正在串流回覆）時，`updatedAt = 現在`，來源記為 `observed`。這基本上就是真實的最後對話時間。
   - **第一次收錄的舊對話不算**：全部訊息都是第一次看到，但不是剛發生的，不能標成 observed。
4. **側欄順序內插**：平台側欄本來就是依最近活動排序（要排除置頂區）。同一批沒有時間的對話，依側欄名次保持先後；時間取上下兩條已知時間之間的值，來源記為 `sidebar-rank`；上下都沒有已知時間時，就保留 `first-seen`，排在有時間的對話後面，彼此之間照側欄名次排。
5. **解析器修補**：接受「Last message …」「上次訊息 …」這類前綴；支援繁體「小時／分鐘／週前」；「Today」上限是現在；相對時間取整到分鐘（順便修掉 P2-7）。
6. **UI**：
   - `page-exact`／`observed`：照常顯示。
   - `page-bucket`／`sidebar-rank`：時間前面加「約」或「~」，滑鼠移上去說明「推估：依 ChatGPT 側欄分組／順序」。
   - `first-seen`：顯示「日期未知」，滑鼠移上去說明「收錄於 10/08 11:20」，不要假裝是對話日期。
7. **舊資料**：現有的 `updatedAt` 分不出是不是收錄時間，一律標成 `first-seen`（或另外標 `legacy`），等下次看到新訊息或頁面時間再升級。不需要清空資料庫。
8. **測試**：補 `search-test`／`verify`。必須覆蓋：新訊息會把時間往前推；bucket 蓋不掉 exact；Today 不會變成未來時間；第一次收錄的舊對話不會被標成 observed；側欄名次內插順序正確；繁體和前綴時間字可以解析。

### 驗收步驟
1. 準備三條對話：A 今天聊過、B 上週聊過、C 一個月前聊過。在平台上依序打開，讓 Chatseek 收錄。
2. Chatseek 側欄順序應該是 A、B、C，不能因為收錄順序變成 C、B、A；沒有真實時間的要顯示「約…」或「日期未知」，不能全部顯示「剛剛」。
3. 在 C 裡面送一句新訊息 → Chatseek 裡的 C 跳到最上面，時間顯示剛剛（來源 observed，不加「約」）。
4. 重新整理頁面、重新載入擴充功能之後，A、B、C 的順序和時間都不變。
5. Claude（解凍後）：打開 `claude.ai/recents`，Chatseek 的時間要對上頁面上的「Last message …」。
6. 三家（加上 Gemini）各做一次步驟 1–4。

### 需要老闆補的資訊
- 截一張 ChatGPT（與 Grok）**左側側欄**：有沒有「今天／昨天」這類分組、每列有沒有時間。
- 確認規則：拿不到真實時間時，用「日期未知（收錄於…）」排在後面，還是用側欄順序推估加上「約」？本單建議兩者都要：先用側欄順序推估，真的推不出來才顯示日期未知。

---

## Gemini 同步提醒（給產品開發）
- `notes`／開工卡〈開工卡-Chatseek-加Gemini-2026-10-08.md〉第 47 行和第 93 行目前寫的是「沒有頁面時間就退回採集時間，可以接受」，**跟老闆今天定的新規則衝突**，需要改成：輸出 `updatedAtSource`，套用 observed／側欄順序備援，UI 標推估，不准把收錄時間當成對話日期。
- Gemini 也要套用第一部分的「收錄健康檢查」（抓到 0 則時提示）。
- 建議做法：兩個問題的共用部分（時間來源欄位、合併規則、健康檢查）先在 `shared.js`／`db.js` 做好，Gemini 分支 rebase 之後直接沿用，不要各家各寫一套。
