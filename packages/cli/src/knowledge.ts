import {
  createLocalKtxEmbeddingProviderFromConfig,
  KtxIngestEmbeddingPortAdapter,
  type KtxEmbeddingPort,
} from '@ktx/context';
import { loadKtxProject } from '@ktx/context/project';
import {
  type LocalKnowledgeScope,
  type LocalKnowledgeSearchResult,
  type LocalKnowledgeSummary,
  listLocalKnowledgePages,
  readLocalKnowledgePage,
  searchLocalKnowledgePages,
  writeLocalKnowledgePage,
} from '@ktx/context/wiki';
import { resolveOutputMode } from './io/mode.js';
import { printList, type PrintListColumn, writeJsonResult } from './io/print-list.js';

export type KtxKnowledgeArgs =
  | { command: 'list'; projectDir: string; userId: string; output?: string; json?: boolean }
  | { command: 'read'; projectDir: string; key: string; userId: string; json?: boolean }
  | {
      command: 'search';
      projectDir: string;
      query: string;
      userId: string;
      output?: string;
      json?: boolean;
      limit?: number;
    }
  | {
      command: 'write';
      projectDir: string;
      key: string;
      scope: LocalKnowledgeScope;
      userId: string;
      summary: string;
      content: string;
      tags: string[];
      refs: string[];
      slRefs: string[];
    };

type KtxKnowledgeIo = import('./cli-runtime.js').KtxCliIo;

const WIKI_LIST_COLUMNS: ReadonlyArray<PrintListColumn<LocalKnowledgeSummary>> = [
  { key: 'scope', label: 'SCOPE', plain: '' },
  { key: 'key', label: 'KEY', plain: '' },
  { key: 'summary', label: 'SUMMARY', plain: '', optional: true, dim: true },
];

const WIKI_SEARCH_COLUMNS: ReadonlyArray<PrintListColumn<LocalKnowledgeSearchResult>> = [
  {
    key: 'score',
    label: 'SCORE',
    plain: 'score=',
    role: 'badge',
    prettyFormat: (value) => `${Math.round(Number(value) * 100)}%`,
    dim: true,
  },
  { key: 'scope', label: 'SCOPE', plain: '' },
  { key: 'key', label: 'KEY', plain: '' },
  { key: 'summary', label: 'SUMMARY', plain: '', optional: true, dim: true },
];

interface KtxKnowledgeDeps {
  embeddingService?: KtxEmbeddingPort | null;
  createEmbeddingProvider?: typeof createLocalKtxEmbeddingProviderFromConfig;
}

function wikiSearchEmbeddingService(
  project: Awaited<ReturnType<typeof loadKtxProject>>,
  deps: KtxKnowledgeDeps,
): KtxEmbeddingPort | null {
  if ('embeddingService' in deps) {
    return deps.embeddingService ?? null;
  }
  const provider = (deps.createEmbeddingProvider ?? createLocalKtxEmbeddingProviderFromConfig)(
    project.config.ingest.embeddings,
  );
  return provider ? new KtxIngestEmbeddingPortAdapter(provider) : null;
}

export async function runKtxKnowledge(
  args: KtxKnowledgeArgs,
  io: KtxKnowledgeIo = process,
  deps: KtxKnowledgeDeps = {},
): Promise<number> {
  try {
    const project = await loadKtxProject({ projectDir: args.projectDir });
    if (args.command === 'list') {
      const pages = await listLocalKnowledgePages(project, { userId: args.userId });
      const mode = resolveOutputMode({ explicit: args.output, json: args.json, io });
      printList<LocalKnowledgeSummary>({
        rows: pages,
        columns: WIKI_LIST_COLUMNS,
        groupBy: 'scope',
        emptyMessage: `No local wiki pages found in ${project.projectDir}`,
        emptyHint: 'Add Markdown files under wiki/ or run `ktx ingest <connectionId>`.',
        unit: 'page',
        command: 'wiki list',
        mode,
        io,
      });
      return 0;
    }
    if (args.command === 'read') {
      const page = await readLocalKnowledgePage(project, { key: args.key, userId: args.userId });
      if (!page) {
        throw new Error(`Wiki page "${args.key}" was not found`);
      }
      if (args.json) {
        writeJsonResult(io, {
          kind: 'wiki.page',
          data: page,
          meta: { command: 'wiki read' },
        });
        return 0;
      }
      io.stdout.write(`# ${page.key}\n\n`);
      io.stdout.write(`Scope: ${page.scope}\n`);
      io.stdout.write(`Summary: ${page.summary}\n\n`);
      io.stdout.write(`${page.content}\n`);
      return 0;
    }
    if (args.command === 'search') {
      const results = await searchLocalKnowledgePages(project, {
        query: args.query,
        userId: args.userId,
        embeddingService: wikiSearchEmbeddingService(project, deps),
        limit: args.limit,
      });
      const mode = resolveOutputMode({ explicit: args.output, json: args.json, io });
      let emptyMessage = `No local wiki pages matched "${args.query}"`;
      let emptyHint = 'Run `ktx wiki list` to inspect available pages.';
      if (results.length === 0 && mode !== 'json') {
        const pages = await listLocalKnowledgePages(project, { userId: args.userId });
        if (pages.length === 0) {
          emptyMessage = `No local wiki pages found in ${project.projectDir}`;
          emptyHint = 'Add Markdown files under wiki/ or run `ktx ingest <connectionId>`.';
        }
      }
      printList<LocalKnowledgeSearchResult>({
        rows: results,
        columns: WIKI_SEARCH_COLUMNS,
        groupBy: 'scope',
        emptyMessage,
        emptyHint,
        unit: 'page',
        command: 'wiki search',
        mode,
        io,
      });
      return 0;
    }

    const write = await writeLocalKnowledgePage(project, {
      key: args.key,
      scope: args.scope,
      userId: args.userId,
      summary: args.summary,
      content: args.content,
      tags: args.tags,
      refs: args.refs,
      slRefs: args.slRefs,
    });
    io.stdout.write(`Wrote ${write.path}\n`);
    return 0;
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
