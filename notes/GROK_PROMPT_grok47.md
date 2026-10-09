你是 Chatseek Chrome 扩展的主开发会话。工作目录固定：/workspace/saas-scout/chatseek

## 硬规则
- 模型已是 grok-4.7；禁止切到 build-fast / Fast / 低 effort
- 只改清单内问题与直接相关小修；不重写架构、不加新站、不做图片批量、不做官方导出导入、不上架
- Claude 本轮不硬测（账号仍可能 restricted）；勿为 Claude 解冻加临时 hack
- 改完必须：`npm run verify` 与 `npm run test:search` 都 ok
- 改动写进 README 或 notes/CHANGELOG-grok47.md（中文短条）
- 本目录 git 可 commit（清晰 message）；若 push origin/main 有权限就 push，没有就留下 commit

## 背景（已上线能力）
- 侧栏本地搜 ChatGPT / Claude / Grok 已打开过的聊天（IndexedDB，不代持 Key，不拦 fetch）
- 日期：有页面真实会话时间用真实；否则采集时间（commit e1ba652）
- 验收号语境：auraelement；Grok 既往关键词 musicmap

## 你要做的整包
1. 通读：manifest.json, background.js, content/{shared,chatgpt,claude,grok}.js, sidepanel/*, src/{db,tokenize}.js, scripts/*
2. 对照清单找真实问题（收聊天不稳、索引丢、搜索不准、日期错/空白、明显坏 UX），列优先级后改
3. 重点检查并必要时修：
   - 打开会话后消息是否可靠入库；reload 扩展后已索引是否还在
   - tokenize / 搜索：长短文、多词、大小写、跨会话
   - pageUpdatedAt / 真实日期解析（ChatGPT、Grok；Claude 逻辑保持但不阻塞）
   - 侧栏空态、加载失败、重复索引、竞态
4. 跑通 verify + test:search；若缺依赖用 npm 装齐（勿扩大 scope）
5. 结束后在 notes/HANDOFF-bd.md 写给商务拓展：改了什么、怎么在 box Load unpacked 复测（ChatGPT+Grok）、已知限制

开始干活。改完停，并打印：READY 与否、session 摘要、测试输出末行。
