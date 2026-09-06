# AgentOS — 本地自主 agent 运行时

[English](README.md) | **简体中文** | [日本語](README.ja.md)

AgentOS 是一个小巧、可扩展的 **agent harness**（代理执行框架），在你的机器上对软件工程任务进行规划、执行、验证、评审与自我纠正。它包含：

- 无框架依赖的 TypeScript 核心（`src/agentos/`）—— 运行时、编排器、agent、工具运行时、事件总线、检查点/恢复、验证引擎、任务队列、指标；
- **CLI**（`bin/agentos.js`）；
- **Next.js 仪表盘**（任务、实时事件时间线、agent、工具、测试、指标），基于 PostgreSQL；
- JSONL + SQLite（`node:sqlite`）持久化用于离线/本地场景，PostgreSQL（Drizzle）用于仪表盘；
- 单元 / 集成 / e2e / 恢复 / 压力 / 混沌测试套件与基准测试。

没有配置 LLM key 时，规划器是**确定性**的（小型目标 DSL，或显式 `steps`）；设置 `LLM_API_KEY` 后，
OpenAI 兼容模型可以规划自由形式的目标、提出修复方案并执行一次额外的独立评审。
无论哪种方式，任务只有凭借客观证据（验证命令 + 评审员 PASS）才能完成。

## Agentic 模式（LLM 工具调用循环）

仿照 Claude Code / Codex 的核心循环，任务可以以 **agentic 模式**运行：模型直接驱动工具注册表——每一轮提出工具调用、观察结构化结果并决定下一步动作，直到它宣布目标达成。harness 始终掌握控制权——预算、逐调用检查点、验证引擎与独立评审员仍然以客观证据把关完成状态。

模型输出实时流式呈现：文本增量以瞬态 `model.delta` 事件分发（绝不持久化），并由 `task run` 和 `chat` 内联渲染。长运行通过自动压缩（LLM 对较早轮次做摘要，无模型时使用确定性标记）保持在上下文窗口内。项目指令文件 `AGENTS.md`（或 `CLAUDE.md`/`AGENTOS.md`）会被注入 agent 的系统提示词。

```bash
export LLM_API_KEY=sk-...        # 需要原生工具调用（OpenAI 兼容 API）
./bin/agentos.js task run --mode agentic --goal 'add a REST endpoint /health to src/server.ts with a test'
```

适用于任何 OpenAI 兼容端点（OpenAI、DeepSeek、GLM、Ollama、vLLM —— 设置 `LLM_BASE_URL`/`LLM_MODEL`）。

## 交互式会话（`agentos chat`）

在 REPL 中输入目标；agent 在当前目录上工作并实时流式输出：

```bash
./bin/agentos.js chat            # 确认模式：每次工具调用都询问 (y/N)
./bin/agentos.js chat --auto     # 不询问（策略与 hooks 仍然生效）
```

REPL 命令：`/tools`、`/tasks`、`/auto`、`/confirm`、`/help`、`/exit`。Ctrl-C 取消正在运行的任务；没有
`LLM_API_KEY` 时 chat 会提示需要设置什么。

## 权限

交互式会话默认为**确认模式**：每次工具执行都先询问用户。拒绝会以 `PERMISSION_DENIED` 呈现（对该步骤是致命错误；任务随后像其他策略违规一样失败）。嵌入方可以通过运行时选项接入自己的审批 UI：

```ts
const rt = await AgentRuntime.create({ permissionMode: "confirm", onPermissionRequest: async (req) => approve(req) });
```

## 沙箱层级

Shell 命令（terminal 工具 + 验证引擎）可以在可插拔沙箱中运行：

```bash
export AGENTOS_SANDBOX=container       # 或 "process" / "none"（默认）
# 或在 .agentos/config.json 中：
{ "sandbox": { "mode": "container", "image": "alpine:3", "memoryMb": 512, "cpus": 1, "network": false } }
```

