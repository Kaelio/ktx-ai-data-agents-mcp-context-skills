import {
  createLocalKtxEmbeddingProviderFromConfig,
  KtxIngestEmbeddingPortAdapter,
  MANAGED_SENTENCE_TRANSFORMERS_BASE_URL,
  type KtxEmbeddingPort,
} from '@ktx/context';
import { reindexLocalIndexes, type ReindexScopeResult, type ReindexSummary } from '@ktx/context/index-sync';
import { loadKtxProject, type KtxLocalProject } from '@ktx/context/project';
import { Option, type Command } from '@commander-js/extra-typings';
import { cancel, intro, log, note, outro } from '@clack/prompts';
import type { KtxCliCommandContext } from './cli-program.js';
import type { KtxCliIo } from './cli-runtime.js';
import { resolveOutputMode } from './io/mode.js';
import { green, red, SYMBOLS } from './io/symbols.js';
import { ensureManagedLocalEmbeddingsDaemon } from './managed-local-embeddings.js';

export interface KtxAdminReindexArgs {
  projectDir: string;
  force: boolean;
  output?: 'pretty' | 'plain' | 'json';
  json?: boolean;
  cliVersion: string;
}

export function registerAdminReindexCommand(admin: Command, context: KtxCliCommandContext): void {
  admin
    .command('reindex')
    .description('Sync local wiki and semantic-layer search indexes from disk')
    .option('--force', 'Clear each discovered scope before rebuilding it', false)
    .option('--json', 'Shortcut for --output=json (overrides --output)', false)
    .addOption(
      new Option('--output <mode>', 'Output mode: pretty, plain, or json').choices(['pretty', 'plain', 'json']),
    )
    .action(async (options: { force?: boolean; json?: boolean; output?: 'pretty' | 'plain' | 'json' }, command) => {
      const runner = context.deps.adminReindex ?? runKtxAdminReindex;
      const { resolveCommandProjectDir } = await import('./cli-program.js');
      context.setExitCode(
        await runner(
          {
            projectDir: resolveCommandProjectDir(command),
            force: options.force === true,
            json: options.json === true,
            output: options.output,
            cliVersion: context.packageInfo.version,
          },
          context.io,
        ),
      );
    });
}

async function resolveReindexEmbeddingService(
  project: KtxLocalProject,
  args: KtxAdminReindexArgs,
  io: KtxCliIo,
): Promise<KtxEmbeddingPort | null> {
  const config = project.config.ingest.embeddings;
  if (config.backend === 'none') {
    return null;
  }

  if (
    config.backend === 'sentence-transformers' &&
    config.sentenceTransformers?.base_url === MANAGED_SENTENCE_TRANSFORMERS_BASE_URL
  ) {
    const daemon = await ensureManagedLocalEmbeddingsDaemon({
      cliVersion: args.cliVersion,
      projectDir: project.projectDir,
      installPolicy: 'never',
      io,
    });
    const provider = createLocalKtxEmbeddingProviderFromConfig(config, { env: { ...process.env, ...daemon.env } });
    return provider ? new KtxIngestEmbeddingPortAdapter(provider) : null;
  }

  const provider = createLocalKtxEmbeddingProviderFromConfig(config);
  return provider ? new KtxIngestEmbeddingPortAdapter(provider) : null;
}

function scopeKey(scope: ReindexScopeResult): string {
  if (scope.kind === 'wiki') {
    return scope.scope === 'user' ? `wiki/user/${scope.scopeId ?? 'local'}` : 'wiki/global';
  }
  return `sl/${scope.connectionId ?? scope.label}`;
}

