import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SourceAdapter } from '@ktx/context/ingest';
import { initKtxProject } from '@ktx/context/project';
import type {
  KtxScanReport,
  LocalScanRunResult,
  RunLocalScanOptions,
} from '@ktx/context/scan';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCliScanProgress, runKtxScan } from './scan.js';

const sqlServerExtractSchema = vi.hoisted(() =>
  vi.fn(async (connectionId: string) => ({
    connectionId,
    extractedAt: '2026-04-29T16:00:00.000Z',
    metadata: { database: 'analytics' },
    tables: [
      {
        catalog: 'analytics',
        db: 'dbo',
        name: 'orders',
        columns: [{ name: 'id', type: 'int', nullable: false, primaryKey: true }],
        foreignKeys: [],
      },
    ],
  })),
);
const createSqlServerLiveDatabaseIntrospection = vi.hoisted(() =>
  vi.fn(() => ({ extractSchema: sqlServerExtractSchema })),
);
const isKtxSqlServerConnectionConfig = vi.hoisted(() =>
  vi.fn((connection: { driver?: string } | undefined) => connection?.driver === 'sqlserver'),
);
const KtxSqlServerScanConnector = vi.hoisted(
  () =>
    class {
      readonly id: string;
      readonly driver = 'sqlserver';

      constructor(options: { connectionId: string }) {
        this.id = `sqlserver:${options.connectionId}`;
      }
    },
);
const bigQueryExtractSchema = vi.hoisted(() =>
  vi.fn(async (connectionId: string) => ({
    connectionId,
    extractedAt: '2026-04-29T17:00:00.000Z',
    metadata: { project_id: 'project-1', datasets: ['analytics'] },
    tables: [
      {
        catalog: 'project-1',
        db: 'analytics',
        name: 'orders',
        columns: [{ name: 'id', type: 'INT64', nullable: false, primaryKey: true }],
        foreignKeys: [],
      },
    ],
  })),
);
const createBigQueryLiveDatabaseIntrospection = vi.hoisted(() =>
  vi.fn(() => ({ extractSchema: bigQueryExtractSchema })),
);
const isKtxBigQueryConnectionConfig = vi.hoisted(() =>
  vi.fn((connection: { driver?: string } | undefined) => connection?.driver === 'bigquery'),
);
const KtxBigQueryScanConnector = vi.hoisted(
  () =>
    class {
      readonly id: string;
      readonly driver = 'bigquery';

      constructor(options: { connectionId: string }) {
        this.id = `bigquery:${options.connectionId}`;
      }
    },
);
const snowflakeExtractSchema = vi.hoisted(() =>
  vi.fn(async (connectionId: string) => ({
    connectionId,
    extractedAt: '2026-04-29T18:00:00.000Z',
    metadata: { database: 'ANALYTICS', schemas: ['PUBLIC'] },
    tables: [
      {
        catalog: 'ANALYTICS',
        db: 'PUBLIC',
        name: 'ORDERS',
        columns: [{ name: 'ID', type: 'NUMBER', nullable: false, primaryKey: true }],
        foreignKeys: [],
      },
    ],
  })),
);
const createSnowflakeLiveDatabaseIntrospection = vi.hoisted(() =>
  vi.fn(() => ({ extractSchema: snowflakeExtractSchema })),
);
const isKtxSnowflakeConnectionConfig = vi.hoisted(() =>
  vi.fn((connection: { driver?: string } | undefined) => connection?.driver === 'snowflake'),
);
const KtxSnowflakeScanConnector = vi.hoisted(
  () =>
    class {
      readonly id: string;
      readonly driver = 'snowflake';

      constructor(options: { connectionId: string }) {
        this.id = `snowflake:${options.connectionId}`;
      }
    },
);
const postgresExtractSchema = vi.hoisted(() =>
  vi.fn(async (connectionId: string) => ({
    connectionId,
    extractedAt: '2026-04-29T12:00:00.000Z',
    metadata: { database: 'analytics' },
    tables: [],
  })),
);
const createPostgresLiveDatabaseIntrospection = vi.hoisted(() =>
  vi.fn(() => ({ extractSchema: postgresExtractSchema })),
);
const isKtxPostgresConnectionConfig = vi.hoisted(() =>
  vi.fn((connection: { driver?: string } | undefined) =>
    ['postgres', 'postgresql'].includes(String(connection?.driver ?? '').toLowerCase()),
  ),
);
const KtxPostgresScanConnector = vi.hoisted(
  () =>
    class {
      readonly id: string;
      readonly driver = 'postgres';

      constructor(options: { connectionId: string }) {
        this.id = `postgres:${options.connectionId}`;
      }
    },
);

vi.mock('@ktx/connector-sqlserver', () => ({
  createSqlServerLiveDatabaseIntrospection,
  isKtxSqlServerConnectionConfig,
  KtxSqlServerScanConnector,
}));

vi.mock('@ktx/connector-bigquery', () => ({
  createBigQueryLiveDatabaseIntrospection,
  isKtxBigQueryConnectionConfig,
  KtxBigQueryScanConnector,
}));

vi.mock('@ktx/connector-snowflake', () => ({
  createSnowflakeLiveDatabaseIntrospection,
  isKtxSnowflakeConnectionConfig,
  KtxSnowflakeScanConnector,
}));

