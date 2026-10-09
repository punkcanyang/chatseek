# Chatseek 提优开工卡（2026-09-23）

老板拍板：用 Grok 4.7 按清单审核修改提优现有 Chatseek；禁止敞开改。

## 谁付钱／本阶段钱

自用提优。本阶段 $0。不上架、不计费、不碰商店订阅。

## 仓库

- 工作目录：`/workspace/saas-scout/chatseek`
- GitHub：https://github.com/punkcanyang/chatseek
- Origin 备份：`punkcan/tmp-776225bf719b1bf4`

## 工具（定死）

- 产品开发用 **Grok Builder（Grok 4.7）** 改仓
- **同一任务同一 session**
- **禁止 Fast**（Cursor／Grok Builder／Codex 一律）
- 商务拓展不写产品代码；READY 后由商务拓展在 box 浏览器 Reload unpacked 做收搜自测

## 做什么（只做清单内）

1. 用 Grok 4.7 审现有扩展：收聊天稳不稳、索引丢不丢、搜索准不准、日期显示、明显坏 UX／明显 bug
2. 只改清单内问题与直接相关的小修；不重写架构、不加新站、不做图片批量、不做导入官方导出、不上架
3. 本地 `npm run verify` 与 `npm run test:search` 通过后再交

## 不做

- 敞开「全面重构」或换皮新功能
- 新站点（Gemini 等）
- Claude 解冻前硬测 Claude 收搜（账号仍在 `claude.ai/restricted`；解冻后另叫一轮）
- 商店上架／月费／花钱资源

## 两周 $0 验收（READY 标准）

全部满足才算 READY，纯文档不算：

1. ChatGPT（测试号 auraelement）：打开若干会话后，侧栏能搜到已打开过的聊天关键词；不丢已索引条目
2. Grok（同测试号语境）：打开若干会话后，关键词搜索命中（既往示例：`musicmap`）
3. 日期：有页面真实会话时间则显示该时间；否则显示采集时间；不整栏空白或全是离谱假日期
4. `npm run verify` 与 `npm run test:search` 通过
5. box 上 Load unpacked／Reload 后，上述 1–3 可复现

Claude：本轮不阻塞 READY；解冻后商务拓展再叫一轮测。

## 交回

产品开发标 READY 后叫醒商务拓展（ee0fb700），附：改了什么、怎么复测、已知限制。商务拓展做浏览器收搜自测后再告老板。
