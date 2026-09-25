# Chatseek 独立审计（2026-09-25，基于 main `1e1f1bb` / 1.0.1）

范围按开工卡：收聊天稳不稳、索引丢不丢、搜索准不准、日期、明显坏 UX／bug、MV3 权限、安全隐私、Load unpacked。Claude 只读代码，没实机。本环境没有登录态浏览器，下面的结论来自读代码、`fake-indexeddb` 测试和 jsdom 页面模拟。

分级：P0 = 收不到／搜不到／丢数据／安全问题；P1 = 明确 bug 或错误 UX；P2 = 可以更好。

## 结论

- **没有发现 P0。** 没有任何网络请求（无 fetch/XHR/WebSocket/beacon），没有 `innerHTML`，权限只有 `sidePanel` + 7 个站点。后台只收自家内容脚本的消息，并核对发送标签页的网址。IndexedDB 连接断了会重开，扩展 Reload 不清库。搜索不读 messages 表，按整词查倒排索引。
- **5 个 P1 已修**（1.0.2），见下表。
- P2 留给老板定，见最后。

## P1（已修）

| # | 问题 | 证据 | 修法 |
|---|------|------|------|
| 1 | **假日期 2001 年。** 行旁边的 "Step 1"、"Top 10"、"Chapter 3"、"Idea 7" 被 Chrome 的 `Date.parse` 解析成 2001 年；行内时间优先于 Today 分组，所以连分组日期也被盖掉。标题属性里的 "Roadmap 2025" 也会变成 2025-01-01。 | `content/shared.js` `parsePageTime` 末尾的 `Date.parse` 兜底；`findTimeNear` 会拿行里 ≤28 字的短文字去试。jsdom 复现：旧代码对 "Chapter 3 draft" 行给出 `2001-01-01`。 | 兜底只接受「月份名/星期名 + 数字」或「d/m/y」格式；没年份时补今年（在未来就用去年）。合理时间下限从 1973 提到 2020-01-01（`shared.js` 与 `src/db.js` 同步）。库里已有的旧假日期：下次采集改成采集时间；侧栏对 2020 年前的时间显示「无日期」。 |
| 2 | **标题被截断。** Grok 的正则 `[|·—-]\s*(Grok|x\.ai|X).*$` 带 `i` 标志，任何 "- x…" 都会截掉后半段："Sales - Xbox plan" → "Sales"。Claude 的 `- Claude.*$` 也会把 "Ideas - Claude Shannon" 截成 "Ideas"。当前打开的会话标题用的就是这个，会覆盖侧栏里的完整标题，标题词就搜不到了。 | `content/grok.js`、`content/claude.js`、`content/chatgpt.js` 的 `titleFromDoc` | 新增 `Chatseek.stripTitleSuffix`，只去掉**结尾**的站名。 |
| 3 | **切换会话时串台。** 单页应用里网址先变、正文后换。800ms 防抖后如果正文还是上一条聊天，就会用新会话 id 把旧消息再存一遍，搜旧聊天的词会多出一条错的结果。 | `content/shared.js` `runCapture` 只看 `location` 决定会话 id | 如果屏幕上的消息**全部**是刚为上一条会话存过的，就跳过这一轮，等下一次 DOM 变化。属于防御性修复，没在真站上复现过。 |
| 4 | **写入失败不会自己重试。** 1.0.1 说「采集失败会重试」，实际上要等页面再变化才会再试；页面静止时这次采集就丢了，直到用户再操作。 | `content/shared.js` `observe` 吞掉了结果和异常 | `runCapture` 返回成功与否；失败按 3s → 6s → … → 60s 退避重试，成功就停。 |
| 5 | **Reload 扩展后旧脚本空转。** 旧标签页里失效的内容脚本还在监听整页 DOM，每次变化都重扫侧栏（每 15 秒还扫一遍页面 JSON），发出去的消息全部失败。交接说明里要求 Reload，这种情况很常见。 | `content/shared.js` `observe` 没有停止条件 | 检测到 `chrome.runtime.id` 消失就断开 MutationObserver、清掉定时器。 |

测试：`scripts/verify.mjs` 新增假日期、补年份、标题后缀、串台保护、失败重试几项；`scripts/search-test.mjs` 新增「库里的 2001 日期被修回来」。已确认这些测试在旧代码上会失败。

