import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { parseKtxProjectConfig } from '@ktx/context/project';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const CLI_BIN = resolve(process.cwd(), 'dist/bin.js');

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface ExecFailure extends Error {
  code?: number;
  stdout?: string;
  stderr?: string;
}

function isExecFailure(error: unknown): error is ExecFailure {
  return error instanceof Error && ('stdout' in error || 'stderr' in error || 'code' in error);
}

async function runBuiltCli(args: string[], options: { env?: NodeJS.ProcessEnv } = {}): Promise<CliResult> {
  try {
    const result = await execFileAsync(process.execPath, [CLI_BIN, ...args], {
      encoding: 'utf8',
      timeout: 20_000,
      ...(options.env ? { env: options.env } : {}),
    });
    return {
      code: 0,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error) {
    if (!isExecFailure(error)) {
      throw error;
    }
    return {
      code: typeof error.code === 'number' ? error.code : 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? error.message,
    };
  }
}

async function writeWarehouseConfig(projectDir: string): Promise<void> {
  await writeFile(
    join(projectDir, 'ktx.yaml'),
    [
      'project: warehouse',
      'connections:',
      '  warehouse:',
      '    driver: postgres',
      'ingest:',
      '  adapters:',
      '    - fake',
      '',
    ].join('\n'),
    'utf-8',
  );
}

async function writeSourceFixture(sourceDir: string): Promise<void> {
  await mkdir(join(sourceDir, 'orders'), { recursive: true });
  await writeFile(join(sourceDir, 'orders', 'orders.json'), '{"name":"orders"}\n', 'utf-8');
}

function createSqliteWarehouse(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE customers (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL
      );
      CREATE TABLE orders (
        id INTEGER PRIMARY KEY,
        customer_id INTEGER NOT NULL,
        total NUMERIC,
        created_at TEXT,
        FOREIGN KEY(customer_id) REFERENCES customers(id)
      );
      INSERT INTO customers (id, name) VALUES (1, 'Ada'), (2, 'Grace');
      INSERT INTO orders (id, customer_id, total, created_at)
        VALUES (10, 1, 42.5, '2026-04-28'), (11, 2, 9.5, '2026-04-29');
    `);
  } finally {
    db.close();
  }
}

async function writeSqliteScanConfig(projectDir: string, dbPath: string, enrich = false): Promise<void> {
  await writeFile(
    join(projectDir, 'ktx.yaml'),
    [
      'project: warehouse',
      'connections:',
      '  warehouse:',
      '    driver: sqlite',
      `    path: ${JSON.stringify(dbPath)}`,
      '    readonly: true',
      'ingest:',
      '  adapters:',
      '    - live-database',
      ...(enrich
        ? [
            'scan:',
            '  enrichment:',
            '    mode: deterministic',
            '    embeddings:',
            '      backend: deterministic',
            '      dimensions: 6',
          ]
        : []),
      '',
    ].join('\n'),
    'utf-8',
  );
}

function parseJsonOutput<T>(stdout: string): T {
  return JSON.parse(stdout) as T;
}

function expectProjectStderr(result: CliResult, projectDir: string): void {
  expect(result).toMatchObject({ code: 0, stderr: `Project: ${projectDir}\n` });
}

async function runSetupNewProject(projectDir: string): Promise<CliResult> {
  return await runBuiltCli([
    'setup',
    '--project-dir',
    projectDir,
    '--new',
    '--no-input',
    '--yes',
    '--skip-llm',
    '--skip-embeddings',
    '--skip-databases',
    '--skip-sources',
    '--skip-agents',
  ]);
}

describe('standalone built ktx CLI smoke', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-standalone-smoke-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('reports missing local ingest LLM config through the built binary', async () => {
    const projectDir = join(tempDir, 'project');
    const sourceDir = join(tempDir, 'source');

    const init = await runSetupNewProject(projectDir);
    expectProjectStderr(init, projectDir);
    expect(init.stdout).toContain(`Project: ${projectDir}`);

    await writeWarehouseConfig(projectDir);
    await writeSourceFixture(sourceDir);

    const run = await runBuiltCli([
      'ingest',
      'run',
      '--project-dir',
      projectDir,
      '--connection-id',
      'warehouse',
      '--adapter',
      'fake',
      '--source-dir',
      sourceDir,
    ]);
    expect(run).toMatchObject({ code: 1, stdout: '' });
    expect(run.stderr).toContain(
      'ktx ingest run requires llm.provider.backend: anthropic, vertex, or gateway, or an injected agentRunner',
    );
  });

  it('rejects the removed agent command through the built binary', async () => {
    const result = await runBuiltCli(['agent']);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain("unknown command 'agent'");
  });

  it('runs doctor setup through the built binary', async () => {
    const result = await runBuiltCli(['status', '--no-input']);

    expect(result.stdout).toMatch(/KTX (setup|project) doctor/);
    expect(result.stdout).toContain('Node 22+');
    expect(result.stdout).toContain('Workspace-local CLI');
    expect(result.stderr === '' || result.stderr.startsWith('Project: ')).toBe(true);
    expect([0, 1]).toContain(result.code);
  });

  it('runs structural and enriched scans through the built binary with manifest artifacts', async () => {
    const projectDir = join(tempDir, 'scan-project');
    const init = await runSetupNewProject(projectDir);
    expectProjectStderr(init, projectDir);

    const dbPath = join(projectDir, 'warehouse.db');
    createSqliteWarehouse(dbPath);
    await writeSqliteScanConfig(projectDir, dbPath);

    const connectionTest = await runBuiltCli(['connection', 'test', 'warehouse', '--project-dir', projectDir]);
    expectProjectStderr(connectionTest, projectDir);
    expect(connectionTest.stdout).toContain('Connection test passed: warehouse');
    expect(connectionTest.stdout).toContain('Driver: sqlite');
    expect(connectionTest.stdout).toContain('Tables: 2');

    const structural = await runBuiltCli(['scan', 'warehouse', '--project-dir', projectDir]);
    expectProjectStderr(structural, projectDir);
    expect(structural.stdout).toContain('Status: done');
    expect(structural.stdout).toContain('Mode: structural');
    expect(structural.stdout).toContain('Schema shards: 1');

    const structuralManifest = await readFile(
      join(projectDir, 'semantic-layer/warehouse/_schema/public.yaml'),
      'utf-8',
    );
    expect(structuralManifest).toContain('customers:');
    expect(structuralManifest).toContain('orders:');
    expect(structuralManifest).toContain('source: formal');
    expect(structuralManifest).not.toContain('ai:');

    const providerlessEnriched = await runBuiltCli([
      'scan',
      'warehouse',
      '--project-dir',
      projectDir,
      '--mode',
      'enriched',
    ]);
    expectProjectStderr(providerlessEnriched, projectDir);
    expect(providerlessEnriched.stdout).toContain('Mode: enriched');
    expect(providerlessEnriched.stdout).toContain('Relationships');
    expect(providerlessEnriched.stdout).toContain('Accepted: 1');
    expect(providerlessEnriched.stdout).toContain('scan_enrichment_backend_not_configured');
    expect(providerlessEnriched.stdout).toContain('Enrichment artifacts: 3');
    await writeSqliteScanConfig(projectDir, dbPath, true);
    const enriched = await runBuiltCli(['scan', 'warehouse', '--project-dir', projectDir, '--mode', 'enriched']);
    expectProjectStderr(enriched, projectDir);
    expect(enriched.stdout).toContain('Mode: enriched');
    expect(enriched.stdout).toContain('Enrichment artifacts:');

    const enrichedManifest = await readFile(join(projectDir, 'semantic-layer/warehouse/_schema/public.yaml'), 'utf-8');
    expect(enrichedManifest).toContain('Deterministic description');
  }, 30_000);

  it('parses gateway LLM config and OpenAI enrichment embeddings used by standalone scans without network calls', async () => {
    const projectDir = join(tempDir, 'gateway-config-project');
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, 'ktx.yaml'),
      [
        'project: gateway-smoke',
        'llm:',
        '  provider:',
        '    backend: gateway',
        '    gateway:',
        '      api_key: env:AI_GATEWAY_API_KEY', // pragma: allowlist secret
        '  models:',
        '    default: env:KTX_SCAN_LLM_MODEL',
        'scan:',
        '  enrichment:',
        '    mode: llm',
        '    embeddings:',
        '      backend: openai',
        '      model: env:KTX_SCAN_EMBEDDING_MODEL',
        '      dimensions: 1536',
        '      openai:',
        '        api_key: env:OPENAI_API_KEY', // pragma: allowlist secret
        '      batchSize: 16',
        '',
      ].join('\n'),
      'utf8',
    );

    const config = parseKtxProjectConfig(await readFile(join(projectDir, 'ktx.yaml'), 'utf8'));
    expect(config.llm).toEqual({
      provider: {
        backend: 'gateway',
        gateway: { api_key: 'env:AI_GATEWAY_API_KEY' }, // pragma: allowlist secret
      },
      models: { default: 'env:KTX_SCAN_LLM_MODEL' },
    });
    expect(config.scan.enrichment).toEqual({
      mode: 'llm',
      embeddings: {
        backend: 'openai',
        model: 'env:KTX_SCAN_EMBEDDING_MODEL',
        dimensions: 1536,
        openai: { api_key: 'env:OPENAI_API_KEY' }, // pragma: allowlist secret
        batchSize: 16,
      },
    });
  });

  it('adds a redacted Notion connection through the built binary', async () => {
    const projectDir = join(tempDir, 'notion-project');
    const init = await runSetupNewProject(projectDir);
    expectProjectStderr(init, projectDir);

    const add = await runBuiltCli([
      'connection',
      'add',
      'notion',
      'notion-main',
      '--project-dir',
      projectDir,
      '--token-env',
      'NOTION_TOKEN',
      '--crawl-mode',
      'all_accessible',
      '--max-pages',
      '5',
    ]);

    expectProjectStderr(add, projectDir);
    expect(add.stdout).toContain('Connection: notion-main');
    expect(add.stdout).toContain('Driver: notion');

    const yaml = await readFile(join(projectDir, 'ktx.yaml'), 'utf-8');
    expect(yaml).toContain('driver: notion');
    expect(yaml).toContain('auth_token_ref: env:NOTION_TOKEN');
    expect(yaml).toContain('crawl_mode: all_accessible');
    expect(yaml).toContain('max_pages_per_run: 5');
    expect(yaml).not.toContain('ntn_');

    const parsed = parseKtxProjectConfig(yaml);
    expect(parsed.connections['notion-main']).toMatchObject({
      driver: 'notion',
      auth_token_ref: 'env:NOTION_TOKEN',
      crawl_mode: 'all_accessible',
    });
  });

});
