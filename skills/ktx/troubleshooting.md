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
