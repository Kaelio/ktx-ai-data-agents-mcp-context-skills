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

async function runBuiltCli(args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<CliResult> {
  try {
    const result = await execFileAsync(process.execPath, [CLI_BIN, ...args], {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      encoding: 'utf8',
      timeout: 20_000,
      env: options.env ?? process.env,
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
      'connections:',
      '  warehouse:',
      '    driver: sqlite',
      `    path: ${JSON.stringify(dbPath)}`,
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

function expectProjectStderr(result: CliResult, projectDir: string): void {
  expect(result).toMatchObject({ code: 0, stderr: `Project: ${projectDir}\n` });
}

function expectSetupStderr(result: CliResult): void {
  expect(result).toMatchObject({ code: 0, stderr: '' });
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

  it('rejects old low-level ingest flags through the built binary', async () => {
    const projectDir = join(tempDir, 'project');

    const init = await runSetupNewProject(projectDir);
    expectSetupStderr(init);
    expect(init.stdout).toContain(`Project: ${projectDir}`);

    const run = await runBuiltCli([
      'ingest',
      'run',
      '--connection-id',
      'warehouse',
      '--adapter',
      'fake',
    ]);
    expect(run).toMatchObject({ code: 1, stdout: '' });
    expect(run.stderr).toContain("unknown option '--connection-id'");
  });

  it('rejects the removed agent command through the built binary', async () => {
    const result = await runBuiltCli(['agent']);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain("unknown command 'agent'");
  });

  it('runs status setup checks through the built binary', async () => {
    const result = await runBuiltCli(['status', '--verbose', '--no-input']);

    expect(result.stdout).toMatch(/KTX status/);
    if (result.stdout.includes('No project here yet.')) {
      expect(result.stdout).toContain('ktx setup');
    } else {
      expect(result.stdout).toContain('Node 22+');
      expect(result.stdout).toContain('Workspace-local CLI');
    }
    expect(result.stdout).toContain('Node 22+');
    expect(result.stdout).toContain('Workspace-local CLI');
    expect(result.stderr === '' || result.stderr.startsWith('Project: ')).toBe(true);
    expect([0, 1]).toContain(result.code);
  });

  it('runs fast public database ingest through the built binary with manifest artifacts', async () => {
    const projectDir = join(tempDir, 'database-ingest-project');
    const init = await runSetupNewProject(projectDir);
    expectSetupStderr(init);

    const dbPath = join(projectDir, 'warehouse.db');
    createSqliteWarehouse(dbPath);
    await writeSqliteScanConfig(projectDir, dbPath);

    const connectionTest = await runBuiltCli(['connection', 'test', 'warehouse', '--project-dir', projectDir]);
    expectProjectStderr(connectionTest, projectDir);
    expect(connectionTest.stdout).toContain('Connection test passed: warehouse');
    expect(connectionTest.stdout).toContain('Driver: sqlite');
    expect(connectionTest.stdout).toContain('Status: ok');

    const ingest = await runBuiltCli(['ingest', 'warehouse', '--project-dir', projectDir, '--fast', '--no-input']);
    expectProjectStderr(ingest, projectDir);
    expect(ingest.stdout).toContain('Ingest finished');
    expect(ingest.stdout).toContain('warehouse');
    expect(ingest.stdout).toContain('Database schema');
    expect(ingest.stdout).toContain('warehouse      done');
    expect(ingest.stdout).not.toContain('KTX scan completed');

    const manifest = await readFile(join(projectDir, 'semantic-layer/warehouse/_schema/public.yaml'), 'utf-8');
    expect(manifest).toContain('customers:');
    expect(manifest).toContain('orders:');
    expect(manifest).toContain('source: formal');
    expect(manifest).not.toContain('ai:');
  }, 30_000);

  it('parses gateway LLM config and OpenAI enrichment embeddings used by standalone scans without network calls', async () => {
    const projectDir = join(tempDir, 'gateway-config-project');
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, 'ktx.yaml'),
      [
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

  it('rejects the removed connection add command through the built binary', async () => {
    const projectDir = join(tempDir, 'notion-project');
    const init = await runSetupNewProject(projectDir);
    expectSetupStderr(init);

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

    expect(add.code).toBe(1);
    expect(add.stdout).toBe('');
    expect(add.stderr).toContain("unknown command 'add'");

    const yaml = await readFile(join(projectDir, 'ktx.yaml'), 'utf-8');
    expect(yaml).not.toContain('driver: notion');
    expect(yaml).not.toContain('auth_token_ref: env:NOTION_TOKEN');
    expect(yaml).not.toContain('ntn_');

    const parsed = parseKtxProjectConfig(yaml);
    expect(parsed.connections['notion-main']).toBeUndefined();
  });

});
