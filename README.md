# Agent Roundtable

**A local-first meeting room for real AI agents.**
One human message, two or three real Codex / Claude Code sessions, one shared project snapshot, no copy-paste relay.

Agent Roundtable runs entirely on your machine. It binds to `127.0.0.1`, stores everything in a local SQLite file, and never sends your files anywhere except to the model providers you explicitly connect.

---

## English

### Why

Working with multiple agents today usually means copying text between windows. That breaks context, hides who said what, and makes "review" a manual relay race.

Agent Roundtable turns it into one room:

- the human is the only identity allowed to post a question;
- each agent keeps its **native session** (Codex thread ID or Claude Code session UUID) across turns;
- every round reads the **same read-only snapshot** of a real project file, identified by SHA-256;
- discussion is read-only; writing to the sandbox requires an explicit, time-limited human approval.

### Features

| Area | What it does |
|---|---|
| Meetings | Multiple meetings with history. Ending a meeting cancels its queue; a new meeting starts empty and never inherits old jobs. |
| Agents | Codex CLI, Claude Code CLI, and an experimental Claude sub-agent participant. Real `--resume`, with session-ID mismatch detection. |
| Shared context | Pick a `.md` / `.txt` file in the browser; the server freezes a snapshot and gives every agent the same SHA-256. |
| Turn modes | Single answer with rotation, two-agent `A→B→A`, or three-agent chain. Optional directed `@agent` delivery. |
| Execution | Human approval bound to task ID, file scope and baseline hash; one-time consume, TTL, revoke; post-run scope guard restores out-of-scope changes. |
| Durability | SQLite-backed job queue, single writer, pause/resume/end, crash recovery, SSE replay after reconnect. |
| Voice | Windows SAPI TTS/STT; external dictation (e.g. Doubao IME) works because plain Enter does not send — `Ctrl+Enter` sends. |

### Architecture

```
Browser (single page, SSE)
        │  token-authenticated HTTP
        ▼
app/server.js ── dispatcher.js ── providers.js
        │              │               ├─ Codex CLI
        │              │               ├─ Claude Code CLI (MagPie gateway)
        │              │               └─ MockProvider (offline deterministic)
        │              ▼
        │        db.js (node:sqlite, schema v3)
        └─ shared snapshot + sandbox + turns
```

- **Zero npm dependencies.** Node.js 24 native `node:sqlite` is the only storage engine.
- **Single writer.** Discussion rounds and approved tasks share one durable queue, so they never write concurrently.
- **Explicit state machines.** Room, participant, approval, task, job and message states are defined in `app/state.js` with guarded transitions.
- **Local by default.** `127.0.0.1` only; no telemetry, no cloud storage.

### Quick start — Mock mode (no accounts, no network)

Requirements: Node.js >= 22.12.

```bash
npm install            # no dependencies; creates nothing but a lockfile if you want one
npm run start:mock
```

Or manually:

```bash
# Windows PowerShell
$env:R2_PROVIDER_MOCK = "1"
$env:R2_PORT = "8820"
$env:R2_DATA_DIR = "./data"
node app/server.js
```

Open the printed URL (or `http://127.0.0.1:8820/#token=<token>`). The token is written to `<R2_DATA_DIR>/room-token.txt`.

In mock mode every invited agent is served by `MockProvider`, which echoes the shared snapshot SHA-256. Use it for demos, CI and offline verification.

### Quick start — Real mode

Prerequisites:

1. Codex CLI installed and logged in.
2. Claude Code CLI installed; this app points it at a local MagPie-compatible gateway through `ANTHROPIC_BASE_URL`.
3. MagPie (or another Anthropic-compatible gateway) running.

```powershell
$env:R2_PORT = "8820"
$env:R2_DATA_DIR = "./data"
$env:R2_CC_MODEL = "group/openrouter"
$env:R2_MAGPIE_BASE = "http://127.0.0.1:3425"
node app/server.js
```

Then in the UI: invite Codex and Claude Code, optionally pick an existing session, select a project file, and send a question.

### Configuration

See `.env.example`. Main variables:

| Variable | Default | Meaning |
|---|---|---|
| `R2_PORT` | `8810` | Local HTTP port |
| `R2_DATA_DIR` | `app/data` | Database, snapshots, turns, TTS cache |
| `R2_HUMAN_TOKEN` | random | Human API token; written to `room-token.txt` |
| `R2_PROVIDER_MOCK` | `0` | `1` = deterministic offline provider |
| `R2_MAGPIE_BASE` | `http://127.0.0.1:3425` | Claude Code gateway |
| `R2_CC_MODEL` | `group/openrouter` | Claude Code model/route |
| `R2_SHARED_ROOTS` | repo root | Extra allowed project roots, `;` separated |
| `R2_APPROVAL_TTL_MS` | `900000` | Approval lifetime |

### Verify

```bash
python test_verify.py
```

The script starts a mock server on an isolated port and temporary data directory, then checks authentication, meeting isolation, snapshot hashing, the `A→B→A` chain and cleanup. It prints `TEST VERIFY PASS` on success.

Additional suites live in `app/tools/` (state, dispatcher, HTTP, browser UI, IME safety).