## P2（没修，建议后续）

按对用户的影响排序。

1. **分词漏词。** `gpt-4o` 只剩 `gpt`（会搜出所有提过 gpt 的聊天）；`4o`、`3d`、单字母、`C++` 在正文里搜不到（只能靠标题）；`123` 会命中 `abc123`；带重音的拉丁字母和西里尔字母（café、Привет）不进索引。证据：`src/tokenize.js` 的 `[a-z][a-z0-9]{1,47}` 和 `[0-9]{2,24}`。要修就得换分词、升级 `DB_VERSION` 并在升级时重建 tokenMap。这属于改索引结构，风险比这轮其它改动都大，建议单独一轮做，并配迁移测试。
2. **没有稳定 id 的消息会留副本。** Claude、Grok 找不到 `data-message-id` 时，用「角色 + 正文前 180 字」的哈希当 id（`content/claude.js`、`content/grok.js`）。流式回复会留下半截副本，消息数偏大；编辑过的消息旧版本也还能搜到。搜索只会多、不会漏。建议在真站 DOM 上找稳定 id（例如 Grok 外层容器可能有 `id="response-…"`），确认后再改。
3. **Grok 角色判断太宽。** class 正则 `/assistant|ai|grok|response|model/` 里的 `ai` 会命中 `container`、`main` 等常见 class（`content/grok.js` `roleFromNode`）。只影响 user/assistant 标记，不影响搜索。
4. **Reload 扩展后要手动刷新网站标签页。** 可以在安装/更新时用 `chrome.scripting` 自动注入，但要加 `scripting` 权限，属于新改动，另议。
5. **清除本地索引后不会马上重收。** 已打开标签页记着「已采过」的指纹，要等页面变化或刷新（`content/shared.js` 的 `state`）。
6. **用不上的站点权限。** `https://x.ai/*`、`https://grok.x.com/*` 基本没有聊天页面，可以删掉以缩小权限（同时改 `scripts/verify.mjs` 白名单）。
7. **相对时间抖动。** "2h" 这类标签每次算出的毫秒数都不同，侧栏指纹每轮都变，整批会话重发一次（`content/shared.js` `runCapture` 的 `listFp`）。按分钟取整即可。
8. **存储持久化。** 没申请 `navigator.storage.persist()` 或 `unlimitedStorage`。磁盘极满时浏览器理论上可以清掉扩展的 IndexedDB。
9. **侧栏最多 80 条**，没有「还有更多」提示（`sidepanel/panel.js` `limit: 80`）。
10. **后台没有逐条核对 platform。** `CAPTURE_CONVERSATIONS` 只核对了发送标签页属于 `msg.platform`，没核对每条会话的 `platform` 与之相同（`background.js`）。只有自家内容脚本能发消息，风险低。
11. **Claude 选择器可能过时。** `.font-claude-message` 在新版 Claude 可能改名了（例如 `.font-claude-response`），解冻后实测再定（`content/claude.js`）。
12. **消息指纹只看长度 + 末尾 80 字。** 中间改了、长度又没变时会漏更新（`content/shared.js` `msgFp`），很少见。
13. **Grok 非 UUID 会话的链接。** 统一写成 `/c/<slug>`；如果原路径是 `/chat/<slug>`，点结果可能打不开（`content/grok.js` `canonicalUrl`）。

## 检查过、没问题

- `manifest.json`：MV3，`minimum_chrome_version` 116，只有 `sidePanel` 权限；内容脚本在 ISOLATED world；Load unpacked 需要的文件和图标都在（`npm run verify` 有检查）。
- 隐私：扩展代码里没有网络调用，也没有 `console` 输出正文；数据只在扩展自己的 IndexedDB。
- 存储并发：每次写入是一个 readwrite 事务，读旧值和写新值在同一事务里，多个标签页同时写会被 IndexedDB 排队，不会互相覆盖。
- 整词搜索：`collectConvIdsForToken` 的 key 范围加 `row.token === token`，前缀词不会误中。多个词必须在同一条对话里。
- 侧栏渲染全部用 `textContent`，没有 XSS 面；打开结果只用校验过站点的 URL。
