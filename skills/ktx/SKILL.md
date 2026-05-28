---
name: ktx
description: Use when installing, configuring, verifying, or debugging ktx in a project, including ktx setup, ktx.yaml, database connectors, embeddings, agent integration, ingest, and ktx status checks.
---

# ktx

Install and configure **ktx**, the open-source context layer for data agents.
Use this skill when a user wants an agent to add **ktx** to a project, connect
data sources, build initial context, install agent rules, or troubleshoot a
local **ktx** setup.

## Operating rules

- Act autonomously when the user asks you to install or configure **ktx**.
- Ask only for choices or values you cannot infer: project directory,
  connection targets, credentials, account identifiers, and source selections.
- Never ask the user to paste secrets when an `env:VAR_NAME` or `file:/path`
  reference would work.
- Do not commit `.ktx/secrets/*` or pasted credentials.
- Verify CLI flags and config keys with `ktx --help`, `ktx <command> --help`,
  or the docs at `https://docs.kaelio.com/ktx/` before using unfamiliar
  options.
- Print or report each command you run and its result when doing setup work.
- If a command fails, identify the cause and change something before retrying.

## Install workflow

Use this workflow for a new or resumed project setup:

1. Confirm the project directory. Default to the current working directory.
2. Check prerequisites:
   - Node.js with `node --version`; require Node 22 or newer.
   - `uv` with `uv --version`; install it only if missing and local Python
     runtime features are needed.
   - **ktx** with `ktx --version`; install the published CLI if missing.
3. Install the published CLI when needed:

   ```bash
   npm install -g @kaelio/ktx
   ```

4. Run interactive setup when the user is present:

   ```bash
   ktx setup
   ```

5. For scripted setup, prefer `ktx setup --no-input --yes` with explicit flags.
   Verify exact flags with `ktx setup --help` and the docs first.
6. Configure one new database connection per scripted setup command. For
   multiple connections, rerun setup once per connection.
7. Run fast ingest by default. Do not run deep ingest unless the user asks for
   LLM-backed enrichment.
8. Install or repair agent integration after project setup:

   ```bash
   ktx setup --agents
   ```

9. Verify readiness:

   ```bash
   ktx status
   ```

   Use `ktx status --json` when you need structured success criteria.

## Common setup choices

Default choices are usually:

- LLM: `claude-code` if the user is already running Claude Code, otherwise ask.
- Embeddings: `sentence-transformers` for local embeddings with no API key, or
  `openai` when the user wants hosted embeddings and has an API key.
- Databases: SQLite, PostgreSQL, MySQL, SQL Server, BigQuery, Snowflake, or
  ClickHouse.
- Context sources: dbt, MetricFlow, LookML, Looker, Metabase, or Notion.

Use `env:` or `file:` references for credentials:

```bash
ktx setup \
  --project-dir ./analytics \
  --no-input \
  --yes \
  --database postgres \
  --database-connection-id warehouse \
  --database-url env:DATABASE_URL \
  --database-schema public
```

Then build or refresh fast context if setup did not already do it:

```bash
ktx ingest warehouse --fast --no-input
```

## Files to inspect

- `ktx.yaml`: project configuration.
- `.ktx/secrets/*`: local secret files. Never commit them.
- `semantic-layer/<connection-id>/*.yaml`: semantic sources for SQL
  compilation.
- `wiki/**/*.md`: project context pages for agents.
- `.claude/skills/ktx/`, `.agents/skills/ktx/`, `.cursor/rules/ktx.mdc`, and
  `.opencode/commands/ktx.md`: generated agent integration files.

## Verification

After setup, run the smallest checks that cover the configured surface:

```bash
ktx connection test <connection-id>
ktx status --json
```

Success means the project is ready, configured connections report healthy, and
the agent integration target requested by the user is installed. If fast setup
completed but deep context readiness is still missing, report that as the next
optional enrichment step rather than retrying setup unchanged.

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
