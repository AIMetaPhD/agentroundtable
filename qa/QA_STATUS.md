# 独立 QA 正式报告 — v0.1.0 Mock 模式

日期：2026-11-23
结论：**【QA PASS】**

## 环境

| 项 | 值 |
|---|---|
| 工作目录 | `rc-20261120` |
| 端口 | `8836` |
| 数据目录 | 独立临时目录（与 `test_verify.py` 的临时目录分离） |
| Provider 模式 | `R2_PROVIDER_MOCK=1` |
| 共享文件 | `app/README.md` |
| 证据 | `qa/qa_mock_evidence.json` |

## 检查结果

| 检查项 | 状态 | 证据摘要 |
|---|---|---|
| 健康与 schema v3 | PASS | `ok=true`，`schema_version=3` |
| 未带 Token 访问 | PASS | `GET /api/state` → 401 |
| 多会议创建与隔离 | PASS | 新会议消息 0，旧会议消息 4 条保留 |
| 共享快照 SHA-256 | PASS | API 与本地 `sha256sum` 完全一致 |
| A→B→A 讨论 | PASS | `agent-a → agent-b → agent-a`，三条回复均回显同一哈希 |
| Mock 环境切换 | PASS | `codex-cli/openai` 与 `claude-code-cli/magpie` 在 `R2_PROVIDER_MOCK=1` 下均走 Mock |
| 显式 `provider=mock` | PASS | 定向消息得到 1 条回复并回显哈希 |
| 状态机/无死锁 | PASS | 轮转完成，worker 回到 idle |
| 无 403 / 429 | PASS | 全流程记录的状态码中没有 403/429 |
| 参会者错误 | PASS | `participant_errors=[]` |

## 执行方式

- 独立 QA subagent 在独立端口、独立数据目录执行黑盒 API 验收。
- 另运行 `python test_verify.py`，输出 `TEST VERIFY PASS`。
- QA 只写入 `qa/qa_mock_evidence.json`，未修改源码。

## 【QA PASS】

Mock 模式下认证、会议隔离、共享快照、A→B→A 轮转、显式 Mock Provider 和零网络阻断均通过。

## 附：真实 Provider 历史说明

2026-11-21 的独立 QA 曾因 QA 执行环境的 WorkBuddy 403 而中止；真实模式另有两个边界：Codex 会话被其他进程持有时返回 `thread-store conflict`，旧 WorkBuddy 模型返回 429。本版默认路由已改为 `group/openrouter`，并在 UI 标注占用会话；这些真实模式边界不影响本次 Mock 模式 QA PASS。
