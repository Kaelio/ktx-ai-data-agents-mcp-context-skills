# Goal

Set up KTX from scratch end-to-end as a fully autonomous, agent-driven replacement for the interactive `ktx setup` wizard. Detect the environment, install missing prerequisites, ask the user only for information you genuinely need (which connections to add, credentials), write a valid configuration, verify it works, and run a fast schema ingest. Keep the user updated throughout.

# Operating principles

- **Be autonomous.** Detect, decide, and act. Only ask the user when you need information that only they can provide: project location, which databases/sources to connect, credentials, and similar choices.
- **Stream short status updates.** Before each major phase ("Checking prerequisites…", "Installing uv…", "Configuring warehouse connection…", "Running fast ingest…") print a one-line update. Not chatty — just enough that the user can see what's happening.
- **Verify against docs, never guess.** CLI flags, config keys, and command names must come from the docs or from `ktx <command> --help`. If something looks wrong or missing, say so explicitly.
- **Print every command you run and its exit code.** Terse, not silent.
- **Fail loudly with cause + fix.** When a command fails: capture the exact error, identify the cause, change something, retry. Never retry an unchanged command. Exceptions for *known soft-failures* are listed in Phase 4 — handle those without retrying.
- **No LLM-based ingestion in this flow.** Only `--fast` ingest (schema-only). The user can run `--deep` later.
- **Platform-agnostic.** Detect the host OS first and pick the right install commands / path syntax. Anything path- or shell-specific must branch on OS.

# Authoritative docs

KTX docs are served at `https://docs.kaelio.com/ktx/`. **Start by fetching `https://docs.kaelio.com/ktx/llms.txt`** to discover the docs map. Scan it for a "troubleshooting" entry — if one exists, read it **before** running install/setup so you can apply known fixes preemptively rather than after failing. If no troubleshooting page is listed (current state of the docs), proceed. Then fetch any other `.md` pages you need (setup, ingest, status, connection types). **Never invent CLI flags or config keys** — verify against the docs or `ktx --help` / `ktx <subcommand> --help`.

> **Note on the `ktx status` JSON example in the docs.** The docs page for `ktx status` shows an example shaped like `{"title": "...", "checks": [...]}`. That example is outdated. The real CLI output uses a top-level `verdict` field plus a `connections[]` array — see Phase 5 for the canonical success criteria. Trust the shape in this prompt over the docs example.

# Workflow

## Phase 1 — Detect environment

Determine the host OS (e.g. via `uname -s`, `process.platform`, or `$env:OS`). Use the right install commands per OS for the rest of this flow.

| Tool | macOS / Linux | Windows (PowerShell) |
|------|---------------|----------------------|
| `uv` | `curl -LsSf https://astral.sh/uv/install.sh \| sh` then re-source shell env | `irm https://astral.sh/uv/install.ps1 \| iex` |
| Node.js | use system / fnm / nvm — **do not** auto-install | use system / nvm-windows — **do not** auto-install |
| KTX CLI | `npm install -g …` (see Phase 2) | `npm install -g …` (see Phase 2) |

