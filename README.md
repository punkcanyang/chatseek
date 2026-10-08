# Chatseek

<img src="docs/chatseek-logo-d.svg" alt="Chatseek" width="64" height="64" />

Chrome 扩展：在本地搜索你打开过的 ChatGPT / Claude / Grok / Gemini 旧聊天。数据只存你浏览器的 IndexedDB（倒排索引），不上传、不代持 Key。

## 安装（Load unpacked / 加载已解压的扩展程序）

1. 打开 `chrome://extensions`
2. 打开「开发者模式」
3. 点「加载已解压的扩展程序」／Load unpacked
4. 选本仓库目录

点工具栏图标打开侧栏搜索。

## 怎么用

1. 打开 chatgpt.com、claude.ai、grok.com / x.ai 或 gemini.google.com，浏览你要搜的聊天（索引会在打开的标签页里采集）
2. 打开 Chatseek 侧栏，输入关键词搜索。可以用「Gemini」只看这一家

## 诚实限制

没打开过的标签页里的旧聊天，这版还是搜不到（open-tab limitation）。用户得去那几个网站转一圈，或以后再做「导入官方导出文件」。只读当前标签页里已经渲染出来的会话列表和消息，不挂 fetch/XHR，不要求 API Key。侧栏日期是这条对话的最后活动时间（页面上的真实会话时间优先）。没有精确时间时按侧栏顺序推估，并标「约」；连顺序也推不出时显示「日期未知」，悬停可见采集时间。分组时间不会盖掉已经拿到的精确时间。四家平台共用这一套，Gemini 不另写日期。

## 范围

- 做：ChatGPT、Claude、Grok、Gemini、本地存、搜索
- 不做：Perplexity、DeepSeek；不代持 API Key；不上架 Chrome Web Store / 不计费。Gemini 只读已经画出来的页面，不请求内部接口，也不一次导入全部历史

## 开发检查

```bash
npm run verify
npm run test:search
npm run test:fixture
npm run test:gemini
```

当前包版本 1.2.0。搜索按完整词匹配（`musicmap` 能中，`music` 不会误中 `musicmap`）。侧栏日期表示最后活动时间：精确时间照常显示；只有侧栏顺序、且旁边已有真实时间时标「约」；没有可推估的锚点时显示「日期未知（收录于 …）」（繁体界面是「約」「日期未知（收錄於 …）」），不用采集时间冒充对话日期。对话页一则消息都没抓到时，侧栏底部和工具栏角标会提示。扩展 Reload 后本地索引还在；网站标签页需要刷新一次，内容脚本才会重新采集。日期规则见 `notes/CHANGELOG-1.1.0.md`，Gemini 见 `notes/CHANGELOG-1.2.0.md`。
