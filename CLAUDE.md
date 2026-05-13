# ken — personal memory layer

A durable, owned memory layer that plugs into any LLM via a CLI. Local-first, server-portable. Eventually wraps a conversational interface that turns natural language into commands. Built to be the foundation under a wider portfolio of personal-software products (daily tasker, health agent, dating planner, content studio, etc.) — each consumes `ken` for personalized context.

The name comes from the archaic word *ken* — the range of one's knowledge ("beyond my ken").

## Why this exists

- The user wants to own their memory layer rather than rent it from any single LLM vendor.
- Reusable across all future products in the portfolio — write once, read from anywhere.
- LLM-agnostic by design: works with Claude, GPT, Gemini, local models — anything that can run a shell command.

## Core design principles (do not violate)

1. **Body text is canonical. Embeddings are derived data.** Never lose a memory because of a model swap. Embeddings are an index, rebuildable any time from source.
2. **One source of truth: the CLI.** Humans, LLMs, and the future chat REPL all use the same `ken` commands. No separate UI/agent paths that can drift.
3. **Local-first, server-portable.** Same code runs against a local SQLite file or a remote `ken serve` process. Switching is an env var (`KEN_REMOTE`), not a rewrite.
4. **No lock-in, ever.** Storage is plain SQLite. Open in any browser, dump to JSON, walk away with all data.
5. **The memory layer does not reason.** Reasoning is whatever LLM is calling `ken search`. Keeps the layer LLM-agnostic.
6. **CLI commands are chat-ready from day one.** All read commands support `--json`. No interactive prompts (use `--yes` flags). Errors are structured. This makes phase 1.5 (chat REPL) a thin layer instead of a refactor.

## Stack

- Runtime: **Bun + TypeScript**
- HTTP framework (for `ken serve`): **Hono** (phase 2)
- Storage: **bun:sqlite** (native, points at Homebrew SQLite via `Database.setCustomSQLite` so loadable extensions work on macOS) + **sqlite-vec** (vectors) + FTS5 (BM25)
- Embeddings: **Ollama** locally (`nomic-embed-text` default, 768d, swappable)
- CLI parser: **citty** (lightweight, type-safe)
- Search ranking: **Reciprocal Rank Fusion** (RRF, k=60) over vector + FTS rankings, with a small recency tiebreaker
- v1 install: launcher script at `~/.local/bin/ken` that runs `bun run src/cli.ts`. `bun build --compile` works locally but bundling sqlite-vec's native dylib for redistribution is a phase 2 problem.

## Storage layout

```
~/.ken/
  ├─ ken.db          # SQLite — memories + embeddings + FTS index
  ├─ config.toml     # default embedding model, default tags, remote URL, llm provider, etc.
  └─ logs/           # append-only JSONL audit trail per day
```

## Schema

```sql
memories (
  id            TEXT PRIMARY KEY,        -- ulid
  name          TEXT NOT NULL,
  description   TEXT NOT NULL,           -- short, used in retrieval ranking
  type          TEXT NOT NULL,           -- user | feedback | project | reference | note | distilled (extensible)
  tags          TEXT,                    -- JSON array
  body          TEXT NOT NULL,
  source        TEXT,                    -- where it came from
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  accessed_at   INTEGER,
  deleted_at    INTEGER                  -- soft delete
)

embeddings (
  memory_id     TEXT NOT NULL,
  model         TEXT NOT NULL,           -- e.g. "nomic-embed-text"
  dim           INTEGER NOT NULL,
  vector        BLOB NOT NULL,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (memory_id, model)
)

-- sqlite-vec virtual table(s) per active model
-- FTS5 virtual table over name + description + body
```

Multiple embedding models can coexist. Re-embedding is a backfill, never a destructive migration.

## CLI surface (v1)

```
ken add [-t type] [--tags a,b] [body...]      # body via args, $EDITOR, or --stdin
ken search "<query>" [--type X] [--limit N] [--json]
ken list [--type X] [--since 7d] [--json]
ken edit <id>                                  # opens $EDITOR; re-embeds on save
ken rm <id> [--yes]                            # soft delete
ken restore <id>
ken index [--json]                             # always-loaded set
ken reembed --model <name> [--resume]
ken serve [--port 5555] [--token ...]          # HTTP mode (phase 2)
ken review [--since 7d]                        # weekly triage (phase 2)
ken chat                                        # conversational REPL (phase 1.5)
ken distill --provider ... --model ...         # LLM-driven summarization (phase 3)
```

All read commands support `--json` for machine output, plain text for humans. No interactive prompts — destructive actions take `--yes`.

## LLM integration (no MCP, no plugin)

Any agent with shell access uses `ken` directly. Wiring is a few lines in the agent's system instructions:

```
You have access to the user's personal memory via the `ken` CLI.
- Recall: `ken search "<query>" --json --limit 5`
- Save: `ken add -t <type> "<content>"`
- Always loaded: `ken index --json`
```

That is the entire integration surface. Works with Claude Code, Codex, Cursor terminal, custom Python scripts, cron jobs.

## Conversational interface (phase 1.5 — `ken chat`)

A REPL that takes natural language, routes to CLI commands via LLM tool use, executes, and replies conversationally. Hybrid: raw CLI commands also work in the same prompt for power-user speed.

```
$ ken
> remember I prefer terse responses
✓ saved as feedback (01HX...)

> what did we decide about auth last week?
[ken search runs, returns top results]
"v1 of ken serve uses bearer token, not OAuth. Want the others?"

> reembed with bge-large
Started in background. ~3 min for 1,247 memories. Keep talking.
```

LLM provider is configurable: `KEN_LLM_PROVIDER=anthropic|openai|ollama`. Default Anthropic Claude (best tool-use). Same swap freedom as embeddings.

