import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { localConnectionInfoFromConfig, type KtxSqlQueryExecutorPort } from '../connections/index.js';
import type { KtxEmbeddingPort, KtxLogger } from '../core/index.js';
import { noopLogger, SessionWorktreeService } from '../core/index.js';
import type { KtxSemanticLayerComputePort } from '../daemon/index.js';
import {
  createRuntimeToolDescriptorFromAiTool,
  createLocalKtxEmbeddingProviderFromConfig,
  createLocalKtxLlmRuntimeFromConfig,
  KtxIngestEmbeddingPortAdapter,
  RuntimeAgentRunner,
  type AgentRunnerPort,
  type KtxLlmRuntimePort,
  type KtxRuntimeToolSet,
} from '../llm/index.js';
import type { KtxLocalProject } from '../project/index.js';
import { ktxLocalStateDbPath } from '../project/index.js';
import { PromptService } from '../prompts/index.js';
import { SkillsRegistryService } from '../skills/index.js';
import {
  type KtxConnectionInfo,
  type KtxQueryResult,
  SemanticLayerService,
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
  type KnowledgeIndexPageListing,
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
import { ingestTracePathForJob, type IngestTraceLevel } from './ingest-trace.js';
import { IngestBundleRunner } from './ingest-bundle.runner.js';
import { PageTriageService } from './page-triage/index.js';
import { createWarehouseVerificationTools } from './tools/warehouse-verification/index.js';
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
const INGEST_TRACE_LEVELS = new Set<IngestTraceLevel>(['error', 'info', 'debug', 'trace']);

function ingestTraceLevelFromEnv(env: NodeJS.ProcessEnv = process.env): IngestTraceLevel {
  const raw = env.KTX_INGEST_TRACE_LEVEL;
  return raw && INGEST_TRACE_LEVELS.has(raw as IngestTraceLevel) ? (raw as IngestTraceLevel) : 'debug';
}

export interface CreateLocalBundleIngestRuntimeOptions {
  project: KtxLocalProject;
  adapters: SourceAdapter[];
  agentRunner?: AgentRunnerPort;
  llmRuntime?: KtxLlmRuntimePort;
  createLlmRuntime?: typeof createLocalKtxLlmRuntimeFromConfig;
  llmDebugRequestFile?: string;
  memoryModel?: string;
  semanticLayerCompute?: KtxSemanticLayerComputePort;
  queryExecutor?: KtxSqlQueryExecutorPort;
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

  resolveTracePath(jobId: string): string {
    return ingestTracePathForJob(this.homeDir, jobId);
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
    private readonly queryExecutor?: KtxSqlQueryExecutorPort,
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
    return this.queryExecutor.execute({
      connectionId,
      projectDir: this.project.projectDir,
      connection: this.project.config.connections[connectionId],
      sql,
    });
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
  private validateParsedSource(sourceName: string, parsed: Record<string, unknown>) {
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
  }

  private async validateComposedSource(
    deps: SlValidationDeps,
    connectionId: string,
    sourceName: string,
    readError: unknown,
  ) {
    try {
      const { sources, loadErrors } = await deps.semanticLayerService.loadAllSources(connectionId);
      const source = sources.find((candidate) => candidate.name === sourceName);
      if (source) {
        return this.validateParsedSource(sourceName, source as unknown as Record<string, unknown>);
      }
      const detail =
        loadErrors.length > 0
          ? loadErrors.join('; ')
          : readError instanceof Error
            ? readError.message
            : String(readError);
      return { errors: [`${sourceName}: ${detail}`], warnings: [] };
    } catch (fallbackError) {
      return {
        errors: [`${sourceName}: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`],
        warnings: [],
      };
    }
  }

  async validateSingleSource(deps: SlValidationDeps, connectionId: string, sourceName: string) {
    let content: string;
    try {
      const file = await deps.semanticLayerService.readSourceFile(connectionId, sourceName);
      content = file.content;
    } catch (error) {
      return this.validateComposedSource(deps, connectionId, sourceName, error);
    }

    try {
      const parsed = YAML.parse(content) as unknown as Record<string, unknown>;
      return this.validateParsedSource(sourceName, parsed);
    } catch (error) {
      return {
        errors: [`${sourceName}: invalid YAML — ${error instanceof Error ? error.message : String(error)}`],
        warnings: [],
      };
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
    const prefix = scope === 'GLOBAL' ? 'wiki/global/' : `wiki/user/${scopeId}/`;
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

  async deleteStale(): Promise<number> {
    await this.syncAllPagesFromDisk();
    return 0;
  }

  async deleteByScope(): Promise<number> {
    await this.syncAllPagesFromDisk();
    return 0;
  }

  async deleteByKey(): Promise<number> {
    await this.syncAllPagesFromDisk();
    return 0;
  }

  async findPageByKey(scope: string, scopeId: string | null, pageKey: string) {
    const path = scope === 'GLOBAL' ? `wiki/global/${pageKey}.md` : `wiki/user/${scopeId}/${pageKey}.md`;
    try {
      await this.project.fileStore.readFile(path);
      return { page_key: pageKey };
    } catch {
      return null;
    }
  }

  async listPagesForUser(
    userId: string,
  ): Promise<KnowledgeIndexPageListing[]> {
    const pages: KnowledgeIndexPageListing[] = [];
    for (const scope of [
      { scope: 'GLOBAL', scopeId: null, dir: 'wiki/global' },
      { scope: 'USER', scopeId: userId, dir: `wiki/user/${userId}` },
    ]) {
      const listed = await this.project.fileStore.listFiles(scope.dir, true);
      for (const file of listed.files.filter((entry) => entry.endsWith('.md'))) {
        const parsedPath = parseKnowledgeIndexPath(file.startsWith('global/') || file.startsWith('user/') ? file : `${scope.dir.replace('wiki/', '')}/${file}`);
        if (!parsedPath || parsedPath.scope !== scope.scope) {
          continue;
        }
        const pageKey = parsedPath.pageKey;
        const raw = await this.project.fileStore.readFile(`${scope.dir}/${file}`);
        const parsed = parseWiki(raw.content);
        pages.push({
          page_key: pageKey,
          summary: parsed.summary,
          scope: scope.scope,
          scope_id: scope.scopeId,
          tags: parseWikiTags(raw.content),
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
    const listed = await this.project.fileStore.listFiles('wiki', true);
    const existingPages = this.sqlite.getExistingPages();
    const pages: SqliteKnowledgeIndexPage[] = [];
    for (const file of listed.files.filter((entry) => entry.endsWith('.md'))) {
      const parsedPath = parseKnowledgeIndexPath(file);
      if (!parsedPath) {
        continue;
      }
      const path = `wiki/${file}`;
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
    private readonly sourceTools: KtxRuntimeToolSet = {},
  ) {}

  toRuntimeTools(context: ToolContext): KtxRuntimeToolSet {
    return {
      ...Object.fromEntries(this.tools.map((tool) => [tool.name, tool.toRuntimeTool(context)])),
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
    const wikiSearchTool = new WikiSearchTool({
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
    });
    const slDiscoverTool = new SlDiscoverTool(slDeps, { maxSources: 25, minRrfScore: 0, maxDetailedSources: 5 });
    const warehouseVerificationTools = createWarehouseVerificationTools({
      connections: deps.connections,
      fallbackFileStore: deps.project.fileStore,
      wikiSearchTool,
      slDiscoverTool,
    });
    this.baseTools = [
      new WikiReadTool(deps.wikiService, deps.knowledgeIndex),
      wikiSearchTool,
      new WikiListTagsTool(deps.knowledgeIndex),
      new WikiWriteTool(deps.wikiService, deps.knowledgeIndex, deps.knowledgeEvents),
      new WikiRemoveTool(deps.wikiService, deps.knowledgeIndex, deps.knowledgeEvents),
      slDiscoverTool,
      new SlEditSourceTool(slDeps),
      new SlReadSourceTool(slDeps),
      new SlWriteSourceTool(slDeps),
      new SlValidateTool(slDeps),
      new SlRollbackTool(deps.slSourcesRepository, deps.connections, 0),
      ...warehouseVerificationTools,
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
    const sourceTools: KtxRuntimeToolSet =
      session.ingest?.sourceKey === 'historic-sql'
        ? {
            emit_historic_sql_evidence: createRuntimeToolDescriptorFromAiTool(
              'emit_historic_sql_evidence',
              createEmitHistoricSqlEvidenceTool({
                connectionId: session.connectionId,
                session,
              }),
            ),
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
    'ktx ingest requires llm.provider.backend: anthropic, vertex, gateway, or claude-code, or an injected agentRunner.',
    'Configure a local Claude Code session or API-backed LLM, then rerun ingest:',
    `  ktx setup --project-dir ${projectDir} --llm-backend claude-code --no-input`,
    `  ktx setup --project-dir ${projectDir} --llm-backend anthropic --anthropic-api-key-env ANTHROPIC_API_KEY --llm-model claude-sonnet-4-6 --no-input`,
  ].join('\n');
}

function resolveAgentRunner(options: CreateLocalBundleIngestRuntimeOptions): {
  agentRunner: AgentRunnerPort;
  llmRuntime?: KtxLlmRuntimePort;
} {
  const llmRuntime =
    options.llmRuntime ??
    (options.createLlmRuntime ?? createLocalKtxLlmRuntimeFromConfig)(options.project.config.llm, {
      projectDir: options.project.projectDir,
      env: process.env,
    }) ??
    undefined;

  if (options.agentRunner) {
    return { agentRunner: options.agentRunner, ...(llmRuntime ? { llmRuntime } : {}) };
  }

  if (!llmRuntime) {
    throw new Error(localIngestLlmProviderGuardMessage(options.project.projectDir));
  }

  return {
    agentRunner: new RuntimeAgentRunner(llmRuntime),
    llmRuntime,
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
  const { agentRunner, llmRuntime } = resolveAgentRunner(options);
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
      ingestTraceLevel: ingestTraceLevelFromEnv(),
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
    llmRuntime,
    pageTriage: llmRuntime
      ? new PageTriageService({
          store: contextStore,
          llmRuntime,
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
