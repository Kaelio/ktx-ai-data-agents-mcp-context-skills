# Agent-Friendly Docs Site Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `docs-site` discoverable and readable by coding agents through `llms.txt`, bundled markdown, per-page markdown routes, markdown negotiation, and stricter agent-friendly docs content.

**Architecture:** Keep the existing Next 15 + Fumadocs app. Add a small `lib/llm-docs.ts` module that reads Fumadocs pages and builds machine-readable markdown responses, then expose those responses through route handlers and a markdown negotiation proxy. Rewrite existing MDX pages in place so the rendered UI and machine-readable routes share one source of truth.

**Tech Stack:** Next.js 15 App Router, Fumadocs, MDX, TypeScript, pnpm, Node 22.

---

### Task 1: Machine-Readable Docs Routes

**Files:**
- Create: `docs-site/lib/llm-docs.ts`
- Create: `docs-site/app/llms.txt/route.ts`
- Create: `docs-site/app/llms-full.txt/route.ts`
- Create: `docs-site/app/llms.mdx/docs/[[...slug]]/route.ts`
- Modify: `docs-site/next.config.mjs`

- [ ] **Step 1: Add the LLM docs utility**

Create `docs-site/lib/llm-docs.ts` with functions that:

```ts
import { source } from "@/lib/source";

const SITE_ORIGIN = "https://ktx.dev";

export type LlmDocsPage = {
  title: string;
  description?: string;
  url: string;
  markdownUrl: string;
  slug: string[];
  getMarkdown: () => Promise<string>;
};

export function getLlmDocsPages(): LlmDocsPage[] {
  return source.getPages().map((page) => ({
    title: page.data.title,
    description: page.data.description,
    url: page.url,
    markdownUrl: `${page.url}.md`,
    slug: page.slugs,
    getMarkdown: async () => normalizeMarkdown(await page.data.getText("raw")),
  }));
}

export function getLlmDocsPage(slug: string[] | undefined) {
  const page = source.getPage(slug);
  if (!page) return null;

  return {
    title: page.data.title,
    description: page.data.description,
    url: page.url,
    markdownUrl: `${page.url}.md`,
    slug: page.slugs,
    getMarkdown: async () => normalizeMarkdown(await page.data.getText("raw")),
  } satisfies LlmDocsPage;
}

export async function getPageMarkdown(page: LlmDocsPage) {
  const body = await page.getMarkdown();
  const description = page.description ? `\n\n> ${page.description}` : "";

  return `# ${page.title}${description}\n\nCanonical URL: ${page.url}\nMarkdown URL: ${page.markdownUrl}\n\n${body}`;
}

export function buildLlmsTxt() {
  const pages = getLlmDocsPages();
  const byUrl = new Map(pages.map((page) => [page.url, page]));
  const link = (url: string, label: string, fallbackDescription: string) => {
    const page = byUrl.get(url);
    const description = page?.description ?? fallbackDescription;
    return `- [${label}](${url}): ${description}`;
  };

  return `# KTX

> Agent-native context layer for analytics engineering and database agents.

KTX provides semantic-layer files, warehouse scans, knowledge pages, provenance, and agent-facing tools that help coding agents answer analytics questions without inventing metrics or joins.

## Start Here

${link("/docs/getting-started/introduction", "Introduction", "What KTX is and who it is for")}
${link("/docs/getting-started/quickstart", "Quickstart", "Set up KTX and build your first context")}
${link("/docs/guides/serving-agents", "Serving Agents", "Expose KTX context through MCP and CLI tools")}
${link("/docs/guides/writing-context", "Writing Context", "Write semantic sources and knowledge pages")}

## Machine-Readable Documentation

- [Full documentation](/llms-full.txt): All docs pages in one plain-text markdown response
- [Quickstart markdown](/docs/getting-started/quickstart.md): Raw markdown for the setup guide
- [Agent CLI markdown](/docs/cli-reference/ktx-agent.md): Raw markdown for machine-readable agent commands
- [Serving Agents markdown](/docs/guides/serving-agents.md): Raw markdown for MCP and CLI workflows

## CLI Reference

${link("/docs/cli-reference/ktx-setup", "ktx setup", "Interactive project setup")}
${link("/docs/cli-reference/ktx-agent", "ktx agent", "Machine-readable commands for coding agents")}
${link("/docs/cli-reference/ktx-sl", "ktx sl", "Semantic-layer commands")}
${link("/docs/cli-reference/ktx-wiki", "ktx wiki", "Knowledge page commands")}
${link("/docs/cli-reference/ktx-connection", "ktx connection", "Connection management commands")}

## Integrations

${link("/docs/integrations/agent-clients", "Agent Clients", "Configure Claude Code, Cursor, Codex, and OpenCode")}
${link("/docs/integrations/primary-sources", "Primary Sources", "Connect KTX to databases and warehouses")}
${link("/docs/integrations/context-sources", "Context Sources", "Ingest dbt, LookML, Metabase, Looker, MetricFlow, and Notion")}
`;
}

