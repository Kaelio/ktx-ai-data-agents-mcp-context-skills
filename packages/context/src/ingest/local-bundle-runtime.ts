import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { KtxLlmProvider } from '@ktx/llm';
import type { Tool } from 'ai';
import YAML from 'yaml';
import type { AgentRunnerService } from '../agent/index.js';
import { AgentRunnerService as DefaultAgentRunnerService } from '../agent/index.js';
import { localConnectionInfoFromConfig } from '../connections/index.js';
import type { KtxEmbeddingPort, KtxLogger } from '../core/index.js';
import { noopLogger, SessionWorktreeService } from '../core/index.js';
import type { KtxSemanticLayerComputePort } from '../daemon/index.js';
import {
  createJsonlKtxLlmDebugRequestRecorder,
  createLocalKtxEmbeddingProviderFromConfig,
  createLocalKtxLlmProviderFromConfig,
  KtxIngestEmbeddingPortAdapter,
} from '../llm/index.js';
import type { KtxLocalProject } from '../project/index.js';
import { ktxLocalStateDbPath } from '../project/index.js';
import { PromptService } from '../prompts/index.js';
import { SkillsRegistryService } from '../skills/index.js';
import {
  type KtxConnectionInfo,
  type KtxQueryResult,
  SemanticLayerService,
  type SemanticLayerSource,
  type SlConnectionCatalogPort,
  SlDiscoverTool,
  SlEditSourceTool,
  type SlPythonPort,
  SlReadSourceTool,
  SlRollbackTool,
  SlSearchService,
  type SlSourcesIndexPort,
  SlValidateTool,
  type SlValidationDeps,
  type SlValidatorPort,
  SlWriteSourceTool,
  SqliteSlSourcesIndex,
  sourceDefinitionSchema,
  sourceOverlaySchema,
} from '../sl/index.js';
import {
  BaseTool,
  ContextCandidateMarkTool,
  ContextCandidateWriteTool,
  ContextEvidenceNeighborsTool,
  ContextEvidenceReadTool,
  ContextEvidenceSearchTool,
  type GitAuthorResolverPort,
  type ToolContext,
  type ToolSession,
} from '../tools/index.js';
import {
  buildKnowledgeSearchText,
  type KnowledgeEventPort,
  type KnowledgeIndexPort,
  KnowledgeWikiService,
  searchLocalKnowledgePages,
  SqliteKnowledgeIndex,
  type SqliteKnowledgeIndexPage,
  WikiListTagsTool,
  WikiReadTool,
  WikiRemoveTool,
  WikiSearchTool,
  WikiWriteTool,
} from '../wiki/index.js';
import {
  CandidateDedupService,
  ContextCandidateCarryforwardService,
  CuratorPaginationService,
} from './context-candidates/index.js';
import { createEmitHistoricSqlEvidenceTool } from './adapters/historic-sql/evidence-tool.js';
import { HistoricSqlProjectionPostProcessor } from './adapters/historic-sql/post-processor.js';
import { ContextEvidenceIndexService, SqliteContextEvidenceStore } from './context-evidence/index.js';
import { DiffSetService } from './diff-set.service.js';
import { IngestBundleRunner } from './ingest-bundle.runner.js';
import { PageTriageService } from './page-triage/index.js';
import type {
  IngestBundleRunnerDeps,
  IngestCommitMessagePort,
  IngestLockPort,
  IngestStoragePort,
  IngestToolsetFactoryPort,
  IngestToolsetLike,
  SourceAdapterRegistryPort,
} from './ports.js';
import { SourceAdapterRegistry } from './source-adapter-registry.js';
import { SqliteBundleIngestStore } from './sqlite-bundle-ingest-store.js';
import type { SourceAdapter } from './types.js';

const promptsDir = fileURLToPath(new URL('../../prompts', import.meta.url));
const skillsDir = fileURLToPath(new URL('../../skills', import.meta.url));
const LOCAL_AUTHOR = { name: 'KTX Local', email: 'local@ktx.local' };
const LOCAL_SHAPE_WARNING = 'Local ingest validates semantic-layer YAML shape only.';

export interface CreateLocalBundleIngestRuntimeOptions {
  project: KtxLocalProject;
  adapters: SourceAdapter[];
  agentRunner?: AgentRunnerService;
  llmProvider?: KtxLlmProvider;
  llmDebugRequestFile?: string;
  memoryModel?: string;
  semanticLayerCompute?: KtxSemanticLayerComputePort;
  queryExecutor?: { execute(input: { connectionId: string; sql: string; maxRows?: number }): Promise<KtxQueryResult> };
  jobIdFactory?: () => string;
  logger?: KtxLogger;
}

