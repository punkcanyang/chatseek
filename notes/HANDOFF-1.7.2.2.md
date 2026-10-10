# Chatseek 1.7.2.2 — 收录完整性修复交接

2026-10-10 UTC。用户先授权修复，再明确要求“检查后合并”。实作起点 `fbe7b2d33173947d5c21422bbae81bc804f3859c`（1.7.2.1）；合并前已快进到远端 main `a11aa7b7e06f003be58b6c03d5f3eaba9b87ac1d` 的公开仓库文档决议，产品基准完全相同。工作分支 `fix/capture-integrity`。最终 PR、提交与合并 SHA 记录在 PR 说明中。

**状态：完整离线测试、Chrome for Testing 两项扩展 e2e、样例截图、性能对照及独立代码复审已通过。按用户授权经 PR 合入 main，不发布 Chrome Web Store。**

## 根因及修复

审查先用旧版真实 adapter、background 和 IndexedDB 重现：最初 12 项收录完整性回归在 1.7.2.1 全部失败，原有 verify／search／fixture 未覆盖这些情况。

1. `planCloneDrops` 只凭整段正文重复推定污染，部分窗口可删除正常的另一组原生轮次及图片。现在只在身份已验、完整单批快照下规划清理，还要求对应轮次共享非空 turnId；删除对象必须精确匹配备用 ID 格式。缺证据和原生轮次均保留，也避免部分窗口无必要地读取全串来规划重复清理。
2. `alignRekeyedTurns` 按窗口位置与前缀合并，未验证角色或轮次。现在要求同角色且无原生 turn 冲突；增长／缩短还须共享 turnId，或备用 ID 的完整页面／相邻稳定锚点证据。fragment 抑制也要求同角色、同非空 turnId。正例证明流式更新与原图片仍存一条；不同轮次、用户提问与引用它的助手回答均独立保存。
3. Claude、Grok、Gemini 未传页面身份验证，只靠过期五秒 hash 门会把旧 DOM 写入新 URL。四家现在每次提取都在首次 await 前记录当前节点，提取后和每批发送前核对 href、页面标记、节点归属。held 混合页面也成为后续切换的残留基线；返回已接受页面另用基线节点验证。Claude／Grok 日期 JSON 缓存同时按 href 失效，Grok 标记按其解析器统一大小写。
4. Claude／Grok 的备用 ID 来自角色＋前 180 字，同前缀消息互相覆盖。现在每个节点在当前会话／角色范围内持有 ID，用完整初始正文 hash、session salt、序号区分；正文变化不改 ID。原生 ID 晚出现沿用该节点已分配身份，之后若原生 ID 再变化则识别为另一轮次。
5. ChatGPT heuristic 以正文＋角色排重，正常重复提问丢失；多个块共用外层 article 也会共用 ID。现在按选中的块节点排重，并以该块作为备用身份宿主。原 fixture 中两个相同正文的用户块现在都保留，cookie／composer／footer 等排除断言不变。
6. 复审发现同一归属问题延伸到异步图片队列。现在冻结排队时的 href、正文、图节点和来源属性（含 picture sources），在采集、load 回调和编码后的实际发送处重新验证。过滤必须早于图片占有，旧 job 不能抢占后来出现的 B 图。不保存或发送图片来源指纹／网址，它们只留在内容脚本临时内存。

## 最终验证

在最终产品修改上执行，使用已有 node_modules，无安装依赖、真实账号或外部页面。

| 检查 | 结果 |
| --- | --- |
| `npm run verify` | exit 0；权限／网络／DOM 守门、ChatGPT fixture |
| `npm run test:search` | exit 0；搜索、活动、阅读、Markdown 攻击、图片、同步、SPA 等全部；含新增 22 项 capture-integrity 与 6 项 image-integrity |
| `npm run test:fixture`、`test:gemini` | 均 exit 0 |
| `npm run test:upgrade`、`test:sync` | 均 exit 0；DB 升级与 3000 行／500 图迁移断言通过 |
| `npm run test:integrity` | 新增测试逐项通过；正常流式与图片 load 正例同时验证 |
| `git diff --check`、两支 e2e 脚本语法检查 | exit 0 |
| manifest 深度对比、lock 与 DB 检查 | 只有 version 改为 1.7.2.2；permissions 精确 sidePanel，host／matches／CSP 完全相同；DB 4、无新依赖 |
| `test:e2e`、`test:e2e-sync` | 最终正式 npm 命令均 exit 0；Chrome for Testing 155.0.8059.39，真实加载扩展。selector／heuristic SPA 的 A/B/C、延迟 DOM、返回，以及图片、阅读、活动时间和手动同步原断言全部通过 |
| 样例截图 | `screenshot-panel.mjs` 实跑 exit 0；`docs/panel-1.7.2.2-sample.png` 为样例 UI。正式扩展 e2e 另生成 `panel-1.7.2.2-spa.png`、`reader-1.7.2.2-spa-A.png`、`reader-1.7.2.2-spa-B.png`，已独立检查归属及数据去识别化 |