### Security model

- The human token is an application-level shared secret, not OS isolation.
- The server binds to loopback only.
- Discussion turns are read-only. Approved tasks may write only to `data/sandbox/`; a post-run guard restores out-of-scope changes.
- Shared snapshots are limited to `.md` / `.txt` files under explicitly allowed project roots, max 2 MiB.
- Native sessions are never modified by the app; a session already held by another process is reported, not force-opened.

### Known limitations

- "Resume a historical session" is not "inject into a running process". Codex may reject a session with `thread-store conflict` while another writer owns it.
- Claude Code runs through a local gateway; it is not Anthropic-hosted Claude unless you configure it that way.
- The built-in SAPI recognizer is unreliable for mixed Chinese/English; external dictation is recommended.
- No multi-machine sync, no mobile client, no OS-level per-file sandbox.

### License

MIT. See `LICENSE`.

---

## 中文

### 这是什么

Agent Roundtable 是一个**本地优先的多 Agent 会议室**。人类只发一次消息，房间按确定性规则把问题交给真实的 Codex / Claude Code 原生会话；每位 Agent 保留自己的会话上下文，所有 Agent 读取同一份项目文件的只读快照，并用 SHA-256 标识版本。

整个过程在本机完成：服务只监听 `127.0.0.1`，数据存本地 SQLite，不经过任何中转服务器。

### 核心特性

- **多会议**：结束当前会议后可新建下一场；旧会议只读保留，旧任务不会流入新会议。
- **原生会话**：Codex thread ID / Claude Code session UUID 真实 `--resume`，并检测返回的会话 ID 是否与邀请一致。
- **共享快照**：在网页里浏览项目目录，点选 `.md` / `.txt` 文件即冻结快照；两位 Agent 收到同一个 SHA-256。
- **讨论模式**：单答轮换、两位 `A→B→A`、三方接龙，也可定向 `@agent`。
- **人类批准**：写入任务绑定任务 ID、文件范围和基线哈希；一次性消费、TTL、撤销、执行后越界恢复。
- **可靠性**：SQLite 持久化队列、单写者、暂停/继续/结束、崩溃恢复、SSE 断线回放。
- **输入友好**：普通 Enter 不发送，`Ctrl+Enter` 才发送，适配豆包等中文输入法。

### 快速启动（Mock 模式，无需账号与网络）

要求 Node.js >= 22.12。

```bash
npm run start:mock
```

或手动：

```powershell
$env:R2_PROVIDER_MOCK = "1"
$env:R2_PORT = "8820"
$env:R2_DATA_DIR = "./data"
node app/server.js
```

打开终端打印的带令牌 URL。Mock 模式下每位 Agent 都会回显共享快照的 SHA-256，适合演示、CI 和离线验收。

### 快速启动（真实模式）

需要本机已登录 Codex CLI、已安装 Claude Code CLI，并运行 MagPie 或兼容网关。

```powershell
$env:R2_PORT = "8820"
$env:R2_DATA_DIR = "./data"
$env:R2_CC_MODEL = "group/openrouter"
$env:R2_MAGPIE_BASE = "http://127.0.0.1:3425"
node app/server.js
```

在网页右侧邀请 Codex 与 Claude Code，可选已有会话，选择项目文件，然后发言。

### 配置

完整变量见 `.env.example`。常用项：`R2_PORT`、`R2_DATA_DIR`、`R2_HUMAN_TOKEN`、`R2_PROVIDER_MOCK`、`R2_MAGPIE_BASE`、`R2_CC_MODEL`、`R2_SHARED_ROOTS`、`R2_APPROVAL_TTL_MS`。

### 验证

```bash
python test_verify.py
```

脚本会在独立端口和临时数据目录以 Mock 模式启动服务，验证鉴权、多会议隔离、快照哈希、`A→B→A` 轮转与清理，成功时打印 `TEST VERIFY PASS`。更多测试在 `app/tools/`。

### 安全边界

- 令牌是应用层共享密钥，不是操作系统级隔离。
- 讨论只读；写入必须经人类批准，且只能改 `data/sandbox/` 内文件；执行后由 scope guard 恢复越界改动。
- 共享快照仅限已授权项目根内的 `.md` / `.txt`，最大 2 MiB。
- 不接管正在被其他进程持有的原生会话；这种情况会明确报错。

### 已知限制

- “恢复历史会话”不等于“向正在运行的进程注入消息”；Codex 可能因 writer 锁拒绝恢复。
- Claude Code 走本机网关，不等于 Anthropic 云端 Claude。
- 内置 SAPI 对中英混说识别不可靠，建议用外部听写。
- 没有多机同步、手机端或 OS 级单文件沙箱。

### 许可证

MIT，见 `LICENSE`。

---

## Repository layout

```
app/                server, dispatcher, providers, database, UI
app/tools/          state, dispatcher, HTTP, UI, IME and RC test suites
test_verify.py      offline end-to-end verification
qa/                 QA status and evidence
evidence/           redacted verification summaries
CHANGELOG_RC.md     internal RC change log and handoff notes
USER_GUIDE.md       operator guide (Chinese)
```