export interface LocalBundleIngestRuntime {
  runner: IngestBundleRunner;
  store: SqliteBundleIngestStore;
  contextStore: SqliteContextEvidenceStore;
  storage: IngestStoragePort;
  registry: SourceAdapterRegistryPort;
  nextJobId(): string;
}

class NoopEmbeddingPort implements KtxEmbeddingPort {
  readonly maxBatchSize = 64;

  async computeEmbedding(): Promise<number[]> {
    return [];
  }

  async computeEmbeddingsBulk(texts: string[]): Promise<number[][]> {
    return texts.map(() => []);
  }
}

class LocalIngestStorage implements IngestStoragePort {
  readonly homeDir: string;
  readonly systemGitAuthor = LOCAL_AUTHOR;

  constructor(private readonly project: KtxLocalProject) {
    this.homeDir = join(project.projectDir, '.ktx');
  }

  resolveUploadDir(uploadId: string): string {
    return join(this.project.projectDir, '.ktx/cache/local-ingest', uploadId, 'upload');
  }

  resolvePullDir(jobId: string): string {
    return join(this.project.projectDir, '.ktx/cache/local-ingest', jobId, 'pull');
  }

  resolveTranscriptDir(jobId: string): string {
    return join(this.project.projectDir, '.ktx/ingest-transcripts', jobId);
  }
}

class LocalIngestLock implements IngestLockPort {
  async withLock<T>(_key: string, fn: () => Promise<T>): Promise<T> {
    return fn();
  }
}

class LocalCommitMessagePort implements IngestCommitMessagePort {
  async enqueueForExternalCommit(): Promise<void> {}
}

class LocalAuthorResolver implements GitAuthorResolverPort {
  async resolve() {
    return LOCAL_AUTHOR;
  }
}

class LocalConnectionCatalog implements SlConnectionCatalogPort {
  constructor(
    private readonly project: KtxLocalProject,
    private readonly queryExecutor?: {
      execute(input: { connectionId: string; sql: string; maxRows?: number }): Promise<KtxQueryResult>;
    },
  ) {}

  async listEnabledConnections(ids: string[]): Promise<KtxConnectionInfo[]> {
    return ids
      .map((id) => localConnectionInfoFromConfig(id, this.project.config.connections[id]))
      .filter((connection): connection is KtxConnectionInfo => connection !== null);
  }

  async getConnectionById(connectionId: string): Promise<KtxConnectionInfo> {
    const connection = localConnectionInfoFromConfig(connectionId, this.project.config.connections[connectionId]);
    if (!connection) {
      throw new Error(`Connection not found: ${connectionId}`);
    }
    return connection;
  }

  async executeQuery(connectionId: string, sql: string): Promise<KtxQueryResult> {
    if (!this.queryExecutor) {
      throw new Error('Local ingest has no query executor configured');
    }
    return this.queryExecutor.execute({ connectionId, sql });
  }
}

class LocalSlPythonPort implements SlPythonPort {
  constructor(private readonly compute?: KtxSemanticLayerComputePort) {}

  async validateSources(input: Parameters<SlPythonPort['validateSources']>[0]) {
    if (!this.compute) {
      return { data: { errors: [], warnings: [LOCAL_SHAPE_WARNING], per_source_warnings: {} } };
    }
    const result = await this.compute.validateSources({
      sources: input.sources,
      dialect: input.dialect,
      recentlyTouched: input.recently_touched,
    });
    return {
      data: {
        errors: result.errors,
        warnings: result.warnings,
        per_source_warnings: result.perSourceWarnings,
      },
    };
  }

  async query(input: Parameters<SlPythonPort['query']>[0]) {
    if (!this.compute) {
      return { error: 'Local ingest has no semantic compute adapter configured' };
    }
    const result = await this.compute.query({
      sources: input.sources,
      dialect: input.dialect,
      query: input.query,
    });
    return { data: { sql: result.sql, plan: result.plan } };
  }
}

