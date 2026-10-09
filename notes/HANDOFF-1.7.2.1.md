# Chatseek 1.7.2.1 交接（熱修：SPA 切換串內文）

基準 main `213dde2`（1.7.2）。分支 `fix/spa-switch`。開工卡 `docs/plan/cards/开工卡-Chatseek-1.7.2.1-P0-SPA切換串內文-2026-10-09.md`。

## 進度

- [x] 2026-10-09 22:3x 開分支、開工卡、本檔（产品开发）
- [x] CodeWhale 寫碼 22:20 開工、22:24 依老闆改定中止（只讀檔，無改動）
- [ ] Codex 規劃＋寫碼 session `01a1210c-fb71-7843-8450-8ec2eb84558e`（gpt-6.1-sol high，非 Fast）
- [ ] Codex 複審（另開 session，gpt-6.1-sol high）
- [ ] 合 main

## 初步判讀（产品开发讀碼，待寫碼者用測試證實）

- `content/chatgpt.js` `messageIdFor`：沒有原生 `data-message-id` 的節點（真機選擇器全 0 → 走 heuristic）拿到 `chatgpt:<convId>:<hash>:dom<N>`，scope 帶新網址的 convId，所以 A 的殘留節點在 URL 換成 B 後拿到**新的** B 前綴 id。
- `content/shared.js` `runCapture` 的 SPA 防護只比 id 後綴（`state.lastMsgKeys`）；dom 序號 id 每次都不同，防護失效 → A 的內文以 B 的 id 寫入。