- `container` —— 每条命令运行在临时 Docker 容器中：工作区挂载到 `/workspace`、**无网络**、
  移除 capabilities、内存/CPU/pids 限制。需要可用的 Docker daemon（`sandbox.onUnavailable: "degrade"`
  在沙箱不可用时降级为无沙箱而不是失败）。
- `process` —— POSIX `ulimit` vmem/pid 限制叠加到命令上（Windows 上会降级）。
- `none` —— 仅策略（deny-list + 工作区路径守卫），历史默认值。

沙箱是对命令策略的补充；它防范的是意外而非对手（见 SECURITY.md）。

## 密钥保险库（API keys）

将 provider key 加密存储在本地，而不是环境变量：

```bash
agentos secrets set LLM_API_KEY        # 值来自 --value 或管道 stdin
agentos secrets list                   # 仅名称
agentos secrets get LLM_API_KEY        # 打码；加 --show 显示
agentos secrets delete LLM_API_KEY
```

`.agentos/secrets.json` 使用 AES-256-GCM 加密；主密钥位于 `.agentos/secret.key`（0600）或
`AGENTOS_SECRET_KEY`（64 位十六进制）。运行时自动加载保险库并按此顺序解析 key：
`config.llm.apiKeySecret`（保险库）→ provider 环境变量 → 保险库默认条目。`agentos doctor` 显示解析结果
（仅名称，绝不显示值）。

## Provider 档案（GitHub Models、DeepSeek、GLM、Ollama、反向代理）

无需手工配置 `LLM_BASE_URL`，选择一个 profile 即可 —— 它会设置端点、默认模型、key 环境变量名以及
**兼容性怪癖**（流式工具调用支持、JSON 模式），harness 会自动适配：

```json
{ "llm": { "provider": "github-models", "model": "openai/gpt-4o-mini" } }
```

- `github-models` —— GitHub 托管的模型网关（`https://models.github.ai/inference`，key：`GITHUB_TOKEN`）
- `deepseek` / `glm` —— 官方 OpenAI 兼容端点（工具调用**流式默认关闭** —— 它们的 SSE `tool_calls`
  增量不可靠；agentic 循环会自动回退到非流式工具调用）
- `ollama` —— 本地运行时，无需 key
- `custom` —— 你自己的 OpenAI 兼容反向代理：设置 `baseUrl` + `apiKeySecret`（保险库条目），
  当代理不能正确流式传输工具调用时设置 `toolStreaming: false`

harness 还会在把错误反馈给模型之前**修复**畸形工具调用 JSON（markdown 围栏、智能引号、尾随逗号、
不闭合括号），并在 provider 在 token 上限处截断一轮时发出 `model.truncated`。这些 profile 适配 provider
怪癖 —— 不会绕过付费、认证或速率限制。

## Skills、作用域 API key、评估循环

```bash
# Skills：.agentos/skills/*.md 中的 markdown 手册（frontmatter name/description），
# 注入 agentic 系统提示词。命中注入/滥用模式的文件会被拒绝。
agentos skills list            # 已加载 + 已拒绝（附原因）
agentos skills show deploy

# 保护仪表盘 API 的作用域 API key（第一个 key 创建之前认证是关闭的）：
agentos apikeys create ci --scopes tasks:read,tasks:write   # key 只显示一次，仅存 SHA-256
agentos apikeys list
curl -H "Authorization: Bearer aos_..." http://localhost:3000/api/agentos/tasks
agentos apikeys revoke key_xxx

# 确定性评估循环：运行套件、持久化报告、机械地比较变体：
agentos eval run --suite evals.json --label baseline
agentos eval run --suite evals.json --label variant-a
agentos eval compare .agentos/evals/baseline-*.json .agentos/evals/variant-a-*.json
```