class LocalShapeOnlySlValidator implements SlValidatorPort<SlValidationDeps> {
  async validateSingleSource(deps: SlValidationDeps, connectionId: string, sourceName: string) {
    try {
      const file = await deps.semanticLayerService.readSourceFile(connectionId, sourceName);
      const parsed = YAML.parse(file.content) as SemanticLayerSource;
      const isOverlay = parsed.table == null && parsed.sql == null;
      const result = (isOverlay ? sourceOverlaySchema : sourceDefinitionSchema).safeParse(parsed);
      return result.success
        ? { errors: [], warnings: [LOCAL_SHAPE_WARNING] }
        : {
            errors: result.error.issues.map(
              (issue) => `${sourceName}: ${issue.path.join('.') || 'source'} ${issue.message}`,
            ),
            warnings: [],
          };
    } catch (error) {
      return { errors: [`${sourceName}: ${error instanceof Error ? error.message : String(error)}`], warnings: [] };
    }
  }
}

function parseWiki(raw: string): { summary: string; content: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    return { summary: '', content: raw.trim() };
  }
  const frontmatter = (YAML.parse(match[1]) ?? {}) as Record<string, unknown>;
  return {
    summary: typeof frontmatter.summary === 'string' ? frontmatter.summary : '',
    content: match[2].trim(),
  };
}

function parseWikiTags(raw: string): string[] {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) {
    return [];
  }
  const frontmatter = (YAML.parse(match[1]) ?? {}) as Record<string, unknown>;
  return Array.isArray(frontmatter.tags)
    ? frontmatter.tags.filter((tag): tag is string => typeof tag === 'string')
    : [];
}

function scoreText(text: string, query: string): number {
  const normalized = query.toLowerCase().trim();
  if (!normalized) {
    return 0;
  }
  const haystack = text.toLowerCase();
  if (haystack.includes(normalized)) {
    return 1;
  }
  const words = normalized.split(/\s+/).filter(Boolean);
  return words.filter((word) => haystack.includes(word)).length / Math.max(words.length, 1);
}

class LocalKnowledgeIndex implements KnowledgeIndexPort {
  private readonly sqlite: SqliteKnowledgeIndex;

  constructor(
    private readonly project: KtxLocalProject,
    private readonly embedding: KtxEmbeddingPort,
  ) {
    this.sqlite = new SqliteKnowledgeIndex({ dbPath: ktxLocalStateDbPath(project) });
  }

  async upsertPage(): Promise<void> {
    await this.syncAllPagesFromDisk();
  }

  async applyDiffTransactional(): Promise<void> {
    await this.syncAllPagesFromDisk();
  }

  async getExistingSearchTexts(
    scope: string,
    scopeId: string | null,
  ): Promise<Map<string, { searchText: string; hasEmbedding: boolean }>> {
    const prefix = scope === 'GLOBAL' ? 'knowledge/global/' : `knowledge/user/${scopeId}/`;
    const result = new Map<string, { searchText: string; hasEmbedding: boolean }>();
    for (const [path, page] of this.sqlite.getExistingPages()) {
      if (!path.startsWith(prefix)) {
        continue;
      }
      result.set(path.slice(prefix.length).replace(/\.md$/, ''), {
        searchText: page.searchText,
        hasEmbedding: page.embedding !== null,
      });
    }
    return result;
  }

  async deleteStale(): Promise<void> {
    await this.syncAllPagesFromDisk();
  }

  async deleteByScope(): Promise<void> {
    await this.syncAllPagesFromDisk();
  }

  async deleteByKey(): Promise<void> {
    await this.syncAllPagesFromDisk();
  }

  async findPageByKey(scope: string, scopeId: string | null, pageKey: string) {
    const path = scope === 'GLOBAL' ? `knowledge/global/${pageKey}.md` : `knowledge/user/${scopeId}/${pageKey}.md`;
    try {
      await this.project.fileStore.readFile(path);
      return { page_key: pageKey };
    } catch {
      return null;
    }
  }

  async listPagesForUser(
    userId: string,
  ): Promise<Array<{ page_key: string; summary: string; scope: string; scope_id: string | null }>> {
    const pages: Array<{ page_key: string; summary: string; scope: string; scope_id: string | null }> = [];
    for (const scope of [
      { scope: 'GLOBAL', scopeId: null, dir: 'knowledge/global' },
      { scope: 'USER', scopeId: userId, dir: `knowledge/user/${userId}` },
    ]) {
      const listed = await this.project.fileStore.listFiles(scope.dir, true);
      for (const file of listed.files.filter((entry) => entry.endsWith('.md'))) {
        const pageKey = file.replace(/\.md$/, '');
        const raw = await this.project.fileStore.readFile(`${scope.dir}/${file}`);
        const parsed = parseWiki(raw.content);
        pages.push({
          page_key: pageKey,
          summary: parsed.summary,
          scope: scope.scope,
          scope_id: scope.scopeId,
        });
      }
    }
    return pages.sort((left, right) => left.page_key.localeCompare(right.page_key));
  }

