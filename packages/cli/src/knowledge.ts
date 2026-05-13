import {
  createLocalKtxEmbeddingProviderFromConfig,
  KtxIngestEmbeddingPortAdapter,
  type KtxEmbeddingPort,
} from '@ktx/context';
import { loadKtxProject } from '@ktx/context/project';
import {
  type LocalKnowledgeScope,
  listLocalKnowledgePages,
  readLocalKnowledgePage,
  searchLocalKnowledgePages,
  writeLocalKnowledgePage,
} from '@ktx/context/wiki';
import { writeJsonResult } from './io/print-list.js';

export type KtxKnowledgeArgs =
  | { command: 'list'; projectDir: string; userId: string; json?: boolean }
  | { command: 'read'; projectDir: string; key: string; userId: string; json?: boolean }
  | { command: 'search'; projectDir: string; query: string; userId: string; json?: boolean; limit?: number }
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
            `No local wiki pages found in ${project.projectDir}. Create one with \`ktx wiki write <key> --summary <summary> --content <content>\` or run ingest.\n`,
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
