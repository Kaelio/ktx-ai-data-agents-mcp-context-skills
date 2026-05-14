import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KtxLocalProject } from '../project/index.js';
import { initKtxProject } from '../project/index.js';
import { describe, expect, it, vi } from 'vitest';
import { applyLocalScanRelationshipReviewDecisions } from './relationship-review-apply.js';
import type { KtxRelationshipReviewDecisionArtifact } from './relationship-review-decisions.js';
import type { ReadLocalScanRelationshipArtifactsResult } from './relationship-artifacts.js';
import type { WriteLocalScanManifestShardsResult } from './local-enrichment-artifacts.js';
import type { KtxSchemaSnapshot } from './types.js';

const acceptedDecisionArtifact: KtxRelationshipReviewDecisionArtifact = {
  connectionId: 'warehouse',
  runId: 'scan-run-a',
  syncId: 'sync-a',
  generatedAt: '2026-05-07T12:00:00.000Z',
  decisions: [
    {
      candidateId: 'orders:orders.customer_id->customers:customers.id',
      decision: 'accepted',
      previousStatus: 'review',
      connectionId: 'warehouse',
      runId: 'scan-run-a',
      syncId: 'sync-a',
      decidedAt: '2026-05-07T12:01:00.000Z',
      reviewer: 'Andrey',
      note: 'Customer link is valid.',
      from: {
        tableId: 'public.orders',
        columnIds: ['public.orders.customer_id'],
        table: { catalog: null, db: 'public', name: 'orders' },
        columns: ['customer_id'],
      },
      to: {
        tableId: 'public.customers',
        columnIds: ['public.customers.id'],
        table: { catalog: null, db: 'public', name: 'customers' },
        columns: ['id'],
      },
      relationshipType: 'many_to_one',
      source: 'deterministic_name',
      score: 0.81,
      confidence: 0.81,
      pkScore: 0.93,
      fkScore: 0.81,
      reasons: ['review_threshold'],
    },
    {
      candidateId: 'orders:orders.note_id->notes:notes.id',
      decision: 'rejected',
      previousStatus: 'review',
      connectionId: 'warehouse',
      runId: 'scan-run-a',
      syncId: 'sync-a',
      decidedAt: '2026-05-07T12:02:00.000Z',
      reviewer: 'Andrey',
      note: null,
      from: {
        tableId: 'public.orders',
        columnIds: ['public.orders.note_id'],
        table: { catalog: null, db: 'public', name: 'orders' },
        columns: ['note_id'],
      },
      to: {
        tableId: 'public.notes',
        columnIds: ['public.notes.id'],
        table: { catalog: null, db: 'public', name: 'notes' },
        columns: ['id'],
      },
      relationshipType: 'many_to_one',
      source: 'embedding_similarity',
      score: 0.7,
      confidence: 0.7,
      pkScore: 0.7,
      fkScore: 0.7,
      reasons: ['review_threshold'],
    },
  ],
};