## Topology

- **v1 — device-only.** `~/.ken/ken.db` on the user's laptop. Direct SQLite access from the CLI. Backup via auto-commit to a private GitHub repo (post-write hook) or rely on Time Machine.
- **v2 — server option.** `ken serve` runs on a DigitalOcean droplet. Laptop CLI flips to remote with `KEN_REMOTE=https://...`. Same commands. Phone access via Shortcuts or future Tauri mobile app.
- **v3 — sync (only if needed).** Server canonical, device cache. Skip until multi-device offline editing is a real pain point.

## Distribution (when v1 CLI works)

- Homebrew tap: `brew install <user>/ken/ken`
- Install script: `curl -fsSL https://ken.sh/install | sh` (universal, OS/arch detection)
- npm: `npm install -g @<user>/ken`
- GitHub Releases: prebuilt binaries for macOS arm64/x64, linux x64, windows
- Docker (for `ken serve`): one-line `docker run` for droplet/self-host

Future Tauri desktop app wraps the CLI with a chat-first GUI; same binary, same engine.

## Phase 1 scope — STATUS: SHIPPED

All steps complete. Dogfood-ready local memory works on the user's machine.

1. ✅ Project scaffold: Bun + TS + citty + sqlite-vec + ulid + smol-toml.
2. ✅ SQLite setup: schema in `src/schema.sql` (loaded as text import), WAL mode, FTS5 with porter+unicode61 tokenizer, sqlite-vec virtual tables created lazily per model.
3. ✅ Ollama embedding client at `src/embed.ts` posting to `localhost:11434/api/embed`.
4. ✅ Six commands: `add`, `search`, `list`, `edit`, `rm`, `index` (all under `src/commands/`).
5. ✅ `--json` mode on all read commands; `--yes` required on `rm`; structured `KenError` with hint + exit code routed via `src/util/cli.ts::withErrors`.
6. ⚠️ Backup hook: scaffolded in config (off by default) but the post-write git commit logic is not wired yet. Open todo for early phase 2.
7. ✅ Smoke test: 102 sample memories seeded via `scripts/seed.ts`. Search latency p50 ~2.7ms, p95 ~3.5ms (well under 50ms target). Quality good across diverse queries.

Phase 1 explicitly does **not** include: chat REPL, `serve` mode, web UI, sync, distillation, multi-device, MCP wrapper, distribution tooling. Those are later phases.

## Phase 1.5 — `ken chat` — STATUS: SHIPPED

- ✅ REPL with Anthropic streaming tool use over existing db.ts helpers (no shellout — direct calls).
- ✅ Default model `claude-haiku-4-5` (configurable via `chat.model` in `~/.ken/config.toml` or `--model` flag).
- ✅ Six tools: `add_memory`, `search_memories`, `list_memories`, `edit_memory`, `delete_memory`, `get_index`.
- ✅ Auto-loads `ken index` into system prompt at session start.
- ✅ Auto-types and auto-tags captures from natural language ("remember I prefer X" → `type=feedback`, inferred tags).
- ✅ Prompt caching enabled on system + tool definitions (`cache_control: ephemeral`).
- ✅ Slash commands: `/help`, `/exit`, `/quit`, `/clear`, `/save <type> [tags]`, `/model <name>`.
- ✅ Hybrid input: lines starting with `ken ` shell out to the raw CLI binary.
- ✅ Streaming text output; tool calls render as `[tool_name…]` status lines.
- ⚠️ API key from `ANTHROPIC_API_KEY` env var or `chat.api_key` in config.toml (Bun also auto-loads project `.env`).
- Provider abstraction is informal — only Anthropic is wired. OpenAI/Ollama/etc. would need `src/chat/anthropic.ts` to grow into a `src/chat/providers/` directory.

Files added: `src/commands/chat.ts`, `src/chat/repl.ts`, `src/chat/tools.ts`, `src/chat/anthropic.ts`. Files modified: `src/cli.ts` (registered chatCmd), `src/config.ts` (chat block), `src/util/err.ts` (LLM_AUTH/LLM_DOWN codes).

## Phase 2

- `ken serve` HTTP mode + auth (single bearer token).
- Deploy to DigitalOcean droplet with automated daily snapshots.
- Phone capture via iOS Shortcuts hitting the HTTP API.
- Tiny web UI (single-page) for browsing/editing long memories.
- `ken review` weekly triage command.
- Distribution: Homebrew tap, install script, GitHub Releases.

## Phase 3

- Tauri 2 desktop app wrapping `ken serve` (Mac/Windows/Linux/iOS/Android).
- `ken daemon` mode: scheduled tasks, event triggers, watch-folder capture.
- Personas: `ken chat --persona daily` (morning routine), `--persona builder` (project context), etc.
- `ken distill` LLM-driven summarization / dedup / fact extraction across memories.

## Open questions to revisit

- Default `ken index` size (how many always-loaded memories before context bloat).
- Tag taxonomy: user-driven or model-suggested? Probably both, with `ken suggest-tags` later.
- Embedding model default once we benchmark `nomic-embed-text` vs `bge-large` on real personal queries.
- Default LLM provider for `ken chat` — Claude probably, but verify cost/quality.

## Working agreements for this repo

- Don't add features beyond the current phase scope. Phase 2/3 ideas go in this file, not in code.
- Don't introduce abstractions until the second concrete need shows up.
- Keep the CLI surface stable. Internals can churn freely; commands cannot.
- Every write path must produce an auditable log line.
- The `memories` table is sacred. Migrations to it require a backup snapshot first.
- All commands are chat-ready: `--json` output, `--yes` flags, structured errors.
