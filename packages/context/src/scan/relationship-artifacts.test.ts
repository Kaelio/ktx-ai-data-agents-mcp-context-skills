import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runLocalStageOnlyIngest, type SourceAdapter } from '../ingest/index.js';
import { initKtxProject, loadKtxProject } from '../project/index.js';
import { describe, expect, it } from 'vitest';
import { readLocalScanRelationshipArtifacts } from './relationship-artifacts.js';
import type { KtxRelationshipArtifact, KtxRelationshipDiagnosticsArtifact } from './relationship-diagnostics.js';
import type { KtxRelationshipProfileArtifact } from './relationship-profiling.js';
import type { KtxScanReport } from './types.js';

async function writeProjectFile(projectDir: string, relativePath: string, content: string): Promise<void> {
  const absolutePath = join(projectDir, relativePath);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, 'utf-8');
}

async function writeWarehouseConfig(projectDir: string): Promise<void> {
  await writeFile(
    join(projectDir, 'ktx.yaml'),
    [
      'connections:',
      '  warehouse:',
      '    driver: sqlite',
      '    path: warehouse.db',
      'ingest:',
      '  adapters:',
      '    - live-database',
      '',
    ].join('\n'),
    'utf-8',
  );
}

function liveDatabaseAdapter(): SourceAdapter {
  return {
    source: 'live-database',
    skillNames: ['live_database_ingest'],
    async fetch(_pullConfig, stagedDir) {
      await mkdir(join(stagedDir, 'tables'), { recursive: true });
      await writeFile(join(stagedDir, 'connection.json'), '{"connectionId":"warehouse"}\n', 'utf-8');
      await writeFile(join(stagedDir, 'foreign-keys.json'), '{"foreignKeys":[]}\n', 'utf-8');
      await writeFile(
        join(stagedDir, 'tables', 'orders.json'),
        '{"name":"orders","db":"public","columns":[{"name":"id","type":"integer","nullable":false,"primaryKey":true}]}\n',
        'utf-8',
      );
    },
    async detect(stagedDir) {
      await writeFile(join(stagedDir, 'connection.json'), '{"connectionId":"warehouse"}\n', 'utf-8');
      return true;
    },
    async chunk() {
      return {
        workUnits: [
          {
            unitKey: 'live-database-public-orders',
            rawFiles: ['tables/orders.json'],
            dependencyPaths: ['connection.json', 'foreign-keys.json'],
            peerFileIndex: [],
          },
        ],
      };
    },
  };
}

async function createLiveDatabaseRun(projectDir: string, runId: string) {
  await initKtxProject({ projectDir });
  await writeWarehouseConfig(projectDir);
  const project = await loadKtxProject({ projectDir });
  await runLocalStageOnlyIngest({
    project,
    adapters: [liveDatabaseAdapter()],
    adapter: 'live-database',
    connectionId: 'warehouse',
    jobId: runId,
    now: () => new Date('2026-05-07T10:00:00.000Z'),
  });
  return project;
}

function scanReport(enrichmentArtifacts: string[], syncId = '2026-05-07-100000-scan-run-review'): KtxScanReport {
  return {
    connectionId: 'warehouse',
    driver: 'sqlite',
    syncId,
    runId: 'scan-run-review',
    trigger: 'cli',
    mode: 'relationships',
    dryRun: false,
    artifactPaths: {
      rawSourcesDir: `raw-sources/warehouse/live-database/${syncId}`,
      reportPath: `raw-sources/warehouse/live-database/${syncId}/scan-report.json`,
      manifestShards: [],
      enrichmentArtifacts,
    },
    diffSummary: {
      tablesAdded: 0,
      tablesModified: 0,
      tablesDeleted: 0,
      tablesUnchanged: 2,
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
      deterministicRelationships: 'completed',
      llmRelationshipValidation: 'skipped',
      statisticalValidation: 'skipped',
    },
    capabilityGaps: [],
    warnings: [],
    relationships: { accepted: 0, review: 1, rejected: 1, skipped: 0 },
    enrichmentState: {
      resumedStages: [],
      completedStages: ['relationships'],
      failedStages: [],
    },
    createdAt: '2026-05-07T10:00:00.000Z',
  };
}

const relationshipArtifact: KtxRelationshipArtifact = {
  connectionId: 'warehouse',
  accepted: [],
  review: [
    {
      id: 'orders:orders.customer_id->customers:customers.id',
      status: 'review',
      source: 'deterministic_name',
      from: {
        tableId: 'orders',
        columnIds: ['orders.customer_id'],
        table: { catalog: null, db: 'public', name: 'orders' },
        columns: ['customer_id'],
      },
      to: {
        tableId: 'customers',
        columnIds: ['customers.id'],
        table: { catalog: null, db: 'public', name: 'customers' },
        columns: ['id'],
      },
      relationshipType: 'many_to_one',
      confidence: 0.62,
      pkScore: 0.91,
      fkScore: 0.62,
      score: 0.62,
      evidence: { sources: ['table_suffix'] },
      validation: { status: 'unavailable' },
      graph: { reasons: ['validation_unavailable_review_only'] },
      reasons: ['validation_unavailable_review_only', 'fk_score_review'],
    },
  ],
  rejected: [
    {
      id: 'orders:orders.note_id->notes:notes.id',
      status: 'rejected',
      source: 'deterministic_name',
      from: {
        tableId: 'orders',
        columnIds: ['orders.note_id'],
        table: { catalog: null, db: 'public', name: 'orders' },
        columns: ['note_id'],
      },
      to: {
        tableId: 'notes',
        columnIds: ['notes.id'],
        table: { catalog: null, db: 'public', name: 'notes' },
        columns: ['id'],
      },
      relationshipType: 'many_to_one',
      confidence: 0.2,
      pkScore: 0.4,
      fkScore: 0.2,
      score: 0.2,
      evidence: { sources: ['exact_column_match'] },
      validation: { status: 'failed' },
      graph: { reasons: ['low_source_coverage'] },
      reasons: ['low_source_coverage'],
    },
  ],
  skipped: [],
};

