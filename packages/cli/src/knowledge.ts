import {
  createLocalKtxEmbeddingProviderFromConfig,
  KtxIngestEmbeddingPortAdapter,
  type KtxEmbeddingPort,
} from '@ktx/context';
import { loadKtxProject } from '@ktx/context/project';
import {
  type LocalKnowledgeSearchResult,
  type LocalKnowledgeSummary,
  listLocalKnowledgePages,
  searchLocalKnowledgePages,
} from '@ktx/context/wiki';
import { resolveOutputMode } from './io/mode.js';
import { printList, type PrintListColumn } from './io/print-list.js';

export type KtxKnowledgeArgs =
  | { command: 'list'; projectDir: string; userId: string; output?: string; json?: boolean }
  | {
      command: 'search';
      projectDir: string;
      query: string;
      userId: string;
      output?: string;
      json?: boolean;
      limit?: number;
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
    return 0;
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
