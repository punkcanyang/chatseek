# Chatseek 1.7.2.3 — ChatGPT 清单与正文错配热修

2026-10-10 UTC。用户明确确认平台 ChatGPT、扩展版本 1.7.2.2，以及“网站切换会话后打开扩展阅读页”的触发方式。此前“修复、检查后合并”的授权继续适用于本次同一缺陷；不发布商店。基准 main `d12025588ba89dac3c9b2e11230e2a66e50e035c`，分支 `fix/conversation-attribution`。

## 根因与证据

清单点击闭包传对应 conv.id，阅读页按 parsed.id 查询 IndexedDB 的精确 conversationId 索引；没有发现这段 UI 把 A 点击发成 B 的复现。采集层却可把 B 的正文写进 A，因而读到错配。

独立样例在 1.7.2.2 复现：快速 A → B → A 完成于 800 ms debounce／1200 ms URL poll 之间，最后 URL 和旧 baseline 相同，B DOM 没被识别；旧正文被 React remount 成新节点后被视为安全，五秒 hash 到期就放行。发送前仅核对 URL 和 isConnected 也不能识别同 URL 正文／原生 ID／角色改写。

复审补出整段 hash 的不足：重建旧消息追加流式 token，或在一条旧 A 轮次旁新增 B 轮次，hash 都会改变。原生 ID 和无原生 ID 两种路径均已独立复现，均纳入新回归。主要负例跑真实旧版 adapter／background／DB，确实观察到错误会话新增了正文；不是只断言新函数存在。

## 修复

- ChatGPT 只监听标准 navigate／currententrychange；navigate 在 URL 改变前读取离开屏幕，记节点和已接受的归属，epoch 废弃跨导航 await 快照。既不 patch history，也不点网页按钮。首次未知观察不因离开页面就登记为 accepted owner；pending 旧节点不覆盖其第一归属。没有 Navigation API 时保留 popstate／旧 URL 检查，但不宣称等价覆盖。
- 本地 transcript、native turn、正文长前缀 owner 有界保存，不按五秒时间授权。原生 ID 逐条检查；fallback 才检查同角色 40／80／160 字前缀。真实不同 native ID 的同文提示不会因 fallback 前缀门而被阻挡。synthetic 检测完整锚定 ID 格式，额外 colon 的原生 ID 保留。
- DOM 消息祖先的 data-conversation-id 或 embedded mapping 的当前祖先链正文精确匹配，才是允许同文／共享原生 ID 分支的内容证据。canonical／侧栏选中链接仅用于冲突检查。祖先检查跨 shadow host 与可读同源 iframe。
- 实际发送前重新提取并比较 body、role、ID、节点，已排队图片继续调用同一身份检查。
- background 转发 guardTranscript／ownershipVerified，DB 写前和写事务内重复检查。meta 保存 512 个 transcript owner、2048 个 native owner、2048 个正文前缀 owner，字段只含指纹／消息键／会话 ID；没有复制正文到新元数据。内容脚本三个 key map 分别最多 256／2048／2048 项，每 key 最多 16 个 owner，节点只用弱引用。没有新删除／迁移路径。

## 验证状态

14 组正式新增归属回归加入 test:search／test:spa／test:integrity。独立 Codex session `/root/review_conversation_mismatch` 另跑 6 组正例：正常 fallback 流式仍一行、重启后 fallback prefix 拦截、短提示与不同答复、新角色正文、明确归属分支、含多 colon 的不同 native ID。代码复审 PASS；最终提交、完整检查和合并 SHA 以 PR 说明为准。

| 最终检查 | 结果 |
| --- | --- |
| verify、test:search | exit 0；原有守门及所有原回归保留，新增 14 组亦通过 |
| test:fixture、test:gemini、test:upgrade、test:sync | 均 exit 0；包含升级与 3000 行／500 图迁移保护 |
| test:e2e、test:e2e-sync | 均 exit 0；官方 Chrome for Testing 155.0.8059.39 加载真实扩展，只访问本机 HTTPS fixtures |
| screenshot | exit 0；原脚本由临时 loader 选择已下载的 CfT，Chrome API mock，仅表示样例 UI |
| diff --check、脚本语法、manifest／lock／UI 对比 | 通过；manifest 仅 version 不同；lock、reader／sidepanel／image-grid 无改动 |
| 独立复审 | 另一个 Codex session，14 组正式与 6 组独立正例通过；不是 Opus／Grok，最终 SHA 结论见 PR |

