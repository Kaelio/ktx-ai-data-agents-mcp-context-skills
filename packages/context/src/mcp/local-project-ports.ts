import YAML from 'yaml';
import {
  type KtxSqlQueryExecutorPort,
  localConnectionInfoFromConfig,
  localConnectionTypeForConfig,
} from '../connections/index.js';
import type { KtxEmbeddingPort } from '../core/index.js';
import type { KtxSemanticLayerComputePort } from '../daemon/index.js';
import {
  createDefaultLocalIngestAdapters,
  getLocalIngestStatus,
  type IngestReportSnapshot,
  ingestReportToMemoryFlowReplay,
  type LocalIngestMcpOptions,
  runLocalIngest,
  runLocalMetabaseIngest,
} from '../ingest/index.js';
import { createLocalKtxEmbeddingProviderFromConfig, KtxIngestEmbeddingPortAdapter } from '../llm/index.js';
import type { KtxLocalProject } from '../project/index.js';
import {
  getLocalScanReport,
  getLocalScanStatus,
  type KtxConnectionDriver,
  type KtxScanConnector,
  type KtxScanReport,
  type LocalScanMcpOptions,
  runLocalScan,
} from '../scan/index.js';
import {
  compileLocalSlQuery,
  type LocalSlSourceSearchResult,
  type LocalSlSourceSummary,
  listLocalSlSources,
  searchLocalSlSources,
  sourceDefinitionSchema,
  sourceOverlaySchema,
} from '../sl/index.js';
import { readLocalKnowledgePage, searchLocalKnowledgePages, writeLocalKnowledgePage } from '../wiki/local-knowledge.js';
import type {
  KtxConnectionTestResponse,
  KtxIngestStatusResponse,
  KtxMcpContextPorts,
  KtxScanArtifactListResponse,
  KtxScanArtifactReadResponse,
  KtxScanArtifactSummary,
  KtxScanArtifactType,
} from './types.js';

const LOCAL_AUTHOR = 'ktx';
const LOCAL_AUTHOR_EMAIL = 'ktx@example.com';
const SL_SHAPE_WARNING = 'Local stdio validation checks YAML shape only; Python semantic validation is not configured.';

interface CreateLocalProjectMcpContextPortsOptions {
  semanticLayerCompute?: KtxSemanticLayerComputePort;
  queryExecutor?: KtxSqlQueryExecutorPort;
  localIngest?: LocalIngestMcpOptions;
  localScan?: LocalScanMcpOptions;
  embeddingService?: KtxEmbeddingPort | null;
}

function dialectForDriver(driver: string | undefined): string {
  const normalized = (driver ?? 'postgres').toUpperCase();
  const map: Record<string, string> = {
    POSTGRESQL: 'postgres',
    POSTGRES: 'postgres',
    BIGQUERY: 'bigquery',
    SNOWFLAKE: 'snowflake',
    MYSQL: 'mysql',
    SQLSERVER: 'tsql',
    MSSQL: 'tsql',
    SQLITE: 'sqlite',
    DUCKDB: 'duckdb',
    CLICKHOUSE: 'clickhouse',
    REDSHIFT: 'redshift',
    DATABRICKS: 'databricks',
  };
  return map[normalized] ?? 'postgres';
}

function assertSafePathToken(kind: string, value: string): string {
  if (
    value.trim().length === 0 ||
    value.includes('..') ||
    value.includes('\\') ||
    value.startsWith('/') ||
    value.startsWith('.') ||
    value.includes('//')
  ) {
    throw new Error(`Unsafe ${kind}: ${value}`);
  }
  return value;
}

function assertSafeConnectionId(connectionId: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(connectionId)) {
    throw new Error(`Unsafe connection id: ${connectionId}`);
  }
  return assertSafePathToken('connection id', connectionId);
}

function assertSafeSourceName(sourceName: string): string {
  if (!/^[a-z0-9][a-z0-9_]*$/.test(sourceName)) {
    throw new Error(`Unsafe semantic-layer source name: ${sourceName}`);
  }
  return assertSafePathToken('semantic-layer source name', sourceName);
}

function normalizeScanDriver(driver: string | undefined): KtxConnectionDriver {
  const normalized = (driver ?? '').toLowerCase();
  if (
    normalized === 'postgres' ||
    normalized === 'postgresql' ||
    normalized === 'sqlite' ||
    normalized === 'sqlite3' ||
    normalized === 'mysql' ||
    normalized === 'clickhouse' ||
    normalized === 'sqlserver' ||
    normalized === 'bigquery' ||
    normalized === 'snowflake'
  ) {
    return normalized === 'sqlite3' ? 'sqlite' : normalized;
  }
  return 'postgres';
}

