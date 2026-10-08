# Chatseek 1.2.0（2026-10-08）

第四家平台：Gemini（gemini.google.com）。接在 1.1.0 的共用日期和健康检查上，不另写一套时间来源。

## 收录

- 新增 `content/gemini.js`。只读已经画在页面上的侧栏和当前对话。不发网络请求，不碰 Gemini 内部接口。
- 权限只多了 `https://gemini.google.com/*`。其他 google.com 子域名、Perplexity、DeepSeek 仍然不收。
- 侧栏可以筛 Gemini。多账号网址保留 `/u/N/`。从 Gem 打开的对话保留 `/gem/<gemId>/<id>`。`/share/`、没有 id 的 `/app`、Gem 编辑页不收。
- 消息走 `Chatseek.queryLayers`：`user-query` / `model-response`，然后 `data-message-author-role`，再然后正文节点。思考过程、屏幕阅读器标签、按钮和输入框不收。
- 对话页抓到 0 条消息时，走 1.1.0 的健康检查：大约 8 秒后仍是 0，侧栏底部和工具栏 `!` 才提示。临时页和没有 id 的页面不当成改版失败。

## 日期

- Gemini 只报页面上的精确时间（`page-exact`）和侧栏名次（`sidebarIndex`，0 是最新）。合并、插值和文案仍在 `src/activity-time.js`。
- 旁边已经有精确时间或分组时间时，按侧栏顺序插值，繁体显示「約」，简体显示「约」。
- 在开着的 Gemini 标签页里送出新消息（对话尾部多一条）时，这条对话记为 `observed`，时间是当下，不加「约」；侧栏其他行随即以它为锚点插值。只是打开旧对话、往上滚出更早的消息，不算活动。这条链路在 1.1.0 里因为 `background.js` 没把消息 id 转给数据库，四家都没有真正生效过，这版一起修了。
- 整栏都没有锚点时，来源留在 `first-seen`，显示「日期未知（收錄於 …）」／「日期未知（收录于 …）」。排序仍跟侧栏，不把采集时间标成「刚刚」，也不把每一条都标成「約」。
- 锚点以下的行只知道「比它旧」，共用插值每行减一小时，只保证顺序。
- 打开过的 Gemini 对话不会再在「日期未知」组里掉到最底。
- 低置信度不会盖掉高置信度。ChatGPT、Claude、Grok 的日期规则不变。

## 标识

- 继续用 1.1.0 的方向 D 图标（`docs/chatseek-logo-d.svg` 和 `icons/`）。这版没有换标。

细节和实机步骤见 `notes/HANDOFF-gemini.md`。1.1.0 的日期与健康检查见 `notes/CHANGELOG-1.1.0.md`。