function quotePlainValue(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

export function reindexHasErrors(summary: ReindexSummary): boolean {
  return summary.scopes.some((scope) => scope.error);
}

export function renderReindexPlain(summary: ReindexSummary, io: KtxCliIo): void {
  const updateKey = summary.force ? 'rebuilt' : 'updated';
  for (const scope of summary.scopes) {
    const cells = [
      scopeKey(scope),
      `scanned=${scope.scanned}`,
      `${updateKey}=${scope.updated}`,
      `deleted=${scope.deleted}`,
      `embeddings=${summary.embeddingsAvailable ? String(scope.embeddingsRecomputed) : '-'}`,
      `duration_ms=${scope.durationMs}`,
      ...(scope.error ? [`error=${quotePlainValue(scope.error)}`] : []),
    ];
    io.stderr.write(`${cells.join('\t')}\n`);
  }
  const failed = summary.scopes.filter((scope) => scope.error).length;
  io.stdout.write(
    [
      'reindex',
      `scopes=${summary.scopes.length}`,
      `scanned=${summary.totals.scanned}`,
      `${updateKey}=${summary.totals.updated}`,
      `deleted=${summary.totals.deleted}`,
      `embeddings=${summary.embeddingsAvailable ? String(summary.totals.embeddingsRecomputed) : '-'}`,
      `duration_ms=${summary.durationMs}`,
      ...(failed > 0 ? [`failed=${failed}`] : []),
    ].join('\t') + '\n',
  );
}

export function renderReindexJson(summary: ReindexSummary, io: KtxCliIo): void {
  io.stdout.write(`${JSON.stringify({ kind: 'reindex', data: summary, meta: { command: 'admin reindex' } }, null, 2)}\n`);
}

function noun(scope: ReindexScopeResult): string {
  return scope.kind === 'wiki' ? 'pages' : 'sources';
}

function formatScopeLine(scope: ReindexScopeResult, force: boolean, embeddingsAvailable: boolean): string {
  if (scope.error) {
    return `${scope.kind === 'wiki' ? 'Wiki' : 'SL'}: ${scope.label} ${SYMBOLS.emDash} failed: ${scope.error}`;
  }
  const changedLabel = force ? 'rebuilt' : 'updated';
  const parts = [`${scope.scanned} ${noun(scope)}`];
  if (scope.updated > 0) {
    parts.push(`${scope.updated} ${changedLabel}`);
  } else {
    parts.push('unchanged');
  }
  if (!force && scope.deleted > 0) {
    parts.push(`${scope.deleted} deleted`);
  }
  if (embeddingsAvailable) {
    parts.push(`${scope.embeddingsRecomputed} embeddings recomputed`);
  }
  parts.push(`${scope.durationMs}ms`);
  return `${scope.kind === 'wiki' ? 'Wiki' : 'SL'}: ${scope.label} ${SYMBOLS.emDash} ${parts.join(` ${SYMBOLS.middot} `)}`;
}

function renderReindexPretty(summary: ReindexSummary, io: KtxCliIo): void {
  intro(summary.force ? 'ktx admin reindex --force' : 'ktx admin reindex');
  if (!summary.embeddingsAvailable) {
    log.warn(`Embeddings: not configured ${SYMBOLS.emDash} indexing lexical only`);
  }
  for (const scope of summary.scopes) {
    const line = formatScopeLine(scope, summary.force, summary.embeddingsAvailable);
    if (scope.error) {
      log.error(red(line));
    } else {
      log.success(green(line));
    }
  }
  const failed = summary.scopes.filter((scope) => scope.error).length;
  note(
    [
      `scopes        ${summary.scopes.length}`,
      `scanned       ${summary.totals.scanned}`,
      `${summary.force ? 'rebuilt' : 'updated'}       ${summary.totals.updated}`,
      `deleted       ${summary.totals.deleted}`,
      `embeddings    ${summary.embeddingsAvailable ? summary.totals.embeddingsRecomputed : SYMBOLS.emDash}`,
      `index         ${summary.dbPath}`,
      ...(failed > 0 ? [`failed        ${failed}`] : []),
    ].join('\n'),
    'Summary',
  );
  if (failed > 0) {
    cancel(`reindex completed with ${failed} error${failed === 1 ? '' : 's'}`);
  } else {
    outro(`Done in ${(summary.durationMs / 1000).toFixed(1)}s`);
  }
  void io;
}

async function runKtxAdminReindex(args: KtxAdminReindexArgs, io: KtxCliIo = process): Promise<number> {
  try {
    const project = await loadKtxProject({ projectDir: args.projectDir });
    const embeddingService = await resolveReindexEmbeddingService(project, args, io);
    const summary = await reindexLocalIndexes(project, { force: args.force, embeddingService });
    const mode = resolveOutputMode({ explicit: args.output, json: args.json, io });

    if (!summary.embeddingsAvailable && mode === 'plain') {
      io.stderr.write(`Embeddings: not configured ${SYMBOLS.emDash} indexing lexical only\n`);
    }

    if (mode === 'json') {
      renderReindexJson(summary, io);
    } else if (mode === 'plain') {
      renderReindexPlain(summary, io);
    } else {
      renderReindexPretty(summary, io);
    }
    return reindexHasErrors(summary) ? 1 : 0;
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
