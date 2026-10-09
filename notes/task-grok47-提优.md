# Chatseek Grok 4.7 提优任务卡（2026-09-23）

## 来源
商务拓展开工卡：`/workspace/bd-punkcan/开工卡-Chatseek-Grok47提优.md`
老板拍板 GO；$0；不上架。

## 工具
- Grok Builder CLI `grok`，**model = grok-4.7**（禁止 `grok-4.7-build-fast` / Fast）
- `default_reasoning_effort=high`
- **同一任务同一 session**（下方 session id；续作 `grok --resume <id>` 或本目录 `grok -c`）

## Session
- session id：`36b6d252-c610-45d8-811c-2a651db17f79`
- 标题：`chatseek-grok47-提优`

## 目标（只做清单内）
1. 收聊天稳、索引不丢、搜索准
2. 日期：有页面真实时间用真实，否则采集时间
3. 明显 bug／坏 UX 小修
4. `npm run verify` + `npm run test:search` 通过

## 不做
敞开重构、新站、图片批量、官方导出导入、上架计费、Claude 硬测

## READY
见开工卡 5 条；Claude 不阻塞。交回商务拓展：改了什么／怎么复测／已知限制。


## 执行结果（2026-09-23 CST）
- session：`36b6d252-c610-45d8-811c-2a651db17f79`
- commit：`1e1f1bb` 已 push `origin/main`
- `npm run verify` → verify ok
- `npm run test:search` → search-test ok
- HANDOFF：`notes/HANDOFF-bd.md`
- 产品侧：自动化 + 代码就绪；开工卡第 5 条（Load unpacked 实机收搜）交给商务拓展勾选后告老板。
