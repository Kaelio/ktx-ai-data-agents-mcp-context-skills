import type { createKtxEmbeddingProvider, createKtxLlmProvider } from '@ktx/llm';
import {
  createDefaultLocalIngestAdapters,
  getLocalStageOnlyIngestStatus,
  type LocalIngestRunRecord,
  runLocalStageOnlyIngest,
  type SourceAdapter,
} from '../ingest/index.js';
import {
  createLocalKtxEmbeddingProviderFromConfig,
  createLocalKtxLlmRuntimeFromConfig,
  KtxScanEmbeddingPortAdapter,
} from '../llm/index.js';
import type { KtxProjectLlmConfig, KtxScanEnrichmentConfig, KtxScanRelationshipConfig } from '../project/config.js';
import type { KtxLocalProject } from '../project/index.js';
import { ktxLocalStateDbPath } from '../project/local-state-db.js';
import { redactKtxScanReport } from './credentials.js';
import { completedKtxScanEnrichmentStateSummary } from './enrichment-state.js';
import { failedKtxScanEnrichmentSummary, ktxScanErrorMessage } from './enrichment-summary.js';
import {
  createDeterministicLocalScanEnrichmentProviders,
  type KtxLocalScanEnrichmentProviders,
  runLocalScanEnrichment,
} from './local-enrichment.js';
import { writeLocalScanEnrichmentArtifacts, writeLocalScanManifestShards } from './local-enrichment-artifacts.js';
import { readLocalScanStructuralSnapshot } from './local-structural-artifacts.js';
import { SqliteLocalScanEnrichmentStateStore } from './sqlite-local-enrichment-state-store.js';
import type {
  KtxConnectionDriver,
  KtxProgressPort,
  KtxScanConnector,
  KtxScanContext,
  KtxScanEnrichmentStateSummary,
  KtxScanInput,
  KtxScanMode,
  KtxScanReport,
  KtxScanTrigger,
  KtxSchemaSnapshot,
} from './types.js';

export interface RunLocalScanOptions {
  project: KtxLocalProject;
  connectionId: string;
  mode?: KtxScanMode;
  detectRelationships?: boolean;
  dryRun?: boolean;
  trigger?: KtxScanTrigger;
  databaseIntrospectionUrl?: string;
  adapters?: SourceAdapter[];
  jobId?: string;
  now?: () => Date;
  connector?: KtxScanConnector;
  createConnector?: (connectionId: string) => KtxScanConnector | Promise<KtxScanConnector>;
  enrichmentProviders?: KtxLocalScanEnrichmentProviders | null;
  enrichmentStateStore?: SqliteLocalScanEnrichmentStateStore | null;
  progress?: KtxProgressPort;
}

export interface LocalScanRunResult {
  runId: string;
  status: 'done';
  done: true;
  connectionId: string;
  mode: KtxScanMode;
  dryRun: boolean;
  syncId: string;
  report: KtxScanReport;
}

export interface LocalScanStatusResponse {
  runId: string;
  status: LocalIngestRunRecord['status'];
  done: boolean;
  connectionId: string;
  mode: KtxScanMode;
  dryRun: boolean;
  syncId: string;
  progress: number;
  startedAt: string;
  completedAt: string;
  reportPath: string | null;
  warnings: KtxScanReport['warnings'];
}

export interface LocalScanMcpOptions {
  adapters?: SourceAdapter[];
  databaseIntrospectionUrl?: string;
  jobIdFactory?: () => string;
  now?: () => Date;
  createConnector?: (connectionId: string) => KtxScanConnector | Promise<KtxScanConnector>;
}

const LIVE_DATABASE_ADAPTER = 'live-database';
const SCAN_REPORT_FILE = 'scan-report.json';
const LOCAL_AUTHOR = 'ktx';
const LOCAL_AUTHOR_EMAIL = 'ktx@example.com';

function normalizeDriver(driver: string | undefined): KtxConnectionDriver {
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
  throw new Error(
    `Standalone ktx scan supports postgres/postgresql/sqlite/mysql/clickhouse/sqlserver/bigquery/snowflake in this phase, received "${driver ?? 'unknown'}"`,
  );
}

function tablePathCount(paths: string[]): number {
  return paths.filter((path) => path.startsWith('tables/') && path.endsWith('.json')).length;
}

function rawSourcesDir(connectionId: string, syncId: string): string {
  return `raw-sources/${connectionId}/${LIVE_DATABASE_ADAPTER}/${syncId}`;
}

