# Current Status — 2026-05-13

## 已完成
- [x] Auto mode 安全分类器（flash 快判）
- [x] 会话持久化（JSONL append-only，-r/-c resume）
- [x] 缺 API key 时的设置界面（粘贴即用）
- [x] 上下文窗口管理 + auto compaction（>80% 自动摘要历史，Footer 显示 ctx 占比）

## 下一步
- [ ] 网络韧性：429/5xx 重试、http_proxy 支持、connect/idle 超时分离
- [ ] 推理强度档位热切（off/low/high/max）
- [ ] Slash commands：/clear /compact /help

## 阻塞
- 无
