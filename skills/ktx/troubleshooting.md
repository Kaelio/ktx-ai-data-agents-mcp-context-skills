# ktx setup troubleshooting

Known failure signatures hit by agent-driven `ktx setup` runs. Match the
error string in the left column, apply the fix in the right column.

## `Error: invalid ELF header` from `better-sqlite3`

Native module compiled for a different platform or architecture (e.g.
installed under Rosetta then run under native arm64).

Fix:

```bash
# Inside the ktx monorepo:
pnpm rebuild better-sqlite3

# Or for a global install:
npm rebuild --global better-sqlite3
```

## `Native CLI binary for <plat> not found`

The platform-specific optional dependency that ships the native CLI binary
was skipped during install (npm/pnpm "optional dep not for this platform").

Fix:

```bash
npm install -g @kaelio/ktx --force
```

## `Missing Anthropic API key: pass --anthropic-api-key-env or --anthropic-api-key-file`

`--no-input` mode defaulted the LLM backend to `anthropic` because no
`--llm-backend` flag was supplied. The CLI then required a key.

Fix — pick one:

```bash
# Inside Claude Code, prefer the local backend:
ktx setup --no-input --llm-backend claude-code ...other flags...

# Otherwise point at an existing env var:
ktx setup --no-input --llm-backend anthropic \
  --anthropic-api-key-env ANTHROPIC_API_KEY ...other flags...
```

## `claude-code` LLM probe fails (auth or binary not found)

The `claude` CLI is not on the agent's `PATH`, or the user has not run
`claude` interactively at least once to log in.

Fix:

```bash
which claude            # confirm the binary resolves
claude --version        # confirm it runs
# If auth probe still fails, the user must run `claude` once interactively
# to complete login; agents cannot do this step.
```

If `claude-code` cannot be made to work, fall back to `--skip-llm` and let
the rest of setup complete; the project is still a usable context layer
without an LLM.

## `KTX cannot work without a database` when resuming setup

`ktx setup` validates the **current invocation's flags**, not the persisted
`ktx.yaml`. Resuming setup with only `--llm-backend …` fails even when the
project already has a healthy database connection.

Fix — re-pass the database flags from the original setup run, even when
only changing one slice:

```bash
ktx setup --no-input \
  --database <driver> --database-connection-id <id> \
  --llm-backend claude-code
```

## `Run in a TTY, or pass --target <target>.` and `ktx setup` exits 1

`ktx setup` runs agent integration as its last step. In `--no-input` mode with
neither `--target` nor `--skip-agents`, that step has no input and the whole
command exits non-zero — even when every database, LLM, and embedding step
already succeeded. The exit code is misleading here.

Fix — pass one of these to the data-only setup runs:

```bash
# Defer agents; install them later with `ktx setup --agents --target <agent>`:
ktx setup --no-input --yes ...other flags... --skip-agents

# Or install agents inline and exit 0:
ktx setup --no-input --yes ...other flags... --target claude-code
```

Either way, confirm the data work landed with `ktx status --json` rather than
trusting the exit code.

## A secret resolves empty only during `ktx ingest` or `ktx mcp`

Setup succeeded, but a later `ktx ingest`/`ktx mcp start` fails to connect or
authenticate. The connection used an `env:VAR_NAME` ref (or a `--*-api-key-env`
flag) and the variable was exported only in the setup shell. `env:` refs are
re-resolved against the process environment on every `ktx` run, so they resolve
to empty wherever the var is absent — including the `ktx mcp` daemon.

Fix — write the secret to a file and use a `file:` ref, which reads from disk
and survives across shells:

```bash
mkdir -p "$PROJECT/.ktx/secrets"
printf '%s\n' '<secret>' > "$PROJECT/.ktx/secrets/<id>-<name>"
chmod 600 "$PROJECT/.ktx/secrets/"*
# then pass: --source-api-key-ref file:$PROJECT/.ktx/secrets/<id>-<name>
```

Alternatively, ensure the var is exported in every shell that runs `ktx`,
including the environment of the `ktx mcp` daemon.
