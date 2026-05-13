import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KtxEmbeddingConfig, KtxEmbeddingHealthCheckOptions, KtxEmbeddingHealthCheckResult } from '@ktx/llm';
import {
  formatDoctorReport,
  runKtxDoctor,
  runSetupDoctorChecks,
  type DoctorCheck,
} from './doctor.js';

function makeIo() {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: {
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

type EmbeddingHealthCheck = (
  config: KtxEmbeddingConfig,
  options?: KtxEmbeddingHealthCheckOptions,
) => Promise<KtxEmbeddingHealthCheckResult>;

async function writeProjectConfig(projectDir: string, embeddingLines: string[]): Promise<void> {
  await writeFile(
    join(projectDir, 'ktx.yaml'),
    [
      'project: warehouse',
      'connections:',
      '  warehouse:',
      '    driver: sqlite',
      '    path: ./warehouse.db',
      'ingest:',
      '  adapters:',
      '    - live-database',
      '  embeddings:',
      ...embeddingLines.map((line) => `    ${line}`),
      '',
    ].join('\n'),
    'utf-8',
  );
}

describe('formatDoctorReport', () => {
  it('shows the failing check and its fix in plain output', () => {
    const checks: DoctorCheck[] = [
      { id: 'node', label: 'Node 22+', status: 'pass', detail: 'v22.16.0 ABI 127', group: 'toolchain' },
      {
        id: 'native-sqlite',
        label: 'Native SQLite',
        status: 'fail',
        detail: 'Cannot load better-sqlite3',
        fix: 'Run: pnpm run native:rebuild',
        group: 'toolchain',
      },
    ];

    const output = formatDoctorReport({ title: 'KTX status', checks });
    expect(output).toContain('KTX status');
    expect(output).toContain('✗ Environment');
    expect(output).toContain('1 of 2 need attention');
    expect(output).toContain('✗ Native SQLite: Cannot load better-sqlite3');
    expect(output).toContain('→ Run: pnpm run native:rebuild');
    expect(output).toContain('1 issue to fix.');
  });

  it('lists what was checked when a group has all passing checks', () => {
    const checks: DoctorCheck[] = [
      { id: 'node', label: 'Node 22+', status: 'pass', detail: 'v22.16.0', group: 'toolchain' },
      { id: 'pnpm', label: 'pnpm 10.20+', status: 'pass', detail: '10.28.0', group: 'toolchain' },
    ];

    const output = formatDoctorReport({ title: 'KTX status', checks });
    expect(output).toContain('✓ Environment');
    expect(output).toContain('Node 22+ · pnpm 10.20+');
    expect(output).not.toContain('v22.16.0');
    expect(output).toContain('Everything ready.');
  });

  it('shows the underlying detail for a single-check group on the group line', () => {
    const checks: DoctorCheck[] = [
      {
        id: 'semantic-search-embeddings',
        label: 'Semantic search embeddings',
        status: 'pass',
        detail: 'openai/text-embedding-3-small (1536d) probe succeeded',
        group: 'search',
      },
    ];

    const output = formatDoctorReport({ title: 'KTX status', checks });
    expect(output).toContain('✓ Semantic search');
    expect(output).toContain('openai/text-embedding-3-small (1536d) probe succeeded');
  });

  it('lists every check in verbose mode', () => {
    const checks: DoctorCheck[] = [
      { id: 'node', label: 'Node 22+', status: 'pass', detail: 'v22.16.0', group: 'toolchain' },
    ];

    const output = formatDoctorReport({ title: 'KTX status', checks }, { verbose: true });
    expect(output).toContain('✓ Node 22+: v22.16.0');
  });
});

describe('runSetupDoctorChecks', () => {
  it('returns pass checks when injected commands and file checks succeed', async () => {
    const checks = await runSetupDoctorChecks({
      env: { PATH: '/bin' },
      workspaceRoot: '/workspace/ktx',
      execText: async (command, args) => {
        if (command === 'pnpm' && args[0] === '--version') return '10.28.0';
        if (command === 'corepack' && args[0] === '--version') return '0.32.0';
        if (command === 'uv' && args[0] === '--version') return 'uv 0.9.5';
        if (command === process.execPath && args.includes('--version')) return '@ktx/cli 0.0.0-private';
        throw new Error(`${command} ${args.join(' ')}`);
      },
      pathExists: async () => true,
      importBetterSqlite3: async () => ({ default: function Database() {} }),
    });

    expect(checks.map((check) => [check.id, check.status])).toEqual([
      ['node', 'pass'],
      ['pnpm', 'pass'],
      ['corepack', 'pass'],
      ['uv', 'pass'],
      ['native-sqlite', 'pass'],
      ['package-build', 'pass'],
      ['workspace-cli', 'pass'],
    ]);
  });

  it('returns exact fixes when setup checks fail', async () => {
    const checks = await runSetupDoctorChecks({
      env: {},
      workspaceRoot: '/workspace/ktx',
      execText: async (command) => {
        throw new Error(`${command} not found`);
      },
      pathExists: async () => false,
      importBetterSqlite3: async () => {
        throw new Error('Cannot find module better-sqlite3');
      },
    });

    expect(checks).toContainEqual({
      id: 'pnpm',
      label: 'pnpm 10.20+',
      status: 'fail',
      detail: 'pnpm not found',
      fix: 'Run: corepack enable && corepack prepare pnpm@10.28.0 --activate',
      group: 'toolchain',
    });
    expect(checks).toContainEqual({
      id: 'package-build',
      label: 'TypeScript package build',
      status: 'fail',
      detail: 'Missing packages/cli/dist/bin.js',
      fix: 'Run: pnpm run build',
      group: 'toolchain',
    });
  });

  it('treats missing corepack as a warning so setup doctor can still pass', async () => {
    const checks = await runSetupDoctorChecks({
      env: { PATH: '/bin' },
      workspaceRoot: '/workspace/ktx',
      execText: async (command, args) => {
        if (command === 'pnpm' && args[0] === '--version') return '10.28.0';
        if (command === 'corepack' && args[0] === '--version') throw new Error('spawn corepack ENOENT');
        if (command === 'uv' && args[0] === '--version') return 'uv 0.9.5';
        if (command === process.execPath && args.includes('--version')) return '@ktx/cli 0.0.0-private';
        throw new Error(`${command} ${args.join(' ')}`);
      },
      pathExists: async () => true,
      importBetterSqlite3: async () => ({ default: function Database() {} }),
    });
    const testIo = makeIo();

    await expect(
      runKtxDoctor(
        { command: 'setup', outputMode: 'plain', inputMode: 'disabled', verbose: true },
        testIo.io,
        { runSetupChecks: async () => checks },
      ),
    ).resolves.toBe(0);

    expect(checks).toContainEqual({
      id: 'corepack',
      label: 'Corepack',
      status: 'warn',
      detail: 'spawn corepack ENOENT',
      fix: 'Run: corepack enable',
      group: 'toolchain',
    });
    expect(testIo.stdout()).toContain('⚠ Corepack: spawn corepack ENOENT');
    expect(testIo.stderr()).toBe('');
  });
});

describe('runKtxDoctor', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-doctor-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('prints setup report and exits nonzero when a check fails', async () => {
    const testIo = makeIo();

    await expect(
      runKtxDoctor(
        { command: 'setup', outputMode: 'plain', inputMode: 'disabled' },
        testIo.io,
        {
          runSetupChecks: async () => [
            { id: 'node', label: 'Node 22+', status: 'pass', detail: 'v22.16.0 ABI 127' },
            {
              id: 'package-build',
              label: 'TypeScript package build',
              status: 'fail',
              detail: 'Missing packages/cli/dist/bin.js',
              fix: 'Run: pnpm run build',
            },
          ],
        },
      ),
    ).resolves.toBe(1);

    expect(testIo.stdout()).toContain('KTX status');
    expect(testIo.stdout()).toContain('No project here yet.');
    expect(testIo.stdout()).toContain('Before you can run');
    expect(testIo.stdout()).toContain('✗ TypeScript package build: Missing packages/cli/dist/bin.js');
    expect(testIo.stdout()).toContain('→ Run: pnpm run build');
    expect(testIo.stderr()).toBe('');
  });

  it('leads with `ktx setup` and hides toolchain warnings when no project exists', async () => {
    const testIo = makeIo();

    await expect(
      runKtxDoctor(
        { command: 'setup', outputMode: 'plain', inputMode: 'disabled' },
        testIo.io,
        {
          runSetupChecks: async () => [
            { id: 'node', label: 'Node 22+', status: 'pass', detail: 'v22.16.0', group: 'toolchain' },
            {
              id: 'corepack',
              label: 'Corepack',
              status: 'warn',
              detail: 'spawn corepack ENOENT',
              fix: 'Run: corepack enable',
              group: 'toolchain',
            },
          ],
        },
      ),
    ).resolves.toBe(0);

    const out = testIo.stdout();
    expect(out).toContain('No project here yet.');
    expect(out).toContain('Run');
    expect(out).toContain('ktx setup');
    expect(out).not.toContain('Corepack');
    expect(out).not.toContain('Node 22+');
  });

  it('prints JSON setup report', async () => {
    const testIo = makeIo();

    await expect(
      runKtxDoctor(
        { command: 'setup', outputMode: 'json', inputMode: 'disabled' },
        testIo.io,
        {
          runSetupChecks: async () => [
            { id: 'node', label: 'Node 22+', status: 'pass', detail: 'v22.16.0 ABI 127' },
          ],
        },
      ),
    ).resolves.toBe(0);

    expect(JSON.parse(testIo.stdout())).toEqual({
      title: 'KTX status',
      checks: [{ id: 'node', label: 'Node 22+', status: 'pass', detail: 'v22.16.0 ABI 127' }],
    });
  });

  it('runs project checks against a valid ktx.yaml', async () => {
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'project: warehouse',
        'connections:',
        '  warehouse:',
        '    driver: sqlite',
        '    path: ./warehouse.db',
        'ingest:',
        '  adapters:',
        '    - live-database',
        '',
      ].join('\n'),
      'utf-8',
    );
    const testIo = makeIo();

    await expect(
      runKtxDoctor(
        { command: 'project', projectDir: tempDir, outputMode: 'plain', inputMode: 'disabled' },
        testIo.io,
        {
          runSetupChecks: async () => [
            { id: 'node', label: 'Node 22+', status: 'pass', detail: 'v22.16.0 ABI 127' },
          ],
        },
      ),
    ).resolves.toBe(0);

    expect(testIo.stdout()).toContain('KTX status');
    expect(testIo.stdout()).toContain('· warehouse');
    expect(testIo.stdout()).toContain('✓ Project');
  });

  it('includes Postgres historic-SQL readiness in project doctor output', async () => {
    await writeFile(
      join(tempDir, 'ktx.yaml'),
      [
        'project: warehouse',
        'connections:',
        '  warehouse:',
        '    driver: postgres',
        '    url: env:WAREHOUSE_DATABASE_URL',
        '    historicSql:',
        '      enabled: true',
        '      dialect: postgres',
        'ingest:',
        '  adapters:',
        '    - live-database',
        '    - historic-sql',
        '',
      ].join('\n'),
      'utf-8',
    );
    const testIo = makeIo();
    const runHistoricSqlDoctorChecks = vi.fn(async () => [
      {
        id: 'historic-sql-postgres-warehouse',
        label: 'Postgres Historic SQL (warehouse)',
        status: 'pass' as const,
        detail:
          'pg_stat_statements ready (PostgreSQL 16.4); info: pg_stat_statements.max is 1000; set it to at least 5000 to reduce query-template eviction churn',
      },
    ]);

    await expect(
      runKtxDoctor(
        { command: 'project', projectDir: tempDir, outputMode: 'plain', inputMode: 'disabled', verbose: true },
        testIo.io,
        {
          runSetupChecks: async () => [
            { id: 'node', label: 'Node 22+', status: 'pass', detail: 'v22.16.0 ABI 127' },
          ],
          runHistoricSqlDoctorChecks,
        },
      ),
    ).resolves.toBe(0);

    expect(runHistoricSqlDoctorChecks).toHaveBeenCalledTimes(1);
    expect(testIo.stdout()).toContain('✓ Postgres Historic SQL (warehouse): pg_stat_statements ready');
    expect(testIo.stdout()).toContain('info: pg_stat_statements.max is 1000');
    expect(testIo.stdout()).not.toContain('→ Update the Postgres parameter group or config');
  });

  it('warns when semantic-search embeddings are not configured', async () => {
    await writeProjectConfig(tempDir, ['backend: deterministic', 'model: deterministic', 'dimensions: 8']);
    const testIo = makeIo();

    await expect(
      runKtxDoctor(
        { command: 'project', projectDir: tempDir, outputMode: 'plain', inputMode: 'disabled' },
        testIo.io,
        {
          runSetupChecks: async () => [
            { id: 'node', label: 'Node 22+', status: 'pass', detail: 'v22.16.0 ABI 127' },
          ],
        },
      ),
    ).resolves.toBe(0);

    expect(testIo.stdout()).toContain('⚠ Semantic search');
    expect(testIo.stdout()).toContain('ingest.embeddings.backend is deterministic.');
    expect(testIo.stdout()).toContain(
      'Semantic lane will be skipped; lexical, dictionary, and token lanes remain available.',
    );
    expect(testIo.stdout()).toContain(
      `→ Run: ktx setup --project-dir ${tempDir} --no-input`,
    );
  });

  it('probes configured semantic-search embeddings for project doctor', async () => {
    await writeProjectConfig(tempDir, [
      'backend: sentence-transformers',
      'model: all-MiniLM-L6-v2',
      'dimensions: 384',
      'sentenceTransformers:',
      '  base_url: http://127.0.0.1:8765',
      "  pathPrefix: ''",
    ]);
    const healthCheck = vi.fn<EmbeddingHealthCheck>(async () => ({ ok: true }));
    const testIo = makeIo();

    await expect(
      runKtxDoctor(
        { command: 'project', projectDir: tempDir, outputMode: 'plain', inputMode: 'disabled', verbose: true },
        testIo.io,
        {
          runSetupChecks: async () => [
            { id: 'node', label: 'Node 22+', status: 'pass', detail: 'v22.16.0 ABI 127' },
          ],
          embeddingHealthCheck: healthCheck,
          embeddingProbeTimeoutMs: 1234,
        },
      ),
    ).resolves.toBe(0);

    expect(healthCheck).toHaveBeenCalledWith(
      {
        backend: 'sentence-transformers',
        model: 'all-MiniLM-L6-v2',
        dimensions: 384,
        sentenceTransformers: { baseURL: 'http://127.0.0.1:8765', pathPrefix: '' },
      },
      { text: 'KTX semantic search doctor probe', timeoutMs: 1234 },
    );
    expect(testIo.stdout()).toContain(
      '✓ Semantic search embeddings: sentence-transformers/all-MiniLM-L6-v2 (384d) probe succeeded',
    );
  });

  it('allows local sentence-transformers semantic-search probes enough time for cold start', async () => {
    await writeProjectConfig(tempDir, [
      'backend: sentence-transformers',
      'model: all-MiniLM-L6-v2',
      'dimensions: 384',
      'sentenceTransformers:',
      '  base_url: http://127.0.0.1:8765',
      "  pathPrefix: ''",
    ]);
    const healthCheck = vi.fn<EmbeddingHealthCheck>(async () => ({ ok: true }));
    const testIo = makeIo();

    await expect(
      runKtxDoctor(
        { command: 'project', projectDir: tempDir, outputMode: 'plain', inputMode: 'disabled' },
        testIo.io,
        {
          runSetupChecks: async () => [
            { id: 'node', label: 'Node 22+', status: 'pass', detail: 'v22.16.0 ABI 127' },
          ],
          embeddingHealthCheck: healthCheck,
        },
      ),
    ).resolves.toBe(0);

    expect(healthCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        backend: 'sentence-transformers',
        model: 'all-MiniLM-L6-v2',
        dimensions: 384,
      }),
      { text: 'KTX semantic search doctor probe', timeoutMs: 120_000 },
    );
  });

  it('reports unhealthy semantic-search embeddings as a warning in JSON output', async () => {
    await writeProjectConfig(tempDir, [
      'backend: sentence-transformers',
      'model: all-MiniLM-L6-v2',
      'dimensions: 384',
      'sentenceTransformers:',
      '  base_url: http://127.0.0.1:8765',
      "  pathPrefix: ''",
    ]);
    const healthCheck = vi.fn<EmbeddingHealthCheck>(async () => ({
      ok: false,
      message: 'connect ECONNREFUSED 127.0.0.1:8765',
    }));
    const testIo = makeIo();

    await expect(
      runKtxDoctor(
        { command: 'project', projectDir: tempDir, outputMode: 'json', inputMode: 'disabled' },
        testIo.io,
        {
          runSetupChecks: async () => [
            { id: 'node', label: 'Node 22+', status: 'pass', detail: 'v22.16.0 ABI 127' },
          ],
          embeddingHealthCheck: healthCheck,
        },
      ),
    ).resolves.toBe(0);

    const report = JSON.parse(testIo.stdout()) as {
      checks: Array<{ id: string; label: string; status: string; detail: string; fix?: string }>;
    };
    expect(report.checks).toContainEqual({
      id: 'semantic-search-embeddings',
      label: 'Semantic search embeddings',
      status: 'warn',
      detail:
        'sentence-transformers/all-MiniLM-L6-v2 (384d) probe failed: connect ECONNREFUSED 127.0.0.1:8765. Semantic lane will be skipped; lexical, dictionary, and token lanes remain available.',
      fix: `Run: ktx setup --project-dir ${tempDir} --no-input`,
      group: 'search',
    });
  });
});