If Node.js is missing, **stop and ask the user** to install it (https://nodejs.org/). Do not attempt to auto-install Node.

## Phase 2 — Verify and install prerequisites

Check each tool in order; install only if missing.

1. **Node.js** — run `node --version`. Require >= 22. If missing or older, stop and instruct the user.
2. **`uv`** — run `uv --version`. If missing, run the OS-appropriate install command, then re-source the shell environment (`export PATH="$HOME/.local/bin:$PATH"` on Linux/macOS) so `uv` is on `PATH`.
3. **KTX CLI** —
   - Install ktx with `npm install -g @kaelio/ktx`
   - Verify with `ktx --version`.

Print one status line per tool ("✓ uv 0.11.15 found", "Installing uv…", "✓ ktx 0.x.y installed").

## Phase 3 — Gather user choices

Ask the user (grouped if your harness supports it; otherwise sequentially):

1. **Project directory.** Default: current working directory. Confirm before continuing.
2. **LLM provider.** Default: `claude-code` with model `sonnet` (the user is already inside Claude Code; no extra API key needed). Offer `anthropic` (paste API key, stored as `env:` or `file:` ref) and `vertex` (GCP project + location) as alternatives. Skip if defaults are accepted.
3. **Embeddings backend.** Default: `sentence-transformers` (local, no API key, managed Python runtime). Offer `openai` only if the user has a key.
4. **Database connections.** Ask how many to add, then loop. For each, collect:
   - Connection name (e.g. `warehouse`, `analytics`).
   - Driver: one of `sqlite`, `postgres`, `mysql`, `clickhouse`, `sqlserver`, `bigquery`, `snowflake`.
   - Connection URL/DSN (or service-account file for BigQuery). Accept `env:VAR_NAME` or `file:/abs/path` to avoid pasting raw secrets.
     - **Heads-up for the user**: even if they paste a literal URL, KTX will silently relocate it into `<project>/.ktx/secrets/<connection>-url` and rewrite `ktx.yaml` to `url: file:…` — this is correct, secure behavior and not a bug.
   - Schemas / datasets to include (postgres / sqlserver / snowflake / bigquery only).
   - Optional `enabled_tables` allowlist if the user wants to scope ingest to specific tables.
5. **BI / metadata sources** (dbt, Metabase, Looker, LookML, MetricFlow, Notion). Default: none. Ask only if the user mentions them.

## Phase 4 — Configure the project

Drive the existing wizard non-interactively (verify exact flag names with `ktx setup --help` and the docs — the automation flags are hidden from help but accepted):

```
ktx setup \
  --project-dir <path> \
  --new \
  --no-input --yes \
  --llm-backend <claude-code|anthropic|vertex> --llm-model <model> \
  [--anthropic-api-key-env ANTHROPIC_API_KEY | --anthropic-api-key-file <path>] \
  [--vertex-project <p> --vertex-location <loc>] \
  --embedding-backend <sentence-transformers|openai> \
  [--embedding-api-key-env OPENAI_API_KEY] \
  --skip-sources \
  --database <driver> --new-database-connection-id <name> --database-url <url|env:VAR|file:/path> \
    [--database-schema <schema> …]
  # repeat the --database / --new-database-connection-id / --database-url / --database-schema block per connection
```

Notes on the flags above:
- **`--new`** is required when bootstrapping an empty directory; use `--existing` instead when re-running setup against a project that already has a `ktx.yaml`.
- **There is no `--skip-agents` flag.** The agent integration step is opt-in: setup leaves it alone unless you pass `--agents --target <target>`. So you do not need to skip it — just don't pass `--agents`.
- **`--skip-sources`** is correct and is the documented way to leave BI/metadata sources unconfigured.

### Known soft-failure: `ktx setup` exits 1 after a successful fast build

When you select a configuration that only does fast (schema-only) ingest, `ktx setup`'s final readiness verification fails with:

```
KTX context build did not pass agent-readiness verification.
  <connection>: deep database context has not completed.
```

This is **expected** and **does not mean setup failed**. Treat the exit code as a soft-failure **only if all of the following hold**:

- The build log shows the fast ingest reached `[100%] Scan completed` for every configured connection.
- `ktx connection test <name>` (run next) exits 0 for every connection.
- `ktx status --json --no-input` reports `verdict: "ready"`.

If those three conditions hold, proceed to Phase 5 without retrying setup, and **do not** switch to `--deep` to "fix" the readiness gate — deep ingest is explicitly out of scope. Mention this in the final report under "Docs / CLI gaps" so the user is aware.

If any of those three conditions do not hold, this is a real failure — capture the error, fetch the relevant docs page, fix the cause, retry.

After `ktx setup` writes `ktx.yaml`, edit it directly for anything flags don't cover:
- Per-connection `enabled_tables` allowlist (snake_case, under `connections.<name>.enabled_tables`).
- Any advanced settings the user requested.

Use a YAML-aware editor (e.g. `uv run python -c "import yaml; …"`) — do not hand-edit blindly.

## Phase 5 — Verify

`ktx setup` already runs a fast schema ingest of every database connection it configures, so you do not need to re-ingest by default. For each configured connection:

```
ktx connection test <connection-name>        # must exit 0
```

Only re-run ingest if setup's build log did **not** reach 100% for that connection:

```
ktx ingest <connection-name> --fast --no-input
```

**Mutex warning on `ktx ingest`**: passing both `--yes` and `--no-input` fails with `Choose only one runtime install mode: --yes or --no-input`. Setup already installed the managed Python runtime, so pass **only `--no-input`** to `ktx ingest`. (`--yes` is only needed when an ingest invocation has to install the runtime itself, which is not the case here.)

Then run the global health check:

```
ktx status --json --no-input
```

Success requires (canonical shape — supersedes the example in the docs):
- `verdict: "ready"` at the top of the JSON.
- Every `connections[].status === "ok"`.
- `ktx connection test <name>` exited 0 for every connection.

Do **not** run `--deep` ingest in this flow — that requires LLM time and is out of scope.

### Optional: directly probe the embeddings daemon

If the user asks for stronger verification that `sentence-transformers` is actually serving (not just that setup said "ok"), do all of:

1. `ktx dev runtime status --json` → expect `"kind": "ready"` and `"features": [..., "local-embeddings"]`.
2. `pgrep -fa ktx-daemon` → expect a process running `ktx-daemon serve-http`.
3. `curl -sS http://127.0.0.1:<port>/health` → expect HTTP 200 with `{"status":"healthy",…}`.
4. `curl -sS -X POST http://127.0.0.1:<port>/embeddings/compute -H 'content-type: application/json' -d '{"text":"hello"}'` → expect `{"embedding": [...384 floats...]}`.

Discover the port from setup's log line `Started KTX local embeddings daemon: http://127.0.0.1:<port>` or from the daemon's OpenAPI at `GET /openapi.json`. Note: the routes are `/health` and `/embeddings/compute` — not `/healthz` or `/embeddings`.

## Phase 6 — Final report

Print a structured report:

```
KTX SETUP COMPLETE

Project:     <path>
LLM:         <backend> / <model>
Embeddings:  <backend> / <model>
Runtime:     managed Python ✓ (if sentence-transformers daemon was started)

Connections:
  - <name> (<driver>)  status=ok  schemas=[…]  tables=<N>
  - …

Sources:     <list or "none">
Verdict:     ready
```

Then **Next steps** (copy-pasteable):
1. Enrich with AI descriptions and embeddings: `ktx ingest <connection> --deep` (several minutes per connection).
2. Add more connections later by rerunning this setup or via `ktx setup --existing --database … --new-database-connection-id …`.
3. Configure BI sources (dbt, Metabase, Looker, LookML, MetricFlow, Notion) — see `ktx setup --help` for `--source …` flags.
4. Install agent integration: `ktx setup --agents --target <claude-code|claude-desktop|codex|cursor|opencode|universal>` (with optional `--global` for `claude-code`/`codex`).
5. Connect the agent / MCP: see docs at `https://docs.kaelio.com/ktx/`.

Under **Docs / CLI gaps to flag** include any of these that applied during your run:
- `ktx setup` exits non-zero after a successful fast build (deep-readiness gate); status reports ready.
- `ktx ingest` rejects `--yes` and `--no-input` together; docs don't note the conflict.
- `ktx status --json` real shape (`verdict`, `connections[]`) doesn't match the example in the docs page.
- The pasted DB URL was moved to `.ktx/secrets/<name>-url` automatically.

End with a single line: `RESULT: PASS` or `RESULT: FAIL — <one-line reason>`.

# Operating rules (recap)

- Print every command you run and its exit code. Status updates may be terse, but never silent.
- On failure: capture the error, fetch the relevant docs page, fix the cause, retry. Never retry an unchanged command.
- Known soft-failures (listed in Phase 4 and Phase 5) are not real failures — handle them as documented; do not retry or escalate.
- If you find a docs/CLI gap ("docs say X but CLI does Y"), call it out in the final report.
- Never commit credentials — KTX accepts `env:` and `file:` references; prefer those. KTX will also auto-relocate literal URLs into `.ktx/secrets/`, but that does not protect anyone who pasted the URL into chat history.