function scanReportPath(connectionId: string, syncId: string): string {
  return `${rawSourcesDir(connectionId, syncId)}/${SCAN_REPORT_FILE}`;
}

function assertSupportedMode(mode: KtxScanMode): void {
  if (mode !== 'structural' && mode !== 'relationships' && mode !== 'enriched') {
    throw new Error(`Unsupported KTX scan mode: ${mode}`);
  }
}

async function resolveScanConnector(options: RunLocalScanOptions, mode: KtxScanMode): Promise<KtxScanConnector | null> {
  if (mode === 'structural' && !options.detectRelationships) {
    return null;
  }
  if (options.connector) {
    return options.connector;
  }
  if (options.createConnector) {
    return options.createConnector(options.connectionId);
  }
  throw new Error('ktx scan --enrich and --detect-relationships require a native standalone scan connector');
}

interface LocalScanEnrichmentProviderDeps {
  createKtxLlmProvider?: typeof createKtxLlmProvider;
  createKtxEmbeddingProvider?: typeof createKtxEmbeddingProvider;
  env?: NodeJS.ProcessEnv;
  projectDir?: string;
}

export function createLocalScanEnrichmentProvidersFromConfig(
  config: KtxScanEnrichmentConfig,
  llmConfig: KtxProjectLlmConfig,
  deps: LocalScanEnrichmentProviderDeps = {},
): KtxLocalScanEnrichmentProviders | null {
  if (config.mode === 'deterministic') {
    return createDeterministicLocalScanEnrichmentProviders();
  }

  if (config.mode !== 'llm' || !config.embeddings) {
    return null;
  }

  const llmRuntime = createLocalKtxLlmRuntimeFromConfig(llmConfig, {
    ...deps,
    projectDir: deps.projectDir,
  });
  const embeddingProvider = createLocalKtxEmbeddingProviderFromConfig(config.embeddings, deps);
  if (!llmRuntime || !embeddingProvider) {
    return null;
  }

  return {
    llmRuntime,
    embedding: new KtxScanEmbeddingPortAdapter(embeddingProvider),
  };
}

function createLocalScanEnrichmentStateStore(options: RunLocalScanOptions): SqliteLocalScanEnrichmentStateStore | null {
  if (options.dryRun) {
    return null;
  }
  if (options.enrichmentStateStore !== undefined) {
    return options.enrichmentStateStore;
  }
  return new SqliteLocalScanEnrichmentStateStore({ dbPath: ktxLocalStateDbPath(options.project) });
}

function localScanProviderIdentity(
  config: KtxScanEnrichmentConfig,
  llmConfig: KtxProjectLlmConfig,
  relationships: KtxScanRelationshipConfig,
): Record<string, unknown> {
  return {
    mode: config.mode,
    embeddingDimensions: config.embeddings?.dimensions ?? null,
    llmModel: llmConfig.models.default ?? null,
    embeddingModel: config.embeddings?.model ?? null,
    batchSize: config.embeddings?.batchSize ?? null,
    baseUrlConfigured: Boolean(llmConfig.provider.gateway?.base_url),
    relationships,
  };
}

function reportFromIngest(input: {
  record: LocalIngestRunRecord;
  driver: KtxConnectionDriver;
  mode: KtxScanMode;
  dryRun: boolean;
  trigger: KtxScanTrigger;
  createdAt: string;
}): KtxScanReport {
  const reportPath = input.dryRun ? null : scanReportPath(input.record.connectionId, input.record.syncId);
  return {
    connectionId: input.record.connectionId,
    driver: input.driver,
    syncId: input.record.syncId,
    runId: input.record.runId,
    trigger: input.trigger,
    mode: input.mode,
    dryRun: input.dryRun,
    artifactPaths: {
      rawSourcesDir: input.dryRun ? null : rawSourcesDir(input.record.connectionId, input.record.syncId),
      reportPath,
      manifestShards: [],
      enrichmentArtifacts: [],
    },
    diffSummary: {
      tablesAdded: tablePathCount(input.record.diffPaths.added),
      tablesModified: tablePathCount(input.record.diffPaths.modified),
      tablesDeleted: tablePathCount(input.record.diffPaths.deleted),
      tablesUnchanged: tablePathCount(input.record.diffPaths.unchanged),
      columnsAdded: 0,
      columnsModified: 0,
      columnsDeleted: 0,
    },
    manifestShardsWritten: 0,
    structuralSyncStats: {
      tablesCreated: 0,
      tablesUpdated: 0,
      tablesDeleted: 0,
      columnsCreated: 0,
      columnsUpdated: 0,
      columnsDeleted: 0,
    },
    enrichment: {
      dataDictionary: 'skipped',
      tableDescriptions: 'skipped',
      columnDescriptions: 'skipped',
      embeddings: 'skipped',
      deterministicRelationships: 'skipped',
      llmRelationshipValidation: 'skipped',
      statisticalValidation: 'skipped',
    },
    capabilityGaps: [],
    warnings: [],
    relationships: { accepted: 0, review: 0, rejected: 0, skipped: 0 },
    enrichmentState: completedKtxScanEnrichmentStateSummary(),
    createdAt: input.createdAt,
  };
}

