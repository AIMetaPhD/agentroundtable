# HANDOFF — Agent Roundtable RC（Claud，2026-11-21）

## 版本

- 标签：`v0.1.0-rc.1`
- 提交：以该标签指向的 commit 为准（`git rev-parse v0.1.0-rc.1`）
- 分支：`main`
- 基线：R3 Branch B（旧会话 ID + 共享文件快照 + 定向投递）

## 本版完成

1. 多会议：schema v3；旧会议保留只读；新建会议不会触发旧任务；结束等待 worker 取消完成。
2. 已有会话列表：只读发现 Codex/Claude 历史会话；UI 选择；未知 ID 拒绝；真实 resume 与 session ID 一致性校验。
3. 项目文件选择：UI 浏览已授权项目根、加入新项目根、点击 `.md/.txt` 固定快照；保留路径白名单、2 MiB、SHA-256。
4. 可用性：默认 Claude 路由改为 `group/openrouter`（旧 WorkBuddy 模型 429）；Codex 占用会话标注“⚠ 当前占用”；失败 Agent 不进入轮换。

## 验证

- 自验：state 25/25、dispatcher 24/24、HTTP 20/20、UI 14/14、RC API 22/22、RC UI 13/13、branch B 11/11、IME 4/4。
- 真实 Provider：Codex→Claude→Codex 通过；共享 sha256 一致；Codex/Claude 历史会话 ID 连续。
- 独立 QA：**PASS**（Mock 模式黑盒，11/11）；证据见 `qa/QA_STATUS.md` 与 `qa/qa_mock_evidence.json`。

## 已知边界

- 不能接管正在被其他进程持有的 Codex 会话（`thread-store conflict`），只提示并拒绝绕过。
- 不能向正在运行的原生进程注入消息。
- Claude 走本机 MagPie 网关，不是 Anthropic 云端 Claude。
- 未在真实试用数据上重放。

## 下一步

1. 人类按同一 commit/tag 做浏览器试用，重点看：新建会议、历史会话选择、项目文件选择、两位 Agent 是否自动接话。
2. 试用反馈进入下一版；真实模式需在不受 WorkBuddy 403 影响的环境另行复验。
3. 论文/实验结果仍按 Paper-first 流程，在对应私有库维护；本仓库只承载此 App 的代码、验收与交接。