export async function buildLlmsFullTxt() {
  const pages = getLlmDocsPages();
  const rendered = await Promise.all(pages.map(getPageMarkdown));
  return [`# KTX Full Documentation`, `Source: ${SITE_ORIGIN}`, ...rendered].join("\n\n---\n\n");
}

function normalizeMarkdown(markdown: string) {
  return markdown.trim().replace(/\n{3,}/g, "\n\n");
}
```

- [ ] **Step 2: Add route handlers**

Create route files:

```ts
import { buildLlmsTxt } from "@/lib/llm-docs";

export const dynamic = "force-static";

export function GET() {
  return new Response(buildLlmsTxt(), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
```

```ts
import { buildLlmsFullTxt } from "@/lib/llm-docs";

export const dynamic = "force-static";

export async function GET() {
  return new Response(await buildLlmsFullTxt(), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
```

```ts
import { getLlmDocsPage, getPageMarkdown } from "@/lib/llm-docs";
import { notFound } from "next/navigation";

export const dynamic = "force-static";

export async function GET(
  _request: Request,
  props: { params: Promise<{ slug?: string[] }> },
) {
  const params = await props.params;
  const page = getLlmDocsPage(params.slug);
  if (!page) notFound();

  return new Response(await getPageMarkdown(page), {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
}

export function generateStaticParams() {
  return getLlmDocsPages().map((page) => ({ slug: page.slug }));
}
```

- [ ] **Step 3: Add `.md` rewrite**

Modify `docs-site/next.config.mjs`:

```js
import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  async rewrites() {
    return [
      {
        source: "/docs/:path*.md",
        destination: "/llms.mdx/docs/:path*",
      },
    ];
  },
};

export default withMDX(config);
```

- [ ] **Step 4: Build check**

Run: `pnpm --filter ktx-docs build`

Expected: Next build completes and static routes include `llms.txt`, `llms-full.txt`, and the LLM markdown route.

### Task 2: Markdown Negotiation

**Files:**
- Create: `docs-site/proxy.ts`

- [ ] **Step 1: Add markdown negotiation proxy**

Create `docs-site/proxy.ts`:

```ts
import { isMarkdownPreferred, rewritePath } from "fumadocs-core/negotiation";
import { NextResponse, type NextRequest } from "next/server";

const { rewrite } = rewritePath("/docs/*path", "/llms.mdx/docs/*path");

export function proxy(request: NextRequest) {
  if (!isMarkdownPreferred(request)) {
    return NextResponse.next();
  }

  const rewrittenPath = rewrite(request.nextUrl.pathname);
  if (!rewrittenPath) {
    return NextResponse.next();
  }

  return NextResponse.rewrite(new URL(rewrittenPath, request.nextUrl));
}

export const config = {
  matcher: ["/docs/:path*"],
};
```

- [ ] **Step 2: Verify build**

Run: `pnpm --filter ktx-docs build`

Expected: Build passes with the proxy included.

### Task 3: Agent-Friendly High-Priority Guides

**Files:**
- Modify: `docs-site/content/docs/getting-started/quickstart.mdx`
- Modify: `docs-site/content/docs/guides/serving-agents.mdx`
- Modify: `docs-site/content/docs/guides/writing-context.mdx`

- [ ] **Step 1: Rewrite quickstart structure**

Add sections for:

- Workflow summary
- Generated files
- Common errors and recovery

Keep existing setup detail, but make each command block copy-pasteable and each expected output complete enough for agents to recognize success.

- [ ] **Step 2: Rewrite Serving Agents as API reference**

Add tables for MCP tool inputs and CLI command inputs. Add workflows:

- Answer an analytics question through MCP
- Answer an analytics question through CLI
- Safely execute SQL with row limits

- [ ] **Step 3: Rewrite Writing Context with schemas and workflows**

Add semantic-source field tables, knowledge-page field tables, and workflows:

- Inspect a source
- Edit and validate a source
- Query through the semantic layer
- Write and search a knowledge page

- [ ] **Step 4: Build check**

Run: `pnpm --filter ktx-docs build`

Expected: MDX compiles without syntax errors.

### Task 4: CLI Reference Normalization

**Files:**
- Modify: `docs-site/content/docs/cli-reference/*.mdx`

- [ ] **Step 1: Normalize every CLI page**

For each CLI reference page, ensure this structure exists:

```md
## Command signature

```bash
ktx <command> [subcommand] [options]
```

## Subcommands

| Subcommand | Description |
|---|---|

## Options

| Flag | Type | Required | Description | Default |
|---|---|---|---|---|

## Examples

```bash
ktx <real-command> --real-flag realistic-value
```

## Output

```text
complete expected output shape
```

## Common errors

| Error | Cause | Recovery |
|---|---|---|
```

Only add sections that are relevant to the command; do not invent output for commands whose output is intentionally interactive.

- [ ] **Step 2: Build check**

Run: `pnpm --filter ktx-docs build`

Expected: MDX compiles without syntax errors.

### Task 5: Integration and Concept Page Polish

**Files:**
- Modify: `docs-site/content/docs/integrations/agent-clients.mdx`
- Modify: `docs-site/content/docs/integrations/primary-sources.mdx`
- Modify: `docs-site/content/docs/integrations/context-sources.mdx`
- Modify: `docs-site/content/docs/concepts/*.mdx`
- Modify: `docs-site/content/docs/benchmarks/link-detection.mdx`

- [ ] **Step 1: Normalize integrations**

Add structured sections for supported values, config snippets, authentication, generated files, and recovery notes. Keep existing examples aligned with current KTX commands.

- [ ] **Step 2: Add agent usage notes**

For concept and benchmark pages, add a compact `## Agent usage notes` section that tells agents when the page is relevant and which concrete page to read next.

- [ ] **Step 3: Build check**

Run: `pnpm --filter ktx-docs build`

Expected: MDX compiles without syntax errors.

### Task 6: Route Verification and Final Checks

**Files:**
- No required source changes unless verification finds a bug.

- [ ] **Step 1: Run production build**

Run: `pnpm --filter ktx-docs build`

Expected: Build succeeds.

- [ ] **Step 2: Run TypeScript check**

Run: `pnpm --filter ktx-docs exec tsc --noEmit`

Expected: TypeScript exits successfully.

- [ ] **Step 3: Start local server**

Run: `pnpm --filter ktx-docs start`

Expected: Server starts on an available port.

- [ ] **Step 4: Verify machine-readable routes**

Run:

```bash
curl -i http://localhost:3000/llms.txt
curl -i http://localhost:3000/llms-full.txt
curl -i http://localhost:3000/docs/getting-started/quickstart.md
curl -i -H "Accept: text/markdown" http://localhost:3000/docs/getting-started/quickstart
curl -i http://localhost:3000/docs/not-a-page.md
```

Expected:

- `/llms.txt`: `200`, `Content-Type: text/plain; charset=utf-8`
- `/llms-full.txt`: `200`, `Content-Type: text/plain; charset=utf-8`
- `/docs/getting-started/quickstart.md`: `200`, `Content-Type: text/markdown; charset=utf-8`
- `/docs/getting-started/quickstart` with `Accept: text/markdown`: `200`, `Content-Type: text/markdown; charset=utf-8`
- `/docs/not-a-page.md`: `404`

- [ ] **Step 5: Inspect final diff**

Run: `git diff --stat && git diff --check`

Expected: Diff contains only docs-site and plan changes, with no whitespace errors.
