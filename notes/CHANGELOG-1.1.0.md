# Chatseek 1.1.0（2026-10-08）

修 ChatGPT 收不到正文，以及侧栏日期被收成采集时间。没有新站点，没有加权限，仍然只读页面、不挂网络。

## 收录

- ChatGPT 消息选择器改成分层：`data-message-author-role` → `data-turn` → `conversation-turn` → `data-message-id` → `main article`。角色先读 author，再读 `data-turn`，避免助手被标成用户。
- 包住整段对话的 `<form>` 不再把消息滤光。浅层 open shadow 里的回合也会读。
- 对话页抓到 0 条消息、并且约 8 秒后仍是 0 时，侧栏底部写「页面可能改版，请回报」，工具栏角标显示 `!`。控制台只打选择器名字和数量，不打正文。Claude / Grok 走同一套健康检查。
- 临时聊天（`temporary-chat=true`）不收录，也不当成改版失败。

## 日期

- 时间是这条对话的最后活动，不是收进 Chatseek 的时间。来源从高到低：`page-exact`、`observed`、`page-bucket`、`sidebar-rank`、`first-seen`。低的不会盖掉高的。`page-exact` 和 `observed` 取较新的那个。
- 继续聊天、尾部出现新消息时，时间推进到现在（`observed`）。第一次把旧对话整段收进来，以及向上滚动补旧消息，都不会被当成刚刚发生。
- 「Today」夹在今天 0 点到现在之间，不会变成中午。相对时间取整到分钟。
- 能解析 `Last message 3 hours ago`、`上次訊息 3 小時前` 这类前缀和繁体「小時／分鐘／週」。
- 没有精确时间时，按侧栏顺序插值，显示「約」。置顶区不参与插值。上下都没有已知时间时，显示「日期未知（收錄於 …）」，排序仍跟侧栏名次，不假装是刚刚。简体界面对应「约」「日期未知（收录于 …）」，一条文案里不混用繁简。
- 升级前已经在库里、又分不出是不是采集时间的记录，下次扫到侧栏时按上面的规则重估，不必清库。

## 标识

- 扩展图标换成方向 D（Ansuz 镜像绑定符）的 16/32/48/128 PNG。侧栏左上角沿用 32px 图标，所以一起换掉。
- SVG 放在 `docs/`：主稿、深色底白线、浅色底黑线、绿色图标。README 用主稿。仓库里没有另一套旧 logo 文件。

## 给 Gemini 分支

共用入口不要各写一份：内容脚本调用 `Chatseek.attachPageTime`、`Chatseek.sidebarSlots`、`Chatseek.pageKind`、`Chatseek.queryLayers`、`Chatseek.runCapture(..., { health })`。合并、侧栏插值和侧栏文案在 `src/activity-time.js`。新平台只要往 `background.js` 的 `HOSTS` 加一项，并在自己的内容脚本里报 health。