async function writeScanReport(project: KtxLocalProject, report: KtxScanReport): Promise<void> {
  if (!report.artifactPaths.reportPath) {
    return;
  }
  await project.fileStore.writeFile(
    report.artifactPaths.reportPath,
    `${JSON.stringify(report, null, 2)}\n`,
    LOCAL_AUTHOR,
    LOCAL_AUTHOR_EMAIL,
    `scan(${LIVE_DATABASE_ADAPTER}): ${report.runId} syncId=${report.syncId}`,
  );
}

function scanDiffSummaryFromRecord(record: LocalIngestRunRecord): KtxScanReport['diffSummary'] {
  return {
    tablesAdded: tablePathCount(record.diffPaths.added),
    tablesModified: tablePathCount(record.diffPaths.modified),
    tablesDeleted: tablePathCount(record.diffPaths.deleted),
    tablesUnchanged: tablePathCount(record.diffPaths.unchanged),
    columnsAdded: 0,
    columnsModified: 0,
    columnsDeleted: 0,
  };
}

function hasNoContentChanges(record: LocalIngestRunRecord): boolean {
  return (
    record.previousRunId !== null &&
    record.diffSummary.added === 0 &&
    record.diffSummary.modified === 0 &&
    record.diffSummary.deleted === 0
  );
}

function scanChangeSummary(diffSummary: KtxScanReport['diffSummary']): string {
  const changedTables = diffSummary.tablesAdded + diffSummary.tablesModified + diffSummary.tablesDeleted;
  const totalTables = changedTables + diffSummary.tablesUnchanged;
  const changeNoun = changedTables === 1 ? 'change' : 'changes';
  const tableNoun = totalTables === 1 ? 'table' : 'tables';
  return `Semantic layer comparison found ${changedTables} ${changeNoun} across ${totalTables} ${tableNoun}`;
}

async function readScanReport(
  project: KtxLocalProject,
  connectionId: string,
  syncId: string,
): Promise<KtxScanReport | null> {
  try {
    const raw = await project.fileStore.readFile(scanReportPath(connectionId, syncId));
    return JSON.parse(raw.content) as KtxScanReport;
  } catch {
    return null;
  }
}

export function resolveEnabledTables(connection: Record<string, unknown> | undefined): Set<string> | null {
  const raw = connection?.enabled_tables;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  return new Set(raw.filter((v): v is string => typeof v === 'string'));
}

export function filterSnapshotTables(snapshot: KtxSchemaSnapshot, enabledTables: Set<string>): KtxSchemaSnapshot {
  return {
    ...snapshot,
    tables: snapshot.tables.filter((table) => {
      const key = table.db ? `${table.db}.${table.name}` : table.name;
      return enabledTables.has(key);
    }),
  };
}

function createFilteredConnector(connector: KtxScanConnector, enabledTables: Set<string>): KtxScanConnector {
  return {
    ...connector,
    async introspect(input: KtxScanInput, ctx: KtxScanContext): Promise<KtxSchemaSnapshot> {
      const snapshot = await connector.introspect(input, ctx);
      return filterSnapshotTables(snapshot, enabledTables);
    },
  };
}

function withInternalLiveDatabaseAdapter(project: KtxLocalProject): KtxLocalProject {
  if (project.config.ingest.adapters.includes(LIVE_DATABASE_ADAPTER)) {
    return project;
  }
  return {
    ...project,
    config: {
      ...project.config,
      ingest: {
        ...project.config.ingest,
        adapters: [...project.config.ingest.adapters, LIVE_DATABASE_ADAPTER],
      },
    },
  };
}

