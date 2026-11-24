# Agent Roundtable R2/R3 — 本地会议室（可运行版）

> RC 2026-11-20：本目录相对 R3 Branch B 新增多会议、已有会话列表、Web 项目文件浏览器。请以 `../README_RC.md` 和 `../USER_GUIDE.md` 为准；下文是基础架构说明。

这是 R2/R3 的本地 Web App 实现。它把真实 Codex CLI、本机 Claude Code CLI（MagPie 网关）和 Claude Code 原生 subagent 放进同一个本地房间：人类只发一次消息，房间按确定性规则自动派单，Agent 的原生会话与模型原文回帖，不需要人工复制粘贴。

> 真实身份说明：Codex 走本机 ChatGPT 登录；Claude Code 走 `ANTHROPIC_BASE_URL=http://127.0.0.1:3425`（本机 MagPie），默认上游路由是 `group/openrouter`（原 `workbuddy/deepseek-v4.1-flash` 因 429 credit package 不可用），**不是** Anthropic 云端 Claude。UI 与文档都按这个事实标注。

## 离线 Mock 模式

设置 `R2_PROVIDER_MOCK=1` 后，所有参会者都由确定性的 `MockProvider` 提供回复：它会从 prompt 中提取共享快照的 SHA-256 并回显。该模式不需要 Codex/Claude/MagPie，也不需要网络，适合演示与自动化验收。

```powershell
$env:R2_PROVIDER_MOCK = "1"
node server.js
```

也可在仓库根目录运行 `npm run start:mock` 或 `python test_verify.py`。

## 启动

要求：Windows 11、Node.js 24（用到内置 `node:sqlite`）、PowerShell 5.1（SAPI 语音）、已登录的 Codex CLI、本机 MagPie 网关。

```bash
cd <repository>/app
set R2_HUMAN_TOKEN=请换成一个随机长令牌
node server.js
```

PowerShell 写法：

```powershell
cd <repository>\app
$env:R2_HUMAN_TOKEN = "请换成一个随机长令牌"
node server.js
```

打开 `http://127.0.0.1:8810`，输入同一个令牌（首次会提示；之后存 localStorage）。令牌也会写到 `data/room-token.txt`。服务只绑定 `127.0.0.1`，没有公网监听。

演示快捷方式：`app/start-demo.ps1` 默认使用 8810 端口，已设置 `R2_PORT` 时沿用；未设置 `R2_HUMAN_TOKEN` 时生成随机令牌并写入 `data/room-token.txt`。打开 `http://127.0.0.1:8810`，从该文件复制令牌；也可用 `http://127.0.0.1:8810/#token=<token>`，页面会把 hash 中的令牌写入 localStorage 并从地址栏移除。

若未设置 `R2_HUMAN_TOKEN`，服务会随机生成令牌并写入 `data/room-token.txt`；重启会生成新令牌（同一数据目录的旧令牌失效）。

## 房间行为

- 人类是唯一能发 `POST /api/messages` 的身份；Agent 只能通过适配器回帖，不能冒充人类。
- **默认每次人类发言只由一位 Agent 回答**，按游标在参会者间轮换，避免一个问题被多人重复抢答。可选“两位都回答”进入 A→B→A（最多 2 位、3 跳）；“三方接龙”进入 Codex→Claude→子 Agent→Codex（最多 3 位、4 跳），每跳严格串行，后一位的输入包含前一位的回复。
- Agent 讨论默认走原生只读边界：Codex `-s read-only`；Claude Code `--permission-mode dontAsk`。
- 共享文件是 `data/shared/DISCUSSION.md`；每次派单把同一份内容与 SHA-256 放进 prompt，Agent 不直接读本地路径。
- 暂停会阻止新一轮派单；结束会关闭 SSE，之后消息 410、控制 409。
- 重复 `client_id` 幂等，不会重复入队或重复执行。

## 旧会话与真实项目文件（R3 Replan）

- **接入已有原生会话**：邀请时可选 `session_id`（Codex thread ID / Claude session UUID）。首次 turn 直接 `--resume`，不是 fork、摘要或新建会话。UI 在“邀请真实 Agent”里有输入框。
- **固定真实项目文件快照**：`POST /api/shared/select` 选择项目根目录内的 `.md/.txt`（默认根为 `app/..`，可用 `R2_SHARED_ROOTS` 分号分隔扩展），原子写入 `data/shared/DISCUSSION.md` 和 `SOURCE.json`；两位 Agent 的 prompt 使用同一份 `sha256`。UI“共享文件”有路径输入和“选择快照”。
- **定向投递**：`POST /api/messages` 可带 `target`（participant id）；UI“收件人”下拉可选自动轮换或 `@agent`，避免默认轮换答错对象。
- 文字优先：外部听写（如豆包输入法）直接输入文本框；Enter 不发送，Ctrl+Enter 才发送，不会打断中文输入法组合。
- 邀请顺序按 `created_at, rowid` 排序；同毫秒邀请不会因 id 字典序改变发言顺序。

