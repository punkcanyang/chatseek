# Chatseek

Chrome 扩展：在本地搜索你打开过的 ChatGPT / Claude / Grok 旧聊天。数据只存你浏览器的 IndexedDB（倒排索引），不上传、不代持 Key。

## 安装（Load unpacked / 加载已解压的扩展程序）

1. 打开 `chrome://extensions`
2. 打开「开发者模式」
3. 点「加载已解压的扩展程序」／Load unpacked
4. 选本目录（`/workspace/saas-scout/chatseek` 或你解压后的文件夹）

点工具栏图标打开侧栏搜索。

## 怎么用

1. 打开 chatgpt.com、claude.ai 或 grok.com / x.ai，浏览你要搜的聊天（索引会在打开的标签页里采集）
2. 打开 Chatseek 侧栏，输入关键词搜索

## 诚实限制

没打开过的标签页里的旧聊天，这版还是搜不到（open-tab limitation）。用户得去那几个网站转一圈，或以后再做「导入官方导出文件」。只读当前标签页里已经渲染出来的会话列表和消息，不挂 fetch/XHR，不要求 API Key。侧栏日期优先用页面上的真实会话时间（有则显示）；否则用采集时间。

## 范围

- 做：ChatGPT、Claude、Grok、本地存、搜索
- 不做：Gemini、Perplexity、DeepSeek；不代持 API Key；不上架 Chrome Web Store / 不计费

## 开发检查

```bash
npm run verify
npm run test:search
```