export async function runLocalScan(options: RunLocalScanOptions): Promise<LocalScanRunResult> {
  const mode = options.mode ?? 'structural';
  assertSupportedMode(mode);
  await options.progress?.update(0.05, 'Preparing scan');
  const rawConnector = await resolveScanConnector(options, mode);

  const connection = options.project.config.connections[options.connectionId];
  if (!connection) {
    throw new Error(`Connection "${options.connectionId}" is not configured in ktx.yaml`);
  }
  const driver = normalizeDriver(connection.driver);
  const enabledTables = resolveEnabledTables(connection);
  const connector = rawConnector && enabledTables ? createFilteredConnector(rawConnector, enabledTables) : rawConnector;
  const adapters =
    options.adapters ??
    createDefaultLocalIngestAdapters(options.project, { databaseIntrospectionUrl: options.databaseIntrospectionUrl });
  const enrichmentProviders =
    connector && (mode !== 'structural' || options.detectRelationships)
      ? options.enrichmentProviders !== undefined
        ? options.enrichmentProviders
        : createLocalScanEnrichmentProvidersFromConfig(options.project.config.scan.enrichment, options.project.config.llm, {
            projectDir: options.project.projectDir,
          })
      : null;

  await options.progress?.update(0.15, 'Inspecting database schema');
  const record = await runLocalStageOnlyIngest({
    project: withInternalLiveDatabaseAdapter(options.project),
    adapters,
    adapter: LIVE_DATABASE_ADAPTER,
    connectionId: options.connectionId,
    trigger: 'manual_resync',
    jobId: options.jobId,
    now: options.now,
    dryRun: options.dryRun,
  });
  await options.progress?.update(0.55, scanChangeSummary(scanDiffSummaryFromRecord(record)));
  let report = reportFromIngest({
    record,
    driver,
    mode,
    dryRun: options.dryRun ?? false,
    trigger: options.trigger ?? 'cli',
    createdAt: (options.now?.() ?? new Date()).toISOString(),
  });
  let reusedExistingScanArtifacts = false;
  const existingReport =
    !report.dryRun && !connector && hasNoContentChanges(record)
      ? await readScanReport(options.project, record.connectionId, record.syncId)
      : null;
  if (existingReport && existingReport.mode === mode && existingReport.dryRun === report.dryRun) {
    report.artifactPaths = existingReport.artifactPaths;
    report.capabilityGaps = existingReport.capabilityGaps;
    report.warnings = existingReport.warnings;
    report.relationships = existingReport.relationships;
    report.enrichment = existingReport.enrichment;
    report.enrichmentState = existingReport.enrichmentState;
    reusedExistingScanArtifacts = true;
  }
  const enrichmentStateStore = connector ? createLocalScanEnrichmentStateStore(options) : null;
  let enrichmentState: KtxScanEnrichmentStateSummary = completedKtxScanEnrichmentStateSummary();
  if (!reusedExistingScanArtifacts && !report.dryRun && report.artifactPaths.rawSourcesDir) {
    await options.progress?.update(0.7, 'Writing schema artifacts');
    const rawSnapshot = await readLocalScanStructuralSnapshot({
      project: options.project,
      connectionId: options.connectionId,
      driver,
      rawSourcesDir: report.artifactPaths.rawSourcesDir,
      extractedAtFallback: report.createdAt,
    });
    const structuralSnapshot = enabledTables ? filterSnapshotTables(rawSnapshot, enabledTables) : rawSnapshot;
    if (enabledTables && structuralSnapshot.tables.length < rawSnapshot.tables.length) {
      const excluded = rawSnapshot.tables.length - structuralSnapshot.tables.length;
      let remaining = excluded;
      const ds = report.diffSummary;
      const subFrom = (field: 'tablesAdded' | 'tablesUnchanged' | 'tablesModified') => {
        const take = Math.min(remaining, ds[field]);
        ds[field] -= take;
        remaining -= take;
      };
      subFrom('tablesAdded');
      subFrom('tablesUnchanged');
      subFrom('tablesModified');
      await options.progress?.update(0.6, scanChangeSummary(report.diffSummary));
    }
    const manifestArtifacts = await writeLocalScanManifestShards({
      project: options.project,
      connectionId: options.connectionId,
      syncId: record.syncId,
      driver,
      snapshot: structuralSnapshot,
      dryRun: false,
    });
    report.artifactPaths.manifestShards = manifestArtifacts.manifestShards;
    report.manifestShardsWritten = manifestArtifacts.manifestShardsWritten;
  }
  if (connector) {
    try {
      await options.progress?.update(
        0.82,
        mode === 'relationships' || options.detectRelationships
          ? 'Detecting relationships'
          : 'Enriching schema metadata',
      );
      const enrichment = await runLocalScanEnrichment({
        connectionId: options.connectionId,
        mode,
        detectRelationships: options.detectRelationships,
        connector,
        context: { runId: record.runId, progress: options.progress?.startPhase(0.18) },
        providers: enrichmentProviders,
        stateStore: enrichmentStateStore,
        syncId: record.syncId,
        providerIdentity: localScanProviderIdentity(
          options.project.config.scan.enrichment,
          options.project.config.llm,
          options.project.config.scan.relationships,
        ),
        relationshipSettings: options.project.config.scan.relationships,
        now: options.now,
      });
      const artifacts = await writeLocalScanEnrichmentArtifacts({
        project: options.project,
        connectionId: options.connectionId,
        syncId: record.syncId,
        driver,
        enrichment,
        dryRun: options.dryRun ?? false,
        relationshipSettings: options.project.config.scan.relationships,
      });
      report.enrichment = enrichment.summary;
      report.relationships = enrichment.relationships;
      enrichmentState = enrichment.state;
      report.enrichmentState = enrichmentState;
      report.warnings.push(...enrichment.warnings);
      report.artifactPaths.enrichmentArtifacts = artifacts.enrichmentArtifacts;
      report.artifactPaths.manifestShards = artifacts.manifestShards;
      report.manifestShardsWritten = artifacts.manifestShardsWritten;
    } catch (error) {
      const message = ktxScanErrorMessage(error);
      report.enrichment = failedKtxScanEnrichmentSummary(mode, options.detectRelationships ?? false);
      const stages = await enrichmentStateStore?.listRunStages(record.runId);
      if (stages) {
        enrichmentState = completedKtxScanEnrichmentStateSummary();
        for (const stage of stages) {
          if (stage.status === 'completed') {
            enrichmentState.completedStages.push(stage.stage);
          } else {
            enrichmentState.failedStages.push(stage.stage);
          }
        }
        report.enrichmentState = enrichmentState;
      }
      report.warnings.push({
        code: 'enrichment_failed',
        message: `KTX scan enrichment failed after structural scan completed: ${message}`,
        recoverable: true,
        metadata: { mode, detectRelationships: options.detectRelationships ?? false },
      });
    }
  }
  report = redactKtxScanReport(report);
  if (!reusedExistingScanArtifacts) {
    await writeScanReport(options.project, report);
  }
  await options.progress?.update(1, 'Scan completed');
  return {
    runId: record.runId,
    status: 'done',
    done: true,
    connectionId: record.connectionId,
    mode,
    dryRun: options.dryRun ?? false,
    syncId: record.syncId,
    report,
  };
}