async function cleanupConnector(connector: KtxScanConnector | null): Promise<void> {
  if (connector?.cleanup) {
    await connector.cleanup();
  }
}

async function testLocalConnection(
  project: KtxLocalProject,
  options: CreateLocalProjectMcpContextPortsOptions,
  connectionId: string,
): Promise<KtxConnectionTestResponse | null> {
  const safeConnectionId = assertSafeConnectionId(connectionId);
  const connection = project.config.connections[safeConnectionId];
  if (!connection) {
    return null;
  }
  const connectionType = localConnectionTypeForConfig(safeConnectionId, connection);
  const createConnector = options.localScan?.createConnector;
  if (!createConnector) {
    return {
      id: safeConnectionId,
      connectionType,
      ok: true,
      tableCount: null,
      message: 'Connection is configured; no native scan connector is available for live testing.',
      warnings: ['ktx serve was not configured with a local scan connector factory.'],
    };
  }

  let connector: KtxScanConnector | null = null;
  try {
    connector = await createConnector(safeConnectionId);
    const snapshot = await connector.introspect(
      {
        connectionId: safeConnectionId,
        driver: normalizeScanDriver(connection.driver),
        mode: 'structural',
        dryRun: true,
        detectRelationships: false,
      },
      { runId: `connection-test-${safeConnectionId}` },
    );
    return {
      id: safeConnectionId,
      connectionType,
      ok: true,
      tableCount: snapshot.tables.length,
      message: 'Connection test passed.',
      warnings: [],
    };
  } catch (error) {
    return {
      id: safeConnectionId,
      connectionType,
      ok: false,
      tableCount: null,
      message: error instanceof Error ? error.message : String(error),
      warnings: [],
    };
  } finally {
    await cleanupConnector(connector);
  }
}

function scanArtifactType(path: string, report: KtxScanReport): KtxScanArtifactType {
  if (path === report.artifactPaths.reportPath) {
    return 'report';
  }
  if (report.artifactPaths.manifestShards.includes(path)) {
    return 'manifest_shard';
  }
  if (report.artifactPaths.enrichmentArtifacts.includes(path)) {
    return 'enrichment_artifact';
  }
  return 'raw_source';
}

async function artifactSize(project: KtxLocalProject, path: string): Promise<number | undefined> {
  try {
    const result = await project.fileStore.readFile(path);
    return typeof result.size === 'number' ? result.size : undefined;
  } catch {
    return undefined;
  }
}

async function listArtifactsForReport(
  project: KtxLocalProject,
  runId: string,
  report: KtxScanReport,
): Promise<KtxScanArtifactListResponse> {
  const paths = new Set<string>();
  if (report.artifactPaths.rawSourcesDir) {
    const listed = await project.fileStore.listFiles(report.artifactPaths.rawSourcesDir);
    for (const file of listed.files) {
      paths.add(file);
    }
  }
  if (report.artifactPaths.reportPath) {
    paths.add(report.artifactPaths.reportPath);
  }
  for (const path of report.artifactPaths.manifestShards) {
    paths.add(path);
  }
  for (const path of report.artifactPaths.enrichmentArtifacts) {
    paths.add(path);
  }

  const artifacts: KtxScanArtifactSummary[] = [];
  for (const path of [...paths].sort()) {
    const size = await artifactSize(project, path);
    artifacts.push({
      path,
      type: scanArtifactType(path, report),
      ...(size === undefined ? {} : { size }),
    });
  }
  return { runId, artifacts };
}

async function readScanArtifact(
  project: KtxLocalProject,
  runId: string,
  path: string,
): Promise<KtxScanArtifactReadResponse | null> {
  const report = await getLocalScanReport(project, runId);
  if (!report) {
    return null;
  }
  const listed = await listArtifactsForReport(project, runId, report);
  const artifact = listed.artifacts.find((candidate) => candidate.path === path);
  if (!artifact) {
    return null;
  }
  const result = await project.fileStore.readFile(path);
  return {
    runId,
    path,
    type: artifact.type,
    ...(typeof result.size === 'number' ? { size: result.size } : {}),
    content: result.content,
  };
}

function slPath(connectionId: string, sourceName: string): string {
  return `semantic-layer/${assertSafeConnectionId(connectionId)}/${assertSafeSourceName(sourceName)}.yaml`;
}

