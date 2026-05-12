# Agent-Friendly Docs Site Design

## Goal

Make `docs-site` easier for coding agents and LLM readers to discover, ingest,
and use. The work applies the Vercel Academy agent-friendly docs patterns to the
KTX documentation site while preserving the current Fumadocs + Next.js
architecture.

Success means agents can:

- Discover the documentation from well-known root files.
- Fetch all documentation in one plain-text response.
- Fetch any docs page as markdown without parsing the HTML UI.
- Follow CLI, MCP, setup, integration, and semantic-layer workflows from
  structured examples.
- Recover from common setup and command failures using explicit troubleshooting
  notes.

## Current State

`docs-site` is a Next 15 app using Fumadocs. Source pages live under
`docs-site/content/docs`, and rendered docs are served under `/docs`.

The site currently has good human-facing MDX pages, but it does not expose:

- `/llms.txt`
- `/llms-full.txt`
- raw markdown routes such as `/docs/getting-started/quickstart.md`
- markdown content negotiation

Many docs pages already use tables and code blocks, but the structure is not
consistently optimized for literal agent parsing. CLI and agent-facing pages are
the highest-priority content because agents are most likely to copy commands and
JSON examples directly.

## Design

### Machine-readable access

Add a small LLM docs utility layer inside `docs-site`:

- `docs-site/lib/llm-docs.ts`
  - Converts Fumadocs pages to raw or LLM-readable markdown.
  - Builds a stable ordered list of docs pages from `source.getPages()`.
  - Produces the `llms.txt` index content.
  - Produces the `llms-full.txt` bundled content.

Add routes:

- `docs-site/app/llms.txt/route.ts`
  - Returns `text/plain; charset=utf-8`.
  - Includes `# KTX`, a blockquote summary, a short description, and sections
    linking to key docs, markdown docs, CLI reference pages, integration pages,
    and `/llms-full.txt`.

- `docs-site/app/llms-full.txt/route.ts`
  - Returns `text/plain; charset=utf-8`.
  - Concatenates all docs pages in source order.
  - Prefixes each page with a stable heading and canonical `/docs/...` URL.

- `docs-site/app/llms.mdx/docs/[[...slug]]/route.ts`
  - Returns one docs page as `text/markdown; charset=utf-8`.
  - Uses the same slug shape as `/docs/[[...slug]]`.
  - Returns 404 for unknown pages.

Add a Next rewrite in `docs-site/next.config.mjs`:

- `/docs/:path*.md` rewrites to `/llms.mdx/docs/:path*`

Add a markdown negotiation proxy for `/docs/...` requests:

- Requests whose `Accept` header prefers markdown are rewritten to the matching
  LLM markdown route.
- Normal browser requests continue to render the existing Fumadocs UI.
- The proxy must leave `/llms.txt`, `/llms-full.txt`, assets, and non-docs
  routes unchanged.

### Content rewrite pass

Rewrite the existing MDX content in a bounded, high-impact pass. The intent is
not to expand every page; it is to make every page more literal and consistent
for agents.

Apply these patterns across docs:

- Put command signatures in fenced code blocks.
- Use tables for flags, options, inputs, outputs, supported values, and
  environment variables.
- Use realistic values in copy-paste examples.
- Show complete expected command output when output shape matters.
- Add explicit "Common errors" or "Recovery" sections for workflows where a
  command can fail for predictable reasons.
- Add workflow sections that chain commands in the order an agent should use
  them.
- Avoid placeholders that an agent could copy literally, unless the placeholder
  is clearly marked as a value to replace.

Priority pages:

1. `getting-started/quickstart.mdx`
   - Add a compact workflow summary.
   - Make prerequisites and generated files explicit.
   - Add troubleshooting for missing API keys, failed connection tests, daemon
     startup, and unbuilt context.

2. `guides/serving-agents.mdx`
   - Treat MCP tools and `ktx agent` commands as agent-facing API references.
   - Add tool/command input tables, output expectations, safety constraints, and
     workflows for answering analytics questions.

3. `guides/writing-context.mdx`
   - Add semantic-source schema tables.
   - Add workflows for listing, reading, editing, validating, querying, and
     writing wiki knowledge.

4. `cli-reference/*.mdx`
   - Normalize every command page to: command signature, subcommands table,
     option tables, examples, output modes, common errors, and related workflows
     where useful.

5. `integrations/agent-clients.mdx`, `integrations/primary-sources.mdx`, and
   `integrations/context-sources.mdx`
   - Normalize integration setup sections into structured config tables,
     copy-paste examples, authentication requirements, and recovery notes.

6. Concept and benchmark pages
   - Keep narrative content, but add compact "Agent usage notes" where it helps
     agents decide when to read or cite the page.

### Documentation boundaries

The first pass should not introduce a separate public docs tree or a generated
API reference system. It should work with the existing MDX source files and
Fumadocs loader.

Do not add stale compatibility aliases or rename KTX concepts. Keep examples
aligned with commands and files that exist in the standalone KTX repository.

### Testing

Verification commands:

- `pnpm --filter ktx-docs build`
- `pnpm --filter ktx-docs exec tsc --noEmit` after generated Fumadocs source
  files exist.
- Route checks against a local docs server:
  - `GET /llms.txt` returns 200 and `text/plain`.
  - `GET /llms-full.txt` returns 200 and `text/plain`.
  - `GET /docs/getting-started/quickstart.md` returns 200 and
    `text/markdown`.
  - unknown markdown docs paths return 404.

For content checks, inspect the generated markdown responses to confirm they
contain:

- realistic command examples,
- tables,
- full output examples where documented,
- workflow sections,
- recovery/error sections.

## Acceptance Criteria

- `/llms.txt` gives agents a concise index with links to key KTX docs and
  `/llms-full.txt`.
- `/llms-full.txt` returns all docs content in source order as plain text.
- Every Fumadocs page can be fetched through a `.md` URL.
- High-priority docs pages use consistent agent-friendly structure.
- The docs site builds successfully.
- Verification results and any skipped checks are reported clearly.
