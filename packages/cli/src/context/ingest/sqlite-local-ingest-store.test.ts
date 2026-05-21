import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteLocalIngestStore } from './sqlite-local-ingest-store.js';
import type { LocalIngestRunRecord } from './local-stage-ingest.js';

function runRecord(overrides: Partial<LocalIngestRunRecord> = {}): LocalIngestRunRecord {
  return {
    runId: 'local-run-1',
    jobId: 'local-run-1',
    status: 'done',
    adapter: 'fake',
    connectionId: 'warehouse',
    sourceDir: '/tmp/source',
    syncId: '2026-04-27-120000-local-run-1',
    startedAt: '2026-04-27T12:00:00.000Z',
    completedAt: '2026-04-27T12:00:01.000Z',
    progress: 1,
    done: true,
    previousRunId: null,
    diffSummary: {
      added: 1,
      modified: 0,
      deleted: 0,
      unchanged: 0,
    },
    diffPaths: {
      added: ['orders/orders.json'],
      modified: [],
      deleted: [],
      unchanged: [],
    },
    workUnitCount: 1,
    rawFileCount: 1,
    workUnits: [
      {
        unitKey: 'fake-orders',
        rawFiles: ['orders/orders.json'],
        peerFileIndex: [],
        dependencyPaths: [],
      },
    ],
    evictionDeletedRawPaths: [],
    errors: [],
    ...overrides,
  };
}

describe('SqliteLocalIngestStore', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-sqlite-local-ingest-'));
    dbPath = join(tempDir, '.ktx', 'db.sqlite');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('persists and reads a local ingest run by id', () => {
    const store = new SqliteLocalIngestStore({ dbPath });
    const record = runRecord();

    store.saveCompletedRun({
      record,
      rawContentHashes: {
        'orders/orders.json': 'hash-1',
      },
    });

    expect(store.findRunById('local-run-1')).toEqual(record);
    expect(store.findRunById('missing-run')).toBeNull();
  });

  it('returns the latest completed report for the same connection and adapter', () => {
    const store = new SqliteLocalIngestStore({ dbPath });
    const first = runRecord({
      runId: 'local-run-1',
      jobId: 'local-run-1',
      completedAt: '2026-04-27T12:00:00.000Z',
    });
    const second = runRecord({
      runId: 'local-run-2',
      jobId: 'local-run-2',
      syncId: '2026-04-27-120500-local-run-2',
      completedAt: '2026-04-27T12:05:00.000Z',
      previousRunId: 'local-run-1',
    });
    const otherAdapter = runRecord({
      runId: 'metabase-run-1',
      jobId: 'metabase-run-1',
      adapter: 'metabase',
      syncId: '2026-04-27-121000-metabase-run-1',
      completedAt: '2026-04-27T12:10:00.000Z',
    });

    store.saveCompletedRun({
      record: first,
      rawContentHashes: {
        'orders/orders.json': 'hash-1',
      },
    });
    store.saveCompletedRun({
      record: second,
      rawContentHashes: {
        'orders/orders.json': 'hash-2',
        'orders/payments.json': 'hash-3',
      },
    });
    store.saveCompletedRun({
      record: otherAdapter,
      rawContentHashes: {
        'cards/revenue.json': 'hash-4',
      },
    });

    expect(store.findLatestCompletedReport('warehouse', 'fake')).toMatchObject({
      runId: 'local-run-2',
      previousRunId: 'local-run-1',
      rawContentHashes: {
        'orders/orders.json': 'hash-2',
        'orders/payments.json': 'hash-3',
      },
    });
    expect(store.findLatestCompletedReport('warehouse', 'fake', { excludeRunId: 'local-run-2' })).toMatchObject({
      runId: 'local-run-1',
      rawContentHashes: {
        'orders/orders.json': 'hash-1',
      },
    });
    expect(store.findLatestCompletedReport('warehouse', 'fake', { excludeRunId: 'local-run-1' })).toMatchObject({
      runId: 'local-run-2',
      rawContentHashes: {
        'orders/orders.json': 'hash-2',
        'orders/payments.json': 'hash-3',
      },
    });
    expect(store.findLatestCompletedReport('warehouse', 'metabase')).toMatchObject({
      runId: 'metabase-run-1',
      rawContentHashes: {
        'cards/revenue.json': 'hash-4',
      },
    });
    expect(store.findLatestCompletedReport('missing', 'fake')).toBeNull();
  });

  it('ignores malformed run ids when reading status', () => {
    const store = new SqliteLocalIngestStore({ dbPath });

    expect(store.findRunById('../escape')).toBeNull();
    expect(store.findRunById('')).toBeNull();
  });
});
