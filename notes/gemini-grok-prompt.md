你是 Chatseek Chrome 扩展的主开发会话（这个任务从头到尾就是这一个 session）。工作目录：/workspace/saas-scout/chatseek，当前分支 feat/gemini（基于 main 0c4d3c7，v1.0.2）。

## 先读
1. 开工卡（以卡为准，完整读完）：/workspace/bd-punkcan/开工卡-Chatseek-加Gemini-2026-10-08.md
2. 通读：manifest.json, background.js, content/{shared,chatgpt,claude,grok}.js, sidepanel/*, src/{db,tokenize}.js, scripts/{verify,search-test}.mjs, README.md, notes/CHANGELOG-grok47.md

## 硬规则
- 模型 grok-4.7 high；禁止切 build-fast / Fast / 低 effort。
- 绝不登入任何 Google/Gemini 账号；不打开需要登入的页面；不打 batchexecute、不攔 fetch/XHR、不要 API Key、不发任何网络请求去 Google。不花钱。
- 不碰 ChatGPT/Claude/Grok 的收集逻辑（content/chatgpt.js / claude.js / grok.js 不改；shared.js、db.js 只做必要小改）。
- 不 push、不开 PR、不改 main（这些我来做）。你可以在 feat/gemini 上 git commit。
- 不要提交 tmp/、docs/、notes/GROK_PROMPT_grok47.md、notes/README-beautify-preview.md、notes/task-grok47-提优.md 这些既有未追踪文件（只 git add 你改/新增的文件）。

## 要做（卡上第 1–7 点全部）
1. 新增 content/gemini.js，结构照 claude.js/grok.js：extractSidebar()、extractMessages()、capture()、Chatseek.observe(capture)。
   - 对话 id：`gemini:<hexId>`；支持 /app/<id>、/u/<n>/app/<id>、/gem/<gemId>/<id>、/u/<n>/gem/<gemId>/<id>；/app（无 id）、/share/、Gem 编辑页不收。
   - **多账号前缀**：保留 /u/<n>/ 前缀到存储的 url，点回去开到正确账号。侧栏项若只有 jslog 的 c_<id>，用当前页面的账号前缀组 url。对话 id 本身不含账号前缀（同一 id 在不同账号理论上不冲突，若你判断要区分请说明理由）。
   - 侧栏：[data-test-id="conversation"]（jslog 里 c_<id>）＋ a[href*="/app/"] 两路都试；标题 .conversation-title / [data-test-id="conversation-title"]，去掉隐藏文字/按钮文字。
   - 消息：user-query / .user-query / .query-text；model-response 正文 message-content / .markdown / .model-response-text；备援 [data-message-author-role]、[aria-label="Gemini response"] 等；按 DOM 位置排序、去重（嵌套元素不重复收）。
   - 排除：model-thoughts / .thoughts-container、.cdk-visually-hidden（「你说了」「You said」「Gemini 说了/said」等）、button、.ql-editor/输入框、工具列/复制按钮文字。
   - 日期：多半没有，退回采集时间（照现有规则）。
   - 找不到元素时安静跳过，不报错。
2. manifest.json：host_permissions 加 https://gemini.google.com/* ；content_scripts 加 ["content/shared.js","content/gemini.js"]；description 改四家；version 1.1.0。
3. background.js：HOSTS 加 gemini、validConversation() 认 gemini（含 url 必须是 https://gemini.google.com/ 下）。
4. 侧栏：index.html 加「Gemini」筛选按钮；panel.js 中英平台名；panel.css 加 .plat.gemini 颜色。
5. src/db.js 约第 108 行佔位标题正则加 Gemini（如 `Gemini`、`New chat`/`新对话`/`新對話`）。
6. scripts/verify.mjs：只放行 https://gemini.google.com/*，其他 google.com 子域（含 google.com 本身、www.google.com、generativelanguage.googleapis.com 等）仍违规；perplexity/deepseek 仍禁；content/gemini.js 进「不准攔 fetch/XHR」检查清单；最好也检查 gemini.js 里不出现 batchexecute。给 verify 本身加自测或至少保证它能挡这些（例如对一个假 manifest 字符串跑检查函数）。
7. scripts/search-test.mjs：加 Gemini 测试资料；四家一起搜、只筛 Gemini 都对；旧 ChatGPT/Grok/Claude 断言不退步。
8. **离线 HTML 样本**：手写 fixtures（例如 scripts/fixtures/gemini-conversation.html，照公开结构：user-query 内含 .cdk-visually-hidden「你说了」+ .query-text；model-response 内含 model-thoughts 思考过程 + message-content .markdown 正文 + 按钮「复制/Copy」；侧栏 [data-test-id="conversation"] jslog c_<id> 和 a[href] 两种；再做一个 /u/1/ 多账号样本）。用 devDependency 里能用的 DOM（若需要 jsdom/linkedom 请装 linkedom 或 jsdom 为 devDependency，免费 npm 包可以）在 node 里载入 shared.js + gemini.js 跑 extractMessages()/extractSidebar()，断言：角色正确、顺序正确、思考过程/「你说了/You said」/按钮文字不在内容里、/share/ 与 /app 不收、/u/1 前缀保留。把这个测试接进 npm run test:search（或新增 npm 脚本并让 test:search 一起跑）。为了能测，gemini.js 可以把纯函数挂到一个测试可取的地方（例如 globalThis.__chatseekGemini 仅在测试环境），但不要改变生产行为。
9. README.md 改四家（去掉「不做 Gemini」字眼），说明 Gemini 的限制。
10. notes/CHANGELOG-gemini.md（短 CHANGELOG）＋ notes/HANDOFF-gemini.md（交接：改了什么、怎么测、已知限制、最可能坏的选择器清单、/u/1 多账号前缀怎么处理、box 未登入未实测需老板实机）。

## 完成标准
- `npm run verify` 与 `npm run test:search` 都过（贴最后输出）。
- git commit 到 feat/gemini（清晰 message），不 push。
- 最后用中文简短回报：改了哪些文件、测试输出、你认为最可能坏的地方。
