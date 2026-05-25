# ktx Terminology Rules

Canonical vocabulary for coding agents working on this repository. Applies to
docs prose, code comments, identifiers, CLI strings, error messages, log lines,
and example output.

For product-name capitalization rules (`ktx` vs `**ktx**` vs code font), see the
`Product Naming` section of `AGENTS.md` — those rules take precedence over
anything below when they conflict.

## The "source" rule

`source` does four different jobs in this codebase. Never write bare `source`
in prose when ambiguity is possible. Always qualify:

- **semantic source** — the YAML file that describes a table
- **primary source** — the connected database
- **context source** — the analytics-tooling integration (dbt, Metabase, etc.)
- **source of truth** — the canonical place a fact lives

Bare `source` is allowed only inside a section that has already established its
referent (e.g., body of a `Semantic sources` page, or `sourceName` as a CLI arg).

## Canonical vocabulary

| Concept | Use | Do not use |
|---|---|---|
| AI consumer (general prose) | **data agent** | analytics agent, database agent, client agent |
| AI consumer (Integrations nav) | **agent client** | client agent |
| Coding-tool framing (user-facing) | **coding agent** | — |
| The connected database | **primary source** / **database connection** | data source |
| Analytics-tooling integration | **context source** / **context-source connection** | BI source, BI model, metadata source, source tool |
| YAML file describing a table | **semantic source** | semantic-layer source, model file, bare "source file" |
| The whole **ktx** surface | **context layer** (lowercase in prose) | "Context Layer" in prose |
| The compiler pillar | **semantic layer** (lowercase in prose) | "Semantic Layer" in prose |
| The query payload | **semantic query** (lowercase in prose) | "Semantic Query" |
| The MCP layer | **MCP server** (the server), **MCP tools** (the functions) | "ktx MCP" as a standalone noun |
| The plugin/implementation | **connector** (prefix with **primary** or **context** when contrasting) | adapter, driver-as-noun |
| Config field value | `driver` (code font only) | `driver` as a generic noun |
| Merge step | **reconcile** / **reconciliation** / **reconciliation agent** | "merge intelligently", bare "LLM agent" |
| Connection ref in prose | **connection id** (lowercase, two words) | "connection ID" |
| CLI arg/flag literal | `connectionId` (code font) | — |
| File path placeholder | `<connection-id>` (code font) | — |
| Fast schema mode | **fast ingest** | schema ingest, schema-only ingest |
| AI-enriched mode | **deep ingest** | AI-enriched ingest |
| Ingest of a primary connection | **database ingest** | — |
| Ingest of a context-source connection | **context-source ingest** | bare "source ingest" |
| Wiki capture | **text ingest** | — |
| Query-history sub-mode | **query-history ingest** | — |
| SQL compilation | **compile** / **the compiler** / **SQL compilation** | "SQL generation" |
| Internal stage inside compilation | **planner** / **planning** (only in semantic-layer-internals) | — |
| Setup flow noun | **setup wizard** | "the wizard" (bare) |
| Setup flow contrast | **interactive setup** (vs non-interactive / flag-driven) | "interactive command" |
| The whole project | **ktx project** | "KTX project" (all caps) |
| The filesystem path | **project directory** | "project dir" |
| Wiki surface as a whole | **wiki** | "wiki context" |
| A single Markdown file | **wiki page** | — |
| YAML vs Markdown contrast | **wiki Markdown** (only when contrasting with **semantic source YAML**) | — |
| Joins multiplying rows (generic) | **fanout** | — |
| The two named patterns | **chasm trap** / **fan trap** | — |
| Casual gloss in user prose | **double-count** | (avoid in technical/internals prose) |

## Prose rules

- **Article + ktx.** Treat `ktx` as a bare proper noun, no article: `ktx
  is...`, `in ktx`. Articles attach to the *following* noun, not to `ktx`:
  `the **ktx** MCP server`, `the **ktx** project`.
- **Capitalization.** Default lowercase for `context layer`, `semantic layer`,
  `semantic query`. Title case only inside literal page titles or H1 headings.
- **Code font.** Reserve code font for the CLI command, binary, paths, config
  field values (e.g. `driver: postgres`), CLI arg/flag literals
  (`connectionId`, `--project-dir`), and path placeholders (`<connection-id>`).
  Do not use code font for prose nouns like *connector* or *reconciliation*.
- **`driver` is never a prose noun.** Always `driver: postgres` (code font, as
  a config field value). For the noun, use `connector`.

## Canonical lists

Use these orderings verbatim when listing supported systems:

- **Primary sources:** PostgreSQL, Snowflake, BigQuery, ClickHouse, MySQL, SQL
  Server, SQLite
- **Context sources:** dbt, MetricFlow, LookML, Looker, Metabase, Notion

If a doc or string omits or reorders members of either list, treat that as a
bug unless the surrounding text justifies the change.

## When updating this file

- Add a new row to the canonical vocabulary table; do not introduce a parallel
  glossary elsewhere.
- If you rename a converged term, search the workspace for the previous form
  and update call sites in the same change.
- When deprecating a term, add it to the *Do not use* column with a one-line
  reason in the surrounding prose, not just in the table.