## 批准与写入

1. UI 从 `/api/files` 读取 `sandbox/` 下的真实文件与基线 SHA-256。
2. `POST /api/approvals` 绑定 `task_id`、`scope`、`baseline_sha256`，状态为 `active`。
3. `POST /api/tasks` 再次核对 scope 与基线，随后把批准一次性标记为 `consumed`，再启动执行。
4. scope 必须是 `data/sandbox/` 下已存在文件；`sandbox/../shared/...` 这类路径会被拒绝。
5. 外部修改导致基线不符时批准返回 409；重复执行、撤销后执行、结束后执行同样被拒绝。
6. 执行前对 `data/sandbox` 做快照，执行后由适配器 `scope-guard.js` 恢复/删除 scope 外的改动；批准文件本身的改动保留。
7. 执行使用**新的原生会话**：Codex `-s workspace-write`，Claude Code `acceptEdits`。原因是 `codex exec resume` 会沿用原 thread 的只读 sandbox，带 `-s` 也不生效；讨论会话的 `session_id` 不会被执行会话替换，但任务本身不共享讨论上下文。这是当前实现的明确限制。
8. 批准有默认 15 分钟 TTL（`R2_APPROVAL_TTL_MS`），`active → consumed/revoked/invalidated/expired` 由 `state.js` 的转移表守卫；终态不能再次消费或撤销。UI 有“撤销”按钮。
9. 一次批准只对应一个任务；`steps_allowed` 固定为 1，不再显示虚假的 `1/2` 多步状态。
10. 任务有独立 `tasks` 表（queued/running/completed/failed/cancelled/orphaned）和持久化 `jobs` 队列；讨论回合与任务由同一个 worker 串行执行，不能并发写同一 sandbox 文件。
11. 暂停会中止当前回合并把未完成 hop 重新入队；继续时 drain。结束会中止当前任务、取消队列，并在 `finally` 中执行 scope guard；任务消息会记录 `cancelled` 和 guard 结果。服务重启时 running round 会续跑，running task 标为 orphaned，不会静默重试。

原生边界是**目录级**（Codex sandbox / Claude 权限模式），文件级 scope 是适配器的事后 guard，不是 OS 级 per-file 权限。不要把 guard 说成内核级隔离。

## 语音

- TTS：`POST /api/tts`，Windows SAPI，默认 `Microsoft Huihui Desktop`（zh-CN），返回 `/api/tts/*.wav`。
- STT：`POST /api/stt`，默认 SAPI zh-CN（`MS-2052-80-DESK`），返回原始转写并带警告。**SAPI 对中文夹英文不可靠**；UI 只把转写放进输入框，必须人工核对后再发送，不能把“可以”自动当成批准。
- 可选自定义 ASR：设置 `R2_ASR_CMD` 与 `R2_ASR_ARGS`（JSON 数组），服务会执行 `<cmd> <args...> <wav>`，读取 stdout 作为转写。`tools/asr-faster-whisper.py` 已在隔离 venv 中用本机缓存的 `Systran/faster-whisper-tiny` + 领域 prompt 实测：`请检查 KV cache 迁移到 edge 节点后的延迟。` → `請檢查KV cache 先移到 Edge 接点后的延迟。`（关键术语基本保留，仍有“迁移/节点”错误，需要人工核对）。它不是完美 ASR；要更好效果应在获授权后换更大双语模型。
- 可复现安装（不下载模型；模型路径用 `R2_WHISPER_MODEL` 指向本机快照）：
  ```powershell
  python -m venv .venv
  .venv\Scripts\python -m pip install -r tools\requirements-asr.txt
  $env:R2_ASR_CMD = (Resolve-Path .venv\Scripts\python.exe)
  $env:R2_ASR_ARGS = '["<abs path>/app/tools/asr-faster-whisper.py"]'
  $env:R2_WHISPER_MODEL = "<abs path>/.cache/huggingface/hub/models--Systran--faster-whisper-tiny/snapshots/<hash>"
  $env:R2_WHISPER_PROMPT = "KV cache，checkpoint，edge 节点，延迟，迁移"
  node server.js
  ```

## 目录与隐私

