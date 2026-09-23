# AgentOS — ローカル自律エージェントランタイム

[English](README.md) | [简体中文](README.zh-CN.md) | **日本語**

AgentOS は、あなたのマシン上でソフトウェアエンジニアリングタスクの計画・実行・検証・レビュー・自己修正を
行う、小さく拡張可能な **agent harness** です。同梱物：

- フレームワーク非依存の TypeScript コア（`src/agentos/`）— ランタイム、オーケストレーター、エージェント、
  ツールランタイム、イベントバス、チェックポイント/リカバリ、検証エンジン、タスクキュー、メトリクス；
- **CLI**（`bin/agentos.js`）；
- **Next.js ダッシュボード**（タスク、ライブイベントタイムライン、エージェント、ツール、テスト、メトリクス）、
  バックエンドは PostgreSQL；
- オフライン/ローカル用の JSONL + SQLite（`node:sqlite`）永続化、ダッシュボード用の PostgreSQL（Drizzle）；
- ユニット / インテグレーション / e2e / リカバリ / ストレステスト / カオステストスイートとベンチマーク。

LLM キーが未設定の場合、プランナーは**決定論的**です（小さなゴール DSL、または明示的な `steps`）。
`LLM_API_KEY` を設定すると、OpenAI 互換モデルが自由形式のゴールを計画し、修正を提案し、追加の独立レビューを
実行します。どちらの場合でも、タスクが完了するには客観的な証拠（検証コマンド + レビュアーの PASS）が必要です。

## Agentic モード（LLM ツール呼び出しループ）

Claude Code / Codex のコアループに倣い、タスクは **agentic モード**で実行できます。モデルがツールレジストリを
直接駆動します：各ターンでツール呼び出しを提案し、構造化された結果を観察し、目標達成を宣言するまで次のアクション
を決定します。ハーネスが常に主導権を握ります — 予算、呼び出しごとのチェックポイント、検証エンジン、独立レビュアーが
客観的な証拠で完了をゲートし続けます。

モデル出力はライブストリーミングされます：テキスト差分は一時的な `model.delta` イベントとして配信され（永続化は
されません）、`task run` と `chat` がインラインで描画します。長時間の実行は自動コンパクション（古いターンの
LLM による要約、モデルなしでは決定論的マーカー）でコンテキストウィンドウ内に収まります。プロジェクトの指示
`AGENTS.md`（または `CLAUDE.md`/`AGENTOS.md`）はエージェントのシステムプロンプトに注入されます。

```bash
export LLM_API_KEY=sk-...        # ネイティブツール呼び出しが必要（OpenAI 互換 API）
./bin/agentos.js task run --mode agentic --goal 'add a REST endpoint /health to src/server.ts with a test'
```

OpenAI 互換エンドポイントであれば動作します（OpenAI、DeepSeek、GLM、Ollama、vLLM — `LLM_BASE_URL`/`LLM_MODEL` を設定）。

## インタラクティブセッション（`agentos chat`）

REPL でゴールを入力すると、エージェントが現在のディレクトリで作業し、出力をライブストリーミングします：

```bash
./bin/agentos.js chat            # 確認モード：ツール呼び出しごとに (y/N) で尋ねる
./bin/agentos.js chat --auto     # プロンプトなし（ポリシーと hooks は適用され続ける）
```

REPL コマンド：`/tools`、`/tasks`、`/auto`、`/confirm`、`/help`、`/exit`。Ctrl-C で実行中タスクをキャンセル；
`LLM_API_KEY` がなければ chat は設定方法を説明します。

## パーミッション

インタラクティブセッションはデフォルトで**確認モード**です：すべてのツール実行前にユーザーに尋ねます。拒否は
`PERMISSION_DENIED` として表面化します（そのステップにとっては致命的エラーで、タスクは他のポリシー違反と同様に
失敗します）。埋め込み側はランタイムオプションで独自の承認 UI を接続できます：

```ts
const rt = await AgentRuntime.create({ permissionMode: "confirm", onPermissionRequest: async (req) => approve(req) });
```

## サンドボックス階層

シェルコマンド（terminal ツール + 検証エンジン）はプラグイン可能なサンドボックス内で実行できます：

```bash
export AGENTOS_SANDBOX=container       # または "process" / "none"（デフォルト）
# または .agentos/config.json 内で：
{ "sandbox": { "mode": "container", "image": "alpine:3", "memoryMb": 512, "cpus": 1, "network": false } }
```

