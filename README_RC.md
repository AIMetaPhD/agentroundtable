# Agent Roundtable Local Web App Release Candidate（2026-11-21）

## 交付内容

- `app/`：完整可运行源码与测试脚本（不包含任何运行时数据）。
- `USER_GUIDE.md`：中文用户指南。
- `start-rc.ps1`：一键启动脚本（端口 8820，数据目录 `data`）。
- `qa/`：独立 QA 报告与 Mock 模式证据（`QA_STATUS.md`、`qa_mock_evidence.json`）。
- `evidence/final/`：主 agent 修复后的真实 Provider 自验记录。
- `CHANGELOG_RC.md`：相对 R3 Branch B 的最小改动摘要。

## 相对 R3 Branch B 的改动

1. 多会议：schema v3；每场会议独立共享文件快照；结束后工作线程完成取消才允许新建；旧会议只读保留，可切换查看。
2. 会话列表：只读发现本机 Codex/Claude 历史会话；UI 下拉选择；拒绝未知 ID；标注“当前占用”的 Codex 会话；保留手动输入与真实 resume 校验。
3. 项目文件选择：Web UI 浏览项目根、加入新项目根、点击 `.md/.txt` 固定快照；路径白名单/2 MiB/后缀限制不变。
4. 可用性修复：
   - 默认 Claude 模型改为 `group/openrouter`（旧 `workbuddy/deepseek-v4.1-flash` 因 WorkBuddy 账号 429 不可用）。
   - Codex 会话被其他进程占用时，错误消息保留 `thread-store conflict` 原文，UI 标注“⚠ 当前占用”。
   - 邀请类型切换自动更新显示名/角色；`error` 状态 Agent 不再进入自动轮换。

## 启动

```powershell
cd <repository>
powershell -ExecutionPolicy Bypass -File .\start-rc.ps1
```

默认令牌从 `data/room-token.txt` 读取；首次启动会生成。打开脚本打印的带令牌 URL。

## 验证摘要

自验（非独立 QA）：state 25/25、dispatcher 24/24、HTTP 20/20、UI 14/14、RC API 22/22、RC UI 12/12、branch B 11/11、IME 4/4；真实 Provider A→B→A 讨论、共享 SHA 一致、Codex/Claude 历史会话 ID 连续均通过。

独立 QA 在 Mock 模式完成黑盒验收并签【QA PASS】；证据见 `qa/QA_STATUS.md` 与 `qa/qa_mock_evidence.json`。

## 发布

本轮未推送 GitHub。按新的交接约定，下一步应把本 RC 提交到 GitHub 私有库并打版本标签，再由 ChatGPT 与人类按同一 commit 验收；需要用户指定私有库与授权后才能执行。
