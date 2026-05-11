import { source } from "@/lib/source";

const siteOrigin = "https://ktx.dev";

export type LlmDocsPage = {
  title: string;
  description?: string;
  url: string;
  markdownUrl: string;
  slug: string[];
  getMarkdown: () => Promise<string>;
};

export function getLlmDocsPages(): LlmDocsPage[] {
  return source.getPages().map(toLlmDocsPage);
}

export function getLlmDocsPage(slug: string[] | undefined) {
  const page = source.getPage(slug);
  return page ? toLlmDocsPage(page) : null;
}

export async function getPageMarkdown(page: LlmDocsPage) {
  const description = page.description ? `\n\n> ${page.description}` : "";
  const body = await page.getMarkdown();

  return normalizeMarkdown(`# ${page.title}${description}

Canonical URL: ${page.url}
Markdown URL: ${page.markdownUrl}

${body}
`);
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
  const rendered = await Promise.all(getLlmDocsPages().map(getPageMarkdown));
  return [`# KTX Full Documentation`, `Source: ${siteOrigin}`, ...rendered].join(
    "\n\n---\n\n",
  );
}

function toLlmDocsPage(page: ReturnType<typeof source.getPages>[number]) {
  return {
    title: page.data.title,
    description: page.data.description,
    url: page.url,
    markdownUrl: `${page.url}.md`,
    slug: page.slugs,
    getMarkdown: async () => normalizeMarkdown(page.data.content),
  } satisfies LlmDocsPage;
}

function normalizeMarkdown(markdown: string) {
  return markdown.trim().replace(/\n{3,}/g, "\n\n");
}