评估用例是 `{ "id", "title", "goal", "acceptance?", "verification?", "budget?" }` —— 评分器只使用客观
证据（任务状态 + 验收 + 计数器），因此变体比较能机械地指出回归与改进。内置离线预设：`agentos eval run --preset core`。
上下文工程（E1）内置：工具结果在进入模型对话前被清理（头尾字符串、切片数组、剥离噪声键），每个 agentic
任务维护一个外部笔记文件（`.agentos/artifacts/<taskId>/notes.md`），在对话压缩后仍然存活。

## Agentic 能力（对齐 Claude Code 的能力集）

- **并行工具调用**：一轮中的独立工具调用以有界并发执行（默认 4）；
  `agentic.parallelToolCalls: false`（或 `agentic.maxParallel`）可调。结果会重排回模型顺序，保持
  provider 配对规则完好。
- **子 agent**：`subagent` 工具把自包含的工作委托给隔离的子运行时（全新上下文、无父转录、不递归
  派生）并返回截断的 {status, summary} —— "上下文防火墙"模式。可选每子 agent `instructions`。
  在运行时选项中设 `subagent: false` 禁用。
- **权限策略**：`config.permissions.allow/deny` 模式（`tool`、`tool.*`、`tool.action`）—— deny 优先并
  从模型的工具列表中隐藏该工具/动作；显式 allow 跳过确认提示；chat `/allow` 添加会话级允许。
- **工作区地图**：Aider 风格的 repo-map（符号提取、预算受限）注入 agentic 提示词与 researcher 报告，
  让模型在读取文件前先了解项目结构。
- **Chat 会话恢复**：轮次持久化到 `.agentos/chat-session.json`；`agentos chat --resume` 用先前上下文
  播种第一轮。斜杠命令来自可扩展注册表（`/tools /tasks /allow /history /new /auto
  /confirm /exit`），嵌入方可通过 `extraCommands` 添加自己的命令。

## Hooks（`.agentos/config.json`）

Claude Code 风格的生命周期 hooks：描述事件的 JSON 载荷送到 hook 命令的 stdin；
环境变量携带 `AGENTOS_HOOK_EVENT` / `AGENTOS_TOOL` / `AGENTOS_ACTION` / `AGENTOS_TASK_ID`。

| 事件 | 退出码 2 | 其他非零 |
|---|---|---|
| `pre_tool_call` | **阻止该工具调用**（`HOOK_BLOCKED`，stderr 为原因） | 记录，不阻断 |
| `post_tool_call` | 不阻断 | 记录，不阻断 |
| `task_completed` / `task_failed` | 不阻断 | 记录，不阻断 |

```json
{
  "hooks": {
    "pre_tool_call": [{ "match": "terminal.*", "command": "node scripts/guard-terminal.js" }],
    "post_tool_call": [{ "match": "filesystem.write", "command": "node scripts/audit-write.js" }],
    "task_completed": [{ "command": "node scripts/notify.js" }]
  }
}
```

`match` 为 `*`（默认）、`tool`、`tool.*` 或 `tool.action`。

## MCP 服务器（Model Context Protocol）

外部工具在启动时经 stdio 传输加入注册表，与 Claude Code / Codex 相同：

```json
{
  "mcpServers": {
    "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": { "GITHUB_TOKEN": "..." } }
  }
}
```

每个 MCP 工具成为注册表中名为 `mcp_<server>_<tool>` 的工具，带单一 `call` 动作，可用于 `steps`、
goal DSL 的 `git:` 风格计划以及 agentic 模式。宕机的服务器发出 `mcp.failed`，绝不阻塞运行时。

## 安装

```bash
npm install                       # Node >= 22.13（node:sqlite）、git、bash
cp .env.example .env 2>/dev/null || true   # 仅仪表盘 / --store pg 需要 DATABASE_URL
```

## 从 CLI 运行任务（无需数据库）