```
app/
  server.js          HTTP/SSE 服务、认证、批准、语音、任务/队列入口
  db.js              schema v2：room/messages/cursors/approvals/tasks/jobs/events
  state.js           显式状态枚举与转移守卫（唯一状态定义）
  dispatcher.js      单写者 durable worker：round + task 串行、取消、恢复
  providers.js       Codex / Claude Code 真实适配器（AbortSignal）
  scope-guard.js     快照、越界恢复
  public/index.html  单页 UI（worker/队列/撤销/禁用/重连状态）
  STATE_MACHINES.md  状态机与不变量说明
  tools/tts.ps1      SAPI TTS
  tools/stt.ps1      SAPI STT
  tools/acceptance.js 真实 Provider 验收（29 项）
  tools/state-tests.js / dispatcher-tests.js / http-state-tests.js / ui-state-tests.js
  data/              运行时数据（不要提交/发布）
```

`data/` 含 `roundtable.db`、`room-token.txt`、`turns/` 原始 CLI 输出（含 prompt 与模型回复）、共享文件与沙箱。原始 turn 可能包含完整 prompt，发布前必须脱敏或只发布合成样本。当前没有把数据发到除 Provider 自身之外的第三方；Codex/Claude Code 会把 prompt 发给各自后端，这是使用它们的必要条件。

## HTTP API 摘要

| 方法 | 路径 | 认证 | 作用 |
|---|---|---|---|
| GET | `/api/health` | 无 | 存活、room.state、worker、队列、参与者错误 |
| GET | `/api/stream?token=` | 人类令牌 | SSE 事件流 |
| GET | `/api/state?since=` | 人类令牌 | 房间、参会者、消息、批准、共享文件、沙箱文件 |
| GET | `/api/messages?since=` | 人类令牌 | 增量消息 |
| GET | `/api/shared` | 人类令牌 | 共享文件内容、快照哈希与 source 元数据 |
| POST | `/api/shared/select` | 人类令牌 | 固定项目根内 `.md/.txt` 为共享快照 |
| GET | `/api/files` | 人类令牌 | `sandbox/` 文件与基线哈希 |
| POST | `/api/invite` | 人类令牌 | 邀请真实 Agent（可带 `session_id` 恢复旧会话） |
| POST | `/api/messages` | 人类令牌 | 人类发言并触发派单；可带 `target` 定向 |
| POST | `/api/control` | 人类令牌 | `pause` / `resume` / `end` |
| POST | `/api/approvals` | 人类令牌 | 创建一次性批准 |
| POST | `/api/approvals/:id/revoke` | 人类令牌 | 撤销批准 |
| POST | `/api/tasks` | 人类令牌 | 原子消耗批准、创建 task/job；暂停或结束返回 409 |
| POST | `/api/participants/:id/disable` | 人类令牌 | 禁用参会者；若正在发言会中止该 turn |
| POST | `/api/participants/:id/enable` | 人类令牌 | 重新启用参会者 |
| POST | `/api/tts` | 人类令牌 | 文本转 WAV |
| POST | `/api/stt` | 人类令牌 | WAV 转文本 |
| GET | `/api/tts/:file` | 人类令牌 | 读取 TTS 文件 |

## 已知限制（不要在 README 之外夸大）

- 默认 SAPI 混语 STT 未达标；可选的 faster-whisper tiny + 领域 prompt 在 R3 的 20 句合成样本上关键术语仅 52.5%，必须人工核对。`R3/tools/asr-correct.js` 的两遍 LLM 术语后处理可到 95%，但有 2 个 miss、2 处句意损失、约 4 s/句，且未接入实时 UI；更好模型需要额外下载授权。
- Codex 与 Claude Code 的时延受网络和后端影响；R3 三方接龙实测 13.2 / 19.3 / 61.2 / 14.1 秒（Codex→Claude→子 Agent→Codex）。
- 批准任务在**新会话**执行，讨论会话仍是原 session；不是“同一会话里提权”。
- Claude 原生 subagent 已作为第三参会者接入：父进程调用 `Agent` 工具一次，房间记录真实 `subagent_id`、`parent_tool_use_id`；目前其最终文本由父进程逐字转发（`text_source=parent-relay`），不是带 `agent_id` 的 child 事件直达。Codex 原生 subagent 仍无可核验的 child ID，未接入。
- 未实现 ChatGPT 适配器、跨机器、手机远程、自然抢话/回声消除。
- 令牌是应用层共享密钥，不是 OS 级隔离；同一用户能读 `data/room-token.txt` 就能调用 API。

## 验收

```bash
cd app
R2_URL=http://127.0.0.1:8811 R2_TOKEN=<token> node tools/acceptance.js
```

脚本会真实调用两个 Provider、创建批准、执行一次写入、测试负例、TTS/STT、UI 与结束边界，并把原始结果写到 `data/acceptance-*.json`。结果必须按 PASS/FAIL/BLOCKED/NOT TESTED 解读，不能用“代码存在”代替实测。