function sourceNameFromPath(path: string): string {
  return (
    path
      .split('/')
      .at(-1)
      ?.replace(/\.ya?ml$/, '') ?? path
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseYamlRecord(raw: string): Record<string, unknown> {
  const parsed = YAML.parse(raw) as unknown;
  if (!isRecord(parsed)) {
    throw new Error('Semantic-layer source YAML must contain an object');
  }
  return parsed;
}

async function listSlPaths(project: KtxLocalProject, connectionId?: string): Promise<string[]> {
  const root = connectionId ? `semantic-layer/${assertSafeConnectionId(connectionId)}` : 'semantic-layer';
  const listed = await project.fileStore.listFiles(root);
  return listed.files.filter((file) => file.endsWith('.yaml') || file.endsWith('.yml')).sort();
}

async function loadComputableSources(
  project: KtxLocalProject,
  connectionId: string,
): Promise<Record<string, unknown>[]> {
  const paths = await listSlPaths(project, connectionId);
  const sources: Record<string, unknown>[] = [];
  for (const path of paths) {
    const raw = await project.fileStore.readFile(path);
    const source = parseYamlRecord(raw.content);
    if (source.table || source.sql) {
      sources.push(source);
    }
  }
  return sources;
}

function validateSourceRecord(sourceName: string, source: Record<string, unknown>): string[] {
  const namedSource = { ...source, name: typeof source.name === 'string' ? source.name : sourceName };
  const definition = sourceDefinitionSchema.safeParse(namedSource);
  if (definition.success) {
    return [];
  }
  const overlay = sourceOverlaySchema.safeParse(namedSource);
  if (overlay.success) {
    return [];
  }
  return definition.error.issues.map((issue) => `${sourceName}: ${issue.path.join('.') || 'source'} ${issue.message}`);
}

function localIngestSourceDir(config: unknown): string | undefined {
  if (!isRecord(config) || config.sourceDir === undefined) {
    return undefined;
  }
  if (typeof config.sourceDir !== 'string' || config.sourceDir.trim().length === 0) {
    throw new Error('Local ingest config sourceDir must be a non-empty string when provided');
  }
  return config.sourceDir;
}

function rawFileCountFromIngestReport(report: IngestReportSnapshot): number {
  return new Set(report.body.workUnits.flatMap((workUnit) => workUnit.rawFiles)).size;
}

function hasSlSearchMetadata(
  source: LocalSlSourceSummary | LocalSlSourceSearchResult,
): source is LocalSlSourceSearchResult {
  return 'score' in source;
}

function statusFromIngestReport(report: IngestReportSnapshot): KtxIngestStatusResponse {
  const failedWorkUnits = report.body.failedWorkUnits;
  return {
    runId: report.runId,
    jobId: report.jobId,
    reportId: report.id,
    status: failedWorkUnits.length > 0 ? 'error' : 'done',
    stage: 'done',
    progress: 1,
    errors: failedWorkUnits,
    done: true,
    adapter: report.sourceKey,
    connectionId: report.connectionId,
    sourceDir: null,
    syncId: report.body.syncId,
    startedAt: report.createdAt,
    completedAt: report.createdAt,
    previousRunId: null,
    diffSummary: report.body.diffSummary,
    workUnitCount: report.body.workUnits.length,
    rawFileCount: rawFileCountFromIngestReport(report),
    workUnits: report.body.workUnits.map((workUnit) => ({
      unitKey: workUnit.unitKey,
      rawFiles: [...workUnit.rawFiles],
      peerFileIndex: [],
      dependencyPaths: [],
    })),
    evictionDeletedRawPaths: [...report.body.evictionInputs],
  };
}

export function createLocalProjectMcpContextPorts(
  project: KtxLocalProject,
  options: CreateLocalProjectMcpContextPortsOptions = {},
): KtxMcpContextPorts {
  const configuredEmbeddingProvider = createLocalKtxEmbeddingProviderFromConfig(project.config.ingest.embeddings);
  const embeddingService =
    options.embeddingService ??
    (configuredEmbeddingProvider ? new KtxIngestEmbeddingPortAdapter(configuredEmbeddingProvider) : null);
  const ports: KtxMcpContextPorts = {
    connections: {
      async list() {
        return Object.entries(project.config.connections)
          .map(([id, config]) => localConnectionInfoFromConfig(id, config))
          .filter(
            (connection): connection is { id: string; name: string; connectionType: string } => connection !== null,
          )
          .sort((a, b) => a.id.localeCompare(b.id));
      },
      async test(input) {
        return testLocalConnection(project, options, input.connectionId);
      },
    },
    knowledge: {
      async search(input) {
        const results = await searchLocalKnowledgePages(project, {
          query: input.query,
          userId: input.userId,
          limit: input.limit,
          embeddingService,
        });
        return {
          results: results.slice(0, input.limit).map((result) => ({
            key: result.key,
            path: result.path,
            scope: result.scope,
            summary: result.summary,
            score: result.score,
            matchReasons: result.matchReasons,
            lanes: result.lanes,
          })),
          totalFound: results.length,
        };
      },
      async read(input) {
        const page = await readLocalKnowledgePage(project, {
          key: input.key,
          userId: input.userId,
        });
        return page
          ? {
              key: page.key,
              scope: page.scope,
              summary: page.summary,
              content: page.content,
              tags: page.tags,
              refs: page.refs,
              slRefs: page.slRefs,
            }
          : null;
      },
      async write(input) {
        const existing = await readLocalKnowledgePage(project, {
          key: input.key,
          userId: input.userId,
        });
        await writeLocalKnowledgePage(project, {
          key: input.key,
          scope: 'GLOBAL',
          userId: input.userId,
          summary: input.summary,
          content: input.content,
          tags: input.tags,
          refs: input.refs,
          slRefs: input.slRefs,
          source: input.source,
          intent: input.intent,
          tables: input.tables,
          representativeSql: input.representativeSql,
          usage: input.usage,
          fingerprints: input.fingerprints,
        });
        return { success: true, key: input.key, action: existing ? 'updated' : 'created' };
      },
    },
    semanticLayer: {
      async listSources(input) {
        const listed: Array<LocalSlSourceSummary | LocalSlSourceSearchResult> = input.query
          ? await searchLocalSlSources(project, {
              connectionId: input.connectionId,
              query: input.query,
              embeddingService,
            })
          : await listLocalSlSources(project, { connectionId: input.connectionId });
        const sources = listed.map((source) => ({
          connectionId: source.connectionId,
          connectionName: source.connectionId,
          name: source.name,
          description: source.description,
          columnCount: source.columnCount,
          measureCount: source.measureCount,
          joinCount: source.joinCount,
          ...(hasSlSearchMetadata(source) ? { score: source.score } : {}),
          ...(hasSlSearchMetadata(source) && source.matchReasons ? { matchReasons: source.matchReasons } : {}),
          ...(hasSlSearchMetadata(source) && source.dictionaryMatches
            ? { dictionaryMatches: source.dictionaryMatches }
            : {}),
          ...(hasSlSearchMetadata(source) && source.lanes ? { lanes: source.lanes } : {}),
        }));
        return { sources, totalSources: sources.length };
      },
      async readSource(input) {
        const path = slPath(input.connectionId, input.sourceName);
        try {
          const result = await project.fileStore.readFile(path);
          return { sourceName: input.sourceName, yaml: result.content };
        } catch {
          return null;
        }
      },
      async writeSource(input) {
        const path = slPath(input.connectionId, input.sourceName);
        if (input.delete) {
          const deleted = await project.fileStore.deleteFile(
            path,
            LOCAL_AUTHOR,
            LOCAL_AUTHOR_EMAIL,
            `Remove semantic-layer source: ${input.sourceName}`,
          );
          return { success: Boolean(deleted), sourceName: input.sourceName };
        }

        const yaml =
          input.yaml ?? YAML.stringify({ ...input.source, name: input.sourceName }, { indent: 2, lineWidth: 0 });
        parseYamlRecord(yaml);
        await project.fileStore.writeFile(
          path,
          `${yaml.trimEnd()}\n`,
          LOCAL_AUTHOR,
          LOCAL_AUTHOR_EMAIL,
          `Update semantic-layer source: ${input.sourceName}`,
        );
        return { success: true, sourceName: input.sourceName, yaml: `${yaml.trimEnd()}\n` };
      },
      async validate(input) {
        if (options.semanticLayerCompute) {
          const connectionId = assertSafeConnectionId(input.connectionId);
          const result = await options.semanticLayerCompute.validateSources({
            sources: await loadComputableSources(project, connectionId),
            dialect: dialectForDriver(project.config.connections[connectionId]?.driver),
            recentlyTouched: input.names,
          });
          return {
            success: result.valid,
            errors: result.errors,
            warnings: result.warnings,
          };
        }

        const names = new Set(input.names ?? []);
        const paths = await listSlPaths(project, input.connectionId);
        const errors: string[] = [];
        for (const path of paths) {
          const sourceName = sourceNameFromPath(path);
          if (names.size > 0 && !names.has(sourceName)) {
            continue;
          }
          try {
            const raw = await project.fileStore.readFile(path);
            errors.push(...validateSourceRecord(sourceName, parseYamlRecord(raw.content)));
          } catch (error) {
            errors.push(`${sourceName}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        return {
          success: errors.length === 0,
          errors,
          warnings: [SL_SHAPE_WARNING],
        };
      },
      async query(input) {
        if (!options.semanticLayerCompute) {
          throw new Error(
            'sl_query requires a semantic-layer query adapter. Local stdio MCP exposes file-backed SL CRUD only.',
          );
        }
        return compileLocalSlQuery(project, {
          connectionId: input.connectionId,
          query: input.query,
          compute: options.semanticLayerCompute,
          execute: Boolean(options.queryExecutor),
          maxRows: input.query.limit,
          queryExecutor: options.queryExecutor,
        });
      },
    },
  };

  if (options.localIngest) {
    ports.ingest = {
      async trigger(input) {
        const sourceDir = localIngestSourceDir(input.config);
        if (input.adapter === 'metabase' && !sourceDir) {
          const result = await (options.localIngest?.runLocalMetabaseIngest ?? runLocalMetabaseIngest)({
            project,
            adapters: options.localIngest?.adapters ?? createDefaultLocalIngestAdapters(project),
            metabaseConnectionId: input.connectionId,
            trigger: input.trigger,
            jobIdFactory: options.localIngest?.jobIdFactory,
            pullConfigOptions: options.localIngest?.pullConfigOptions,
            agentRunner: options.localIngest?.agentRunner,
            llmProvider: options.localIngest?.llmProvider,
            memoryModel: options.localIngest?.memoryModel,
            semanticLayerCompute: options.localIngest?.semanticLayerCompute ?? options.semanticLayerCompute,
            queryExecutor: options.localIngest?.queryExecutor ?? options.queryExecutor,
            logger: options.localIngest?.logger,
          });
          return {
            runId: `metabase-fanout:${result.metabaseConnectionId}`,
            jobId: undefined,
            reportId: undefined,
            fanout: {
              status: result.status,
              children: result.children.map((child) => ({
                runId: child.report.runId,
                jobId: child.report.jobId,
                reportId: child.report.id,
                targetConnectionId: child.targetConnectionId,
                metabaseDatabaseId: child.metabaseDatabaseId,
              })),
            },
          };
        }

        const executeLocalIngest = options.localIngest?.runLocalIngest ?? runLocalIngest;
        const result = await executeLocalIngest({
          project,
          adapters: options.localIngest?.adapters ?? createDefaultLocalIngestAdapters(project),
          adapter: input.adapter,
          connectionId: input.connectionId,
          sourceDir,
          pullConfigOptions: options.localIngest?.pullConfigOptions,
          trigger: input.trigger,
          jobId: options.localIngest?.jobIdFactory?.(),
          agentRunner: options.localIngest?.agentRunner,
          llmProvider: options.localIngest?.llmProvider,
          memoryModel: options.localIngest?.memoryModel,
          semanticLayerCompute: options.localIngest?.semanticLayerCompute ?? options.semanticLayerCompute,
          queryExecutor: options.localIngest?.queryExecutor ?? options.queryExecutor,
          logger: options.localIngest?.logger,
        });
        return {
          runId: result.report.runId,
          jobId: result.report.jobId,
          reportId: result.report.id,
        };
      },
      async status(input) {
        const report = await getLocalIngestStatus(project, input.runId);
        return report ? statusFromIngestReport(report) : null;
      },
      async report(input) {
        return getLocalIngestStatus(project, input.runId);
      },
      async replay(input) {
        const report = await getLocalIngestStatus(project, input.runId);
        return report ? ingestReportToMemoryFlowReplay(report) : null;
      },
    };
  }

  if (options.localScan) {
    ports.scan = {
      async trigger(input) {
        return runLocalScan({
          project,
          connectionId: input.connectionId,
          mode: input.mode,
          detectRelationships: input.detectRelationships,
          dryRun: input.dryRun,
          trigger: 'mcp',
          adapters: options.localScan?.adapters,
          databaseIntrospectionUrl: options.localScan?.databaseIntrospectionUrl,
          createConnector: options.localScan?.createConnector,
          jobId: options.localScan?.jobIdFactory?.(),
          now: options.localScan?.now,
        });
      },
      async status(input) {
        return getLocalScanStatus(project, input.runId);
      },
      async report(input) {
        return getLocalScanReport(project, input.runId);
      },
      async listArtifacts(input) {
        const report = await getLocalScanReport(project, input.runId);
        return report ? listArtifactsForReport(project, input.runId, report) : null;
      },
      async readArtifact(input) {
        return readScanArtifact(project, input.runId, input.path);
      },
    };
  }

  return ports;
}