- `container` — すべてのコマンドが使い捨ての Docker コンテナ内で実行：ワークスペースは `/workspace` に
  マウント、**ネットワークなし**、capabilities をドロップ、メモリ/CPU/pids 制限。到達可能な Docker デーモンが
  必要（`sandbox.onUnavailable: "degrade"` でサンドボックス不可時に失敗ではなく非サンドボックスへフォールバック）。
- `process` — POSIX `ulimit` のメモリ/プロセス/CPU 秒制限。Windows では **失敗終了**（`SANDBOX_UNAVAILABLE`）。
  サンドボックス無しで走らせるのは `sandbox.onUnavailable: "degrade"` を明示したときだけ。
- `none` — ポリシーのみ（拒否リスト + ワークスペースパスガード）、従来のデフォルト。

サンドボックスはコマンドポリシーを補完するものです。事故を封じ込めるものであり、敵対者を封じ込めるものでは
ありません（SECURITY.md を参照）。

## シークレットボールト（API キー）

環境変数の代わりに、プロバイダキーを暗号化して保存します：

```bash
agentos secrets set LLM_API_KEY        # 値は --value またはパイプされた stdin から
agentos secrets list                   # 名前のみ
agentos secrets get LLM_API_KEY        # マスク表示；--show で表示
agentos secrets delete LLM_API_KEY
```

`.agentos/secrets.json` は AES-256-GCM で暗号化されます。マスターキーは `.agentos/secret.key`（0600）または
`AGENTOS_SECRET_KEY`（64 桁の 16 進数）に置かれます。ランタイムはボールトを自動ロードし、次の順序でキーを解決します：
`config.llm.apiKeySecret`（ボールト）→ プロバイダ環境変数 → ボールトのデフォルトエントリ。`agentos doctor` は
解決結果を表示します（名前のみ、値は決して表示しません）。

## プロバイダプロファイル（GitHub Models、DeepSeek、GLM、Ollama、リバースプロキシ）

`LLM_BASE_URL` を手動設定する代わりに、プロファイルを選択してください — エンドポイント、デフォルトモデル、
キー環境変数名、そしてハーネスが適応する**互換性のクセ**（ストリーミングツール呼び出し対応、JSON モード）が
設定されます：

```json
{ "llm": { "provider": "github-models", "model": "openai/gpt-4o-mini" } }
```

- `github-models` — GitHub のホスト型モデルゲートウェイ（`https://models.github.ai/inference`、キー：`GITHUB_TOKEN`）
- `deepseek` / `glm` — 公式 OpenAI 互換エンドポイント（ツール呼び出しの**ストリーミングはデフォルトで無効** —
  SSE の `tool_calls` 差分が不安定なため；agentic ループは自動的に非ストリーミングのツール呼び出しへフォールバック）
- `ollama` — ローカルランタイム、キー不要
- `custom` — 独自の OpenAI 互換リバースプロキシ：`baseUrl` + `apiKeySecret`（ボールトエントリ）を設定し、
  プロキシがツール呼び出しを正しくストリーミングできない場合は `toolStreaming: false` を設定

ハーネスは、エラーをモデルに返す前に不正なツール呼び出し JSON を**修復**し（markdown フェンス、スマートクォート、
末尾カンマ、閉じ括弧の不一致）、プロバイダがトークン上限でターンを打ち切ったときは `model.truncated` を出力します。
これらのプロファイルはプロバイダのクセに適応するものであり、支払い・認証・レート制限を回避するものではありません。

## Skills、スコープ付き API キー、評価ループ

```bash
# Skills：.agentos/skills/*.md のマークダウンプレイブック（frontmatter の name/description）。
# agentic システムプロンプトに注入されます。注入/悪用パターンに一致するファイルは拒否されます。
agentos skills list            # ロード済み + 拒否（理由付き）
agentos skills show deploy

# ダッシュボード API を守るスコープ付き API キー（最初のキーが作成されるまで認証は OFF）：
agentos apikeys create ci --scopes tasks:read,tasks:write   # キーは一度だけ表示、SHA-256 のみ保存
agentos apikeys list
curl -H "Authorization: Bearer aos_..." http://localhost:3000/api/agentos/tasks
agentos apikeys revoke key_xxx

# 決定論的な評価ループ：スイートを実行、レポートを永続化、バリアントを機械的に比較：
agentos eval run --suite evals.json --label baseline
agentos eval run --suite evals.json --label variant-a
agentos eval compare .agentos/evals/baseline-*.json .agentos/evals/variant-a-*.json
```

