# RC 改动摘要（相对 R3 Branch B，2026-11-20）

## P0：会议可重复使用

- `db.js` 升到 schema v3：保留所有旧 room；participants 复合主键 `(room_id,id)`；每场会议独立共享文件快照与 `SOURCE.json`。
- 新 API：`GET /api/rooms`、`POST /api/rooms`、`POST /api/rooms/:id/select`。
- UI 顶部增加会议下拉、“新建会议”；结束后按钮才可用；旧会议可切换查看。
- 结束时等待当前工作线程完成取消（最多 3 秒）才返回，新建会议不会撞上旧回合；启动恢复会取消 ended 会议遗留的 round jobs。

## P0：已有 Agent 会话方便接入

- 新增 `sessions.js`：只读枚举 Codex rollout 与 Claude Code session JSONL 的元数据；不读取凭据，不修改文件。
- 新 API `GET /api/sessions?provider=codex|claude`；UI “列出已有会话”下拉选择并自动填 ID。
- 手动 ID 仍可用，但必须在真实本机会话索引中存在；原生 `--resume` 和 session mismatch 守卫不变。
- 明确边界：恢复历史会话，不接管当前运行的原生进程；子 Agent 不参与独立会话列表。

## P1：真实项目共享更方便

- 新增 `GET /api/projects`、`POST /api/projects/roots`、`GET /api/projects/browse`；项目根持久化到 `data/projects.json`。
- UI 可浏览目录、加入新项目根、点击 `.md/.txt` 固定快照；也保留手动输入路径。
- 路径白名单、2 MiB 限制、后缀限制、快照 SHA-256、`SOURCE.json`、同一版本喂给两位 Agent 均保留。

## 试用反馈修复与可用性

- 邀请类型切换时自动把显示名/角色改成 Codex / Claude Code / 子 Agent，不再三个都叫“Codex 负责人”。
- `eligibleAgents()` 排除 `error` 状态，失败 Agent 不再进入轮换；“三方接龙”实验性标注。
- 默认 Claude 模型从 `workbuddy/deepseek-v4.1-flash` 改为 `group/openrouter`：前者实测返回 429（WorkBuddy 免费模型仍需 credit package），后者在本机 MagPie 可直接用。
- Codex 历史会话若仍被其他进程持有，列表标注“⚠ 当前占用”，错误消息保留 `thread-store conflict` 原文；不尝试绕过原生 writer 锁。
- 讨论消息 `meta` 记录 `shared_sha256` / `shared_source_sha256`，便于核对两位 Agent 是否消费同一版本。
- 独立 8820 端口和数据目录，不覆盖现有试用数据。

## 未改

- 状态机核心语义、真实 Provider 适配器、批准/任务保护、暂停/恢复、TTS/STT、ASR 模型均未重构；CCCC 仅保留既有对照结论；未发布 GitHub。
