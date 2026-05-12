import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initKtxProject } from '@ktx/context/project';
import type {
  ApplyLocalScanRelationshipReviewDecisionsResult,
  ExportLocalRelationshipFeedbackLabelsResult,
  KtxRelationshipFeedbackCalibrationReport,
  KtxRelationshipThresholdAdviceReport,
  KtxScanReport,
  LocalScanRunResult,
  LocalScanStatusResponse,
  ReadLocalScanRelationshipArtifactsResult,
  RunLocalScanOptions,
  WriteLocalScanRelationshipReviewDecisionResult,
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
        { runLocalScan },
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
    expect(io.stdout()).toContain('ktx dev scan status --project-dir ');
    expect(io.stdout()).toContain(' scan-run-1\n');
    expect(io.stdout()).toContain('ktx dev scan report --project-dir ');
    expect(io.stdout()).toContain(' scan-run-1\n');
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
        { runLocalScan },
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
        { runLocalScan },
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
        { runLocalScan },
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
        { runLocalScan },
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
          { runLocalScan },
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
          { runLocalScan },
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

  it('prints status and human report output by default', async () => {
    await initKtxProject({ projectDir: tempDir, projectName: 'warehouse' });
    const status: LocalScanStatusResponse = {
      runId: 'scan-run-1',
      status: 'done',
      done: true,
      connectionId: 'warehouse',
      mode: 'structural',
      dryRun: false,
      syncId: 'sync-1',
      progress: 1,
      startedAt: '2026-04-29T09:00:00.000Z',
      completedAt: '2026-04-29T09:00:01.000Z',
      reportPath: 'raw-sources/warehouse/live-database/sync-1/scan-report.json',
      warnings: [],
    };
    const io = makeIo();

    await expect(
      runKtxScan({ command: 'status', projectDir: tempDir, runId: 'scan-run-1' }, io.io, {
        getLocalScanStatus: vi.fn().mockResolvedValue(status),
      }),
    ).resolves.toBe(0);
    expect(io.stdout()).toContain('Run: scan-run-1');
    expect(io.stdout()).toContain('Status: done');

    const reportIo = makeIo();
    await expect(
      runKtxScan({ command: 'report', projectDir: tempDir, runId: 'scan-run-1', json: false }, reportIo.io, {
        getLocalScanReport: vi.fn().mockResolvedValue(report),
      }),
    ).resolves.toBe(0);
    expect(reportIo.stdout()).toContain('KTX scan report\n');
    expect(reportIo.stdout()).toContain('Run: scan-run-1');
    expect(reportIo.stdout()).toContain('What changed\n');
    expect(() => JSON.parse(reportIo.stdout())).toThrow();
  });

  it('prints raw report JSON when requested', async () => {
    await initKtxProject({ projectDir: tempDir, projectName: 'warehouse' });
    const reportIo = makeIo();

    await expect(
      runKtxScan({ command: 'report', projectDir: tempDir, runId: 'scan-run-1', json: true }, reportIo.io, {
        getLocalScanReport: vi.fn().mockResolvedValue(report),
      }),
    ).resolves.toBe(0);

    expect(JSON.parse(reportIo.stdout())).toMatchObject({ runId: 'scan-run-1', connectionId: 'warehouse' });
  });

  it('prints review relationship artifacts in human form', async () => {
    await initKtxProject({ projectDir: tempDir, projectName: 'warehouse' });
    const reviewReport: KtxScanReport = {
      ...reportWithAttention,
      runId: 'scan-run-review',
      syncId: 'sync-review',
      relationships: { accepted: 0, review: 1, rejected: 1, skipped: 0 },
      artifactPaths: {
        ...reportWithAttention.artifactPaths,
        reportPath: 'raw-sources/warehouse/live-database/sync-review/scan-report.json',
        enrichmentArtifacts: [
          'raw-sources/warehouse/live-database/sync-review/enrichment/relationships.json',
          'raw-sources/warehouse/live-database/sync-review/enrichment/relationship-diagnostics.json',
          'raw-sources/warehouse/live-database/sync-review/enrichment/relationship-profile.json',
        ],
      },
    };
    const relationshipArtifacts: ReadLocalScanRelationshipArtifactsResult = {
      runId: 'scan-run-review',
      connectionId: 'warehouse',
      syncId: 'sync-review',
      report: reviewReport,
      relationships: {
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
      },
      diagnostics: {
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
        profileWarnings: [],
      },
      profile: {
        connectionId: 'warehouse',
        driver: 'sqlite',
        sqlAvailable: false,
        tables: [],
        columns: {},
        queryCount: 0,
        warnings: ['KTX scan connector cannot run read-only SQL relationship validation'],
      },
      paths: {
        relationships: 'raw-sources/warehouse/live-database/sync-review/enrichment/relationships.json',
        diagnostics: 'raw-sources/warehouse/live-database/sync-review/enrichment/relationship-diagnostics.json',
        profile: 'raw-sources/warehouse/live-database/sync-review/enrichment/relationship-profile.json',
      },
    };
    const readLocalScanRelationshipArtifacts = vi.fn(async () => relationshipArtifacts);

    const io = makeIo();
    await expect(
      runKtxScan(
        {
          command: 'relationships',
          projectDir: tempDir,
          runId: 'scan-run-review',
          status: 'review',
          json: false,
          limit: 10,
        },
        io.io,
        { readLocalScanRelationshipArtifacts },
      ),
    ).resolves.toBe(0);

    expect(readLocalScanRelationshipArtifacts).toHaveBeenCalledWith(
      expect.objectContaining({ projectDir: tempDir }),
      'scan-run-review',
    );

    expect(io.stdout()).toContain('KTX relationship artifacts');
    expect(io.stdout()).toContain('Run: scan-run-review');
    expect(io.stdout()).toContain('Summary: accepted=0 review=1 rejected=1 skipped=0');
    expect(io.stdout()).toContain('Reason: relationship candidates require review before manifest writes');
    expect(io.stdout()).toContain('Review relationships (1)');
    expect(io.stdout()).toContain('orders.customer_id -> customers.id');
    expect(io.stdout()).toContain(
      'type=many_to_one source=deterministic_name confidence=0.62 pkScore=0.91 fkScore=0.62',
    );
    expect(io.stdout()).toContain('reasons=validation_unavailable_review_only, fk_score_review');
    expect(io.stdout()).toContain('relationships.json');
  });

  it('prints filtered relationship artifacts as JSON', async () => {
    await initKtxProject({ projectDir: tempDir, projectName: 'warehouse' });
    const jsonReport: KtxScanReport = {
      ...reportWithAttention,
      runId: 'scan-run-json',
      syncId: 'sync-json',
      artifactPaths: {
        ...reportWithAttention.artifactPaths,
        reportPath: 'raw-sources/warehouse/live-database/sync-json/scan-report.json',
        enrichmentArtifacts: ['raw-sources/warehouse/live-database/sync-json/enrichment/relationships.json'],
      },
    };
    const relationshipArtifacts: ReadLocalScanRelationshipArtifactsResult = {
      runId: 'scan-run-json',
      connectionId: 'warehouse',
      syncId: 'sync-json',
      report: jsonReport,
      relationships: {
        connectionId: 'warehouse',
        accepted: [],
        review: [],
        rejected: [],
        skipped: [{ relationshipId: 'composite:orders', reason: 'composite_key_width_limit' }],
      },
      diagnostics: null,
      profile: null,
      paths: {
        relationships: 'raw-sources/warehouse/live-database/sync-json/enrichment/relationships.json',
        diagnostics: null,
        profile: null,
      },
    };
    const readLocalScanRelationshipArtifacts = vi.fn(async () => relationshipArtifacts);

    const io = makeIo();
    await expect(
      runKtxScan(
        {
          command: 'relationships',
          projectDir: tempDir,
          runId: 'scan-run-json',
          status: 'skipped',
          json: true,
          limit: 25,
        },
        io.io,
        { readLocalScanRelationshipArtifacts },
      ),
    ).resolves.toBe(0);

    expect(JSON.parse(io.stdout())).toMatchObject({
      runId: 'scan-run-json',
      connectionId: 'warehouse',
      status: 'skipped',
      relationships: {
        accepted: [],
        review: [],
        rejected: [],
        skipped: [{ relationshipId: 'composite:orders', reason: 'composite_key_width_limit' }],
      },
    });
  });

  it('records an accepted relationship review decision in human form', async () => {
    await initKtxProject({ projectDir: tempDir, projectName: 'warehouse' });
    const decisionResult: WriteLocalScanRelationshipReviewDecisionResult = {
      path: 'raw-sources/warehouse/live-database/sync-review/enrichment/relationship-review-decisions.json',
      decision: {
        candidateId: 'orders:orders.customer_id->customers:customers.id',
        decision: 'accepted',
        previousStatus: 'review',
        connectionId: 'warehouse',
        runId: 'scan-run-review',
        syncId: 'sync-review',
        decidedAt: '2026-05-07T12:00:00.000Z',
        reviewer: 'Andrey',
        note: 'Looks right',
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
        source: 'deterministic_name',
        score: 0.62,
        confidence: 0.62,
        pkScore: 0.91,
        fkScore: 0.62,
        reasons: ['fk_score_review'],
      },
      artifact: {
        connectionId: 'warehouse',
        runId: 'scan-run-review',
        syncId: 'sync-review',
        generatedAt: '2026-05-07T12:00:00.000Z',
        decisions: [],
      },
    };
    const writeLocalScanRelationshipReviewDecision = vi.fn(async () => decisionResult);

    const io = makeIo();
    await expect(
      runKtxScan(
        {
          command: 'relationshipDecision',
          projectDir: tempDir,
          runId: 'scan-run-review',
          candidateId: 'orders:orders.customer_id->customers:customers.id',
          decision: 'accepted',
          reviewer: 'Andrey',
          note: 'Looks right',
          json: false,
        },
        io.io,
        { writeLocalScanRelationshipReviewDecision },
      ),
    ).resolves.toBe(0);

    expect(writeLocalScanRelationshipReviewDecision).toHaveBeenCalledWith(
      expect.objectContaining({ projectDir: tempDir }),
      {
        runId: 'scan-run-review',
        candidateId: 'orders:orders.customer_id->customers:customers.id',
        decision: 'accepted',
        reviewer: 'Andrey',
        note: 'Looks right',
      },
    );
    expect(io.stdout()).toContain('Recorded relationship decision');
    expect(io.stdout()).toContain('Decision: accepted');
    expect(io.stdout()).toContain('Candidate: orders:orders.customer_id->customers:customers.id');
    expect(io.stdout()).toContain('Previous status: review');
    expect(io.stdout()).toContain(
      'Path: raw-sources/warehouse/live-database/sync-review/enrichment/relationship-review-decisions.json',
    );
  });

  it('records a rejected relationship review decision as JSON', async () => {
    await initKtxProject({ projectDir: tempDir, projectName: 'warehouse' });
    const decisionResult: WriteLocalScanRelationshipReviewDecisionResult = {
      path: 'raw-sources/warehouse/live-database/sync-review/enrichment/relationship-review-decisions.json',
      decision: {
        candidateId: 'orders:orders.customer_id->customers:customers.id',
        decision: 'rejected',
        previousStatus: 'review',
        connectionId: 'warehouse',
        runId: 'scan-run-review',
        syncId: 'sync-review',
        decidedAt: '2026-05-07T12:00:00.000Z',
        reviewer: 'Andrey',
        note: null,
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
        source: 'deterministic_name',
        score: 0.62,
        confidence: 0.62,
        pkScore: 0.91,
        fkScore: 0.62,
        reasons: ['fk_score_review'],
      },
      artifact: {
        connectionId: 'warehouse',
        runId: 'scan-run-review',
        syncId: 'sync-review',
        generatedAt: '2026-05-07T12:00:00.000Z',
        decisions: [],
      },
    };
    const writeLocalScanRelationshipReviewDecision = vi.fn(async () => decisionResult);

    const io = makeIo();
    await expect(
      runKtxScan(
        {
          command: 'relationshipDecision',
          projectDir: tempDir,
          runId: 'scan-run-review',
          candidateId: 'orders:orders.customer_id->customers:customers.id',
          decision: 'rejected',
          reviewer: 'ktx',
          note: null,
          json: true,
        },
        io.io,
        { writeLocalScanRelationshipReviewDecision },
      ),
    ).resolves.toBe(0);

    expect(JSON.parse(io.stdout())).toMatchObject({
      path: 'raw-sources/warehouse/live-database/sync-review/enrichment/relationship-review-decisions.json',
      decision: {
        candidateId: 'orders:orders.customer_id->customers:customers.id',
        decision: 'rejected',
        previousStatus: 'review',
      },
    });
  });

  it('reports missing scan runs when recording relationship decisions', async () => {
    await initKtxProject({ projectDir: tempDir, projectName: 'warehouse' });
    const writeLocalScanRelationshipReviewDecision = vi.fn(async () => null);

    const io = makeIo();
    await expect(
      runKtxScan(
        {
          command: 'relationshipDecision',
          projectDir: tempDir,
          runId: 'missing-run',
          candidateId: 'orders:orders.customer_id->customers:customers.id',
          decision: 'accepted',
          reviewer: 'ktx',
          note: null,
          json: false,
        },
        io.io,
        { writeLocalScanRelationshipReviewDecision },
      ),
    ).resolves.toBe(1);

    expect(io.stderr()).toContain('Scan run "missing-run" was not found');
  });

  it('applies accepted relationship review decisions with human output', async () => {
    await initKtxProject({ projectDir: tempDir, projectName: 'warehouse' });
    const applyLocalScanRelationshipReviewDecisions = vi.fn(
      async (): Promise<ApplyLocalScanRelationshipReviewDecisionsResult> => ({
        runId: 'scan-run-a',
        connectionId: 'warehouse',
        syncId: 'sync-a',
        dryRun: true,
        decisionsPath: 'raw-sources/warehouse/live-database/sync-a/enrichment/relationship-review-decisions.json',
        selectedDecisions: 1,
        appliedRelationships: 1,
        relationships: [
          {
            id: 'orders:orders.customer_id->customers:customers.id',
            source: 'manual',
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
            confidence: 1,
            isPrimaryKeyReference: true,
          },
        ],
        manifestShards: [],
        manifestShardsWritten: 0,
      }),
    );

    const io = makeIo();
    await expect(
      runKtxScan(
        {
          command: 'relationshipApply',
          projectDir: tempDir,
          runId: 'scan-run-a',
          applyAllAccepted: true,
          candidateIds: [],
          dryRun: true,
          json: false,
        },
        io.io,
        { applyLocalScanRelationshipReviewDecisions },
      ),
    ).resolves.toBe(0);

    expect(applyLocalScanRelationshipReviewDecisions).toHaveBeenCalledWith(
      expect.objectContaining({ projectDir: tempDir }),
      {
        runId: 'scan-run-a',
        applyAllAccepted: true,
        candidateIds: [],
        dryRun: true,
      },
    );
    expect(io.stdout()).toContain('Relationship review apply');
    expect(io.stdout()).toContain('Run: scan-run-a');
    expect(io.stdout()).toContain('Mode: dry-run');
    expect(io.stdout()).toContain('Applied: 1 manual relationship');
    expect(io.stdout()).toContain('Schema shards written: 0');
  });

  it('prints relationship review apply JSON', async () => {
    await initKtxProject({ projectDir: tempDir, projectName: 'warehouse' });
    const applyResult: ApplyLocalScanRelationshipReviewDecisionsResult = {
      runId: 'scan-run-a',
      connectionId: 'warehouse',
      syncId: 'sync-a',
      dryRun: false,
      decisionsPath: 'raw-sources/warehouse/live-database/sync-a/enrichment/relationship-review-decisions.json',
      selectedDecisions: 1,
      appliedRelationships: 1,
      relationships: [],
      manifestShards: ['semantic-layer/warehouse/_schema/public.yaml'],
      manifestShardsWritten: 1,
    };
    const applyLocalScanRelationshipReviewDecisions = vi.fn(async () => applyResult);

    const io = makeIo();
    await expect(
      runKtxScan(
        {
          command: 'relationshipApply',
          projectDir: tempDir,
          runId: 'scan-run-a',
          applyAllAccepted: false,
          candidateIds: ['orders:orders.customer_id->customers:customers.id'],
          dryRun: false,
          json: true,
        },
        io.io,
        { applyLocalScanRelationshipReviewDecisions },
      ),
    ).resolves.toBe(0);

    expect(JSON.parse(io.stdout())).toEqual(applyResult);
    expect(applyLocalScanRelationshipReviewDecisions).toHaveBeenCalledWith(
      expect.objectContaining({ projectDir: tempDir }),
      {
        runId: 'scan-run-a',
        applyAllAccepted: false,
        candidateIds: ['orders:orders.customer_id->customers:customers.id'],
        dryRun: false,
      },
    );
  });

  it('prints relationship feedback export summary in human form', async () => {
    await initKtxProject({ projectDir: tempDir, projectName: 'warehouse' });
    const feedback: ExportLocalRelationshipFeedbackLabelsResult = {
      generatedAt: '2026-05-07T13:00:00.000Z',
      filters: { connectionId: null, decision: 'all' },
      summary: { total: 2, accepted: 1, rejected: 1, connections: 1, runs: 1 },
      labels: [
        {
          schemaVersion: 1,
          candidateId: 'orders:orders.customer_id->customers:customers.id',
          decision: 'accepted',
          previousStatus: 'review',
          connectionId: 'warehouse',
          runId: 'scan-run-review',
          syncId: 'sync-review',
          decidedAt: '2026-05-07T12:00:00.000Z',
          reviewer: 'Andrey',
          note: 'Confirmed in warehouse docs',
          relationshipType: 'many_to_one',
          source: 'deterministic_name',
          score: 0.62,
          confidence: 0.62,
          pkScore: 0.91,
          fkScore: 0.62,
          fromTable: 'public.orders',
          fromColumns: ['customer_id'],
          toTable: 'public.customers',
          toColumns: ['id'],
          reasons: ['fk_score_review'],
          artifactPath: 'raw-sources/warehouse/live-database/sync-review/enrichment/relationship-review-decisions.json',
        },
        {
          schemaVersion: 1,
          candidateId: 'orders:orders.note_id->notes:notes.id',
          decision: 'rejected',
          previousStatus: 'rejected',
          connectionId: 'warehouse',
          runId: 'scan-run-review',
          syncId: 'sync-review',
          decidedAt: '2026-05-07T12:05:00.000Z',
          reviewer: 'Andrey',
          note: null,
          relationshipType: 'many_to_one',
          source: 'deterministic_name',
          score: 0.2,
          confidence: 0.2,
          pkScore: 0.4,
          fkScore: 0.2,
          fromTable: 'public.orders',
          fromColumns: ['note_id'],
          toTable: 'public.notes',
          toColumns: ['id'],
          reasons: ['low_source_coverage'],
          artifactPath: 'raw-sources/warehouse/live-database/sync-review/enrichment/relationship-review-decisions.json',
        },
      ],
      warnings: [],
    };
    const exportLocalRelationshipFeedbackLabels = vi.fn(async () => feedback);

    const io = makeIo();
    await expect(
      runKtxScan(
        {
          command: 'relationshipFeedback',
          projectDir: tempDir,
          connectionId: null,
          decision: 'all',
          json: false,
          jsonl: false,
        },
        io.io,
        { exportLocalRelationshipFeedbackLabels },
      ),
    ).resolves.toBe(0);

    expect(exportLocalRelationshipFeedbackLabels).toHaveBeenCalledWith(
      expect.objectContaining({ projectDir: tempDir }),
      {
        connectionId: null,
        decision: 'all',
      },
    );
    expect(io.stdout()).toContain('KTX relationship feedback labels');
    expect(io.stdout()).toContain('Total: 2');
    expect(io.stdout()).toContain('Accepted: 1');
    expect(io.stdout()).toContain('Rejected: 1');
    expect(io.stdout()).toContain('orders.customer_id -> customers.id');
    expect(io.stdout()).toContain('decision=accepted previous=review score=0.62 reviewer=Andrey');
  });

  it('prints relationship feedback labels as JSONL', async () => {
    await initKtxProject({ projectDir: tempDir, projectName: 'warehouse' });
    const feedback: ExportLocalRelationshipFeedbackLabelsResult = {
      generatedAt: '2026-05-07T13:00:00.000Z',
      filters: { connectionId: 'warehouse', decision: 'accepted' },
      summary: { total: 1, accepted: 1, rejected: 0, connections: 1, runs: 1 },
      labels: [
        {
          schemaVersion: 1,
          candidateId: 'orders:orders.customer_id->customers:customers.id',
          decision: 'accepted',
          previousStatus: 'review',
          connectionId: 'warehouse',
          runId: 'scan-run-review',
          syncId: 'sync-review',
          decidedAt: '2026-05-07T12:00:00.000Z',
          reviewer: 'ktx',
          note: null,
          relationshipType: 'many_to_one',
          source: 'deterministic_name',
          score: 0.62,
          confidence: 0.62,
          pkScore: 0.91,
          fkScore: 0.62,
          fromTable: 'public.orders',
          fromColumns: ['customer_id'],
          toTable: 'public.customers',
          toColumns: ['id'],
          reasons: ['fk_score_review'],
          artifactPath: 'raw-sources/warehouse/live-database/sync-review/enrichment/relationship-review-decisions.json',
        },
      ],
      warnings: [],
    };
    const exportLocalRelationshipFeedbackLabels = vi.fn(async () => feedback);
    const formatKtxRelationshipFeedbackLabelsJsonl = vi.fn(
      () => '{"candidateId":"orders:orders.customer_id->customers:customers.id"}\n',
    );

    const io = makeIo();
    await expect(
      runKtxScan(
        {
          command: 'relationshipFeedback',
          projectDir: tempDir,
          connectionId: 'warehouse',
          decision: 'accepted',
          json: false,
          jsonl: true,
        },
        io.io,
        { exportLocalRelationshipFeedbackLabels, formatKtxRelationshipFeedbackLabelsJsonl },
      ),
    ).resolves.toBe(0);

    expect(exportLocalRelationshipFeedbackLabels).toHaveBeenCalledWith(
      expect.objectContaining({ projectDir: tempDir }),
      {
        connectionId: 'warehouse',
        decision: 'accepted',
      },
    );
    expect(formatKtxRelationshipFeedbackLabelsJsonl).toHaveBeenCalledWith(feedback);
    expect(JSON.parse(io.stdout())).toEqual({ candidateId: 'orders:orders.customer_id->customers:customers.id' });
  });

  it('prints relationship feedback export as JSON', async () => {
    await initKtxProject({ projectDir: tempDir, projectName: 'warehouse' });
    const feedback: ExportLocalRelationshipFeedbackLabelsResult = {
      generatedAt: '2026-05-07T13:00:00.000Z',
      filters: { connectionId: null, decision: 'rejected' },
      summary: { total: 0, accepted: 0, rejected: 0, connections: 0, runs: 0 },
      labels: [],
      warnings: [],
    };
    const exportLocalRelationshipFeedbackLabels = vi.fn(async () => feedback);

    const io = makeIo();
    await expect(
      runKtxScan(
        {
          command: 'relationshipFeedback',
          projectDir: tempDir,
          connectionId: null,
          decision: 'rejected',
          json: true,
          jsonl: false,
        },
        io.io,
        { exportLocalRelationshipFeedbackLabels },
      ),
    ).resolves.toBe(0);

    expect(JSON.parse(io.stdout())).toMatchObject({
      filters: { connectionId: null, decision: 'rejected' },
      summary: { total: 0, accepted: 0, rejected: 0 },
      labels: [],
    });
  });

  it('prints relationship feedback calibration as human output', async () => {
    await initKtxProject({ projectDir: tempDir, projectName: 'warehouse' });
    const calibration: KtxRelationshipFeedbackCalibrationReport = {
      generatedAt: '2026-05-07T13:00:00.000Z',
      filters: { connectionId: null, decision: 'all' },
      thresholds: { accept: 0.85, review: 0.55 },
      summary: {
        total: 2,
        scored: 2,
        unscored: 0,
        acceptedLabels: 1,
        rejectedLabels: 1,
        predictedAccepted: 1,
        predictedReview: 0,
        predictedRejected: 1,
        acceptedBandPrecision: 1,
        rejectedBandPrecision: 1,
        reviewBandAcceptedRate: null,
        meanAcceptedScore: 0.91,
        meanRejectedScore: 0.21,
      },
      buckets: [
        {
          label: '0.00-0.24',
          minInclusive: 0,
          maxInclusive: 0.24,
          total: 1,
          accepted: 0,
          rejected: 1,
          acceptanceRate: 0,
        },
        {
          label: '0.25-0.49',
          minInclusive: 0.25,
          maxInclusive: 0.49,
          total: 0,
          accepted: 0,
          rejected: 0,
          acceptanceRate: null,
        },
        {
          label: '0.50-0.74',
          minInclusive: 0.5,
          maxInclusive: 0.74,
          total: 0,
          accepted: 0,
          rejected: 0,
          acceptanceRate: null,
        },
        {
          label: '0.75-1.00',
          minInclusive: 0.75,
          maxInclusive: 1,
          total: 1,
          accepted: 1,
          rejected: 0,
          acceptanceRate: 1,
        },
      ],
      labels: [],
      warnings: [],
    };
    const calibrateLocalRelationshipFeedbackLabels = vi.fn(async () => calibration);
    const formatKtxRelationshipFeedbackCalibrationMarkdown = vi.fn(
      () => 'KTX relationship feedback calibration\nTotal labels: 2\n',
    );

    const io = makeIo();
    await expect(
      runKtxScan(
        {
          command: 'relationshipCalibration',
          projectDir: tempDir,
          connectionId: null,
          decision: 'all',
          acceptThreshold: 0.85,
          reviewThreshold: 0.55,
          json: false,
        },
        io.io,
        { calibrateLocalRelationshipFeedbackLabels, formatKtxRelationshipFeedbackCalibrationMarkdown },
      ),
    ).resolves.toBe(0);

    expect(calibrateLocalRelationshipFeedbackLabels).toHaveBeenCalledWith(
      expect.objectContaining({ projectDir: tempDir }),
      {
        connectionId: null,
        decision: 'all',
        acceptThreshold: 0.85,
        reviewThreshold: 0.55,
      },
    );
    expect(formatKtxRelationshipFeedbackCalibrationMarkdown).toHaveBeenCalledWith(calibration);
    expect(io.stdout()).toBe('KTX relationship feedback calibration\nTotal labels: 2\n');
  });

  it('prints relationship feedback calibration as JSON', async () => {
    await initKtxProject({ projectDir: tempDir, projectName: 'warehouse' });
    const calibration: KtxRelationshipFeedbackCalibrationReport = {
      generatedAt: '2026-05-07T13:00:00.000Z',
      filters: { connectionId: 'warehouse', decision: 'rejected' },
      thresholds: { accept: 0.9, review: 0.5 },
      summary: {
        total: 0,
        scored: 0,
        unscored: 0,
        acceptedLabels: 0,
        rejectedLabels: 0,
        predictedAccepted: 0,
        predictedReview: 0,
        predictedRejected: 0,
        acceptedBandPrecision: null,
        rejectedBandPrecision: null,
        reviewBandAcceptedRate: null,
        meanAcceptedScore: null,
        meanRejectedScore: null,
      },
      buckets: [],
      labels: [],
      warnings: [],
    };
    const calibrateLocalRelationshipFeedbackLabels = vi.fn(async () => calibration);

    const io = makeIo();
    await expect(
      runKtxScan(
        {
          command: 'relationshipCalibration',
          projectDir: tempDir,
          connectionId: 'warehouse',
          decision: 'rejected',
          acceptThreshold: 0.9,
          reviewThreshold: 0.5,
          json: true,
        },
        io.io,
        { calibrateLocalRelationshipFeedbackLabels },
      ),
    ).resolves.toBe(0);

    expect(JSON.parse(io.stdout())).toMatchObject({
      filters: { connectionId: 'warehouse', decision: 'rejected' },
      thresholds: { accept: 0.9, review: 0.5 },
      summary: { total: 0, scored: 0 },
    });
  });

  it('prints relationship threshold advice as human output', async () => {
    await initKtxProject({ projectDir: tempDir, projectName: 'warehouse' });
    const advice: KtxRelationshipThresholdAdviceReport = {
      generatedAt: '2026-05-07T14:00:00.000Z',
      filters: { connectionId: null, decision: 'all' },
      status: 'ready',
      gates: {
        minTotalLabels: 4,
        minAcceptedLabels: 2,
        minRejectedLabels: 2,
        minAcceptedBandPrecision: 0.9,
        minAcceptedOrReviewRecall: 0.8,
        minRejectedBandPrecision: 0.8,
      },
      summary: {
        totalLabels: 4,
        scoredLabels: 4,
        unscoredLabels: 0,
        acceptedLabels: 2,
        rejectedLabels: 2,
        evaluatedCandidates: 2,
        eligibleCandidates: 1,
      },
      recommended: {
        acceptThreshold: 0.9,
        reviewThreshold: 0.55,
        eligible: true,
        predictedAccepted: 1,
        predictedReview: 1,
        predictedRejected: 2,
        acceptedBandPrecision: 1,
        acceptedRecall: 0.5,
        acceptedOrReviewRecall: 1,
        rejectedBandPrecision: 1,
        rejectedRecall: 1,
        falseAcceptedRejectedLabels: 0,
        falseRejectedAcceptedLabels: 0,
      },
      candidates: [],
      reasons: [],
      warnings: [],
    };
    const adviseLocalRelationshipFeedbackThresholds = vi.fn(async () => advice);
    const formatKtxRelationshipThresholdAdviceMarkdown = vi.fn(
      () => 'KTX relationship threshold advice\nRecommended: accept=0.90 review=0.55\n',
    );

    const io = makeIo();
    await expect(
      runKtxScan(
        {
          command: 'relationshipThresholds',
          projectDir: tempDir,
          connectionId: null,
          minTotalLabels: 4,
          minAcceptedLabels: 2,
          minRejectedLabels: 2,
          json: false,
        },
        io.io,
        { adviseLocalRelationshipFeedbackThresholds, formatKtxRelationshipThresholdAdviceMarkdown },
      ),
    ).resolves.toBe(0);

    expect(adviseLocalRelationshipFeedbackThresholds).toHaveBeenCalledWith(
      expect.objectContaining({ projectDir: tempDir }),
      {
        connectionId: null,
        minTotalLabels: 4,
        minAcceptedLabels: 2,
        minRejectedLabels: 2,
      },
    );
    expect(formatKtxRelationshipThresholdAdviceMarkdown).toHaveBeenCalledWith(advice);
    expect(io.stdout()).toBe('KTX relationship threshold advice\nRecommended: accept=0.90 review=0.55\n');
  });

  it('prints relationship threshold advice as JSON', async () => {
    await initKtxProject({ projectDir: tempDir, projectName: 'warehouse' });
    const advice: KtxRelationshipThresholdAdviceReport = {
      generatedAt: '2026-05-07T14:00:00.000Z',
      filters: { connectionId: 'warehouse', decision: 'all' },
      status: 'insufficient_labels',
      gates: {
        minTotalLabels: 20,
        minAcceptedLabels: 5,
        minRejectedLabels: 5,
        minAcceptedBandPrecision: 0.9,
        minAcceptedOrReviewRecall: 0.8,
        minRejectedBandPrecision: 0.8,
      },
      summary: {
        totalLabels: 0,
        scoredLabels: 0,
        unscoredLabels: 0,
        acceptedLabels: 0,
        rejectedLabels: 0,
        evaluatedCandidates: 0,
        eligibleCandidates: 0,
      },
      recommended: null,
      candidates: [],
      reasons: ['Need at least 20 scored labels; found 0.'],
      warnings: [],
    };
    const adviseLocalRelationshipFeedbackThresholds = vi.fn(async () => advice);

    const io = makeIo();
    await expect(
      runKtxScan(
        {
          command: 'relationshipThresholds',
          projectDir: tempDir,
          connectionId: 'warehouse',
          minTotalLabels: 20,
          minAcceptedLabels: 5,
          minRejectedLabels: 5,
          json: true,
        },
        io.io,
        { adviseLocalRelationshipFeedbackThresholds },
      ),
    ).resolves.toBe(0);

    expect(JSON.parse(io.stdout())).toMatchObject({
      filters: { connectionId: 'warehouse', decision: 'all' },
      status: 'insufficient_labels',
      recommended: null,
    });
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
        '    readonly: true',
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
        { runLocalScan },
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
        '    readonly: true',
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
        { runLocalScan },
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
        '    readonly: true',
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
        { runLocalScan },
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
        '    readonly: true',
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
        { runLocalScan },
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
        '    readonly: true',
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
        { runLocalScan },
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
        '    readonly: true',
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
        { runLocalScan },
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
        '    readonly: true',
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
        { runLocalScan },
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