評価ケースは `{ "id", "title", "goal", "acceptance?", "verification?", "budget?" }` です — スコアラーは客観的な
証拠のみ（タスクステータス + 受け入れ + カウンタ）を使用するため、バリアント比較は回帰と改善を機械的に特定できます。
組み込みのオフラインプリセット：`agentos eval run --preset core`。コンテキストエンジニアリング（E1）も組み込み：
ツール結果はモデルの会話に入る前にクリーンアップされ（先頭+末尾の文字列、配列のスライス、ノイズキーの除去）、
各 agentic タスクは外部ノートファイル（`.agentos/artifacts/<taskId>/notes.md`）を保持し、会話のコンパクション後も
存続します。

## Agentic 機能（Claude Code 相当セット）

- **並列ツール呼び出し**：ターン内で連続する読み取り専用呼び出しだけを `agentic.maxParallel`（既定 4）で並列実行。
  書き込み・シェルなど状態を変える呼び出しは単独で実行し、同じターンの編集が重ならない。`agentic.parallelToolCalls: false`
  ですべて直列。結果はモデルの順序を保つ。
- **サブエージェント**：`subagent` ツールは自己完結した作業を分離された子ランタイムに委譲（新しいコンテキスト、
  親のトランスクリプトなし、再帰的なスポーンなし）し、上限付きの {status, summary} を返します —
  「コンテキストファイアウォール」パターン。サブエージェントごとの `instructions` は任意。ランタイムオプションで
  `subagent: false` とすると無効化できます。
- **パーミッションポリシー**：`config.permissions.allow/deny` パターン（`tool`、`tool.*`、`tool.action`）—
  deny が優先され、モデルのツールリストからそのツール/アクションを隠します。明示的な allow は確認プロンプトを
  スキップ；chat の `/allow` はセッションスコープの許可を追加します。
- **ワークスペースマップ**：Aider スタイルの repo-map（シンボル抽出、予算制限あり）が agentic プロンプトと
  researcher レポートに注入され、モデルはファイルを読む前にプロジェクト構造を把握できます。
- **Chat セッション再開**：ターンは `.agentos/chat-session.json` に永続化；`agentos chat --resume` は最初のターンに
  過去のコンテキストを投入します。スラッシュコマンドは拡張可能なレジストリから（`/tools /tasks /allow /history /new
  /auto /confirm /exit`）、埋め込み側は `extraCommands` で独自コマンドを追加できます。

## Hooks（`.agentos/config.json`）

Claude Code スタイルのライフサイクル hooks：イベントを記述する JSON ペイロードが hook コマンドの stdin に渡され、
環境変数に `AGENTOS_HOOK_EVENT` / `AGENTOS_TOOL` / `AGENTOS_ACTION` / `AGENTOS_TASK_ID` が設定されます。

| イベント | 終了コード 2 | その他の非ゼロ |
|---|---|---|
| `pre_tool_call` | **ツール呼び出しをブロック**（`HOOK_BLOCKED`、stderr が理由） | 記録のみ、非ブロッキング |
| `post_tool_call` | 非ブロッキング | 記録のみ、非ブロッキング |
| `task_completed` / `task_failed` | 非ブロッキング | 記録のみ、非ブロッキング |

```json
{
  "hooks": {
    "pre_tool_call": [{ "match": "terminal.*", "command": "node scripts/guard-terminal.js" }],
    "post_tool_call": [{ "match": "filesystem.write", "command": "node scripts/audit-write.js" }],
    "task_completed": [{ "command": "node scripts/notify.js" }]
  }
}
```

`match` は `*`（デフォルト）、`tool`、`tool.*` または `tool.action`。

## MCP サーバー（Model Context Protocol）

外部ツールは起動時に stdio トランスポート経由でレジストリに参加します。Claude Code / Codex と同様です：

```json
{
  "mcpServers": {
    "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": { "GITHUB_TOKEN": "..." } }
  }
}
```

各 MCP ツールは `mcp_<server>_<tool>` という名前のレジストリツールになり、単一の `call` アクションを持ち、
`steps`、goal DSL の `git:` スタイルの計画、agentic モードで使用できます。ダウンしたサーバーは `mcp.failed` を
出力し、ランタイムをブロックしません。

## インストール

