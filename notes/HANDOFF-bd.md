# 交给商务拓展：Chatseek 1.0.1 复测

开发会话：`36b6d252-c610-45d8-811c-2a651db17f79`（chatseek-grok47-提优）。本环境没有登录态 Chrome，**没有**代跑 auraelement 实机。自动化 `verify` 和 `test:search` 已过。开工卡第 5 条（box 上 Load unpacked 后收搜可复现）要你勾。

## 改了什么

- 版本 `1.0.0` → `1.0.1`。
- 打开过的聊天更不容易漏写：写入失败会重试，不会被「已经采过」卡住；同一页不会用旧消息覆盖新消息。
- 扩展 Reload **不会**清空 IndexedDB。连接断了会重开，侧栏不该再把库报错说成「索引丢了」。
- 搜索按整词：`musicmap` 应能中；`music` 不应误中 `musicmap`。多词要在同一条对话里。忽略大小写。
- 日期：页面上有精确时间用精确时间；只有 Today / Yesterday / Previous 7 Days 这类分组时，用分组（同一组会显示成同一个大约日期）；都没有再用采集时间。长列表不再只给前十几条填日期。
- Grok 消息在页面没标 role 时也会尽量入库。
- 侧栏：加载中、失败、清除失败、中文输入法，少闪空态。

细节短条：`notes/CHANGELOG-grok47.md`。

## 在 box 上怎么复测（ChatGPT + Grok）

1. 代码在 `/workspace/saas-scout/chatseek`（版本 1.0.2 或更新；1.0.2 的改动见 `notes/CHANGELOG-grok47.md`）。
2. Chrome 打开 `chrome://extensions` → 开发者模式 → 加载已解压的扩展程序 / Load unpacked → 选这个目录。已经装过的话点 **Reload**。
3. **刷新**已打开的 chatgpt.com 和 grok.com 标签页（Reload 扩展不会自动给旧页面换上新的内容脚本）。
4. 用验收号 **auraelement** 登录。
5. ChatGPT：打开若干已经有内容的会话（侧栏多划一点，让 Today / 更早的分组都出现）。再打开 Chatseek 侧栏：
   - 能搜到刚才打开过的聊天里的词。
   - 关掉侧栏再开、或 Reload 扩展后再开侧栏（网站页再刷新一次），刚才的索引还在。
   - 日期不是整栏空白。有分组的聊天应显示今天、昨天或一个日期，而不是全部挤在「刚刚」。悬停时间可看绝对日期。
6. Grok：同样打开若干会话。用既往关键词 **`musicmap`** 搜，应命中打开过且正文里出现过这个词的那条。再搜一个显然不存在的词，应是「没有匹配」而不是乱命中。
7. 不要测 Claude。账号可能仍是 `claude.ai/restricted`。本轮逻辑留着，但不阻塞。

## 已知限制

- 没在这个标签页里打开、也没滚动进侧栏的旧聊天，仍然搜不到。
- 很长的对话只索引**已经画在页面上**的消息。要多收，就在那条对话里往上滚，让更早的消息渲染出来。
- 分组日期是大约值（例如 Previous 7 Days 用区间中点），不是每条消息的精确修改时间。页面 JSON 里有精确 `update_time` 时会用精确的。
- 搜索是整词，不是词干。`music` 不会命中 `musicmap`。
- 不挂网络请求，不代持 Key，不能导入官方导出文件。
- 清除本地索引会删掉这台浏览器里 Chatseek 的 IndexedDB，网站上的聊天还在。
- 本轮没有上架，没有 Gemini / Perplexity / DeepSeek。

## 自动化（已跑）

```text
verify ok
search-test ok {
  longBody: 5633,
  stores: [ 'conversations', 'tokenMap' ],
  stats: { conversations: 3, messages: 5 },
  pageUpdatedAtPreserved: true
}
```