const diagnosticsArtifact: KtxRelationshipDiagnosticsArtifact = {
  connectionId: 'warehouse',
  generatedAt: '2026-05-07T10:00:00.000Z',
  summary: { accepted: 0, review: 1, rejected: 1, skipped: 0 },
  noAcceptedReason: 'relationship candidates require review before manifest writes',
  candidateCountsBySource: { deterministic_name: 2 },
  validation: { available: false, sqlAvailable: false, queryCount: 0 },
  thresholds: { acceptThreshold: 0.85, reviewThreshold: 0.55 },
  policy: {
    validationRequiredForManifest: true,
    maxCandidatesPerColumn: 25,
    profileSampleRows: 10000,
    validationConcurrency: 4,
  },
  warnings: [],
  profileWarnings: ['KTX scan connector cannot run read-only SQL relationship validation'],
};

const profileArtifact: KtxRelationshipProfileArtifact = {
  connectionId: 'warehouse',
  driver: 'sqlite',
  sqlAvailable: false,
  tables: [],
  columns: {},
  queryCount: 0,
  warnings: ['KTX scan connector cannot run read-only SQL relationship validation'],
};

describe('local scan relationship artifact reader', () => {
  it('loads relationship, diagnostics, and profile artifacts for a scan run', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'ktx-relationship-artifacts-'));
    try {
      const project = await createLiveDatabaseRun(projectDir, 'scan-run-review');
      const syncId = '2026-05-07-100000-scan-run-review';
      const report = scanReport(
        [
          `raw-sources/warehouse/live-database/${syncId}/enrichment/relationships.json`,
          `raw-sources/warehouse/live-database/${syncId}/enrichment/relationship-profile.json`,
          `raw-sources/warehouse/live-database/${syncId}/enrichment/relationship-diagnostics.json`,
        ],
        syncId,
      );
      await writeProjectFile(projectDir, report.artifactPaths.reportPath ?? '', `${JSON.stringify(report, null, 2)}\n`);
      await writeProjectFile(
        projectDir,
        `raw-sources/warehouse/live-database/${syncId}/enrichment/relationships.json`,
        `${JSON.stringify(relationshipArtifact, null, 2)}\n`,
      );
      await writeProjectFile(
        projectDir,
        `raw-sources/warehouse/live-database/${syncId}/enrichment/relationship-diagnostics.json`,
        `${JSON.stringify(diagnosticsArtifact, null, 2)}\n`,
      );
      await writeProjectFile(
        projectDir,
        `raw-sources/warehouse/live-database/${syncId}/enrichment/relationship-profile.json`,
        `${JSON.stringify(profileArtifact, null, 2)}\n`,
      );

      const result = await readLocalScanRelationshipArtifacts(project, 'scan-run-review');

      expect(result).toMatchObject({
        runId: 'scan-run-review',
        connectionId: 'warehouse',
        syncId,
        paths: {
          relationships: `raw-sources/warehouse/live-database/${syncId}/enrichment/relationships.json`,
          diagnostics: `raw-sources/warehouse/live-database/${syncId}/enrichment/relationship-diagnostics.json`,
          profile: `raw-sources/warehouse/live-database/${syncId}/enrichment/relationship-profile.json`,
        },
      });
      expect(result?.relationships.review[0]).toMatchObject({
        id: 'orders:orders.customer_id->customers:customers.id',
        status: 'review',
        reasons: ['validation_unavailable_review_only', 'fk_score_review'],
      });
      expect(result?.diagnostics?.noAcceptedReason).toBe('relationship candidates require review before manifest writes');
      expect(result?.profile?.sqlAvailable).toBe(false);
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('returns null when the scan run has no report', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'ktx-relationship-artifacts-missing-run-'));
    try {
      await initKtxProject({ projectDir });
      const project = await loadKtxProject({ projectDir });

      await expect(readLocalScanRelationshipArtifacts(project, 'missing-run')).resolves.toBeNull();
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('throws a focused error when a scan report does not reference relationships.json', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'ktx-relationship-artifacts-missing-artifact-'));
    try {
      const project = await createLiveDatabaseRun(projectDir, 'scan-run-review');
      const report = scanReport([]);
      await writeProjectFile(projectDir, report.artifactPaths.reportPath ?? '', `${JSON.stringify(report, null, 2)}\n`);

      await expect(readLocalScanRelationshipArtifacts(project, 'scan-run-review')).rejects.toThrow(
        'Scan report "scan-run-review" does not reference relationships.json',
      );
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});
