import {
  createLocalKtxEmbeddingProviderFromConfig,
  KtxIngestEmbeddingPortAdapter,
  type KtxEmbeddingPort,
} from '@ktx/context';
import { loadKtxProject } from '@ktx/context/project';
import { listLocalKnowledgePages, searchLocalKnowledgePages } from '@ktx/context/wiki';
import { writeJsonResult } from './io/print-list.js';

export type KtxKnowledgeArgs =
  | { command: 'list'; projectDir: string; userId: string; json?: boolean }
  | { command: 'search'; projectDir: string; query: string; userId: string; json?: boolean; limit?: number };

interface KtxKnowledgeIo {
  stdout: { write(chunk: string): void };
  stderr: { write(chunk: string): void };
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

export async function runKtxKnowledge(
  args: KtxKnowledgeArgs,
  io: KtxKnowledgeIo = process,
  deps: KtxKnowledgeDeps = {},
): Promise<number> {
  try {
    const project = await loadKtxProject({ projectDir: args.projectDir });
    if (args.command === 'list') {
      const pages = await listLocalKnowledgePages(project, { userId: args.userId });
      if (args.json) {
        writeJsonResult(io, {
          kind: 'list',
          data: { items: pages },
          meta: { command: 'wiki list' },
        });
        return 0;
      }
      for (const page of pages) {
        io.stdout.write(`${page.scope}\t${page.key}\t${page.summary}\n`);
      }
      return 0;
    }
    if (args.command === 'search') {
      const results = await searchLocalKnowledgePages(project, {
        query: args.query,
        userId: args.userId,
        embeddingService: wikiSearchEmbeddingService(project, deps),
        limit: args.limit,
      });
      if (args.json) {
        writeJsonResult(io, {
          kind: 'list',
          data: { items: results },
          meta: { command: 'wiki search' },
        });
        return 0;
      }
      if (results.length === 0) {
        const pages = await listLocalKnowledgePages(project, { userId: args.userId });
        if (pages.length === 0) {
          io.stderr.write(
            `No local wiki pages found in ${project.projectDir}. Run ingest to capture wiki context, then retry the search.\n`,
          );
        } else {
          io.stderr.write(
            `No local wiki pages matched "${args.query}". Run \`ktx wiki list\` to inspect available pages.\n`,
          );
        }
        return 0;
      }
      for (const result of results) {
        io.stdout.write(`${result.score}\t${result.scope}\t${result.key}\t${result.summary}\n`);
      }
      return 0;
    }
    const _exhaustive: never = args;
    throw new Error(`Unsupported wiki command: ${JSON.stringify(_exhaustive)}`);
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
