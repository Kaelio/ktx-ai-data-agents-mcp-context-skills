import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { localConnectionInfoFromConfig } from '../../context/connections/local-warehouse-descriptor.js';
import type { KtxEmbeddingPort } from '../../context/core/embedding.js';
import type { KtxFileStorePort, KtxFileWriteResult } from '../../context/core/file-store.js';
import { type KtxLogger, noopLogger } from '../../context/core/config.js';
import { SessionWorktreeService } from '../../context/core/session-worktree.service.js';
import type { KtxSemanticLayerComputePort } from '../../context/daemon/semantic-layer-compute.js';
import { createLocalKtxLlmRuntimeFromConfig } from '../../context/llm/local-config.js';
import { RuntimeAgentRunner, type AgentRunnerPort, type KtxLlmRuntimePort, type KtxRuntimeToolSet } from '../../context/llm/runtime-port.js';
import type { KtxLocalProject } from '../../context/project/project.js';
import { PromptService } from '../../context/prompts/prompt.service.js';
import { SkillsRegistryService } from '../../context/skills/skills-registry.service.js';
import type { KtxConnectionInfo, KtxQueryResult, SlConnectionCatalogPort, SlPythonPort, SlSourcesIndexPort } from '../../context/sl/ports.js';
import { SemanticLayerService } from '../../context/sl/semantic-layer.service.js';
import type { SemanticLayerSource } from '../../context/sl/types.js';
import { SlDiscoverTool } from '../../context/sl/tools/sl-discover.tool.js';
import { SlEditSourceTool } from '../../context/sl/tools/sl-edit-source.tool.js';
import { SlReadSourceTool } from '../../context/sl/tools/sl-read-source.tool.js';
import { SlRollbackTool } from '../../context/sl/tools/sl-rollback.tool.js';
import { SlSearchService } from '../../context/sl/sl-search.service.js';
import { SlValidateTool } from '../../context/sl/tools/sl-validate.tool.js';
import type { SlValidationDeps } from '../../context/sl/tools/sl-warehouse-validation.js';
import type { SlValidatorPort } from '../../context/sl/sl-validator.port.js';
import { SlWriteSourceTool } from '../../context/sl/tools/sl-write-source.tool.js';
import { SqliteSlSourcesIndex } from '../../context/sl/sqlite-sl-sources-index.js';
import { sourceDefinitionSchema, sourceOverlaySchema } from '../../context/sl/schemas.js';
import { BaseTool, type ToolContext } from '../../context/tools/base-tool.js';
import type { GitAuthorResolverPort } from '../../context/tools/authors.js';
import type { KnowledgeEventPort, KnowledgeIndexPort, KnowledgeIndexPageListing } from '../../context/wiki/ports.js';
import { KnowledgeWikiService } from '../../context/wiki/knowledge-wiki.service.js';
import { searchLocalKnowledgePages } from '../../context/wiki/local-knowledge.js';
import { WikiListTagsTool } from '../../context/wiki/tools/wiki-list-tags.tool.js';
import { WikiReadTool } from '../../context/wiki/tools/wiki-read.tool.js';
import { WikiRemoveTool } from '../../context/wiki/tools/wiki-remove.tool.js';
import { WikiSearchTool } from '../../context/wiki/tools/wiki-search.tool.js';
import { WikiWriteTool } from '../../context/wiki/tools/wiki-write.tool.js';
import { LocalMemoryRunStore } from './local-memory-runs.js';
import { MemoryAgentService } from './memory-agent.service.js';
import { MemoryIngestService } from './memory-runs.js';
import type {
  MemoryConnectionPort,
  MemoryFileStorePort,
  MemoryKnowledgeSlRefsPort,
  MemorySlSourceReconcilerPort,
  MemoryToolSetLike,
  MemoryToolsetFactoryPort,
} from './types.js';

const promptsDir = fileURLToPath(new URL('../../prompts', import.meta.url));
const skillsDir = fileURLToPath(new URL('../../skills', import.meta.url));
const LOCAL_AUTHOR = { name: 'KTX Local', email: 'local@ktx.local' };
const LOCAL_SHAPE_WARNING = 'Local memory ingest validates semantic-layer YAML shape only.';

export interface CreateLocalProjectMemoryIngestOptions {
  llmRuntime?: KtxLlmRuntimePort;
  agentRunner?: AgentRunnerPort;
  memoryModel?: string;
  semanticLayerCompute?: KtxSemanticLayerComputePort;
  queryExecutor?: { execute(input: { connectionId: string; sql: string; maxRows?: number }): Promise<KtxQueryResult> };
  runIdFactory?: () => string;
  logger?: KtxLogger;
}