const artifacts: ReadLocalScanRelationshipArtifactsResult = {
  runId: 'scan-run-a',
  connectionId: 'warehouse',
  syncId: 'sync-a',
  report: {
    connectionId: 'warehouse',
    driver: 'postgres',
    syncId: 'sync-a',
    runId: 'scan-run-a',
    trigger: 'cli',
    mode: 'relationships',
    dryRun: false,
    artifactPaths: {
      rawSourcesDir: 'raw-sources/warehouse/live-database/sync-a',
      reportPath: 'raw-sources/warehouse/live-database/sync-a/scan-report.json',
      manifestShards: ['semantic-layer/warehouse/_schema/public.yaml'],
      enrichmentArtifacts: ['raw-sources/warehouse/live-database/sync-a/enrichment/relationships.json'],
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
    manifestShardsWritten: 1,
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
    capabilityGaps: [],
    warnings: [],
    relationships: { accepted: 0, review: 1, rejected: 1, skipped: 0 },
    enrichmentState: { resumedStages: [], completedStages: ['relationships'], failedStages: [] },
    createdAt: '2026-05-07T12:00:00.000Z',
  },
  relationships: {
    connectionId: 'warehouse',
    accepted: [],
    review: [],
    rejected: [],
    skipped: [],
  },
  diagnostics: null,
  profile: null,
  paths: {
    relationships: 'raw-sources/warehouse/live-database/sync-a/enrichment/relationships.json',
    diagnostics: null,
    profile: null,
  },
};

const snapshot: KtxSchemaSnapshot = {
  connectionId: 'warehouse',
  driver: 'postgres',
  extractedAt: '2026-05-07T12:00:00.000Z',
  scope: { schemas: ['public'] },
  metadata: {},
  tables: [
    {
      catalog: null,
      db: 'public',
      name: 'customers',
      kind: 'table',
      comment: null,
      estimatedRows: 2,
      foreignKeys: [],
      columns: [
        {
          name: 'id',
          nativeType: 'integer',
          normalizedType: 'integer',
          dimensionType: 'number',
          nullable: false,
          primaryKey: false,
          comment: null,
        },
      ],
    },
    {
      catalog: null,
      db: 'public',
      name: 'orders',
      kind: 'table',
      comment: null,
      estimatedRows: 2,
      foreignKeys: [],
      columns: [
        {
          name: 'customer_id',
          nativeType: 'integer',
          normalizedType: 'integer',
          dimensionType: 'number',
          nullable: false,
          primaryKey: false,
          comment: null,
        },
      ],
    },
  ],
};

async function projectWithDecisions(
  decisions = acceptedDecisionArtifact,
): Promise<{ project: KtxLocalProject; tempDir: string }> {
  const tempDir = await mkdtemp(join(tmpdir(), 'ktx-relationship-review-apply-'));
  const project = await initKtxProject({
    projectDir: join(tempDir, 'project'),
  });
  await project.fileStore.writeFile(
    'raw-sources/warehouse/live-database/sync-a/enrichment/relationship-review-decisions.json',
    `${JSON.stringify(decisions)}\n`,
    'ktx',
    'ktx@example.com',
    'Seed relationship review decisions',
  );
  return { project, tempDir };
}

function manifestResult(): WriteLocalScanManifestShardsResult {
  return {
    manifestShards: ['semantic-layer/warehouse/_schema/public.yaml'],
    manifestShardsWritten: 1,
  };
}

describe('relationship review apply', () => {
  it('previews all accepted decisions without writing manifest shards', async () => {
    const { project, tempDir } = await projectWithDecisions();
    const writeLocalScanManifestShards = vi.fn(async () => manifestResult());
    try {
      const result = await applyLocalScanRelationshipReviewDecisions(project, {
        runId: 'scan-run-a',
        applyAllAccepted: true,
        dryRun: true,
        readLocalScanRelationshipArtifacts: vi.fn(async () => artifacts),
        readLocalScanStructuralSnapshot: vi.fn(async () => snapshot),
        writeLocalScanManifestShards,
      });

      expect(result).toMatchObject({
        runId: 'scan-run-a',
        connectionId: 'warehouse',
        syncId: 'sync-a',
        dryRun: true,
        selectedDecisions: 1,
        appliedRelationships: 1,
        manifestShards: [],
        manifestShardsWritten: 0,
      });
      expect(result.relationships[0]).toMatchObject({
        id: 'orders:orders.customer_id->customers:customers.id',
        source: 'manual',
        relationshipType: 'many_to_one',
        confidence: 1,
      });
      expect(writeLocalScanManifestShards).not.toHaveBeenCalled();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('writes selected accepted decisions as manual manifest relationships', async () => {
    const { project, tempDir } = await projectWithDecisions();
    const readLocalScanStructuralSnapshot = vi.fn(async () => snapshot);
    const writeLocalScanManifestShards = vi.fn(async () => manifestResult());
    try {
      const result = await applyLocalScanRelationshipReviewDecisions(project, {
        runId: 'scan-run-a',
        candidateIds: ['orders:orders.customer_id->customers:customers.id'],
        readLocalScanRelationshipArtifacts: vi.fn(async () => artifacts),
        readLocalScanStructuralSnapshot,
        writeLocalScanManifestShards,
      });

      expect(readLocalScanStructuralSnapshot).toHaveBeenCalledWith({
        project: expect.any(Object),
        connectionId: 'warehouse',
        driver: 'postgres',
        rawSourcesDir: 'raw-sources/warehouse/live-database/sync-a',
        extractedAtFallback: '2026-05-07T12:00:00.000Z',
      });
      expect(writeLocalScanManifestShards).toHaveBeenCalledWith({
        project: expect.any(Object),
        connectionId: 'warehouse',
        syncId: 'sync-a',
        driver: 'postgres',
        snapshot,
        dryRun: false,
        relationshipUpdate: {
          connectionId: 'warehouse',
          accepted: [
            expect.objectContaining({
              id: 'orders:orders.customer_id->customers:customers.id',
              source: 'manual',
              from: expect.objectContaining({ columns: ['customer_id'] }),
              to: expect.objectContaining({ columns: ['id'] }),
            }),
          ],
          rejected: [],
          skipped: [],
        },
      });
      expect(result.manifestShardsWritten).toBe(1);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects ambiguous apply selection input', async () => {
    const { project, tempDir } = await projectWithDecisions();
    try {
      await expect(
        applyLocalScanRelationshipReviewDecisions(project, {
          runId: 'scan-run-a',
          readLocalScanRelationshipArtifacts: vi.fn(async () => artifacts),
        }),
      ).rejects.toThrow('Pass --all-accepted or at least one --candidate to choose review decisions to apply');

      await expect(
        applyLocalScanRelationshipReviewDecisions(project, {
          runId: 'scan-run-a',
          applyAllAccepted: true,
          candidateIds: ['orders:orders.customer_id->customers:customers.id'],
          readLocalScanRelationshipArtifacts: vi.fn(async () => artifacts),
        }),
      ).rejects.toThrow('Use either --all-accepted or --candidate, not both');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('refuses rejected decisions and missing candidate ids', async () => {
    const { project, tempDir } = await projectWithDecisions();
    try {
      await expect(
        applyLocalScanRelationshipReviewDecisions(project, {
          runId: 'scan-run-a',
          candidateIds: ['orders:orders.note_id->notes:notes.id'],
          readLocalScanRelationshipArtifacts: vi.fn(async () => artifacts),
        }),
      ).rejects.toThrow('Relationship review decision "orders:orders.note_id->notes:notes.id" is rejected, not accepted');

      await expect(
        applyLocalScanRelationshipReviewDecisions(project, {
          runId: 'scan-run-a',
          candidateIds: ['missing'],
          readLocalScanRelationshipArtifacts: vi.fn(async () => artifacts),
        }),
      ).rejects.toThrow('Relationship review decision "missing" was not found for scan run "scan-run-a"');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