增强 e2e 增加同步 push/replace 同 URL 往返、重建旧正文等候 6.5 秒、重建旧流式、重建混合消息的负断言；其余阅读／图片／活动／同步断言保留。静态 fixtures 原先大量重用 u1/a1 与相同样例正文，现提供正确内容祖先证明以表达真实独立会话；专用 SPA fixtures 不提供强归属证明，selector 与 heuristic 的样例开头分开。强内容证明允许同文独立会话的两项正式正例继续保留。旧测试把“无标记同文 remount 等五秒”视为可收录，这正是已重现漏洞；现改为先证明持续 hold，再用消息祖先 ID 验证真实同文会话可放行，没有减少 verify 守门。

本版真实扩展截图：docs/panel-1.7.2.3-spa.png、reader-1.7.2.3-spa-A.png、reader-1.7.2.3-spa-B.png；样例 mock UI 为 panel-1.7.2.3-sample.png。独立检查均为人工样例，A 为 maple／tea garden，B 为 ocean／silver moon。测试产生的旧版本截图覆盖全部恢复，只提交本版四张。

正式 e2e 不使用 loader：`DISPLAY=:81 CHROME_PATH=/workspace/chatseek/work/chrome-for-testing/chrome-linux64/chrome npm run test:e2e` 与 `npm run test:e2e-sync`。测试环境下的 gap／rest 缩短只来自原环境参数，生产同步间隔仍由 verify 锁定。

性能对照基准为 main `d120255`，两个版本用同一系统 Chromium 151、本机样例，各三轮中位数，串行运行：

| 样例 | 1.7.2.2 | 1.7.2.3 |
| --- | --- | --- |
| 阅读页 3000 则挂载 | 78 ms | 76 ms |
| 阅读页捲动 p95 | 5.5 ms | 4.8 ms |
| 清单 3000 条打开 | 166 ms | 157 ms |
| 清单捲动 p95 | 1 ms | 1 ms |
| 500 张缩略图打开 | 41 ms | 45 ms |
| 图片捲动 p95 | 2.5 ms | 2.9 ms |

阅读／清单／图片 UI 源码未改；样例没有观察到明显性能退化。图片差异为打开 4 ms、捲动 0.4 ms，小样本不声称统计等价，也不以 UI 性能样例声称已量化导航同步快照开销。

运行时网站只读、无网络请求；permissions 仍精确 sidePanel，host／matches／CSP 不改，DB 4、无新依赖、$0。未登录任何真实账号；所有截图为本机人工样例。

## 用户自己的 Chrome 验证（5 步）

1. 保持原扩展目录和 ID，更新文件，在 chrome://extensions 重新加载并确认 1.7.2.3；刷新 ChatGPT 页面。
2. 打开 A 后切换 B，等待收录，分别打开扩展阅读页，核对两段正文。
3. 快速 A → B → A、返回／前进，再分别核对正文；流式增长应就地更新。
4. 若某条清单在旧版已经存错，确认对应网站原会话后，仅对这条使用“从索引移除”，再打开并刷新对应网站会话重新采集。这个动作移除本机该条历史和缩略图；不删除网站会话。重新打开有消息时可解除单项 removed tombstone。不要清空全库。
5. 检查这些会话图片与正文对应，其他已收录会话仍在。

## 边界

- 新守门拦已复现的新增错配，不能可靠猜测既存正文的真正归属；刷新／重新抓取可能追加正确消息，但不会自动清掉旧错文。
- 首次注入就处于 URL=A／从未观察的 B DOM，且没有内容归属标记，无法单凭 URL／正文稳定证明来源。缺原生 ID 的 <40 字、正文前缀被重写、owner 有界淘汰亦没有绝对保障。
- 无原生 ID 且同角色前 40 字重复的新会话可能暂缓采集，等待明确内容归属或不同的新正文；强证明允许正常同文分支。这是保守门槛，不把暂停说成完整收录。
- 所有样例为本机模拟站点；真实 ChatGPT 改版／账号场景仍由用户自己的 Chrome 验证，其他平台沿用 1.7.2.2 的保护，本热修没有宣称解决四平台全部未证明首屏。