export function createLocalProjectMemoryIngest(
  project: KtxLocalProject,
  options: CreateLocalProjectMemoryIngestOptions = {},
): MemoryIngestService {
  const logger = options.logger ?? noopLogger;
  const rootFileStore = new LocalMemoryFileStore(project.fileStore);
  const embedding = new NoopEmbeddingPort();
  const knowledgeIndex = new LocalKnowledgeIndex(project);
  const knowledgeEvents = new NoopKnowledgeEventPort();
  const knowledgeSlRefs = new NoopKnowledgeSlRefsPort();
  const connections = new LocalMemoryConnections(project, options.queryExecutor);
  const slPython = new LocalSlPythonPort(options.semanticLayerCompute);
  const semanticLayerService = new SemanticLayerService(rootFileStore, connections, slPython, logger);
  const slSourcesRepository = new SqliteSlSourcesIndex({ dbPath: join(project.projectDir, '.ktx', 'db.sqlite') });
  const slSearchService = new SlSearchService(embedding, slSourcesRepository, logger);
  const wikiService = new KnowledgeWikiService(rootFileStore, embedding, knowledgeIndex, project.git, logger);
  const authorResolver = new LocalAuthorResolver();
  const llmRuntime =
    options.llmRuntime ?? createLocalKtxLlmRuntimeFromConfig(project.config.llm, { projectDir: project.projectDir });
  const toolsetFactory = new LocalMemoryToolsetFactory({
    project,
    embedding,
    wikiService,
    knowledgeIndex,
    knowledgeEvents,
    semanticLayerService,
    slSearchService,
    authorResolver,
    slSourcesRepository,
    connections,
  });
  const agentRunner =
    options.agentRunner ??
    new RuntimeAgentRunner(requireLlmRuntime(llmRuntime));
  const memoryAgent = new MemoryAgentService({
    settings: {
      knowledge: { userScopedKnowledgeEnabled: false },
      slValidation: { probeRowCount: 0 },
      llm: { memoryIngestionModel: project.config.llm.models.default ?? 'local-memory-model' },
    },
    promptService: new PromptService({ promptsDir, partials: [] }),
    skillsRegistry: new SkillsRegistryService({ skillsDir }),
    wikiService,
    knowledgeIndex,
    knowledgeSlRefs,
    semanticLayerService,
    slSearchService,
    connections,
    rootFileStore,
    gitService: project.git,
    lockingService: new LocalMemoryLock(),
    slSourcesRepository,
    sessionWorktreeService: new SessionWorktreeService({
      coreConfig: project.coreConfig,
      gitService: project.git,
      configService: rootFileStore,
    }),
    semanticLayerSourceReconciler: new NoopSemanticLayerSourceReconciler(),
    agentRunner,
    slValidator: new LocalShapeOnlySlValidator(),
    toolsetFactory,
    logger,
  });
  return new MemoryIngestService({
    memoryAgent,
    runs: new LocalMemoryRunStore({ projectDir: project.projectDir, idFactory: options.runIdFactory }),
  });
}

function requireLlmRuntime(runtime: KtxLlmRuntimePort | null | undefined): KtxLlmRuntimePort {
  if (!runtime) {
    throw new Error('createLocalProjectMemoryIngest requires llm.provider.backend or an injected agentRunner');
  }
  return runtime;
}

class LocalMemoryFileStore implements MemoryFileStorePort {
  constructor(private readonly fileStore: MemoryFileStorePort | KtxFileStorePort) {}

  forWorktree(workdir: string): LocalMemoryFileStore {
    return new LocalMemoryFileStore(this.fileStore.forWorktree(workdir) as KtxFileStorePort);
  }

  writeFile(...args: Parameters<KtxFileStorePort['writeFile']>): Promise<KtxFileWriteResult> {
    return this.fileStore.writeFile(...args);
  }

  readFile(...args: Parameters<KtxFileStorePort['readFile']>) {
    return this.fileStore.readFile(...args);
  }

  deleteFile(...args: Parameters<KtxFileStorePort['deleteFile']>) {
    return this.fileStore.deleteFile(...args);
  }

  listFiles(...args: Parameters<KtxFileStorePort['listFiles']>) {
    return this.fileStore.listFiles(...args);
  }

  getFileHistory(...args: Parameters<KtxFileStorePort['getFileHistory']>) {
    return this.fileStore.getFileHistory(...args);
  }

  async enqueueCommitMessageJobForExternalCommit(): Promise<void> {}
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

class LocalKnowledgeIndex implements KnowledgeIndexPort {
  constructor(private readonly project: KtxLocalProject) {}

  async upsertPage(): Promise<void> {}

  async applyDiffTransactional(): Promise<void> {}

  async getExistingSearchTexts(): Promise<Map<string, { searchText: string; hasEmbedding: boolean }>> {
    return new Map();
  }

  async deleteStale(): Promise<number> {
    return 0;
  }

  async deleteByScope(): Promise<number> {
    return 0;
  }

  async deleteByKey(): Promise<number> {
    return 0;
  }

  async findPageByKey(scope: string, scopeId: string | null, pageKey: string) {
    const path = this.pagePath(scope, scopeId, pageKey);
    try {
      await this.project.fileStore.readFile(path);
      return { page_key: pageKey };
    } catch {
      return null;
    }
  }

