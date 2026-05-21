import { describe, expect, it } from 'vitest';
import type {
  DeterministicFinalizationContext,
  FinalizationOverrideReplay,
  FinalizationResult,
} from './ingest/index.js';
import type {
  ApplyLocalScanRelationshipReviewDecisionsInput,
  ApplyLocalScanRelationshipReviewDecisionsResult,
} from './scan/index.js';

const scanTypeExportCoverage: Partial<{
  input: ApplyLocalScanRelationshipReviewDecisionsInput;
  result: ApplyLocalScanRelationshipReviewDecisionsResult;
}> = {};

const ingestFinalizationTypeExportCoverage: Partial<{
  context: DeterministicFinalizationContext;
  overrideReplay: FinalizationOverrideReplay;
  result: FinalizationResult;
}> = {};

describe('@ktx/context package exports', () => {
  it('exports package entry points used by host adapters', async () => {
    const core = await import('./core/index.js');
    const connections = await import('./connections/index.js');
    const scan = await import('./scan/index.js');
    const search = await import('./search/index.js');
    const agent = await import('./agent/index.js');
    const prompts = await import('./prompts/index.js');
    const skills = await import('./skills/index.js');
    const sl = await import('./sl/index.js');
    const wiki = await import('./wiki/index.js');
    const tools = await import('./tools/index.js');
    const memory = await import('./memory/index.js');
    const ingest = await import('./ingest/index.js');
    const memoryFlow = await import('./ingest/memory-flow/index.js');
    const metabaseMapping = await import('./ingest/metabase-mapping.js');
    const mcp = await import('./mcp/index.js');
    const project = await import('./project/index.js');
    const daemon = await import('./daemon/index.js');
    const sqlAnalysis = await import('./sql-analysis/index.js');
    const root = await import('./index.js');

    expect(core).toBeDefined();
    expect(connections.createPostgresQueryExecutor).toBeTypeOf('function');
    expect(connections.createSqliteQueryExecutor).toBeTypeOf('function');
    expect(connections.createDefaultLocalQueryExecutor).toBeTypeOf('function');
    expect(connections.sqliteDatabasePathFromConnection).toBeTypeOf('function');
    expect(connections.parseNotionConnectionConfig).toBeTypeOf('function');
    expect(connections.redactNotionConnectionConfig).toBeTypeOf('function');
    expect(connections.notionConnectionToPullConfig).toBeTypeOf('function');
    expect(scan).toBeDefined();
    expect(scanTypeExportCoverage).toEqual({});
    expect(ingestFinalizationTypeExportCoverage).toEqual({});
    expect(scan.createKtxConnectorCapabilities).toBeTypeOf('function');
    expect(`liveDatabaseSnapshotToKtx${'SchemaSnapshot'}` in scan).toBe(false);
    expect(scan.normalizeKtxNativeType).toBeTypeOf('function');
    expect(scan.inferKtxDimensionType).toBeTypeOf('function');
    expect(scan.redactKtxCredentialEnvelope).toBeTypeOf('function');
    expect(scan.redactKtxScanReport).toBeTypeOf('function');
    expect(scan.redactKtxScanWarning).toBeTypeOf('function');
    expect(core.redactKtxSensitiveMetadata).toBeTypeOf('function');
    expect(core.redactKtxSensitiveText).toBeTypeOf('function');
    expect(scan.isKtxDataDictionaryCandidate).toBeTypeOf('function');
    expect(scan.buildKtxColumnEmbeddingText).toBeTypeOf('function');
    expect(scan.KtxDescriptionGenerator).toBeTypeOf('function');
    expect(scan.runLocalScan).toBeTypeOf('function');
    expect(scan.writeLocalScanEnrichmentArtifacts).toBeTypeOf('function');
    expect(scan.readLocalScanStructuralSnapshot).toBeTypeOf('function');
    expect(scan.writeLocalScanManifestShards).toBeTypeOf('function');
    expect(scan.buildKtxColumnDescriptionPrompt).toBeTypeOf('function');
    expect(scan.buildKtxTableDescriptionPrompt).toBeTypeOf('function');
    expect(scan.buildKtxDataSourceDescriptionPrompt).toBeTypeOf('function');
    expect(scan.currentKtxRelationshipBenchmarkDetector).toBeTypeOf('function');
    expect(scan.generateKtxRelationshipDiscoveryCandidates).toBeTypeOf('function');
    expect(scan.inferKtxRelationshipTargetPks).toBeTypeOf('function');
    expect(scan.mergeKtxRelationshipDiscoveryCandidates).toBeTypeOf('function');
    expect(scan.normalizeKtxRelationshipName).toBeTypeOf('function');
    expect(scan.tokenizeKtxRelationshipName).toBeTypeOf('function');
    expect(scan.tokenSimilarity).toBeTypeOf('function');
    expect(scan.localCandidateTables).toBeTypeOf('function');
    expect(scan.scoreKtxRelationshipCandidate).toBeTypeOf('function');
    expect(scan.defaultKtxRelationshipScoreWeights).toBeTypeOf('function');
    expect(scan.normalizeKtxRelationshipScoreWeights).toBeTypeOf('function');
    expect(scan.calibrateWeightsFromSyntheticFixtures).toBeTypeOf('function');
    expect(scan.singularizeKtxRelationshipToken).toBeTypeOf('function');
    expect(scan.pluralizeKtxRelationshipToken).toBeTypeOf('function');
    expect(scan.collectKtxFormalMetadataRelationships).toBeTypeOf('function');
    expect(scan.discoverKtxCompositeRelationships).toBeTypeOf('function');
    expect(scan.proposeKtxRelationshipCandidatesWithLlm).toBeTypeOf('function');
    expect(scan.profileKtxRelationshipSchema).toBeTypeOf('function');
    expect(scan.quoteKtxRelationshipIdentifier).toBeTypeOf('function');
    expect(scan.formatKtxRelationshipTableRef).toBeTypeOf('function');
    expect(scan.validateKtxRelationshipDiscoveryCandidates).toBeTypeOf('function');
    expect(scan.applyKtxRelationshipValidationBudget).toBeTypeOf('function');
    expect(scan.defaultKtxRelationshipValidationBudget).toBeTypeOf('function');
    expect(scan.resolveKtxRelationshipGraph).toBeTypeOf('function');
    expect(scan.discoverKtxRelationships).toBeTypeOf('function');
    expect('KtxRelationshipDetector' in scan).toBe(false);
    expect('defaultKtxRelationshipDetectionSettings' in scan).toBe(false);
    expect('KTX_RELATIONSHIP_DETECTION_CONFIDENCE' in scan).toBe(false);
    expect(scan.buildKtxRelationshipArtifacts).toBeTypeOf('function');
    expect(scan.buildKtxRelationshipDiagnostics).toBeTypeOf('function');
    expect(scan.readLocalScanRelationshipArtifacts).toBeTypeOf('function');
    expect(scan.writeLocalScanRelationshipReviewDecision).toBeTypeOf('function');
    expect(scan.applyLocalScanRelationshipReviewDecisions).toBeTypeOf('function');
    expect(scan.exportLocalRelationshipFeedbackLabels).toBeTypeOf('function');
    expect(scan.formatKtxRelationshipFeedbackLabelsJsonl).toBeTypeOf('function');
    expect(scan.buildKtxRelationshipFeedbackCalibrationReport).toBeTypeOf('function');
    expect(scan.calibrateLocalRelationshipFeedbackLabels).toBeTypeOf('function');
    expect(scan.formatKtxRelationshipFeedbackCalibrationMarkdown).toBeTypeOf('function');
    expect(scan.buildKtxRelationshipThresholdAdviceReport).toBeTypeOf('function');
    expect(scan.adviseLocalRelationshipFeedbackThresholds).toBeTypeOf('function');
    expect(scan.formatKtxRelationshipThresholdAdviceMarkdown).toBeTypeOf('function');
    expect(scan.emptyKtxRelationshipProfileArtifact).toBeTypeOf('function');
    expect(scan.loadKtxRelationshipBenchmarkFixture).toBeTypeOf('function');
    expect(scan.loadKtxRelationshipBenchmarkFixtures).toBeTypeOf('function');
    expect(scan.maskKtxRelationshipBenchmarkSnapshot).toBeTypeOf('function');
    expect(scan.runKtxRelationshipBenchmarkCase).toBeTypeOf('function');
    expect(scan.runKtxRelationshipBenchmarkSuite).toBeTypeOf('function');
    expect(scan.KTX_RELATIONSHIP_BENCHMARK_MODES).toEqual([
      'metadata_present',
      'declared_fks_removed',
      'declared_pks_removed',
      'declared_pks_and_declared_fks_removed',
      'llm_disabled',
      'profiling_disabled',
      'validation_disabled',
      'embeddings_disabled',
    ]);
    expect(scan.buildKtxRelationshipBenchmarkReport).toBeTypeOf('function');
    expect(scan.formatKtxRelationshipBenchmarkReportMarkdown).toBeTypeOf('function');
    expect(search).toBeDefined();
    expect(search.HybridSearchCore).toBeTypeOf('function');
    expect(search.normalizeSearchQuery).toBeTypeOf('function');
    expect(search.rrfContribution).toBeTypeOf('function');
    expect(search.assertSearchBackendConformanceCase).toBeTypeOf('function');
    expect(search.assertSearchBackendCapabilities).toBeTypeOf('function');
    expect(core.resolveKtxConfigReference).toBeTypeOf('function');
    expect(root.HybridSearchCore).toBeTypeOf('function');
    expect(root.assertSearchBackendConformanceCase).toBeTypeOf('function');
    expect(root.assertSearchBackendCapabilities).toBeTypeOf('function');
    expect(root.createLocalKtxEmbeddingProviderFromConfig).toBeTypeOf('function');
    expect(agent).toBeDefined();
    expect(agent.RuntimeAgentRunner).toBeTypeOf('function');
    expect(root.RuntimeAgentRunner).toBeTypeOf('function');
    expect(root.createLocalKtxLlmProviderFromConfig).toBeTypeOf('function');
    expect(prompts).toBeDefined();
    expect(skills).toBeDefined();
    expect(sl).toBeDefined();
    expect(sl.writeLocalSlSource).toBeTypeOf('function');
    expect(sl.readLocalSlSource).toBeTypeOf('function');
    expect(sl.validateLocalSlSource).toBeTypeOf('function');
    expect(sl.searchLocalSlSources).toBeTypeOf('function');
    expect(sl.SqliteSlSourcesIndex).toBeTypeOf('function');
    expect('searchLocalSlSourcesWithPglitePrototype' in sl).toBe(false);
    expect(sl.compileLocalSlQuery).toBeTypeOf('function');
    expect(wiki).toBeDefined();
    expect(wiki.writeLocalKnowledgePage).toBeTypeOf('function');
    expect(wiki.readLocalKnowledgePage).toBeTypeOf('function');
    expect(wiki.searchLocalKnowledgePages).toBeTypeOf('function');
    expect(wiki.SqliteKnowledgeIndex).toBeTypeOf('function');
    expect('WikiSearchMatchReason' in wiki).toBe(false);
    expect(tools).toBeDefined();
    expect(memory).toBeDefined();
    expect(ingest).toBeDefined();
    expect(memoryFlow.parseMemoryFlowReplayInput).toBeTypeOf('function');
    expect(memoryFlow.renderMemoryFlowReplay).toBeTypeOf('function');
    expect(ingest.LiveDatabaseSourceAdapter).toBeTypeOf('function');
    expect(ingest.createDaemonLiveDatabaseIntrospection).toBeTypeOf('function');
    expect(ingest.buildLiveDatabaseManifestShards).toBeTypeOf('function');
    expect(ingest.planLiveDatabaseStructuralSync).toBeTypeOf('function');
    expect(ingest.runLocalIngest).toBeTypeOf('function');
    expect(ingest.runLocalMetabaseIngest).toBeTypeOf('function');
    expect(ingest.getLocalIngestStatus).toBeTypeOf('function');
    expect(ingest.createLocalBundleIngestRuntime).toBeTypeOf('function');
    expect(ingest.runLocalStageOnlyIngest).toBeTypeOf('function');
    expect(ingest.getLocalStageOnlyIngestStatus).toBeTypeOf('function');
    expect(ingest.createDefaultLocalIngestAdapters).toBeTypeOf('function');
    expect(ingest.createLookerQueryToSlTool).toBeTypeOf('function');
    expect(ingest.buildLookerSlProposal).toBeTypeOf('function');
    expect(ingest.describeLookerScope).toBeTypeOf('function');
    expect(ingest.hashLookerScope).toBeTypeOf('function');
    expect(ingest.readLookerFetchReport).toBeTypeOf('function');
    expect(ingest.writeLookerFetchReport).toBeTypeOf('function');
    expect(ingest.writeLookerEvidenceDocuments).toBeTypeOf('function');
    expect(ingest.getLookerTriageSignals).toBeTypeOf('function');
    expect(ingest.LookerClient).toBeTypeOf('function');
    expect(ingest.DefaultLookerConnectionClientFactory).toBeTypeOf('function');
    expect(ingest.DefaultLookerClientFactory).toBeTypeOf('function');
    expect(ingest.LocalLookerRuntimeStore).toBeTypeOf('function');
    expect(ingest.createDaemonLookerTableIdentifierParser).toBeTypeOf('function');
    expect(ingest.createLocalLookerCredentialResolver).toBeTypeOf('function');
    expect(ingest.discoverLookerConnections).toBeTypeOf('function');
    expect(ingest.computeLookerMappingDrift).toBeTypeOf('function');
    expect(ingest.validateLookerMappings).toBeTypeOf('function');
    expect(ingest.refreshLookerMappingPlaceholders).toBeTypeOf('function');
    expect(ingest.suggestKtxConnectionForLookerConnection).toBeTypeOf('function');
    expect(ingest.buildLookerPullConfigFromInputs).toBeTypeOf('function');
    expect(ingest.validateLookerWarehouseTarget).toBeTypeOf('function');
    expect(ingest.sqlglotDialectForConnectionType).toBeTypeOf('function');
    expect(ingest.lookerConnectionIdSchema).toBeDefined();
    expect(ingest.lookerRuntimeCursorsSchema).toBeDefined();
    expect(ingest.stagedSyncConfigSchema).toBeDefined();
    expect(ingest.stagedLookerScopeFileSchema).toBeDefined();
    expect(ingest.stagedLookerFetchReportSchema).toBeDefined();
    expect('LocalMetabaseSourceStateReader' in ingest).toBe(false);
    expect(ingest.KtxYamlMetabaseSourceStateReader).toBeTypeOf('function');
    expect(ingest.LocalMetabaseDiscoveryCache).toBeTypeOf('function');
    expect(ingest.createLocalMetabaseSourceAdapter).toBeTypeOf('function');
    expect(ingest.metabaseRuntimeConfigFromLocalConnection).toBeTypeOf('function');
    expect(ingest.IngestMetabaseClientFactory).toBeTypeOf('function');
    expect(ingest.MetabaseClient).toBeTypeOf('function');
    expect(ingest.DefaultMetabaseConnectionClientFactory).toBeTypeOf('function');
    expect(ingest.DEFAULT_METABASE_CLIENT_CONFIG).toMatchObject({
      maxRetries: 2,
      timeoutMs: 60000,
      retryableStatuses: [429, 500, 502, 503, 504],
    });
    expect(ingest.expandCardReferences).toBeTypeOf('function');
    expect(ingest.CardReferenceCycleError).toBeTypeOf('function');
    expect(ingest.parseMetabasePullConfig).toBeTypeOf('function');
    expect(ingest.METABASE_ENGINE_TO_CONNECTION_TYPE).toMatchObject({
      postgres: 'POSTGRESQL',
      bigquery: 'BIGQUERY',
      snowflake: 'SNOWFLAKE',
    });
    expect(metabaseMapping.METABASE_ENGINE_TO_CONNECTION_TYPE).toBe(ingest.METABASE_ENGINE_TO_CONNECTION_TYPE);
    expect(metabaseMapping.validateMappingPhysicalMatch).toBeTypeOf('function');
    expect(ingest.discoverMetabaseDatabases).toBeTypeOf('function');
    expect(ingest.computeMetabaseMappingDrift).toBeTypeOf('function');
    expect(ingest.computeMetabaseMappingPhysicalMismatches).toBeTypeOf('function');
    expect(ingest.refreshMetabaseMapping).toBeTypeOf('function');
    expect(ingest.validateMetabaseMappings).toBeTypeOf('function');
    expect(ingest.validateMappingPhysicalMatch).toBeTypeOf('function');
    expect(ingest.findBestMatch).toBeTypeOf('function');
    expect(ingest.NotionSourceAdapter).toBeTypeOf('function');
    expect(ingest.NotionClient).toBeTypeOf('function');
    expect(ingest.HistoricSqlSourceAdapter).toBeTypeOf('function');
    expect(ingest.SnowflakeHistoricSqlQueryHistoryReader).toBeTypeOf('function');
    expect(ingest.BigQueryHistoricSqlQueryHistoryReader).toBeTypeOf('function');
    expect(ingest.PostgresPgssReader).toBeTypeOf('function');
    expect(ingest.HistoricSqlExtensionMissingError).toBeTypeOf('function');
    expect(ingest.HistoricSqlVersionUnsupportedError).toBeTypeOf('function');
    expect(ingest.HISTORIC_SQL_SOURCE_KEY).toBe('historic-sql');
    expect(ingest.historicSqlUnifiedPullConfigSchema).toBeDefined();
    expect(ingest.aggregatedTemplateSchema).toBeDefined();
    expect(ingest.stagedTableInputSchema).toBeDefined();
    expect(ingest.historicSqlEvidenceEnvelopeSchema).toBeDefined();
    expect(ingest.historicSqlEvidencePath).toBeTypeOf('function');
    expect(ingest.createEmitHistoricSqlEvidenceTool).toBeTypeOf('function');
    expect(ingest.SqliteContextEvidenceStore).toBeTypeOf('function');
    expect(ingest.SqliteBundleIngestStore).toBeTypeOf('function');
    expect(ingest.CuratorPaginationService).toBeTypeOf('function');
    expect(mcp).toBeDefined();
    expect(project).toBeDefined();
    expect(daemon).toBeDefined();
    expect(mcp.registerKtxContextTools).toBeTypeOf('function');
    expect(mcp.createLocalProjectMcpContextPorts).toBeTypeOf('function');
    expect(project.buildDefaultKtxProjectConfig).toBeTypeOf('function');
    expect(daemon.createHttpSemanticLayerComputePort).toBeTypeOf('function');
    expect(daemon.createPythonSemanticLayerComputePort).toBeTypeOf('function');
    expect(sqlAnalysis.createHttpSqlAnalysisPort).toBeTypeOf('function');
    expect(root.createHttpSqlAnalysisPort).toBeTypeOf('function');
  });
});