```bash
# 在当前目录初始化 .agentos/（SQLite 存储 + JSONL 镜像）
./bin/agentos.js init

# 规划 → 执行 → 验证 → 评审 → COMPLETED
./bin/agentos.js task run --goal 'write hello.txt: hello world
run: cat hello.txt
verify: grep -q hello hello.txt
check contains hello.txt: hello'

./bin/agentos.js task status            # 列出任务
./bin/agentos.js task logs <id>         # 事件日志（--follow、--type tool.）
./bin/agentos.js task result <id>       # 计划、步骤结果、验证证据、评审
./bin/agentos.js task pause <id>        # 从另一个终端 —— 已检查点化，可恢复
./bin/agentos.js task resume <id>
./bin/agentos.js recover                # 崩溃后：从检查点恢复每个中断的任务
./bin/agentos.js doctor
./bin/agentos.js tools list
./bin/agentos.js agent list
./bin/agentos.js metrics --prometheus
./bin/agentos.js --help
```

显式步骤与预算：

```bash
./bin/agentos.js task run --goal 'n/a' \
  --step 'filesystem.write:{"path":"a.txt","content":"1"}' \
  --step 'terminal.execute:{"command":"cat a.txt"}' \
  --verify 'test -f a.txt' --max-retries 2 --timeout 60000
```

Goal DSL（每行一条指令）：`write <path>: <content>`、`append <path>: <content>`、`mkdir <path>`、`delete <path>`、
`run: <command>`、`fetch <url>`、`git: <action> {json}`、`verify: <command>`、`check exists <path>`、
`check contains <path>: <text>`、`check not-contains <path>: <text>`、`check command: <command>`。`#` 开头的行是注释。

## 仪表盘（PostgreSQL）

```bash
# .env: DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/app_db
npx drizzle-kit push          # 创建 agentos_tasks / agentos_events / agentos_checkpoints
npm run dev                   # http://localhost:3000
```

仪表盘的运行时位于 Next.js 服务进程内，启动时恢复中断的任务，并轮询存储，因此
`./bin/agentos.js --store pg task create ...` 创建的任务也会被接住。见 [API.md](API.md)。

## 可选 LLM

```bash
export LLM_API_KEY=...            # 或 OPENAI_API_KEY
export LLM_BASE_URL=https://api.openai.com/v1   # 任何 OpenAI 兼容端点（Ollama、vLLM、DeepSeek、GLM...）
export LLM_MODEL=gpt-4o-mini
```

全部变量见 [.env.example](.env.example)（仪表盘 `DATABASE_URL`、超时、重试）。

## 测试

```bash
npm test                 # 单元 + 集成
npm run test:e2e         # CLI 端到端
npm run test:recovery    # 任务中途 SIGKILL → 重启 → 恢复
npm run test:stress      # 数百任务、数千事件、并发工具调用
npm run test:chaos       # 存储故障、工具崩溃、工作区被删、部分写入
npm run test:all         # 以上全部
npm run lint && npm run typecheck && npm run build
npm run bench            # 重新生成 BENCHMARK.md
```

可选层级（环境缺失时跳过）：

```bash
# 真实 LLM 冒烟：对在线 OpenAI 兼容 provider 锻炼 agentic 循环
LLM_SMOKE=1 LLM_API_KEY=sk-... npm run test:smoke

# PostgreSQL 回归（仪表盘路径），使用一次性数据库
TEST_DATABASE_URL=postgresql://postgres:pw@127.0.0.1:5432/agentos_test npm run test:integration
```

## 文档

[ARCHITECTURE.md](ARCHITECTURE.md) · [API.md](API.md) · [DEVELOPMENT.md](DEVELOPMENT.md) · [SECURITY.md](SECURITY.md) ·
[TROUBLESHOOTING.md](TROUBLESHOOTING.md) · [BENCHMARK.md](BENCHMARK.md) · [DECISIONS.md](DECISIONS.md) · [FINAL-REPORT.md](FINAL-REPORT.md)