  async getUserPageCount(userId: string): Promise<number> {
    return (await this.listPagesForUser(userId)).filter((page) => page.scope === 'USER').length;
  }

  async incrementUsageCount(): Promise<void> {}

  async searchRRF(
    userId: string,
    _embedding: number[] | null,
    queryText: string,
    limit: number,
  ): Promise<Array<{ pageKey: string; summary: string; rrfScore: number }>> {
    const pages = await this.listPagesForUser(userId);
    return pages
      .map((page) => ({
        pageKey: page.page_key,
        summary: page.summary,
        rrfScore: scoreText(`${page.page_key} ${page.summary}`, queryText),
      }))
      .filter((page) => page.rrfScore > 0)
      .sort((left, right) => right.rrfScore - left.rrfScore || left.pageKey.localeCompare(right.pageKey))
      .slice(0, limit);
  }

  private async syncAllPagesFromDisk(): Promise<void> {
    const listed = await this.project.fileStore.listFiles('knowledge', true);
    const existingPages = this.sqlite.getExistingPages();
    const pages: SqliteKnowledgeIndexPage[] = [];
    for (const file of listed.files.filter((entry) => entry.endsWith('.md'))) {
      const parsedPath = parseKnowledgeIndexPath(file);
      if (!parsedPath) {
        continue;
      }
      const path = `knowledge/${file}`;
      const raw = await this.project.fileStore.readFile(path);
      const parsed = parseWiki(raw.content);
      const tags = parseWikiTags(raw.content);
      const searchText = buildKnowledgeSearchText(parsedPath.pageKey, parsed.summary, parsed.content, tags);
      const existing = existingPages.get(path);
      const embedding =
        existing?.searchText === searchText && existing.embedding
          ? existing.embedding
          : await this.embedding.computeEmbedding(searchText).catch(() => null);
      pages.push({
        path,
        key: parsedPath.pageKey,
        scope: parsedPath.scope,
        summary: parsed.summary,
        content: parsed.content,
        tags,
        embedding,
      });
    }
    this.sqlite.sync(pages);
  }
}

function parseKnowledgeIndexPath(file: string): { scope: 'GLOBAL' | 'USER'; pageKey: string } | null {
  const segments = file.split('/');
  if (segments.length === 2 && segments[0] === 'global') {
    const pageKey = segments[1].replace(/\.md$/, '');
    return /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(pageKey) ? { scope: 'GLOBAL', pageKey } : null;
  }
  if (segments.length >= 3 && segments[0] === 'global' && segments[1] === 'historic-sql') {
    const historicPath = segments.slice(2).join('/').replace(/\.md$/, '');
    if (historicPath.split('/').every((segment) => /^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/.test(segment))) {
      return { scope: 'GLOBAL', pageKey: `historic-sql/${historicPath}` };
    }
    return null;
  }
  if (segments.length === 3 && segments[0] === 'user') {
    const pageKey = segments[2].replace(/\.md$/, '');
    return /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(pageKey) ? { scope: 'USER', pageKey } : null;
  }
  return null;
}

class NoopKnowledgeEventPort implements KnowledgeEventPort {
  async createEvent(): Promise<void> {}
}

class LocalIngestToolSet implements IngestToolsetLike {
  constructor(
    private readonly tools: BaseTool[],
    private readonly sourceTools: Record<string, Tool> = {},
  ) {}

  toAiSdkTools(context: ToolContext) {
    return {
      ...Object.fromEntries(this.tools.map((tool) => [tool.name, tool.toAiSdkTool(context)])),
      ...this.sourceTools,
    };
  }
}

class LocalIngestToolsetFactory implements IngestToolsetFactoryPort {
  private readonly baseTools: BaseTool[];
  private readonly contextTools: BaseTool[];

