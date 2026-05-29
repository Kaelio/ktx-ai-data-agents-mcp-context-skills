---
name: ktx
description: Installs and configures ktx, the open-source context layer for data agents — runs ktx setup non-interactively with hidden CLI flags, configures database connections and embeddings, installs agent integration, and verifies readiness. Use when the user asks an agent to add ktx to a project, connect data sources, install agent rules, ingest schema, or troubleshoot a local ktx install.
---

# ktx

Install and configure **ktx**, the open-source context layer for data agents.
Use this skill when a user wants an agent to add **ktx** to a project, connect
data sources, build initial context, install agent integration, or troubleshoot
a local **ktx** setup.

## Operating rules

- Act autonomously when the user asks you to install or configure **ktx**.
  The non-interactive scripted flow below is the canonical path — bare
  `ktx setup` is interactive (clack prompts) and an agent cannot drive it.
- Setup's non-interactive flags are intentionally hidden from `--help`. Use the
  flags listed below; verify uncommon flags against the docs at
  `https://docs.kaelio.com/ktx/` or this skill — not against `--help` output.
- Ask only for values you cannot infer: project directory, connection targets,
  credentials, account identifiers, and source selections.
- Never ask the user to paste secrets when an `env:VAR_NAME` or `file:/path`
  reference would work. Pasting a literal URL is also safe — `ktx setup`
  auto-externalizes URLs into `.ktx/secrets/<id>-url` (see workflow step 2).
- Do not commit `.ktx/secrets/*`.
- Print each command you run and its result.
- If a command fails, identify the cause and change something before retrying.

## Gather inputs once

Before invoking `ktx setup`, collect in one round:

1. Project directory (default: current working directory).
2. LLM backend and key strategy. In `--no-input` mode the CLI defaults to
   `anthropic` and **requires an API key**. When the user is inside Claude
   Code, pass `--llm-backend claude-code` explicitly; otherwise pass
   `--llm-backend anthropic --anthropic-api-key-env ANTHROPIC_API_KEY`.
3. Embedding backend (`sentence-transformers` is the local default and needs
   no key; use `openai` only if the user already has a key, then pass
   `--embedding-api-key-env OPENAI_API_KEY`).
4. Database: driver, connection id, URL (or `env:` / `file:` ref), and one or
   more schemas.
