export { DbtSourceAdapter } from './adapters/dbt/dbt.adapter.js';
export { FakeSourceAdapter } from './adapters/fake/fake.adapter.js';
export type {
  DaemonLiveDatabaseIntrospectionOptions,
  KtxDaemonDatabaseHttpJsonRunner,
  KtxDaemonDatabaseIntrospectionCommand,
  KtxDaemonDatabaseJsonRunner,
} from './adapters/live-database/daemon-introspection.js';
export { createDaemonLiveDatabaseIntrospection } from './adapters/live-database/daemon-introspection.js';
export type {
  LiveDatabaseExtractedColumn,
  LiveDatabaseExtractedForeignKey,
  LiveDatabaseExtractedSchema,
  LiveDatabaseExtractedTable,
} from './adapters/live-database/extracted-schema.js';
export {
  buildLiveDatabaseTableNaturalKey,
  ktxSchemaSnapshotToExtractedSchema,
} from './adapters/live-database/extracted-schema.js';
export { LiveDatabaseSourceAdapter } from './adapters/live-database/live-database.adapter.js';
export type {
  BuildLiveDatabaseManifestShardsInput,
  BuildLiveDatabaseManifestShardsResult,
  LiveDatabaseManifestColumn,
  LiveDatabaseManifestExistingDescriptions,
  LiveDatabaseManifestJoinData,
  LiveDatabaseManifestJoinEntry,
  LiveDatabaseManifestShard,
  LiveDatabaseManifestTableData,
  LiveDatabaseManifestTableEntry,
} from './adapters/live-database/manifest.js';
export { buildLiveDatabaseManifestShards } from './adapters/live-database/manifest.js';
export type {
  LiveDatabaseStructuralChanges,
  LiveDatabaseStructuralSyncOperations,
  LiveDatabaseStructuralSyncPlan,
  LiveDatabaseStructuralSyncStats,
  LiveDatabaseSyncedColumn,
  LiveDatabaseSyncedLink,
  LiveDatabaseSyncedSchema,
  LiveDatabaseSyncedTable,
  PlanLiveDatabaseStructuralSyncInput,
} from './adapters/live-database/structural-sync.js';
export { planLiveDatabaseStructuralSync } from './adapters/live-database/structural-sync.js';
export type {
  LiveDatabaseIntrospectionPort,
  LiveDatabaseSourceAdapterDeps,
} from './adapters/live-database/types.js';
export { getLookerTriageSignals, writeLookerEvidenceDocuments } from './adapters/looker/evidence-documents.js';
export { LookerClient } from './adapters/looker/client.js';
export type {
  LookerClientDeps,
  LookerClientLogger,
  LookerConnectionParams,
  LookerSdkPort,
  LookerWarehouseConnectionInfo,
  TestConnectionResult as LookerTestConnectionResult,
} from './adapters/looker/client.js';
export type {
  LookerClientFactory,
  LookerEntityRef,
  LookerRuntimeClient,
} from './adapters/looker/fetch.js';
export {
  DefaultLookerClientFactory,
  DefaultLookerConnectionClientFactory,
} from './adapters/looker/factory.js';
export {
  createDaemonLookerTableIdentifierParser,
  type DaemonLookerTableIdentifierParserOptions,
  type KtxDaemonTableIdentifierHttpJsonRunner,
} from './adapters/looker/daemon-table-identifier-parser.js';
export type {
  LookerConnectionClientFactory,
  LookerCredentialResolver,
} from './adapters/looker/factory.js';
export {
  createLocalLookerCredentialResolver,
  createLocalLookerSourceAdapter,
  lookerCredentialsFromLocalConnection,
} from './adapters/looker/local-looker.adapter.js';
export {
  LocalLookerRuntimeStore,
  type ClearLocalLookerMappingsInput,
  type LocalLookerConnectionMappingListRow,
  type LocalLookerMappingSource,
  type LookerSourceStateReader,
  type RefreshLocalLookerDiscoveredConnectionsInput,
  type UpsertLocalLookerConnectionMappingInput,
} from './adapters/looker/local-runtime-store.js';
export {
  LOOKER_DIALECT_TO_CONNECTION_TYPE,
  buildLookerPullConfigFromInputs,
  collectExploreParseItems,
  computeLookerMappingDrift,
  discoverLookerConnections,
  extractWarehouseDatabase,
  extractWarehouseHost,
  lookerDialectToConnectionType,
  normalizeHost,
  normalizeName,
  projectParsedIdentifier,
  refreshLookerMappingPlaceholders,
  sqlglotDialectForConnectionType,
  suggestKtxConnectionForLookerConnection,
  validateLookerMappings,
  validateLookerWarehouseTarget,
} from './adapters/looker/mapping.js';
export type {
  LookerConnectionMapping as KtxLookerConnectionMapping,
  LookerMappingCandidateConnection,
  LookerMappingClient,
  LookerMappingDrift,
  LookerMappingValidationResult,
  LookerParsedIdentifier,
  LookerTableIdentifierParseItem,
  LookerTableIdentifierParser,
  LookerTargetConnection,
  LookerWarehouseTargetConnectionType,
} from './adapters/looker/mapping.js';
export {
  readLookerFetchReport,
  writeLookerFetchReport,
} from './adapters/looker/fetch-report.js';
export { LookerSourceAdapter, type LookerSourceAdapterDeps } from './adapters/looker/looker.adapter.js';
export {
  describeLookerScope,
  hashLookerScope,
  isPathInLookerScope,
  readLookerScope,
} from './adapters/looker/scope.js';
export type {
  LookerQueryToSlInput,
  LookerSlFieldProposal,
  LookerSlMeasureProposal,
  LookerSlProposal,
  LookerSlSegmentProposal,
} from './adapters/looker/tools/looker-query-to-sl.tool.js';
export {
  buildLookerSlProposal,
  createLookerQueryToSlTool,
  formatLookerSlProposal,
  lookerQueryToSlInputSchema,
} from './adapters/looker/tools/looker-query-to-sl.tool.js';
export type {
  LookerPullConfig,
  LookerRuntimeCursors,
  StagedDashboardFile,
  StagedExploreFile,
  StagedFoldersTreeFile,
  StagedGroupFile,
  StagedLookerFetchIssue,
  StagedLookerFetchReport,
  StagedLookerQuery,
  StagedLookerScopeFile,
  StagedLookerSignalsFile,
  StagedLookFile,
  StagedLookmlModelsFile,
  StagedUserFile,
} from './adapters/looker/types.js';
export {
  lookerConnectionIdSchema,
  lookerRuntimeCursorsSchema,
  stagedLookerFetchIssueSchema,
  stagedLookerFetchReportSchema,
  stagedLookerScopeFileSchema,
  stagedSyncConfigSchema,
} from './adapters/looker/types.js';
export { LookmlSourceAdapter } from './adapters/lookml/lookml.adapter.js';
export { parseLookmlStagedDir } from './adapters/lookml/parse.js';
export type { ParsedLookmlProject } from './adapters/lookml/parse.js';
export {
  DEFAULT_METABASE_CLIENT_CONFIG,
  DefaultMetabaseConnectionClientFactory,
  MetabaseClient,
  getDummyValueForWidgetType,
  stripOptionalClauses,
} from './adapters/metabase/client.js';
export { CardReferenceCycleError, expandCardReferences } from './adapters/metabase/card-references.js';
export { IngestMetabaseClientFactory } from './adapters/metabase/client-port.js';
export type { MetabaseClientLogger } from './adapters/metabase/client.js';
export type {
  MetabaseCard,
  MetabaseCardSummary,
  MetabaseClientConfig,
  MetabaseClientFactory,
  MetabaseClientRuntimeConfig,
  MetabaseCollection,
  MetabaseCollectionItem,
  MetabaseConnectionClientFactory,
  MetabaseDatabase,
  MetabaseDatasetQuery,
  MetabaseNativeQueryResult,
  MetabaseParameter,
  MetabaseResolvedTemplateTag,
  MetabaseResultMetadataColumn,
  MetabaseRuntimeClient,
  MetabaseTemplateTag,
  MetabaseUser,
  ResolvedSqlResult,
  TestConnectionResult,
} from './adapters/metabase/client-port.js';
export type {
  MetabaseSourceState,
  MetabaseSourceStateMapping,
  MetabaseSourceStateReader,
  MetabaseSourceStateSelection,
} from './adapters/metabase/source-state-port.js';
export {
  METABASE_ENGINE_TO_CONNECTION_TYPE,
  computeMetabaseMappingDrift,
  computeMetabaseMappingPhysicalMismatches,
  discoverMetabaseDatabases,
  findBestMatch,
  refreshMetabaseMapping,
  validateMappingPhysicalMatch,
  validateMetabaseMappings,
} from './adapters/metabase/mapping.js';
export type {
  AutoMatchCandidate,
  AutoMatchResult as MetabaseAutoMatchResult,
  DiscoveredMetabaseDatabase,
  KtxConnectionPhysicalInfo,
  MappingPhysicalInfo,
  MappingRefreshReport,
  MetabaseMappedConnectionType,
  MetabaseMappingDrift,
  MetabaseMappingValidationResult,
  PhysicalMismatch,
  PhysicalMismatchInput,
} from './adapters/metabase/mapping.js';
export { planMetabaseFanoutChildren } from './adapters/metabase/fanout-planner.js';
export type {
  MetabaseFanoutChildPlan,
  MetabaseFanoutMappingInput,
  PlanMetabaseFanoutChildrenInput,
} from './adapters/metabase/fanout-planner.js';
export { MetabaseSourceAdapter } from './adapters/metabase/metabase.adapter.js';
export {
  createLocalMetabaseSourceAdapter,
  metabaseRuntimeConfigFromLocalConnection,
} from './adapters/metabase/local-metabase.adapter.js';
export { LocalMetabaseSourceStateReader } from './adapters/metabase/local-source-state-store.js';
export type {
  ClearLocalMetabaseMappingsInput,
  LocalMetabaseMappingListRow,
  LocalMetabaseMappingSource,
  LocalMetabaseSourceStateMappingInput,
  ReplaceLocalMetabaseSourceStateInput,
  RefreshLocalMetabaseDiscoveredDatabasesInput,
  SetLocalMetabaseMappingSyncEnabledInput,
  SetLocalMetabaseSyncStateInput,
  UpsertLocalMetabaseDatabaseMappingInput,
} from './adapters/metabase/local-source-state-store.js';
export { metabaseLocalConnectionIdSchema, metabasePullConfigSchema, parseMetabasePullConfig } from './adapters/metabase/types.js';
export type { MetabasePullConfig, MetabaseSyncMode } from './adapters/metabase/types.js';
export {
  fetchMetricflowRepo,
} from './adapters/metricflow/fetch.js';
export type { FetchMetricflowRepoParams, FetchMetricflowRepoResult } from './adapters/metricflow/fetch.js';
export {
  parseMetricflowFiles,
  translateMetricflowJinjaFilter,
} from './adapters/metricflow/deep-parse.js';
export type {
  DimensionDefinition,
  MeasureDefinition,
  MetricFlowParseResult,
  MetricflowParseOptions,
  ParsedCrossModelMetric,
  ParsedMetricflowRelationship,
  ParsedSemanticModel,
  SimpleMeasureDefinition,
} from './adapters/metricflow/deep-parse.js';
export {
  buildMetricflowColumns,
  buildMetricflowJoinsForModel,
  buildMetricflowMeasures,
  buildMetricflowSemanticModelSource,
  countImportableMetricflowRelationships,
  filterValidMetricflowRelationships,
  findMatchingMetricflowTable,
  getMetricflowAvailableColumnNames,
  mapCrossModelMetricToSource,
  mapSemanticModelToSource,
  normalizeMetricflowJoinOn,
  parseMetricflowJoinReference,
  resolveMetricflowSemanticModelSourceName,
  rewriteMetricflowJoinOn,
  rewriteMetricflowManifestJoins,
  toKebabCaseMetricflowName,
} from './adapters/metricflow/semantic-models.js';
export { importMetricflowSemanticModels } from './adapters/metricflow/import-semantic-models.js';
export type {
  ImportMetricflowSemanticModelsDeps,
  ImportMetricflowSemanticModelsInput,
  MetricFlowImportResult,
  MetricflowSemanticLayerService,
  MetricflowSemanticLayerWriter,
} from './adapters/metricflow/import-semantic-models.js';
export type {
  MetricflowHostTable,
  MetricflowSemanticModelImportContext,
  MetricflowSemanticModelJoin,
  MetricflowWritableSemanticLayerSource,
} from './adapters/metricflow/semantic-models.js';
export { MetricflowSourceAdapter, type MetricflowSourceAdapterDeps } from './adapters/metricflow/metricflow.adapter.js';
export {
  metricflowPullConfigSchema,
  parseMetricflowPullConfig,
  pullConfigFromMetricflowIntegration,
} from './adapters/metricflow/pull-config.js';
export type {
  MetricflowIntegrationLike,
  MetricflowPullConfig,
} from './adapters/metricflow/pull-config.js';
export { NOTION_ORG_KNOWLEDGE_WARNING } from './adapters/notion/chunk.js';
export { NOTION_DEFAULT_MAX_KNOWLEDGE_CREATES_PER_RUN } from './adapters/notion/types.js';
export { NotionSourceAdapter, type NotionSourceAdapterDeps } from './adapters/notion/notion.adapter.js';
export { NotionClient, type NotionApi, type NotionBotInfo } from './adapters/notion/notion-client.js';
export { chunkHistoricSqlStagedDir, describeHistoricSqlScope } from './adapters/historic-sql/chunk.js';
export { detectHistoricSqlStagedDir } from './adapters/historic-sql/detect.js';
export {
  HistoricSqlExtensionMissingError,
  HistoricSqlGrantsMissingError,
  HistoricSqlVersionUnsupportedError,
} from './adapters/historic-sql/errors.js';
export { HistoricSqlSourceAdapter } from './adapters/historic-sql/historic-sql.adapter.js';
export { BigQueryHistoricSqlQueryHistoryReader } from './adapters/historic-sql/bigquery-query-history-reader.js';
export type { BigQueryHistoricSqlQueryHistoryReaderOptions } from './adapters/historic-sql/bigquery-query-history-reader.js';
export { PostgresPgssQueryHistoryReader } from './adapters/historic-sql/postgres-pgss-query-history-reader.js';
export { SnowflakeHistoricSqlQueryHistoryReader } from './adapters/historic-sql/snowflake-query-history-reader.js';
export { stageHistoricSqlTemplates } from './adapters/historic-sql/stage.js';
export {
  pgssBaselinePath,
  readPgssBaseline,
  stagePgStatStatementsTemplates,
  writePgssBaselineAtomic,
} from './adapters/historic-sql/stage-pgss.js';
export type { PgssBaseline, StagePgStatStatementsTemplatesResult } from './adapters/historic-sql/stage-pgss.js';
export type {
  HistoricSqlDialect,
  HistoricSqlManifest,
  HistoricSqlMetadata,
  HistoricSqlPullConfig,
  HistoricSqlQueryHistoryReader,
  HistoricSqlRawQueryRow,
  HistoricSqlSourceAdapterDeps,
  HistoricSqlTimeWindow,
  HistoricSqlUsage,
  KtxPostgresQueryClient,
  PostgresPgssAggregateRow,
  PostgresPgssProbeResult,
  PostgresPgssReader,
  PostgresPgssRow,
  PostgresPgssSnapshot,
} from './adapters/historic-sql/types.js';
export {
  HISTORIC_SQL_OBJECT_TYPE,
  HISTORIC_SQL_SOURCE_KEY,
  historicSqlManifestSchema,
  historicSqlMetadataSchema,
  historicSqlPullConfigSchema,
  historicSqlRawQueryRowSchema,
  historicSqlUsageSchema,
} from './adapters/historic-sql/types.js';
export type { CanonicalPin } from './canonical-pins.js';
export { buildCanonicalPinsPromptBlock, selectRelevantCanonicalPins } from './canonical-pins.js';
export type {
  BudgetExhaustedCandidateForCarryForward,
  CandidateDedupServiceDeps,
  CandidateDedupSettings,
  ContextCandidateActionHint,
  ContextCandidateCarryforwardArgs,
  ContextCandidateCarryforwardResult,
  ContextCandidateCarryforwardServiceDeps,
  ContextCandidateCarryforwardSettings,
  ContextCandidateEmbeddingPort,
  ContextCandidateForPrompt,
  ContextCandidateLane,
  ContextCandidateRejectionReason,
  ContextCandidateScoreAggregation,
  ContextCandidateStatus,
  ContextCandidateStorePort,
  ContextCandidateVerdictSummary,
  CuratorPaginationInput,
  CuratorPaginationServiceDeps,
  CuratorPaginationSettings,
  CurrentRunEvidenceChunkForCarryForward,
  InsertContextCandidateInput,
  MarkContextCandidateClusterInput,
} from './context-candidates/index.js';
export {
  buildContextCandidateEmbeddingText,
  CandidateDedupService,
  ContextCandidateCarryforwardService,
  CuratorPaginationService,
} from './context-candidates/index.js';
export type {
  ContextEvidenceDocumentRef,
  ContextEvidenceEmbeddingPort,
  ContextEvidenceIndexStorePort,
  ContextEvidenceIndexSummary as PackageContextEvidenceIndexSummary,
  EvidencePublishState,
  ReplaceContextEvidenceChunk,
  SqliteContextEvidenceStoreOptions,
  UpsertContextEvidenceDocument,
} from './context-evidence/index.js';
export {
  ContextEvidenceIndexService,
  SqliteContextEvidenceStore,
} from './context-evidence/index.js';
export { DiffSetService } from './diff-set.service.js';
export { IngestBundleRunner } from './ingest-bundle.runner.js';
export type { DefaultLocalIngestAdaptersOptions } from './local-adapters.js';
export { createDefaultLocalIngestAdapters, localPullConfigForAdapter } from './local-adapters.js';
export type {
  LocalIngestMcpOptions,
  LocalIngestResult,
  LocalMetabaseFanoutChild,
  LocalMetabaseFanoutProgress,
  LocalMetabaseFanoutProgressChild,
  LocalMetabaseFanoutResult,
  RunLocalIngestOptions,
  RunLocalMetabaseIngestOptions,
} from './local-ingest.js';
export { getLatestLocalIngestStatus, getLocalIngestStatus, runLocalIngest, runLocalMetabaseIngest } from './local-ingest.js';
export { seedLocalMappingStateFromKtxYaml } from './local-mapping-reconcile.js';
export type {
  CreateLocalBundleIngestRuntimeOptions,
  LocalBundleIngestRuntime,
} from './local-bundle-runtime.js';
export { createLocalBundleIngestRuntime } from './local-bundle-runtime.js';
export type {
  LocalIngestDiffPaths,
  LocalIngestRunRecord,
  LocalIngestStatus,
  RunLocalStageOnlyIngestOptions,
} from './local-stage-ingest.js';
export { getLocalStageOnlyIngestStatus, runLocalStageOnlyIngest } from './local-stage-ingest.js';
export {
  ingestReportToMemoryFlowReplay,
  localIngestRunToMemoryFlowReplay,
} from './memory-flow/events.js';
export {
  buildAuthenticatedUrl,
  cleanupRepoDir,
  cloneOrPull,
  RepoConfigError,
  RepoFetchError,
  repoDirExists,
  sanitizeRepoError,
  testRepoConnection,
  validateRepoConfig,
} from './repo-fetch.js';
export type { RepoFetchConfig } from './repo-fetch.js';
export {
  loadProjectInfo,
  parseProjectName,
  parseProjectVars,
  resolveJinjaVariables,
} from './dbt-shared/project-vars.js';
export type { DbtProjectInfo, ResolveJinjaVariablesResult } from './dbt-shared/project-vars.js';
export { findDbtSchemaFiles, loadDbtSchemaFiles } from './dbt-shared/schema-files.js';
export {
  computeDbtSchemaHash,
  parseDbtSchemaFile,
  parseDbtSchemaFiles,
} from './adapters/dbt-descriptions/parse-schema.js';
export type {
  DbtParsedColumn,
  DbtColumnConstraints,
  DbtDataTestRef,
  DbtParsedRelationship,
  DbtParsedTable,
  DbtSchemaFile,
  DbtSchemaParseResult,
} from './adapters/dbt-descriptions/parse-schema.js';
export { findMatchingKtxTable, matchDbtTables } from './adapters/dbt-descriptions/match-tables.js';
export type { DbtHostTableLite, DbtTableMatch } from './adapters/dbt-descriptions/match-tables.js';
export { toDescriptionUpdates } from './adapters/dbt-descriptions/to-description-updates.js';
export type { DbtDescriptionUpdates } from './adapters/dbt-descriptions/to-description-updates.js';
export { toRelationshipUpdates } from './adapters/dbt-descriptions/to-relationship-updates.js';
export type { DbtRelationshipUpdates } from './adapters/dbt-descriptions/to-relationship-updates.js';
export { toMetadataUpdates } from './adapters/dbt-descriptions/to-metadata-updates.js';
export { mergeSemanticModelTables } from './adapters/dbt-descriptions/merge-semantic-model-tables.js';
export type { KtxJoinUpdate, KtxMetadataUpdate } from '../scan/enrichment-types.js';
export {
  createInitialMemoryFlowInteractionState,
  findMemoryFlowSearchMatches,
  reduceMemoryFlowInteractionState,
  selectedMemoryFlowColumn,
  selectedMemoryFlowDetails,
  selectMemoryFlowChip,
  selectMemoryFlowColumn,
  visibleMemoryFlowChips,
} from './memory-flow/interaction.js';
export { renderMemoryFlowInteractive } from './memory-flow/interactive-render.js';
export { createMemoryFlowLiveBuffer, sanitizeMemoryFlowError } from './memory-flow/live-buffer.js';
export { renderMemoryFlowReplay } from './memory-flow/render.js';
export { formatMemoryFlowFinalSummary } from './memory-flow/summary.js';
export type { MemoryFlowStreamEvent } from './memory-flow/schema.js';
export {
  memoryFlowActionDetailSchema,
  memoryFlowDetailSectionsSchema,
  memoryFlowEventSchema,
  memoryFlowPlannedWorkUnitSchema,
  memoryFlowReplayInputSchema,
  memoryFlowRunStatusSchema,
  memoryFlowStreamEventSchema,
  parseMemoryFlowReplayInput,
} from './memory-flow/schema.js';
export type {
  MemoryFlowChip,
  MemoryFlowColumnId,
  MemoryFlowColumnView,
  MemoryFlowDisplayStatus,
  MemoryFlowEvent,
  MemoryFlowEventSink,
  MemoryFlowFilterMode,
  MemoryFlowInteractionCommand,
  MemoryFlowInteractionState,
  MemoryFlowLiveBufferOptions,
  MemoryFlowPaneId,
  MemoryFlowPlannedWorkUnit,
  MemoryFlowRenderOptions,
  MemoryFlowReplayInput,
  MemoryFlowReplayPatch,
  MemoryFlowRunStatus,
  MemoryFlowViewModel,
} from './memory-flow/types.js';
export { buildMemoryFlowViewModel } from './memory-flow/view-model.js';
export type {
  MemoryFlowStatusBadge,
  MemoryFlowVisualColumn,
  MemoryFlowVisualModel,
} from './memory-flow/visuals.js';
export {
  buildMemoryFlowVisualModel,
  memoryFlowStatusBadge,
  renderMemoryFlowConnectorLine,
} from './memory-flow/visuals.js';
export type {
  PageTriageEvidenceChunk,
  PageTriageReport,
  PageTriageRunArgs,
  PageTriageServiceDeps,
  PageTriageSettings,
  PageTriageStorePort,
} from './page-triage/index.js';
export { PageTriageService } from './page-triage/index.js';
export type {
  CandidateDedupPort,
  CandidateDedupResult,
  ContextCandidateCarryforwardPort,
  ContextCandidateForDedup,
  ContextCandidateSummary,
  ContextEvidenceCandidatesPort,
  ContextEvidenceIndexPort,
  ContextEvidenceIndexSummary,
  CreateIngestRunArgs,
  CuratorPaginationPort,
  CuratorPaginationReport,
  DiffSetComputerPort,
  IngestBundleRunnerDeps,
  IngestCanonicalPinsPort,
  IngestCommitMessagePort,
  IngestFileStorePort,
  IngestGitAuthor,
  IngestKnowledgeIndexPort,
  IngestLockPort,
  IngestProvenanceInsert,
  IngestProvenancePort,
  IngestProvenanceRow,
  IngestReportsPort,
  IngestRunnerJob,
  IngestRunRecord,
  IngestRunsPort,
  IngestSessionWorktree,
  IngestSessionWorktreePort,
  IngestSettingsPort,
  IngestStoragePort,
  IngestToolsetFactoryPort,
  IngestToolsetLike,
  PageTriagePort,
  PageTriageRunResult,
  ProvenanceActionType,
  SourceAdapterRegistryPort,
} from './ports.js';
export {
  buildSyncId,
  provenanceMarker,
  rawSourcesDirForSync,
  rawSourcesRoot,
} from './raw-sources-paths.js';
export { ingestReportSnapshotSchema, parseIngestReportSnapshot } from './report-snapshot.js';
export type { IngestReportBody, IngestReportSnapshot } from './reports.js';
export * from './reports.js';
export { SourceAdapterRegistry } from './source-adapter-registry.js';
export type { SqliteBundleIngestStoreOptions } from './sqlite-bundle-ingest-store.js';
export { SqliteBundleIngestStore } from './sqlite-bundle-ingest-store.js';
export type {
  SaveCompletedLocalIngestRunInput,
  SqliteLocalIngestStoreOptions,
} from './sqlite-local-ingest-store.js';
export { SqliteLocalIngestStore } from './sqlite-local-ingest-store.js';
export type {
  ReconcileCandidateForPrompt,
  ReconcileCandidateSummary,
  ReconcilePromptRunState,
  WikiPageRef,
} from './stages/build-reconcile-context.js';
export {
  buildReconcileSystemPrompt,
  buildReconcileToolSet,
  buildReconcileUserPrompt,
} from './stages/build-reconcile-context.js';
export type { ReconciliationOutcome } from './stages/stage-4-reconciliation.js';
export { runReconciliationStage4 } from './stages/stage-4-reconciliation.js';
export type { StageIndex } from './stages/stage-index.types.js';
export type {
  ChunkResult,
  DiffSet,
  EvictionUnit,
  FetchContext,
  IngestBundleJob,
  IngestBundleRef,
  IngestBundleResult,
  IngestDiffSummary,
  IngestJobContext,
  IngestJobPhase,
  IngestTrigger,
  ScopeDescriptor,
  SourceAdapter,
  SourceFetchIssue,
  SourceFetchReport,
  TriageLane,
  TriageSignals,
  UnresolvedCardInfo,
  WorkUnit,
} from './types.js';
