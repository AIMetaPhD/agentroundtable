# Agent Roundtable RC（2026-11-20）中文用户指南

## 启动

要求：Windows 11、Node.js 24（内置 `node:sqlite`）、已登录的 Codex CLI、本机 MagPie 网关。

```powershell
cd <repository>\app
$env:R2_PORT = "8820"
$env:R2_HUMAN_TOKEN = "<your-token>"
$env:R2_DATA_DIR = "<repository>\data"
$env:R2_CC_MODEL = "group/openrouter"
node server.js
```

浏览器打开：`http://127.0.0.1:8820/#token=<your-token>`

服务只监听 `127.0.0.1`。令牌也在 `data/room-token.txt`。该端口与数据目录独立于其他正在运行的实例。

## 选择已有 Codex / Claude Code 会话

1. 右侧“邀请真实 Agent”选择类型（Codex CLI 或 Claude Code CLI）。显示名会自动改成对应名字。
2. 点“列出已有会话”。列表只读发现本机会话元数据：Codex 来自 `$CODEX_HOME/sessions`，Claude Code 来自 `$HOME/.claude/projects`。不会修改会话文件、不读取凭据、不复制聊天内容。
3. 选择一条会话；下拉会把 ID 自动填入“手动填写会话 ID”。也可以手动输入兼容的 ID，但服务器只在真实本机索引中存在时才接受。
4. 点“邀请”。首次发言时才真正 `--resume`；如果返回的原生 session ID 与邀请 ID 不一致，房间会拦截并报错，不会冒充恢复。
5. 边界：这是“恢复历史会话”，不是“接管当前正在运行的原生进程”。本实现不会向另一个正在运行的进程注入消息。若该会话仍被 Codex/Claude 原生进程占用，CLI 可能报 `already has an active writer` 等冲突；此时换一个已结束的历史会话或留空新建，不要改全局配置。子 Agent 跟随父进程，不使用独立会话列表。

## 选择真实项目文件

1. 右侧“共享文件（只读快照）”：从“项目根”下拉选目录，或者在目录浏览器点击文件夹进入。
2. 想加入新的项目根目录：进入该目录后点“把当前目录设为项目根”，之后无需改环境变量。
3. 点击 `.md` / `.txt` 文件即可固定只读快照。也可以在输入框直接输入路径后点“选择快照”。
4. 服务器限制：路径必须在已授权项目根内、文件必须存在、后缀为 `.md/.markdown/.txt`、大小不超过 2 MiB；生成快照 SHA-256 并记录 `SOURCE.json`。两位 Agent 的 prompt 使用同一份快照和哈希。
5. 讨论默认只读，不会修改真实项目。要执行写入必须走“批准并执行任务”，并且只能改 `data/sandbox/` 里已存在的文件。

## 开始讨论

1. 邀请 Codex 和 Claude Code 后，在左侧文本框输入问题。豆包语音输入法可直接输入中英混合；Enter 不会发送，Ctrl+Enter 或“发送”按钮才发送。
2. “本轮模式”：单答自动轮换；“两位都回答”是 Codex→Claude→Codex；“三方接龙”按顺序接龙。收件人下拉可定向 `@agent`。
3. 用“暂停 / 继续 / 结束”控制会议。暂停时消息排队，继续后自动处理。结束后不能再发言；工作线程先完成取消再允许新建下一场，防止旧回合写入新会议。
4. 每场会议有自己的共享文件快照、消息、参会者和批准。顶部“会议”下拉可查看旧会议；旧记录只读保留。

## 新建下一场会议

1. 点当前会议的“结束”，确认顶部状态变成 `ended`、发送按钮禁用。
2. 点“新建会议”，可输入名称。新会议自动激活、对话为空、共享文件是独立的草稿。
3. 旧会议可在“会议”下拉中切换查看；切换不会恢复旧任务，也不会把旧回合派到新会议。

## 已知边界

- Claude Code CLI 走本机 MagPie 网关，默认路由 `group/openrouter`（免费 OpenRouter 组），不是 Anthropic 云端 Claude。
- 内置 SAPI ASR 对中英混说不可靠；建议用豆包输入法并把转写放进文本框人工核对。
- Claude Code 子 Agent 是实验性第三方参会者；如果 handback 校验失败会报 `subagent_not_verified`，此时移除它，改用 Codex + Claude Code CLI。
- 本轮没有发布 GitHub，没有修改全局配置，也没有重新优化 ASR。