  async listPagesForUser(userId: string) {
    const pages: KnowledgeIndexPageListing[] = [];
    for (const scope of [
      { scope: 'GLOBAL', scopeId: null, dir: 'wiki/global' },
      { scope: 'USER', scopeId: userId, dir: `wiki/user/${userId}` },
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
          tags: parseWikiTags(raw.content),
        });
      }
    }
    return pages.sort((a, b) => a.page_key.localeCompare(b.page_key));
  }

  async getUserPageCount(userId: string): Promise<number> {
    return (await this.listPagesForUser(userId)).filter((page) => page.scope === 'USER').length;
  }

  async incrementUsageCount(): Promise<void> {}

  async searchRRF(_userId: string, _embedding: number[] | null, queryText: string, limit: number) {
    const pages = await this.listPagesForUser(_userId);
    return pages
      .map((page) => ({
        pageKey: page.page_key,
        summary: page.summary,
        rrfScore: scoreText(`${page.page_key} ${page.summary}`, queryText),
      }))
      .filter((page) => page.rrfScore > 0)
      .sort((a, b) => b.rrfScore - a.rrfScore || a.pageKey.localeCompare(b.pageKey))
      .slice(0, limit);
  }

  private pagePath(scope: string, scopeId: string | null, pageKey: string): string {
    return scope === 'GLOBAL' ? `wiki/global/${pageKey}.md` : `wiki/user/${scopeId}/${pageKey}.md`;
  }
}

class NoopKnowledgeEventPort implements KnowledgeEventPort {
  async createEvent(): Promise<void> {}
}

class NoopKnowledgeSlRefsPort implements MemoryKnowledgeSlRefsPort {
  async syncFromWiki(): Promise<{ inserted: number; deleted: number }> {
    return { inserted: 0, deleted: 0 };
  }
}

class LocalMemoryConnections implements MemoryConnectionPort, SlConnectionCatalogPort {
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
      throw new Error('Local memory capture has no query executor configured');
    }
    return this.queryExecutor.execute({ connectionId, sql });
  }
}

class LocalSlPythonPort implements SlPythonPort {
  constructor(private readonly compute?: KtxSemanticLayerComputePort) {}

  async validateSources(input: Parameters<SlPythonPort['validateSources']>[0]) {
    if (!this.compute) {
      return {
        data: {
          errors: [],
          warnings: [LOCAL_SHAPE_WARNING],
          per_source_warnings: {},
        },
      };
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
      return { error: 'Local memory capture has no semantic compute adapter configured' };
    }
    const result = await this.compute.query({
      sources: input.sources,
      dialect: input.dialect,
      query: input.query,
    });
    return { data: { sql: result.sql, plan: result.plan } };
  }
}

class LocalAuthorResolver implements GitAuthorResolverPort {
  async resolve() {
    return LOCAL_AUTHOR;
  }
}

class LocalMemoryLock {
  async withLock<T>(_key: 'config:repo', fn: () => Promise<T>): Promise<T> {
    return fn();
  }
}

class NoopSemanticLayerSourceReconciler implements MemorySlSourceReconcilerPort {
  async upsertRow(): Promise<void> {}
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

class LocalMemoryToolSet implements MemoryToolSetLike {
  constructor(private readonly tools: BaseTool[]) {}

  toRuntimeTools(context: ToolContext): KtxRuntimeToolSet {
    return Object.fromEntries(this.tools.map((tool) => [tool.name, tool.toRuntimeTool(context)]));
  }
}

class LocalMemoryToolsetFactory implements MemoryToolsetFactoryPort {
  private readonly wikiTools: BaseTool[];
  private readonly slTools: BaseTool[];

  constructor(deps: {
    project: KtxLocalProject;
    embedding: KtxEmbeddingPort;
    wikiService: KnowledgeWikiService;
    knowledgeIndex: KnowledgeIndexPort;
    knowledgeEvents: KnowledgeEventPort;
    semanticLayerService: SemanticLayerService;
    slSearchService: SlSearchService;
    authorResolver: GitAuthorResolverPort;
    slSourcesRepository: SlSourcesIndexPort;
    connections: SlConnectionCatalogPort;
  }) {
    const slDeps = {
      semanticLayerService: deps.semanticLayerService,
      slSearchService: deps.slSearchService,
      authorResolver: deps.authorResolver,
    };
    this.wikiTools = [
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
      new WikiListTagsTool(deps.knowledgeIndex),
      new WikiWriteTool(deps.wikiService, deps.knowledgeIndex, deps.knowledgeEvents),
      new WikiRemoveTool(deps.wikiService, deps.knowledgeIndex, deps.knowledgeEvents),
    ];
    this.slTools = [
      new SlDiscoverTool(slDeps, { maxSources: 25, minRrfScore: 0, maxDetailedSources: 5 }),
      new SlEditSourceTool(slDeps),
      new SlReadSourceTool(slDeps),
      new SlWriteSourceTool(slDeps),
      new SlValidateTool(slDeps),
      new SlRollbackTool(deps.slSourcesRepository, deps.connections, 0),
    ];
  }

  createIngestWuToolset(): MemoryToolSetLike {
    return new LocalMemoryToolSet([...this.wikiTools, ...this.slTools]);
  }

  createToolset(): MemoryToolSetLike {
    return new LocalMemoryToolSet(this.wikiTools);
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