  constructor(deps: {
    project: KtxLocalProject;
    wikiService: KnowledgeWikiService;
    knowledgeIndex: KnowledgeIndexPort;
    knowledgeEvents: KnowledgeEventPort;
    semanticLayerService: SemanticLayerService;
    slSearchService: SlSearchService;
    authorResolver: GitAuthorResolverPort;
    slSourcesRepository: SlSourcesIndexPort;
    connections: SlConnectionCatalogPort;
    contextStore: SqliteContextEvidenceStore;
    embedding: KtxEmbeddingPort;
  }) {
    const slDeps = {
      semanticLayerService: deps.semanticLayerService,
      slSearchService: deps.slSearchService,
      authorResolver: deps.authorResolver,
    };
    this.baseTools = [
      new WikiReadTool(deps.wikiService, deps.knowledgeIndex),
      new WikiSearchTool({
        search: async (input) => {
          const results = await searchLocalKnowledgePages(deps.project, {
            userId: input.userId,
            query: input.query,
            limit: input.limit,
            embeddingService: deps.embedding,
          });
          return {
            results: results.slice(0, input.limit).map((result) => ({
              key: result.key,
              path: result.path,
              summary: result.summary,
              score: result.score,
              matchReasons: result.matchReasons,
              lanes: result.lanes,
            })),
            totalFound: results.length,
          };
        },
      }),
      new WikiListTagsTool(deps.wikiService, deps.knowledgeIndex),
      new WikiWriteTool(deps.wikiService, deps.knowledgeIndex, deps.knowledgeEvents),
      new WikiRemoveTool(deps.wikiService, deps.knowledgeIndex, deps.knowledgeEvents),
      new SlDiscoverTool(slDeps, { maxSources: 25, minRrfScore: 0, maxDetailedSources: 5 }),
      new SlEditSourceTool(slDeps),
      new SlReadSourceTool(slDeps),
      new SlWriteSourceTool(slDeps),
      new SlValidateTool(slDeps),
      new SlRollbackTool(deps.slSourcesRepository, deps.connections, 0),
    ];
    this.contextTools = [
      new ContextEvidenceSearchTool(deps.contextStore, deps.embedding),
      new ContextEvidenceReadTool(deps.contextStore),
      new ContextEvidenceNeighborsTool(deps.contextStore),
      new ContextCandidateWriteTool(deps.contextStore, deps.embedding),
      new ContextCandidateMarkTool(deps.contextStore),
    ];
  }

  createIngestWuToolset(session: ToolSession, options?: { includeContextEvidenceTools?: boolean }): IngestToolsetLike {
    const sourceTools: Record<string, Tool> =
      session.ingest?.sourceKey === 'historic-sql'
        ? {
            emit_historic_sql_evidence: createEmitHistoricSqlEvidenceTool({
              connectionId: session.connectionId,
              session,
            }),
          }
        : {};
    return new LocalIngestToolSet(
      options?.includeContextEvidenceTools ? [...this.baseTools, ...this.contextTools] : this.baseTools,
      sourceTools,
    );
  }
}

function registerAdapters(adapters: SourceAdapter[]): SourceAdapterRegistry {
  const registry = new SourceAdapterRegistry();
  for (const adapter of adapters) {
    registry.register(adapter);
  }
  return registry;
}

function nextLocalJobId(): string {
  return `local-${Date.now().toString(36)}`;
}

function localIngestLlmProviderGuardMessage(projectDir: string): string {
  return [
    'ktx dev ingest run requires llm.provider.backend: anthropic, vertex, or gateway, or an injected agentRunner.',
    'Configure an Anthropic provider, then rerun ingest:',
    `  ktx setup --project-dir ${projectDir} --anthropic-api-key-env ANTHROPIC_API_KEY --anthropic-model claude-sonnet-4-6 --no-input`,
  ].join('\n');
}

function resolveAgentRunner(options: CreateLocalBundleIngestRuntimeOptions): {
  agentRunner: AgentRunnerService;
  llmProvider?: KtxLlmProvider;
} {
  const llmProvider =
    options.llmProvider ?? createLocalKtxLlmProviderFromConfig(options.project.config.llm) ?? undefined;

  if (options.agentRunner) {
    return { agentRunner: options.agentRunner, ...(llmProvider ? { llmProvider } : {}) };
  }

  if (!llmProvider) {
    throw new Error(localIngestLlmProviderGuardMessage(options.project.projectDir));
  }

  return {
    agentRunner: new DefaultAgentRunnerService({
      llmProvider,
      logger: options.logger ?? noopLogger,
      ...(options.llmDebugRequestFile
        ? { debugRequestRecorder: createJsonlKtxLlmDebugRequestRecorder(options.llmDebugRequestFile) }
        : {}),
    }),
    llmProvider,
  };
}

