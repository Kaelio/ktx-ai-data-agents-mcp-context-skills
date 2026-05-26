import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  completedKtxScanEnrichmentStateSummary,
  computeKtxScanEnrichmentInputHash,
  summarizeKtxScanEnrichmentState,
} from '../../../src/context/scan/enrichment-state.js';
import { SqliteLocalScanEnrichmentStateStore } from '../../../src/context/scan/sqlite-local-enrichment-state-store.js';
import type { KtxSchemaSnapshot } from '../../../src/context/scan/types.js';

const snapshot: KtxSchemaSnapshot = {
  connectionId: 'warehouse',
  driver: 'postgres',
  extractedAt: '2026-04-29T12:00:00.000Z',
  scope: { schemas: ['public'] },
  metadata: {},
  tables: [
    {
      catalog: null,
      db: 'public',
      name: 'orders',
      kind: 'table',
      comment: null,
      estimatedRows: 1,
      foreignKeys: [],
      columns: [
        {
          name: 'id',
          nativeType: 'integer',
          normalizedType: 'integer',
          dimensionType: 'number',
          nullable: false,
          primaryKey: true,
          comment: null,
        },
      ],
    },
  ],
};

describe('scan enrichment state', () => {
  let tempDir: string;
  let store: SqliteLocalScanEnrichmentStateStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-scan-enrichment-state-'));
    store = new SqliteLocalScanEnrichmentStateStore({ dbPath: join(tempDir, 'db.sqlite') });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('computes stable input hashes without depending on object key order', () => {
    const first = computeKtxScanEnrichmentInputHash({
      snapshot,
      mode: 'enriched',
      detectRelationships: true,
      providerIdentity: { provider: 'local-heuristic', llmModel: 'a' },
    });
    const second = computeKtxScanEnrichmentInputHash({
      snapshot: { ...snapshot, metadata: {} },
      mode: 'enriched',
      detectRelationships: true,
      providerIdentity: { llmModel: 'a', provider: 'local-heuristic' },
    });
    const firstTable = snapshot.tables[0];
    if (!firstTable) {
      throw new Error('Expected test snapshot table');
    }
    const changed = computeKtxScanEnrichmentInputHash({
      snapshot: { ...snapshot, tables: [{ ...firstTable, name: 'orders_v2' }] },
      mode: 'enriched',
      detectRelationships: true,
      providerIdentity: { provider: 'local-heuristic', llmModel: 'a' },
    });

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toBe(first);
    expect(changed).not.toBe(first);
  });

  it('persists completed stages and ignores stale hashes', async () => {
    const inputHash = computeKtxScanEnrichmentInputHash({
      snapshot,
      mode: 'enriched',
      detectRelationships: true,
      providerIdentity: { provider: 'local-heuristic' },
    });

    await store.saveCompletedStage({
      runId: 'scan-run-1',
      connectionId: 'warehouse',
      syncId: 'sync-1',
      mode: 'enriched',
      stage: 'descriptions',
      inputHash,
      output: [{ table: { catalog: null, db: 'public', name: 'orders' }, tableDescription: 'Orders' }],
      updatedAt: '2026-04-29T12:01:00.000Z',
    });

    await expect(
      store.findCompletedStage({
        runId: 'scan-run-1',
        stage: 'descriptions',
        inputHash,
      }),
    ).resolves.toMatchObject({
      runId: 'scan-run-1',
      stage: 'descriptions',
      status: 'completed',
      output: [{ table: { catalog: null, db: 'public', name: 'orders' }, tableDescription: 'Orders' }],
    });

    await expect(
      store.findCompletedStage({
        runId: 'scan-run-1',
        stage: 'descriptions',
        inputHash: 'different-hash',
      }),
    ).resolves.toBeNull();
  });

  it('records failed stages without making them reusable', async () => {
    await store.saveFailedStage({
      runId: 'scan-run-2',
      connectionId: 'warehouse',
      syncId: 'sync-2',
      mode: 'enriched',
      stage: 'embeddings',
      inputHash: 'hash-2',
      errorMessage: 'embedding service timed out',
      updatedAt: '2026-04-29T12:02:00.000Z',
    });

    await expect(
      store.findCompletedStage({
        runId: 'scan-run-2',
        stage: 'embeddings',
        inputHash: 'hash-2',
      }),
    ).resolves.toBeNull();

    await expect(store.listRunStages('scan-run-2')).resolves.toEqual([
      expect.objectContaining({
        runId: 'scan-run-2',
        stage: 'embeddings',
        status: 'failed',
        errorMessage: 'embedding service timed out',
      }),
    ]);
  });

  it('summarizes resumed, completed, and failed stages for reports', () => {
    expect(
      summarizeKtxScanEnrichmentState({
        resumedStages: ['descriptions'],
        completedStages: ['descriptions', 'embeddings'],
        failedStages: ['relationships'],
      }),
    ).toEqual({
      resumedStages: ['descriptions'],
      completedStages: ['descriptions', 'embeddings'],
      failedStages: ['relationships'],
    });

    expect(completedKtxScanEnrichmentStateSummary()).toEqual({
      resumedStages: [],
      completedStages: [],
      failedStages: [],
    });
  });
});