最初本机 Chromium 151 的 `/etc/chromium/policies/managed` 有 `ExtensionInstallBlocklist: ["*"]`，两项 e2e 无法加载扩展；这项失败已由最终 Chrome for Testing 实测补齐。专用浏览器从官方 Chrome for Testing 清单／storage.googleapis.com 下载到临时 `work/`，新配置不使用任何真实账号，未修改系统 Chromium 管理策略。

测试环境代理让模拟域名产生 `ERR_TUNNEL_CONNECTION_FAILED`；两支 e2e 的浏览器启动增加 `--no-proxy-server`，让既有 localhost resolver 映射直连本机。ChatGPT 脚本原加载日志硬编码 1.7.2.1，现精确核对 manifest.version，并按它命名本版 SPA 截图；verify 仍锁定 1.7.2.2，其余断言未改。最终运行无临时 loader：

```bash
DISPLAY=:81 CHROME_PATH=/workspace/chatseek/work/chrome-for-testing/chrome-linux64/chrome npm run test:e2e
DISPLAY=:81 CHROME_PATH=/workspace/chatseek/work/chrome-for-testing/chrome-linux64/chrome npm run test:e2e-sync
```

两项正式 e2e 确实加载扩展，模拟站点来自本机 HTTPS fixture；`panel-1.7.2.2-sample.png` 单独属于原截图脚本的 Chrome API mock，不能作为真实网站验证。旧版截图试跑产生的覆盖已恢复，不提交到本版。

独立复审：另一个 Codex session `/root/review_capture_integrity`，与实现 session 分开，继承当前 Codex 模型；未调用指定的 Opus／Grok 模型。审查及 16 组独立 adapter／IndexedDB 对抗样例通过，另验证 heuristic 共同祖先、growth／clone 正负例、图像回退、有效 B 图保留、正常待加载 → load → WebP。结论 **PASS：无剩余可复现代码阻挡**。合并前再次复跑 verify／28 项正式完整性回归、核对产品文件 hash，检查两项 e2e 小调整、本版真实扩展截图和开发 session 的最终 e2e 证据。复审未改产品代码、提交或联网；最终确切提交的合并结论同步记录在 PR 说明。

运行时依旧只读网站、无网络请求、不加权限；花费 $0。新测试不是放宽 verify，仅同步其精确版本断言。

## 性能对照

同机 Chromium 151，无头、新临时配置、本机样例 HTTP 页面；基准是 `git archive fbe7b2d` 的文件副本，使用同一 node_modules、同一脚本。每端三轮，表中为中位统计；不是扩展加载测试。

| 样例／指标 | 基准 1.7.2.1 | 修复 1.7.2.2 |
| --- | --- | --- |
| 阅读页 3000 条：挂载 | 112 ms | 109 ms |
| 阅读页：跳转／滚动 p95 | 4.36／8.2 ms | 4.38／5.6 ms |
| 侧栏 3000 条（虚拟化同时挂载 80）：打开 | 153 ms | 158 ms |
| 侧栏：滚动 p95 | 1 ms | 1 ms |
| 图片页 500 图：打开 | 44 ms | 43 ms |
| 图片页：滚动 p95 | 6.0 ms | 4.7 ms |

侧栏首轮与其他重负载任务同时运行，打开 224 → 634 ms、滚动 p95 2 → 9 ms；未据此声称无回退。所有其他任务结束后单独反向顺序复测，三轮分别为修复 218／158／149 ms、基准 147／153／156 ms，表中列此复测。初轮大差异没有在独立复测中持续；这些有限样本不证明统计上无差异。阅读页、侧栏、image-grid 渲染代码没有修改。

## 用户自己的 Chrome 验证（≤6 步）

1. 更新原扩展目录的文件，保持原路径及扩展 ID，在 `chrome://extensions` 重新加载 Chatseek，确认 1.7.2.2；不要移除扩展或清空索引。然后刷新已打开的四家会话分页面。
2. 在 ChatGPT 发两次相同提问，侧栏阅读页应能保留两轮；让助手引用提问开头，原提问不得被改为助手回答。
3. 在 Claude／Grok 打开同前缀但后文不同的两条消息，待回复流式完成，阅读页应各存一条，连续增长不多存。
4. 各平台在 A／B 会话间快速切换、等待超过五秒、返回；侧栏阅读页分别应只有各自正文。混合 DOM 暂停期间等待页面重绘。
5. 对有图片的会话切换并返回，缩略图只属于对应消息；正常加载后的图可缓存或显示原网站限制的佔位。
6. 打开长对话并滚动使历史 DOM 离开画面，已收录历史轮次和缩略图不应因局部窗口重新采集消失。

## 限制与后续发布门槛

- 已被旧版本删除的消息／图无法从本机凭空恢复，需重新打开原会话，让网站重新呈现后采集。
- 没有稳定身份或完整证据的历史重复条目保留；这次不做无证据的破坏性清理。
- 网站长期复用旧节点、页面标记冲突或图片来源中途变化时可能暂停采集，待安全的下一轮／刷新；无原生身份且正文被重写到无法对齐时可能留下额外历史条目。
- 未登入四家真实网站；Chrome for Testing 覆盖本机样例，真实网站改版后的选择器与账号场景仍由用户在自己的 Chrome 验证。