export function createLocalBundleIngestRuntime(
  options: CreateLocalBundleIngestRuntimeOptions,
): LocalBundleIngestRuntime {
  const logger = options.logger ?? noopLogger;
  const dbPath = ktxLocalStateDbPath(options.project);
  mkdirSync(join(options.project.projectDir, '.ktx/cache/local-ingest'), { recursive: true });
  const store = new SqliteBundleIngestStore({ dbPath });
  const contextStore = new SqliteContextEvidenceStore({ dbPath });
  const embeddingProvider = createLocalKtxEmbeddingProviderFromConfig(options.project.config.ingest.embeddings);
  const embedding = embeddingProvider ? new KtxIngestEmbeddingPortAdapter(embeddingProvider) : new NoopEmbeddingPort();
  const connections = new LocalConnectionCatalog(options.project, options.queryExecutor);
  const rootFileStore = options.project.fileStore;
  const semanticLayerService = new SemanticLayerService(
    rootFileStore,
    connections,
    new LocalSlPythonPort(options.semanticLayerCompute),
    logger,
  );
  const slSourcesRepository = new SqliteSlSourcesIndex({ dbPath });
  const slSearchService = new SlSearchService(embedding, slSourcesRepository, logger);
  const knowledgeIndex = new LocalKnowledgeIndex(options.project, embedding);
  const knowledgeEvents = new NoopKnowledgeEventPort();
  const wikiService = new KnowledgeWikiService(rootFileStore, embedding, knowledgeIndex, options.project.git, logger);
  const { agentRunner, llmProvider } = resolveAgentRunner(options);
  const promptService = new PromptService({ promptsDir, partials: [], logger });
  const storage = new LocalIngestStorage(options.project);
  const registry = registerAdapters(options.adapters);
  const toolsetFactory = new LocalIngestToolsetFactory({
    project: options.project,
    wikiService,
    knowledgeIndex,
    knowledgeEvents,
    semanticLayerService,
    slSearchService,
    authorResolver: new LocalAuthorResolver(),
    slSourcesRepository,
    connections,
    contextStore,
    embedding,
  });

  const deps: IngestBundleRunnerDeps = {
    runs: store,
    provenance: store,
    reports: store,
    canonicalPins: store,
    registry,
    diffSetService: new DiffSetService(store),
    sessionWorktreeService: new SessionWorktreeService({
      coreConfig: options.project.coreConfig,
      gitService: options.project.git,
      configService: rootFileStore,
    }),
    agentRunner,
    gitService: options.project.git,
    lockingService: new LocalIngestLock(),
    storage,
    settings: {
      memoryIngestionModel: options.project.config.llm.models.default ?? 'local-ingest-model',
      probeRowCount: 0,
      workUnitMaxConcurrency: options.project.config.ingest.workUnits.maxConcurrency,
      workUnitStepBudget: options.project.config.ingest.workUnits.stepBudget,
      workUnitFailureMode: options.project.config.ingest.workUnits.failureMode,
    },
    skillsRegistry: new SkillsRegistryService({ skillsDir, logger }),
    promptService,
    wikiService,
    knowledgeIndex,
    semanticLayerService,
    slSearchService,
    slSourcesRepository,
    connections,
    slValidator: new LocalShapeOnlySlValidator(),
    toolsetFactory,
    commitMessages: new LocalCommitMessagePort(),
    embedding,
    contextEvidenceIndex: new ContextEvidenceIndexService({ store: contextStore, embeddings: embedding, logger }),
    pageTriage: llmProvider
      ? new PageTriageService({
          store: contextStore,
          llmProvider,
          settings: {
            enabled: true,
            maxConcurrency: 2,
            lightExtractionEnabled: true,
            classifierModel: null,
            lightExtractionMaxCandidates: 5,
          },
          promptService,
          logger,
        })
      : undefined,
    contextEvidenceCandidates: contextStore,
    candidateDedup: new CandidateDedupService({
      store: contextStore,
      embeddings: embedding,
      settings: { enabled: true, topicSimilarityThreshold: 0.86, scoreAggregation: 'max' },
      logger,
    }),
    contextCandidateCarryforward: new ContextCandidateCarryforwardService({
      store: contextStore,
      settings: { reExamineBudgetExhaustedOnRerun: true },
      logger,
    }),
    curatorPagination: new CuratorPaginationService({
      store: contextStore,
      agentRunner,
      settings: { batchSize: 8, maxPasses: 8, stepBudgetPerPass: 60 },
      logger,
    }),
    postProcessors: {
      'historic-sql': new HistoricSqlProjectionPostProcessor(),
    },
    logger,
  };

  return {
    runner: new IngestBundleRunner(deps),
    store,
    contextStore,
    storage,
    registry,
    nextJobId: options.jobIdFactory ?? nextLocalJobId,
  };
}
