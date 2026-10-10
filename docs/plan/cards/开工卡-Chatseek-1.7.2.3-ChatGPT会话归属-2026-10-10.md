# 开工卡：Chatseek 1.7.2.3 ChatGPT 会话归属热修

用户报告：扩展 1.7.2.2，在 ChatGPT 网站切换会话后，扩展清单是 A，阅读页正文却来自 B。此前用户已授权修复、检查后合并；本次按同一缺陷继续修复。基准 main `d12025588ba89dac3c9b2e11230e2a66e50e035c`，分支 `fix/conversation-attribution`。

## 范围

1. 标准 Navigation API 的同步只读监听，在采集 debounce 前记录离开的 DOM，覆盖快速 pushState／replaceState／返回；发送期间 URL 往返也废弃旧快照。不改写网站 history／DOM。
2. 新节点不证明新会话。已知其他会话的整段正文、原生消息 ID，以及无原生 ID 消息的同角色长前缀都暂缓收录；弱 canonical／网站侧栏选中标记不授权。
3. 内容祖先 conversation ID 或当前 embedded mapping 精确正文证明允许真实同文会话／分支。支持同源 iframe 与 shadow 的祖先证明。
4. 后台 meta 有界保存已接受的正文／轮次指纹归属，跨脚本或 worker 重启不靠五秒到期重新放行；不保存额外正文、不升 DB。
5. 实际发送前核对正文、角色、原生 ID 和节点；不自动删除归属不明的既存历史。交接说明单项错配索引的用户恢复方法与证据边界。

## 验收

- 实际 adapter → background → IndexedDB 的正负例；真实 Chrome for Testing 对 selector／heuristic 的快速同步往返、重建旧正文、旧流式与混合 DOM 断言。
- verify、search、fixture、gemini、upgrade、sync、两项扩展 e2e、样例截图与 3000 阅读／3000 清单／500 图性能对照。
- 不同 Codex session 独立复审；最终提交再核对，按既有授权经 PR 合并。
- permissions 精确 sidePanel；host／matches／CSP 不变；运行时无网络、网站只读；DB 4，无依赖变动，$0。

未知首次注入的无标记旧 DOM、短于 40 字的无原生 ID 消息、前缀重写或归属缓存界外不宣称绝对识别。无证据的同前缀消息可能暂停，待明确页面证明／新正文。真实账号仍只由用户自己的 Chrome 验证。

交接：`notes/HANDOFF-1.7.2.3.md`。
