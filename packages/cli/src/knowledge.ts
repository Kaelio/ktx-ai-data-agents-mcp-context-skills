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
import { createRankBadgeFormatter, printList, type PrintListColumn } from './io/print-list.js';

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
      debug?: boolean;
    };

type KtxKnowledgeIo = import('./cli-runtime.js').KtxCliIo;

const WIKI_LIST_COLUMNS: ReadonlyArray<PrintListColumn<LocalKnowledgeSummary>> = [
  { key: 'scope', label: 'SCOPE', plain: '' },
  { key: 'key', label: 'KEY', plain: '' },
  { key: 'summary', label: 'SUMMARY', plain: '', optional: true, dim: true },
];

function wikiSearchColumns(
  rows: ReadonlyArray<LocalKnowledgeSearchResult>,
): ReadonlyArray<PrintListColumn<LocalKnowledgeSearchResult>> {
  return [
    {
      key: 'score',
      label: 'SCORE',
      plain: 'score=',
      role: 'badge',
      prettyFormat: createRankBadgeFormatter(rows),
      dim: true,
    },
    { key: 'scope', label: 'SCOPE', plain: '' },
    { key: 'key', label: 'KEY', plain: '' },
    { key: 'summary', label: 'SUMMARY', plain: '', optional: true, dim: true },
  ];
}

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

function writeWikiSearchDebug(
  io: KtxKnowledgeIo,
  input: {
    mode: string;
    embeddingConfigured: boolean;
    results: LocalKnowledgeSearchResult[];
  },
): void {
  io.stderr.write(
    `[debug] wiki search mode=${input.mode} embedding=${input.embeddingConfigured ? 'configured' : 'unconfigured'} results=${input.results.length}\n`,
  );
  const lanes = input.results[0]?.lanes ?? [];
  for (const lane of lanes) {
    const reason = lane.reason ? ` reason=${lane.reason}` : '';
    io.stderr.write(
      `[debug] wiki search lane=${lane.lane} status=${lane.status} returned=${lane.returnedCandidateCount} weight=${lane.weight}${reason}\n`,
    );
  }
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
      const embeddingService = wikiSearchEmbeddingService(project, deps);
      const results = await searchLocalKnowledgePages(project, {
        query: args.query,
        userId: args.userId,
        embeddingService,
        limit: args.limit,
      });
      if (args.debug) {
        writeWikiSearchDebug(io, {
          mode: project.config.storage.search,
          embeddingConfigured: embeddingService !== null,
          results,
        });
      }
      const mode = resolveOutputMode({ explicit: args.output, json: args.json, io });
      let emptyMessage = `No local wiki pages matched "${args.query}"`;
      let emptyHint = 'Run `ktx wiki` to inspect available pages.';
      if (results.length === 0 && mode !== 'json') {
        const pages = await listLocalKnowledgePages(project, { userId: args.userId });
        if (pages.length === 0) {
          emptyMessage = `No local wiki pages found in ${project.projectDir}`;
          emptyHint = 'Add Markdown files under wiki/ or run `ktx ingest <connectionId>`.';
        }
      }
      printList<LocalKnowledgeSearchResult>({
        rows: results,
        columns: wikiSearchColumns(results),
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
