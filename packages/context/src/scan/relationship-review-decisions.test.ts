import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runLocalStageOnlyIngest, type SourceAdapter } from '../ingest/index.js';
import { initKtxProject, loadKtxProject } from '../project/index.js';
import { describe, expect, it } from 'vitest';
import { writeLocalScanRelationshipReviewDecision } from './relationship-review-decisions.js';
import type { KtxRelationshipArtifact, KtxRelationshipDiagnosticsArtifact } from './relationship-diagnostics.js';
import type { KtxRelationshipProfileArtifact } from './relationship-profiling.js';
import type { KtxScanReport } from './types.js';

const RUN_ID = 'scan-run-review';
const SYNC_ID = '2026-05-07-100000-scan-run-review';

async function writeProjectFile(projectDir: string, relativePath: string, content: string): Promise<void> {
  const absolutePath = join(projectDir, relativePath);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, 'utf-8');
}

async function createProject(projectDir: string): Promise<void> {
  await initKtxProject({ projectDir, projectName: 'warehouse' });
  await writeFile(
    join(projectDir, 'ktx.yaml'),
    [
      'project: warehouse',
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

async function createLiveDatabaseRun(projectDir: string): Promise<void> {
  await createProject(projectDir);
  const project = await loadKtxProject({ projectDir });
  await runLocalStageOnlyIngest({
    project,
    adapters: [liveDatabaseAdapter()],
    adapter: 'live-database',
    connectionId: 'warehouse',
    jobId: RUN_ID,
    now: () => new Date('2026-05-07T10:00:00.000Z'),
  });
}

function reviewRelationships(): KtxRelationshipArtifact {
  return {
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
        validation: { status: 'passed' },
        graph: { reasons: ['fk_score_review'] },
        reasons: ['fk_score_review'],
      },
    ],
    rejected: [],
    skipped: [],
  };
}

function diagnostics(): KtxRelationshipDiagnosticsArtifact {
  return {
    connectionId: 'warehouse',
    generatedAt: '2026-05-07T10:00:00.000Z',
    summary: { accepted: 0, review: 1, rejected: 0, skipped: 0 },
    noAcceptedReason: 'relationship candidates require review before manifest writes',
    candidateCountsBySource: { deterministic_name: 1 },
    validation: { available: true, sqlAvailable: true, queryCount: 3 },
    thresholds: { acceptThreshold: 0.85, reviewThreshold: 0.55 },
    policy: {
      validationRequiredForManifest: true,
      maxCandidatesPerColumn: 25,
      profileSampleRows: 10000,
      validationConcurrency: 4,
    },
    warnings: [],
    profileWarnings: [],
  };
}

function profile(): KtxRelationshipProfileArtifact {
  return {
    connectionId: 'warehouse',
    driver: 'sqlite',
    sqlAvailable: true,
    tables: [],
    columns: {},
    queryCount: 3,
    warnings: [],
  };
}

function report(): KtxScanReport {
  return {
    connectionId: 'warehouse',
    driver: 'sqlite',
    syncId: SYNC_ID,
    runId: RUN_ID,
    trigger: 'cli',
    mode: 'relationships',
    dryRun: false,
    artifactPaths: {
      rawSourcesDir: `raw-sources/warehouse/live-database/${SYNC_ID}`,
      reportPath: `raw-sources/warehouse/live-database/${SYNC_ID}/scan-report.json`,
      manifestShards: [],
      enrichmentArtifacts: [
        `raw-sources/warehouse/live-database/${SYNC_ID}/enrichment/relationships.json`,
        `raw-sources/warehouse/live-database/${SYNC_ID}/enrichment/relationship-diagnostics.json`,
        `raw-sources/warehouse/live-database/${SYNC_ID}/enrichment/relationship-profile.json`,
      ],
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
      statisticalValidation: 'completed',
    },
    relationships: { accepted: 0, review: 1, rejected: 0, skipped: 0 },
    enrichmentState: {
      resumedStages: [],
      completedStages: ['relationships'],
      failedStages: [],
    },
    warnings: [],
    capabilityGaps: [],
    createdAt: '2026-05-07T10:00:00.000Z',
  };
}

async function writeScanArtifacts(projectDir: string): Promise<void> {
  await writeProjectFile(
    projectDir,
    `raw-sources/warehouse/live-database/${SYNC_ID}/scan-report.json`,
    JSON.stringify(report(), null, 2),
  );
  await writeProjectFile(
    projectDir,
    `raw-sources/warehouse/live-database/${SYNC_ID}/enrichment/relationships.json`,
    JSON.stringify(reviewRelationships(), null, 2),
  );
  await writeProjectFile(
    projectDir,
    `raw-sources/warehouse/live-database/${SYNC_ID}/enrichment/relationship-diagnostics.json`,
    JSON.stringify(diagnostics(), null, 2),
  );
  await writeProjectFile(
    projectDir,
    `raw-sources/warehouse/live-database/${SYNC_ID}/enrichment/relationship-profile.json`,
    JSON.stringify(profile(), null, 2),
  );
}

describe('relationship review decisions', () => {
  it('writes an accepted decision beside the scan relationship artifacts', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'ktx-relationship-review-decisions-'));
    try {
      await createLiveDatabaseRun(projectDir);
      await writeScanArtifacts(projectDir);
      const project = await loadKtxProject({ projectDir });

      const result = await writeLocalScanRelationshipReviewDecision(project, {
        runId: 'scan-run-review',
        candidateId: 'orders:orders.customer_id->customers:customers.id',
        decision: 'accepted',
        reviewer: 'Andrey',
        note: 'Matches the warehouse model',
        decidedAt: '2026-05-07T12:00:00.000Z',
      });

      expect(result).not.toBeNull();
      if (!result) {
        throw new Error('Expected relationship review decision to be written');
      }
      expect(result.path).toBe(
        `raw-sources/warehouse/live-database/${SYNC_ID}/enrichment/relationship-review-decisions.json`,
      );
      expect(result.artifact.decisions).toHaveLength(1);
      expect(result.decision).toMatchObject({
        candidateId: 'orders:orders.customer_id->customers:customers.id',
        decision: 'accepted',
        previousStatus: 'review',
        reviewer: 'Andrey',
        note: 'Matches the warehouse model',
        source: 'deterministic_name',
        relationshipType: 'many_to_one',
        score: 0.62,
        reasons: ['fk_score_review'],
      });
      await expect(project.fileStore.readFile(result.path)).resolves.toMatchObject({
        path: result.path,
        content: expect.stringContaining('"decision": "accepted"'),
      });
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('replaces the existing decision for the same candidate id', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'ktx-relationship-review-replace-'));
    try {
      await createLiveDatabaseRun(projectDir);
      await writeScanArtifacts(projectDir);
      const project = await loadKtxProject({ projectDir });

      await writeLocalScanRelationshipReviewDecision(project, {
        runId: 'scan-run-review',
        candidateId: 'orders:orders.customer_id->customers:customers.id',
        decision: 'accepted',
        reviewer: 'Andrey',
        note: 'First decision',
        decidedAt: '2026-05-07T12:00:00.000Z',
      });
      const replacement = await writeLocalScanRelationshipReviewDecision(project, {
        runId: 'scan-run-review',
        candidateId: 'orders:orders.customer_id->customers:customers.id',
        decision: 'rejected',
        reviewer: 'Andrey',
        note: 'Reviewed against source data and rejected',
        decidedAt: '2026-05-07T12:05:00.000Z',
      });

      expect(replacement).not.toBeNull();
      if (!replacement) {
        throw new Error('Expected replacement relationship review decision to be written');
      }
      expect(replacement.artifact.decisions).toHaveLength(1);
      expect(replacement.artifact.decisions[0]).toMatchObject({
        decision: 'rejected',
        note: 'Reviewed against source data and rejected',
        decidedAt: '2026-05-07T12:05:00.000Z',
      });
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('returns null when the scan run does not exist', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'ktx-relationship-review-missing-run-'));
    try {
      await createProject(projectDir);
      const project = await loadKtxProject({ projectDir });

      await expect(
        writeLocalScanRelationshipReviewDecision(project, {
          runId: 'missing-run',
          candidateId: 'orders:orders.customer_id->customers:customers.id',
          decision: 'accepted',
          reviewer: 'Andrey',
          note: null,
          decidedAt: '2026-05-07T12:00:00.000Z',
        }),
      ).resolves.toBeNull();
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('rejects unknown candidate ids for an existing scan run', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'ktx-relationship-review-missing-candidate-'));
    try {
      await createLiveDatabaseRun(projectDir);
      await writeScanArtifacts(projectDir);
      const project = await loadKtxProject({ projectDir });

      await expect(
        writeLocalScanRelationshipReviewDecision(project, {
          runId: 'scan-run-review',
          candidateId: 'orders:orders.unknown_id->customers:customers.id',
          decision: 'accepted',
          reviewer: 'Andrey',
          note: null,
          decidedAt: '2026-05-07T12:00:00.000Z',
        }),
      ).rejects.toThrow(
        'Relationship candidate "orders:orders.unknown_id->customers:customers.id" was not found in scan run "scan-run-review"',
      );
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});