5. Optional context sources (dbt, Metabase, Looker, LookML, MetricFlow,
   Notion). Add each one with a follow-up `ktx setup --source …` run (see
   [Add context sources](#add-context-sources)); use `--skip-sources` only
   when the user has none.

Do not discover these inputs across multiple setup runs.

## Install workflow

1. **Detect the install path.** If the working directory contains
   `packages/cli/dist/bin.js` or `pnpm-workspace.yaml` referencing
   `@kaelio/ktx` you are inside the **ktx** monorepo — build and link the
   local CLI with `pnpm` and do **not** run `npm install -g`. Otherwise:

   ```bash
   node --version    # require >= 22; stop and ask the user if older
   ktx --version || npm install -g @kaelio/ktx
   ```

2. **Run scripted setup** (canonical path):

   ```bash
   ktx setup --no-input --yes \
     --project-dir <path> \
     --llm-backend claude-code \
     --embedding-backend sentence-transformers \
     --database <driver> --database-connection-id <id> \
     --database-url '<raw-url | env:NAME | file:/abs/path>' \
     --database-schema <schema> \
     --skip-sources
   ```

   - Configure one new database connection per setup invocation. For multiple
     connections, rerun setup once per connection.
   - Pasting a literal `--database-url` is safe: the CLI relocates the URL
     into `.ktx/secrets/<connection-id>-url` and rewrites `ktx.yaml` to a
     `file:` ref automatically.

3. **Resumability and `--skip-*`.** Re-running `ktx setup` against an existing
   project resumes its config. Use `--skip-llm`, `--skip-databases`,
   `--skip-sources`, or `--skip-embeddings` to leave a slice unconfigured but
   let the rest complete instead of aborting on the first failure. **When
   resuming an existing project to change one slice (e.g. only LLM), still
   pass the database flags from the previous run** — setup validates current
   flags, not persisted `ktx.yaml` state.

4. **Run fast ingest** if setup did not already complete one:

   ```bash
   ktx ingest <connection-id> --fast --no-input
   ```

   Note: `ktx ingest` rejects `--yes` together with `--no-input`
   (*Choose only one runtime install mode*); `ktx setup` accepts both. Use
   `--no-input` only for ingest. Do not run `--deep` ingest unless the user
   explicitly asks for LLM-backed enrichment.

5. **Install agent integration:**

   ```bash
   ktx setup --agents --target <claude-code|claude-desktop|codex|cursor|opencode|universal>
   ktx mcp start --project-dir <path>
   ```

   Agent integration is **not usable until `ktx mcp start` is running**. The
   `--agents` step prints this requirement as `Required before using agents`.

6. **Fall back to bare `ktx setup` only when a human is at the keyboard** —
   it uses interactive prompts an agent cannot answer.

## Add context sources

Context sources (dbt, Metabase, Looker, LookML, MetricFlow, Notion) are added
**one at a time** — `--source` is not repeatable, so run `ktx setup` once per
source. Source setup is resumable against an existing project: pass
`--skip-databases --skip-llm --skip-embeddings` so only the source is
configured. Map warehouse-backed sources (dbt, Metabase, Looker) to an existing
database connection with `--source-warehouse-connection-id <db-connection-id>`.
Prefer `env:VAR` / `file:/abs/path` refs for keys and tokens over literals.

```bash
# dbt — pick exactly one of --source-path (local) or --source-git-url (remote)
ktx setup --no-input --yes --skip-databases --skip-llm --skip-embeddings \
  --source dbt --source-connection-id <id> \
  --source-git-url <url> --source-branch <branch> \
  --source-warehouse-connection-id <db-connection-id>

# Metabase
ktx setup --no-input --yes --skip-databases --skip-llm --skip-embeddings \
  --source metabase --source-connection-id <id> \
  --source-url <url> --source-api-key-ref env:METABASE_API_KEY \
  --source-warehouse-connection-id <db-connection-id> \
  --metabase-database-id <metabase-db-id>

# Notion
ktx setup --no-input --yes --skip-databases --skip-llm --skip-embeddings \
  --source notion --source-connection-id <id> \
  --source-api-key-ref env:NOTION_TOKEN \
  --notion-crawl-mode selected_roots --notion-root-page-id <page-id>
```

Notes:

- `--metabase-database-id` is the **numeric id of the warehouse inside
  Metabase** (not the ktx connection id). Discover it from the Metabase API
  (`GET /api/database`) or UI if the user doesn't know it.
- `--notion-crawl-mode selected_roots` requires at least one
  `--notion-root-page-id` (repeatable); use `all_accessible` to crawl
  everything the token can see.
- After adding sources, ingest each new connection so its context is queryable:
  `ktx ingest <source-connection-id> --fast --no-input`.

## Files to inspect

- `ktx.yaml`: project configuration.
- `.ktx/secrets/*`: local secret files. Never commit them.
- `semantic-layer/<connection-id>/*.yaml`: semantic sources for SQL
  compilation.
- `wiki/**/*.md`: project context pages for agents.
- `.claude/skills/ktx/`, `.agents/skills/ktx/`, `.cursor/rules/ktx.mdc`, and
  `.opencode/commands/ktx.md`: generated agent integration files.

## Verification

After setup, run:

```bash
ktx connection test <connection-id>
ktx status --json --no-input
```

**Judge readiness from `ktx status --json` fields, not the exit code.**
`ktx status` exits 1 whenever the LLM is `none`, even when embeddings and
every database connection are healthy. Treat success as:

- `verdict: "ready"` at the top of the JSON, and
- every `connections[].status === "ok"`, and
- every `ktx connection test <id>` exited 0.

A non-zero exit with only the LLM unconfigured is still a usable context
layer — report it as "ready, LLM optional" rather than retrying setup.

## Troubleshooting

For known failure signatures (`invalid ELF header`,
`Native CLI binary for <plat> not found`, `Missing Anthropic API key`,
`claude-code` probe failure, `KTX cannot work without a database` on resume),
see [troubleshooting.md](troubleshooting.md).

## Final report

End setup work with a concise report:

```text
ktx SETUP COMPLETE

Project:     <path>
LLM:         <backend> / <model>
Embeddings:  <backend> / <model>
Connections: <name> (<driver>) status=<ok|warn|fail>
Sources:     <list or none>
Verdict:     <ready|needs action>

Next:
1. <copy-pasteable command or action>
2. <copy-pasteable command or action>

RESULT: PASS
```
