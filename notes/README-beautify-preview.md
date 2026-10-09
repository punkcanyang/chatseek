# Chatseek README beautify — preview

## 改了什么
- Whole README 重排：Hero → 证明/形态 → 是什么 → 怎么用 → 限制 → 范围 → 开发
- 新增纯静态 SVG：`docs/readme-assets/hero.svg`、`flow.svg`
- 去掉本机绝对路径示例；保留 open-tab 限制与 v1.0.1／完整词匹配等事实
- 未改扩展功能代码；未 commit／push

## 预览怎么看
1. 用编辑器或 `glow`／VS Code Markdown 预览打开 `README.md`
2. 浏览器直接打开 `docs/readme-assets/*.svg`
3. 审计：`python3 ~/.grok/skills/beautify-github-readme/scripts/audit_readme.py /workspace/saas-scout/chatseek/README.md`

## 已知限制
- 无私有仓截图，hero 用示意侧栏（非真实 UI 截图）
- GitHub 暗色主题下 SVG 自带深底，对比度已按深底设计
- Grok session 卡住只读后由执行手按技能质量条手落