vi.mock('@ktx/connector-postgres', () => ({
  createPostgresLiveDatabaseIntrospection,
  isKtxPostgresConnectionConfig,
  KtxPostgresScanConnector,
}));

function makeIo(options: { isTTY?: boolean } = {}) {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: {
        isTTY: options.isTTY,
        write: (chunk: string) => {
          stdout += chunk;
        },
      },
      stderr: {
        write: (chunk: string) => {
          stderr += chunk;
        },
      },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

function fakeLiveDatabaseAdapter(
  createIntrospection: (options: { connections: unknown }) => {
    extractSchema: (connectionId: string) => Promise<unknown>;
  },
): SourceAdapter {
  return {
    source: 'live-database',
    skillNames: [],
    async detect() {
      return true;
    },
    async fetch(_pullConfig: unknown, stagedDir: string, ctx: { connectionId: string }) {
      await mkdir(stagedDir, { recursive: true });
      const schema = await createIntrospection({ connections: {} }).extractSchema(ctx.connectionId);
      await writeFile(
        join(stagedDir, 'connection.json'),
        JSON.stringify({ connectionId: ctx.connectionId, schema }, null, 2),
        'utf-8',
      );
    },
    async chunk() {
      return { workUnits: [] };
    },
  };
}

const report: KtxScanReport = {
  connectionId: 'warehouse',
  driver: 'postgres',
  syncId: 'sync-1',
  runId: 'scan-run-1',
  trigger: 'cli',
  mode: 'structural',
  dryRun: false,
  artifactPaths: {
    rawSourcesDir: 'raw-sources/warehouse/live-database/sync-1',
    reportPath: 'raw-sources/warehouse/live-database/sync-1/scan-report.json',
    manifestShards: [],
    enrichmentArtifacts: [],
  },
  diffSummary: {
    tablesAdded: 1,
    tablesModified: 0,
    tablesDeleted: 0,
    tablesUnchanged: 0,
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
  enrichmentState: {
    resumedStages: [],
    completedStages: [],
    failedStages: [],
  },
  createdAt: '2026-04-29T09:00:00.000Z',
};

const reportWithAttention: KtxScanReport = {
  ...report,
  mode: 'relationships',
  diffSummary: {
    tablesAdded: 3,
    tablesModified: 2,
    tablesDeleted: 0,
    tablesUnchanged: 13,
    columnsAdded: 18,
    columnsModified: 5,
    columnsDeleted: 0,
  },
  capabilityGaps: ['columnStats'],
  warnings: [
    {
      code: 'connector_capability_missing',
      message: 'KTX scan connector is missing optional capability: columnStats',
      recoverable: true,
      metadata: { capability: 'columnStats' },
    },
    {
      code: 'relationship_validation_failed',
      message: 'Could not validate relationship orders.customer_id -> customers.id',
      table: 'orders',
      column: 'customer_id',
      recoverable: true,
    },
  ],
  relationships: { accepted: 7, review: 3, rejected: 2, skipped: 4 },
  enrichmentState: {
    resumedStages: ['relationships'],
    completedStages: ['descriptions', 'relationships'],
    failedStages: [],
  },
  artifactPaths: {
    ...report.artifactPaths,
    manifestShards: ['raw-sources/warehouse/live-database/sync-1/_schema/shard-000.json'],
    enrichmentArtifacts: ['raw-sources/warehouse/live-database/sync-1/_enrichment/relationships.json'],
  },
};

describe('runKtxScan', () => {
  let tempDir: string;
  const noLocalIngestAdapters = () => [];

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-cli-scan-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('runs structural scans and prints a dev-friendly plain summary', async () => {
    await initKtxProject({ projectDir: tempDir, projectName: 'warehouse' });
    const runLocalScan = vi.fn(
      async (_input: RunLocalScanOptions): Promise<LocalScanRunResult> => ({
        runId: 'scan-run-1',
        status: 'done',
        done: true,
        connectionId: 'warehouse',
        mode: 'structural',
        dryRun: false,
        syncId: 'sync-1',
        report,
      }),
    );
    const io = makeIo();

    await expect(
      runKtxScan(
        {
          command: 'run',
          projectDir: tempDir,
          connectionId: 'warehouse',
          mode: 'structural',
          detectRelationships: false,
          dryRun: false,
          databaseIntrospectionUrl: 'http://127.0.0.1:8765',
        },
        io.io,
        { runLocalScan, createLocalIngestAdapters: noLocalIngestAdapters },
      ),
    ).resolves.toBe(0);

    expect(runLocalScan).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: 'warehouse',
        mode: 'structural',
        databaseIntrospectionUrl: 'http://127.0.0.1:8765',
        connector: undefined,
      }),
    );
    expect(io.stdout()).toContain('KTX scan completed\n');
    expect(io.stdout()).toContain('Run: scan-run-1');
    expect(io.stdout()).toContain('Mode: structural');
    expect(io.stdout()).toContain('What changed\n');
    expect(io.stdout()).toContain('New tables: 1\n');
    expect(io.stdout()).toContain('Changed tables: 0\n');
    expect(io.stdout()).toContain('Removed tables: 0\n');
    expect(io.stdout()).toContain('Unchanged tables: 0\n');
    expect(io.stdout()).toContain('Needs attention\n  None\n');
    expect(io.stdout()).toContain('Artifacts\n');
    expect(io.stdout()).toContain('Report: raw-sources/warehouse/live-database/sync-1/scan-report.json');
    expect(io.stdout()).toContain('Next:\n');
    expect(io.stdout()).toContain('ktx status --project-dir ');
    expect(io.stdout()).not.toContain('ktx dev scan status');
    expect(io.stdout()).not.toContain('ktx dev scan report');
    expect(io.stdout()).not.toContain('\u001b[');
    expect(io.stdout()).not.toContain('✓');
    expect(io.stdout()).not.toContain('+1');
    expect(io.stdout()).not.toContain('/~');
  });

  it('passes managed daemon options to local ingest adapters when no explicit daemon URL is set', async () => {
    await initKtxProject({ projectDir: tempDir, projectName: 'warehouse' });
    const createLocalIngestAdapters = vi.fn(() => []);
    const runLocalScan = vi.fn(
      async (_input: RunLocalScanOptions): Promise<LocalScanRunResult> => ({
        runId: 'scan-run-1',
        status: 'done',
        done: true,
        connectionId: 'warehouse',
        mode: 'structural',
        dryRun: false,
        syncId: 'sync-1',
        report,
      }),
    );
    const io = makeIo();

    await expect(
      runKtxScan(
        {
          command: 'run',
          projectDir: tempDir,
          connectionId: 'warehouse',
          mode: 'structural',
          detectRelationships: false,
          dryRun: false,
          cliVersion: '0.2.0',
          runtimeInstallPolicy: 'auto',
        },
        io.io,
        { runLocalScan, createLocalIngestAdapters },
      ),
    ).resolves.toBe(0);

    expect(createLocalIngestAdapters).toHaveBeenCalledWith(expect.objectContaining({ projectDir: tempDir }), {
      managedDaemon: {
        cliVersion: '0.2.0',
        installPolicy: 'auto',
        io: io.io,
      },
    });
  });

  it('explains warnings, capability gaps, and relationships in human scan summaries', async () => {
    await initKtxProject({ projectDir: tempDir, projectName: 'warehouse' });
    const runLocalScan = vi.fn(
      async (_input: RunLocalScanOptions): Promise<LocalScanRunResult> => ({
        runId: 'scan-run-1',
        status: 'done',
        done: true,
        connectionId: 'warehouse',
        mode: 'relationships',
        dryRun: false,
        syncId: 'sync-1',
        report: reportWithAttention,
      }),
    );
    const io = makeIo();

    await expect(
      runKtxScan(
        {
          command: 'run',
          projectDir: tempDir,
          connectionId: 'warehouse',
          mode: 'structural',
          detectRelationships: false,
          dryRun: false,
        },
        io.io,
        { runLocalScan, createLocalIngestAdapters: noLocalIngestAdapters },
      ),
    ).resolves.toBe(0);

    expect(io.stdout()).toContain('Semantic layer comparison found 5 changes across 18 tables');
    expect(io.stdout()).toContain('New columns: 18');
    expect(io.stdout()).toContain('Changed columns: 5');
    expect(io.stdout()).toContain('Relationships\n');
    expect(io.stdout()).toContain('Accepted: 7');
    expect(io.stdout()).toContain('Review: 3');
    expect(io.stdout()).toContain('Rejected: 2');
    expect(io.stdout()).toContain('Skipped: 4');
    expect(io.stdout()).toContain('Needs attention\n');
    expect(io.stdout()).toContain('2 warnings');
    expect(io.stdout()).toContain('1 capability gap');
    expect(io.stdout()).toContain('columnStats is unavailable; relationship confidence may be lower.');
    expect(io.stdout()).toContain(
      'relationship_validation_failed: orders.customer_id: Could not validate relationship orders.customer_id -> customers.id',
    );
    expect(io.stdout()).not.toContain('+3');
    expect(io.stdout()).not.toContain('~2');
    expect(io.stdout()).not.toContain('=13');
  });

  it('prints review-only relationship summaries and validation capability warnings', async () => {
    await initKtxProject({ projectDir: tempDir, projectName: 'warehouse' });
    const reviewOnlyReport: KtxScanReport = {
      ...reportWithAttention,
      capabilityGaps: [],
      warnings: [
        {
          code: 'connector_capability_missing',
          message: 'KTX scan connector cannot run read-only SQL relationship validation',
          recoverable: true,
          metadata: { capability: 'readOnlySql' },
        },
      ],
      relationships: { accepted: 0, review: 12, rejected: 44, skipped: 0 },
    };
    const runLocalScan = vi.fn(
      async (_input: RunLocalScanOptions): Promise<LocalScanRunResult> => ({
        runId: 'scan-run-review',
        status: 'done',
        done: true,
        connectionId: 'warehouse',
        mode: 'relationships',
        dryRun: false,
        syncId: 'sync-review',
        report: reviewOnlyReport,
      }),
    );
    const io = makeIo();

    await expect(
      runKtxScan(
        {
          command: 'run',
          projectDir: tempDir,
          connectionId: 'warehouse',
          mode: 'structural',
          detectRelationships: false,
          dryRun: false,
        },
        io.io,
        { runLocalScan, createLocalIngestAdapters: noLocalIngestAdapters },
      ),
    ).resolves.toBe(0);

    expect(io.stdout()).toContain('Relationships');
    expect(io.stdout()).toContain('Accepted: 0');
    expect(io.stdout()).toContain('Review: 12');
    expect(io.stdout()).toContain('Rejected: 44');
    expect(io.stdout()).toContain(
      'connector_capability_missing: KTX scan connector cannot run read-only SQL relationship validation',
    );
  });

  it('passes a scan progress port and prints TTY progress messages', async () => {
    await initKtxProject({ projectDir: tempDir, projectName: 'warehouse' });
    const runLocalScan = vi.fn(async (input: RunLocalScanOptions): Promise<LocalScanRunResult> => {
      await input.progress?.update(0.15, 'Inspecting database schema');
      await input.progress?.update(0.55, 'Semantic layer comparison found 5 changes across 18 tables');
      return {
        runId: 'scan-run-1',
        status: 'done',
        done: true,
        connectionId: 'warehouse',
        mode: 'relationships',
        dryRun: false,
        syncId: 'sync-1',
        report: reportWithAttention,
      };
    });
    const io = makeIo({ isTTY: true });
    const previousCi = process.env.CI;
    delete process.env.CI;

    try {
      const exitCode = await runKtxScan(
        {
          command: 'run',
          projectDir: tempDir,
          connectionId: 'warehouse',
          mode: 'structural',
          detectRelationships: false,
          dryRun: false,
        },
        io.io,
        { runLocalScan, createLocalIngestAdapters: noLocalIngestAdapters },
      );
      expect({ exitCode, stderr: io.stderr() }).toEqual({ exitCode: 0, stderr: '' });
    } finally {
      if (previousCi === undefined) {
        delete process.env.CI;
      } else {
        process.env.CI = previousCi;
      }
    }

    expect(runLocalScan.mock.calls[0]?.[0].progress).toBeDefined();
    expect(io.stdout()).toContain('[15%] Inspecting database schema');
    expect(io.stdout()).toContain('[55%] Semantic layer comparison found 5 changes across 18 tables');
  });

  it('uses injected structured progress without requiring TTY progress output', async () => {
    await initKtxProject({ projectDir: tempDir, projectName: 'warehouse' });
    const progressEvents: Array<{ progress: number; message?: string; transient?: boolean }> = [];
    const structuredProgress = {
      async update(progress: number, message?: string, options?: { transient?: boolean }) {
        progressEvents.push({
          progress,
          ...(message !== undefined ? { message } : {}),
          ...(options?.transient !== undefined ? { transient: options.transient } : {}),
        });
      },
      startPhase() {
        return structuredProgress;
      },
    };
    const runLocalScan = vi.fn(async (input: RunLocalScanOptions): Promise<LocalScanRunResult> => {
      await input.progress?.update(0.42, 'Generating descriptions 4/10 tables', { transient: true });
      return {
        runId: 'scan-run-1',
        status: 'done',
        done: true,
        connectionId: 'warehouse',
        mode: 'structural',
        dryRun: false,
        syncId: 'sync-1',
        report,
      };
    });
    const io = makeIo();

    await expect(
      runKtxScan(
        {
          command: 'run',
          projectDir: tempDir,
          connectionId: 'warehouse',
          mode: 'structural',
          detectRelationships: false,
          dryRun: false,
        },
        io.io,
        { runLocalScan, createLocalIngestAdapters: noLocalIngestAdapters, progress: structuredProgress },
      ),
    ).resolves.toBe(0);

    expect(progressEvents).toContainEqual({
      progress: 0.42,
      message: 'Generating descriptions 4/10 tables',
      transient: true,
    });
    expect(io.stdout()).not.toContain('[42%] Generating descriptions 4/10 tables');
  });

  it('updates transient TTY progress messages in place', async () => {
    const io = makeIo({ isTTY: true });
    const previousCi = process.env.CI;
    delete process.env.CI;

    try {
      const progress = createCliScanProgress(io.io);
      await progress.update(0.84, 'Generating descriptions 1/35 tables', { transient: true });
      await progress.update(0.85, 'Generating descriptions 2/35 tables', { transient: true });
      await progress.update(0.9, 'Building embeddings 1/4 batches');
    } finally {
      if (previousCi === undefined) {
        delete process.env.CI;
      } else {
        process.env.CI = previousCi;
      }
    }

    expect(io.stdout()).toContain('\r[84%] Generating descriptions 1/35 tables');
    expect(io.stdout()).toContain('\r[85%] Generating descriptions 2/35 tables');
    expect(io.stdout()).toContain('\n[90%] Building embeddings 1/4 batches\n');
  });

  it('scales nested progress phases by the parent phase weight', async () => {
    const io = makeIo({ isTTY: true });
    const previousCi = process.env.CI;
    delete process.env.CI;

    try {
      const progress = createCliScanProgress(io.io);
      await progress.update(0.82, 'Enriching schema metadata');
      const enrichmentProgress = progress.startPhase(0.18);
      await enrichmentProgress.update(0.05, 'Loaded schema snapshot with 56 tables');
      const descriptionProgress = enrichmentProgress.startPhase(0.45);
      await descriptionProgress.update(37 / 56, 'Generating descriptions 37/56 tables', { transient: true });
      await descriptionProgress.update(1, 'Generated descriptions for 56 tables');
    } finally {
      if (previousCi === undefined) {
        delete process.env.CI;
      } else {
        process.env.CI = previousCi;
      }
    }

    expect(io.stdout()).toContain('\r[88%] Generating descriptions 37/56 tables');
    expect(io.stdout()).toContain('\n[91%] Generated descriptions for 56 tables\n');
    expect(io.stdout()).not.toContain('[100%] Generating descriptions 37/56 tables');
  });

  it('flushes transient TTY progress messages before printing scan failures', async () => {
    await initKtxProject({ projectDir: tempDir, projectName: 'warehouse' });
    const runLocalScan = vi.fn(async (input: RunLocalScanOptions): Promise<LocalScanRunResult> => {
      await input.progress?.update(0.42, 'Generating descriptions 3/35 tables', { transient: true });
      throw new Error('scan failed');
    });
    const io = makeIo({ isTTY: true });
    const previousCi = process.env.CI;
    delete process.env.CI;

    try {
      await expect(
        runKtxScan(
          {
            command: 'run',
            projectDir: tempDir,
            connectionId: 'warehouse',
            mode: 'structural',
            detectRelationships: false,
            dryRun: false,
          },
          io.io,
          { runLocalScan, createLocalIngestAdapters: () => [] },
        ),
      ).resolves.toBe(1);
    } finally {
      if (previousCi === undefined) {
        delete process.env.CI;
      } else {
        process.env.CI = previousCi;
      }
    }

    expect(io.stdout()).toContain('\r[42%] Generating descriptions 3/35 tables\u001b[K\n');
    expect(io.stderr()).toBe('scan failed\n');
  });

  it('does not print live progress messages for non-TTY output', async () => {
    await initKtxProject({ projectDir: tempDir, projectName: 'warehouse' });
    const runLocalScan = vi.fn(async (input: RunLocalScanOptions): Promise<LocalScanRunResult> => {
      await input.progress?.update(0.15, 'Inspecting database schema');
      return {
        runId: 'scan-run-1',
        status: 'done',
        done: true,
        connectionId: 'warehouse',
        mode: 'structural',
        dryRun: false,
        syncId: 'sync-1',
        report,
      };
    });
    const io = makeIo();

    await expect(
      runKtxScan(
        {
          command: 'run',
          projectDir: tempDir,
          connectionId: 'warehouse',
          mode: 'structural',
          detectRelationships: false,
          dryRun: false,
        },
        io.io,
        { runLocalScan, createLocalIngestAdapters: noLocalIngestAdapters },
      ),
    ).resolves.toBe(0);

    expect(io.stdout()).not.toContain('[15%]');
    expect(io.stdout()).not.toContain('Inspecting database schema');
  });

  it('uses terminal-aware visual styling only for TTY output', async () => {
    await initKtxProject({ projectDir: tempDir, projectName: 'warehouse' });
    const runLocalScan = vi.fn(
      async (_input: RunLocalScanOptions): Promise<LocalScanRunResult> => ({
        runId: 'scan-run-1',
        status: 'done',
        done: true,
        connectionId: 'warehouse',
        mode: 'structural',
        dryRun: false,
        syncId: 'sync-1',
        report,
      }),
    );
    const io = makeIo({ isTTY: true });
    const previousNoColor = process.env.NO_COLOR;
    const previousCi = process.env.CI;
    const previousTerm = process.env.TERM;
    delete process.env.NO_COLOR;
    delete process.env.CI;
    process.env.TERM = 'xterm-256color';

    try {
      await expect(
        runKtxScan(
          {
            command: 'run',
            projectDir: tempDir,
            connectionId: 'warehouse',
            mode: 'structural',
            detectRelationships: false,
            dryRun: false,
          },
          io.io,
          { runLocalScan, createLocalIngestAdapters: noLocalIngestAdapters },
        ),
      ).resolves.toBe(0);
    } finally {
      if (previousNoColor === undefined) {
        delete process.env.NO_COLOR;
      } else {
        process.env.NO_COLOR = previousNoColor;
      }
      if (previousCi === undefined) {
        delete process.env.CI;
      } else {
        process.env.CI = previousCi;
      }
      if (previousTerm === undefined) {
        delete process.env.TERM;
      } else {
        process.env.TERM = previousTerm;
      }
    }

    expect(io.stdout()).toContain('✓');
    expect(io.stdout()).toContain('KTX scan completed');
    expect(io.stdout()).toContain('\u001b[');
  });

  it('honors NO_COLOR for TTY scan summaries', async () => {
    await initKtxProject({ projectDir: tempDir, projectName: 'warehouse' });
    const runLocalScan = vi.fn(
      async (_input: RunLocalScanOptions): Promise<LocalScanRunResult> => ({
        runId: 'scan-run-1',
        status: 'done',
        done: true,
        connectionId: 'warehouse',
        mode: 'structural',
        dryRun: false,
        syncId: 'sync-1',
        report,
      }),
    );
    const io = makeIo({ isTTY: true });
    const previousNoColor = process.env.NO_COLOR;
    process.env.NO_COLOR = '1';

    try {
      await expect(
        runKtxScan(
          {
            command: 'run',
            projectDir: tempDir,
            connectionId: 'warehouse',
            mode: 'structural',
            detectRelationships: false,
            dryRun: false,
          },
          io.io,
          { runLocalScan, createLocalIngestAdapters: noLocalIngestAdapters },
        ),
      ).resolves.toBe(0);
    } finally {
      if (previousNoColor === undefined) {
        delete process.env.NO_COLOR;
      } else {
        process.env.NO_COLOR = previousNoColor;
      }
    }

    expect(io.stdout()).toContain('KTX scan completed');
    expect(io.stdout()).not.toContain('\u001b[');
  });

  it('passes native CLI adapters into local scan runs for mysql configs', async () => {
    const tempProject = await mkdtemp(join(tmpdir(), 'ktx-scan-cli-native-'));
    await initKtxProject({ projectDir: tempProject, projectName: 'warehouse' });
    await writeFile(
      join(tempProject, 'ktx.yaml'),
      [
        'project: warehouse',
        'connections:',
        '  warehouse:',
        '    driver: mysql',
        '    url: env:MYSQL_URL',
        '',
      ].join('\n'),
      'utf-8',
    );
    const io = makeIo();
    const runLocalScan = vi.fn(
      async (_input: RunLocalScanOptions): Promise<LocalScanRunResult> => ({
        runId: 'scan-run-1',
        status: 'done',
        done: true,
        connectionId: 'warehouse',
        mode: 'structural',
        dryRun: false,
        syncId: 'sync-1',
        report,
      }),
    );

    await expect(
      runKtxScan(
        {
          command: 'run',
          projectDir: tempProject,
          connectionId: 'warehouse',
          mode: 'structural',
          detectRelationships: false,
          dryRun: false,
        },
        io.io,
        { runLocalScan, createLocalIngestAdapters: noLocalIngestAdapters },
      ),
    ).resolves.toBe(0);

    expect(runLocalScan).toHaveBeenCalledWith(expect.objectContaining({ adapters: expect.any(Array) }));
    await rm(tempProject, { recursive: true, force: true });
  });

  it('creates a native connector for standalone relationship scans', async () => {
    const tempProject = await mkdtemp(join(tmpdir(), 'ktx-scan-cli-relationships-'));
    await initKtxProject({ projectDir: tempProject, projectName: 'warehouse' });
    await writeFile(
      join(tempProject, 'ktx.yaml'),
      [
        'project: warehouse',
        'connections:',
        '  warehouse:',
        '    driver: sqlite',
        '    path: warehouse.db',
        '',
      ].join('\n'),
      'utf-8',
    );
    const io = makeIo();
    const runLocalScan = vi.fn(
      async (_input: RunLocalScanOptions): Promise<LocalScanRunResult> => ({
        runId: 'scan-run-1',
        status: 'done',
        done: true,
        connectionId: 'warehouse',
        mode: 'relationships',
        dryRun: false,
        syncId: 'sync-1',
        report: { ...report, mode: 'relationships' },
      }),
    );

    await expect(
      runKtxScan(
        {
          command: 'run',
          projectDir: tempProject,
          connectionId: 'warehouse',
          mode: 'relationships',
          detectRelationships: true,
          dryRun: false,
        },
        io.io,
        { runLocalScan, createLocalIngestAdapters: noLocalIngestAdapters },
      ),
    ).resolves.toBe(0);

    expect(runLocalScan).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'relationships',
        detectRelationships: true,
        connector: expect.objectContaining({ driver: 'sqlite' }),
      }),
    );
    await rm(tempProject, { recursive: true, force: true });
  });

  it('routes standalone postgres scans through the native connector before daemon fallback', async () => {
    const tempProject = await mkdtemp(join(tmpdir(), 'ktx-scan-cli-native-postgres-'));
    await initKtxProject({ projectDir: tempProject, projectName: 'warehouse' });
    await writeFile(
      join(tempProject, 'ktx.yaml'),
      [
        'project: warehouse',
        'connections:',
        '  warehouse:',
        '    driver: postgres',
        '    host: db.example.test',
        '    database: analytics',
        '    username: reader',
        '    password: env:POSTGRES_PASSWORD',
        '',
      ].join('\n'),
      'utf-8',
    );
    const io = makeIo();
    const runLocalScan = vi.fn(
      async (_input: RunLocalScanOptions): Promise<LocalScanRunResult> => ({
        runId: 'scan-run-1',
        status: 'done',
        done: true,
        connectionId: 'warehouse',
        mode: 'structural',
        dryRun: false,
        syncId: 'sync-1',
        report,
      }),
    );

    await expect(
      runKtxScan(
        {
          command: 'run',
          projectDir: tempProject,
          connectionId: 'warehouse',
          mode: 'structural',
          detectRelationships: false,
          dryRun: false,
        },
        io.io,
        {
          runLocalScan,
          createLocalIngestAdapters: () => [fakeLiveDatabaseAdapter(createPostgresLiveDatabaseIntrospection)],
        },
      ),
    ).resolves.toBe(0);

    expect(runLocalScan).toHaveBeenCalledWith(expect.objectContaining({ adapters: expect.any(Array) }));
    const scanOptions = runLocalScan.mock.calls[0]?.[0];
    const liveDatabase = scanOptions?.adapters?.find((adapter) => adapter.source === 'live-database');
    if (!liveDatabase?.fetch) {
      throw new Error('Expected scan adapters to include a fetch-capable live-database adapter');
    }
    const stagedDir = join(tempProject, 'postgres-staged');
    await liveDatabase.fetch(undefined, stagedDir, { connectionId: 'warehouse', sourceKey: 'live-database' });
    expect(createPostgresLiveDatabaseIntrospection).toHaveBeenCalledWith({ connections: expect.any(Object) });
    expect(postgresExtractSchema).toHaveBeenCalledWith('warehouse');
    await expect(readFile(join(stagedDir, 'connection.json'), 'utf-8')).resolves.toContain(
      '"connectionId": "warehouse"',
    );
    await rm(tempProject, { recursive: true, force: true });
  });

  it('passes native CLI adapters into local scan runs for clickhouse configs', async () => {
    const tempProject = await mkdtemp(join(tmpdir(), 'ktx-scan-cli-native-clickhouse-'));
    await initKtxProject({ projectDir: tempProject, projectName: 'warehouse' });
    await writeFile(
      join(tempProject, 'ktx.yaml'),
      [
        'project: warehouse',
        'connections:',
        '  warehouse:',
        '    driver: clickhouse',
        '    host: env:CLICKHOUSE_HOST',
        '    database: analytics',
        '    username: reader',
        '    password: env:CLICKHOUSE_PASSWORD',
        '',
      ].join('\n'),
      'utf-8',
    );
    const io = makeIo();
    const runLocalScan = vi.fn(
      async (_input: RunLocalScanOptions): Promise<LocalScanRunResult> => ({
        runId: 'scan-run-1',
        status: 'done',
        done: true,
        connectionId: 'warehouse',
        mode: 'structural',
        dryRun: false,
        syncId: 'sync-1',
        report: { ...report, driver: 'clickhouse' },
      }),
    );

    await expect(
      runKtxScan(
        {
          command: 'run',
          projectDir: tempProject,
          connectionId: 'warehouse',
          mode: 'structural',
          detectRelationships: false,
          dryRun: false,
        },
        io.io,
        { runLocalScan, createLocalIngestAdapters: noLocalIngestAdapters },
      ),
    ).resolves.toBe(0);

    expect(runLocalScan).toHaveBeenCalledWith(expect.objectContaining({ adapters: expect.any(Array) }));
    await rm(tempProject, { recursive: true, force: true });
  });

  it('passes native CLI adapters into local scan runs for sqlserver configs', async () => {
    const tempProject = await mkdtemp(join(tmpdir(), 'ktx-scan-cli-native-sqlserver-'));
    await initKtxProject({ projectDir: tempProject, projectName: 'warehouse' });
    await writeFile(
      join(tempProject, 'ktx.yaml'),
      [
        'project: warehouse',
        'connections:',
        '  warehouse:',
        '    driver: sqlserver',
        '    host: env:SQLSERVER_HOST',
        '    database: analytics',
        '    username: reader',
        '    schema: dbo',
        '',
      ].join('\n'),
      'utf-8',
    );
    const io = makeIo();
    const runLocalScan = vi.fn(
      async (_input: RunLocalScanOptions): Promise<LocalScanRunResult> => ({
        runId: 'scan-run-1',
        status: 'done',
        done: true,
        connectionId: 'warehouse',
        mode: 'structural',
        dryRun: false,
        syncId: 'sync-1',
        report: { ...report, driver: 'sqlserver' },
      }),
    );

    await expect(
      runKtxScan(
        {
          command: 'run',
          projectDir: tempProject,
          connectionId: 'warehouse',
          mode: 'structural',
          detectRelationships: false,
          dryRun: false,
        },
        io.io,
        {
          runLocalScan,
          createLocalIngestAdapters: () => [fakeLiveDatabaseAdapter(createSqlServerLiveDatabaseIntrospection)],
        },
      ),
    ).resolves.toBe(0);

    expect(runLocalScan).toHaveBeenCalledWith(expect.objectContaining({ adapters: expect.any(Array) }));
    const scanOptions = runLocalScan.mock.calls[0]?.[0];
    const liveDatabase = scanOptions?.adapters?.find((adapter) => adapter.source === 'live-database');
    if (!liveDatabase?.fetch) {
      throw new Error('Expected scan adapters to include a fetch-capable live-database adapter');
    }
    const stagedDir = join(tempProject, 'sqlserver-staged');
    await liveDatabase.fetch(undefined, stagedDir, { connectionId: 'warehouse', sourceKey: 'live-database' });
    expect(createSqlServerLiveDatabaseIntrospection).toHaveBeenCalledWith({ connections: expect.any(Object) });
    expect(sqlServerExtractSchema).toHaveBeenCalledWith('warehouse');
    await expect(readFile(join(stagedDir, 'connection.json'), 'utf-8')).resolves.toContain(
      '"connectionId": "warehouse"',
    );
    await rm(tempProject, { recursive: true, force: true });
  });

  it('passes native CLI adapters into local scan runs for bigquery configs', async () => {
    const tempProject = await mkdtemp(join(tmpdir(), 'ktx-scan-cli-native-bigquery-'));
    await initKtxProject({ projectDir: tempProject, projectName: 'warehouse' });
    await writeFile(
      join(tempProject, 'ktx.yaml'),
      [
        'project: warehouse',
        'connections:',
        '  warehouse:',
        '    driver: bigquery',
        '    dataset_id: analytics',
        '    credentials_json: env:BIGQUERY_CREDENTIALS_JSON',
        '    location: US',
        '',
      ].join('\n'),
      'utf-8',
    );
    const io = makeIo();
    const runLocalScan = vi.fn(
      async (_input: RunLocalScanOptions): Promise<LocalScanRunResult> => ({
        runId: 'scan-run-1',
        status: 'done',
        done: true,
        connectionId: 'warehouse',
        mode: 'structural',
        dryRun: false,
        syncId: 'sync-1',
        report: { ...report, driver: 'bigquery' },
      }),
    );

    await expect(
      runKtxScan(
        {
          command: 'run',
          projectDir: tempProject,
          connectionId: 'warehouse',
          mode: 'structural',
          detectRelationships: false,
          dryRun: false,
        },
        io.io,
        {
          runLocalScan,
          createLocalIngestAdapters: () => [fakeLiveDatabaseAdapter(createBigQueryLiveDatabaseIntrospection)],
        },
      ),
    ).resolves.toBe(0);

    expect(runLocalScan).toHaveBeenCalledWith(expect.objectContaining({ adapters: expect.any(Array) }));
    const scanOptions = runLocalScan.mock.calls[0]?.[0];
    const liveDatabase = scanOptions?.adapters?.find((adapter) => adapter.source === 'live-database');
    if (!liveDatabase?.fetch) {
      throw new Error('Expected scan adapters to include a fetch-capable live-database adapter');
    }
    const stagedDir = join(tempProject, 'bigquery-staged');
    await liveDatabase.fetch(undefined, stagedDir, { connectionId: 'warehouse', sourceKey: 'live-database' });
    expect(createBigQueryLiveDatabaseIntrospection).toHaveBeenCalledWith({ connections: expect.any(Object) });
    expect(bigQueryExtractSchema).toHaveBeenCalledWith('warehouse');
    await expect(readFile(join(stagedDir, 'connection.json'), 'utf-8')).resolves.toContain(
      '"connectionId": "warehouse"',
    );
    await rm(tempProject, { recursive: true, force: true });
  });

  it('passes native CLI adapters into local scan runs for snowflake configs', async () => {
    const tempProject = await mkdtemp(join(tmpdir(), 'ktx-scan-cli-native-snowflake-'));
    await initKtxProject({ projectDir: tempProject, projectName: 'warehouse' });
    await writeFile(
      join(tempProject, 'ktx.yaml'),
      [
        'project: warehouse',
        'connections:',
        '  warehouse:',
        '    driver: snowflake',
        '    authMethod: password',
        '    account: env:SNOWFLAKE_ACCOUNT',
        '    warehouse: WH',
        '    database: ANALYTICS',
        '    schema_name: PUBLIC',
        '    username: reader',
        '',
      ].join('\n'),
      'utf-8',
    );
    const io = makeIo();
    const runLocalScan = vi.fn(
      async (_input: RunLocalScanOptions): Promise<LocalScanRunResult> => ({
        runId: 'scan-run-1',
        status: 'done',
        done: true,
        connectionId: 'warehouse',
        mode: 'structural',
        dryRun: false,
        syncId: 'sync-1',
        report: { ...report, driver: 'snowflake' },
      }),
    );

    await expect(
      runKtxScan(
        {
          command: 'run',
          projectDir: tempProject,
          connectionId: 'warehouse',
          mode: 'structural',
          detectRelationships: false,
          dryRun: false,
        },
        io.io,
        {
          runLocalScan,
          createLocalIngestAdapters: () => [fakeLiveDatabaseAdapter(createSnowflakeLiveDatabaseIntrospection)],
        },
      ),
    ).resolves.toBe(0);

    expect(runLocalScan).toHaveBeenCalledWith(expect.objectContaining({ adapters: expect.any(Array) }));
    const scanOptions = runLocalScan.mock.calls[0]?.[0];
    const liveDatabase = scanOptions?.adapters?.find((adapter) => adapter.source === 'live-database');
    if (!liveDatabase?.fetch) {
      throw new Error('Expected scan adapters to include a fetch-capable live-database adapter');
    }
    const stagedDir = join(tempProject, 'snowflake-staged');
    await liveDatabase.fetch(undefined, stagedDir, { connectionId: 'warehouse', sourceKey: 'live-database' });
    expect(createSnowflakeLiveDatabaseIntrospection).toHaveBeenCalledWith({ connections: expect.any(Object) });
    expect(snowflakeExtractSchema).toHaveBeenCalledWith('warehouse');
    await expect(readFile(join(stagedDir, 'connection.json'), 'utf-8')).resolves.toContain(
      '"connectionId": "warehouse"',
    );
    await rm(tempProject, { recursive: true, force: true });
  });
});