```bash
npm install                       # Node >= 22.13（node:sqlite）、git、bash
cp .env.example .env 2>/dev/null || true   # DATABASE_URL はダッシュボード / --store pg の場合のみ必要
```

## CLI からタスクを実行（データベース不要）

```bash
# 現在のディレクトリで .agentos/ を初期化（SQLite ストア + JSONL ミラー）
./bin/agentos.js init

# 計画 → 実行 → 検証 → レビュー → COMPLETED
./bin/agentos.js task run --goal 'write hello.txt: hello world
run: cat hello.txt
verify: grep -q hello hello.txt
check contains hello.txt: hello'

./bin/agentos.js task status            # タスク一覧
./bin/agentos.js task logs <id>         # イベントログ（--follow、--type tool.）
./bin/agentos.js task result <id>       # 計画、ステップ結果、検証証拠、レビュー
./bin/agentos.js task pause <id>        # 別のターミナルから — チェックポイント済み、再開可能
./bin/agentos.js task resume <id>
./bin/agentos.js recover                # クラッシュ後：チェックポイントから中断タスクをすべて再開
./bin/agentos.js doctor
./bin/agentos.js tools list
./bin/agentos.js agent list
./bin/agentos.js metrics --prometheus
./bin/agentos.js --help
```

明示的なステップと予算：

```bash
./bin/agentos.js task run --goal 'n/a' \
  --step 'filesystem.write:{"path":"a.txt","content":"1"}' \
  --step 'terminal.execute:{"command":"cat a.txt"}' \
  --verify 'test -f a.txt' --max-retries 2 --timeout 60000
```

Goal DSL（1 行に 1 命令）：`write <path>: <content>`、`append <path>: <content>`、`mkdir <path>`、`delete <path>`、
`run: <command>`、`fetch <url>`、`git: <action> {json}`、`verify: <command>`、`check exists <path>`、
`check contains <path>: <text>`、`check not-contains <path>: <text>`、`check command: <command>`。`#` で始まる行はコメントです。

## ダッシュボード（PostgreSQL）

```bash
# .env: DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/app_db
npx drizzle-kit push          # agentos_tasks / agentos_events / agentos_checkpoints を作成
npm run dev                   # http://localhost:3000
```

ダッシュボードのランタイムは Next.js サーバープロセス内にあり、起動時に中断タスクを復旧し、ストアをポーリングするため、
`./bin/agentos.js --store pg task create ...` で作成されたタスクも拾われます。詳しくは [API.md](API.md)。

## オプションの LLM

```bash
export LLM_API_KEY=...            # または OPENAI_API_KEY
export LLM_BASE_URL=https://api.openai.com/v1   # 任意の OpenAI 互換エンドポイント（Ollama、vLLM、DeepSeek、GLM...）
export LLM_MODEL=gpt-4o-mini
```

すべての変数は [.env.example](.env.example) を参照（ダッシュボードの `DATABASE_URL`、タイムアウト、リトライ）。

## テスト

```bash
npm test                 # ユニット + インテグレーション
npm run test:e2e         # CLI エンドツーエンド
npm run test:recovery    # タスク途中で SIGKILL → 再起動 → 再開
npm run test:stress      # 数百タスク、数千イベント、並列ツール呼び出し
npm run test:chaos       # ストア障害、ツールクラッシュ、ワークスペース削除、部分書き込み
npm run test:all         # 上記すべて
npm run lint && npm run typecheck && npm run build
npm run bench            # BENCHMARK.md を再生成
```

オプション階層（環境がなければスキップ）：

```bash
# 実 LLM スモーク：ライブの OpenAI 互換プロバイダに対して agentic ループを演習
LLM_SMOKE=1 LLM_API_KEY=sk-... npm run test:smoke

# PostgreSQL リグレッション（ダッシュボード経路）、使い捨てデータベースを使用
TEST_DATABASE_URL=postgresql://postgres:pw@127.0.0.1:5432/agentos_test npm run test:integration
```

## ドキュメント

[ARCHITECTURE.md](ARCHITECTURE.md) · [API.md](API.md) · [DEVELOPMENT.md](DEVELOPMENT.md) · [SECURITY.md](SECURITY.md) ·
[TROUBLESHOOTING.md](TROUBLESHOOTING.md) · [BENCHMARK.md](BENCHMARK.md) · [DECISIONS.md](DECISIONS.md) · [FINAL-REPORT.md](FINAL-REPORT.md)