export async function getLocalScanReport(project: KtxLocalProject, runId: string): Promise<KtxScanReport | null> {
  const status = await getLocalStageOnlyIngestStatus(project, runId);
  if (!status || status.adapter !== LIVE_DATABASE_ADAPTER) {
    return null;
  }
  const report = await readScanReport(project, status.connectionId, status.syncId);
  if (!report) {
    return null;
  }
  return {
    ...report,
    runId: status.runId,
    syncId: status.syncId,
    diffSummary: scanDiffSummaryFromRecord(status),
  };
}

export async function getLocalScanStatus(
  project: KtxLocalProject,
  runId: string,
): Promise<LocalScanStatusResponse | null> {
  const status = await getLocalStageOnlyIngestStatus(project, runId);
  if (!status || status.adapter !== LIVE_DATABASE_ADAPTER) {
    return null;
  }
  const report = await getLocalScanReport(project, runId);
  return {
    runId: status.runId,
    status: status.status,
    done: status.done,
    connectionId: status.connectionId,
    mode: report?.mode ?? 'structural',
    dryRun: report?.dryRun ?? false,
    syncId: status.syncId,
    progress: status.progress,
    startedAt: status.startedAt,
    completedAt: status.completedAt,
    reportPath: report?.artifactPaths.reportPath ?? null,
    warnings: report?.warnings ?? [],
  };
}
