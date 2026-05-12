import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { parseKtxProjectConfig } from '@ktx/context/project';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
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

function getRunId(stdout: string): string {
  const match = stdout.match(/^Run: (.+)$/m);
  if (!match) {
    throw new Error(`Could not find run id in output:\n${stdout}`);
  }
  return match[1];
}

function structuredContent<T extends object>(result: unknown): T {
  const content = (result as { structuredContent?: unknown }).structuredContent;
  expect(content).toBeDefined();
  return content as T;
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
      'dev',
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
      'ktx dev ingest run requires llm.provider.backend: anthropic, vertex, or gateway, or an injected agentRunner',
    );
  });

  it('runs the default pre-seeded demo without credentials', async () => {
    const projectDir = join(tempDir, 'demo-project');
    const result = await runBuiltCli(
      ['setup', 'demo', '--project-dir', projectDir, '--plain', '--no-input'],
      {
        env: { ...process.env, ANTHROPIC_API_KEY: '' },
      },
    );

    expectProjectStderr(result, projectDir);
    expect(result.stdout).toContain('Mode: seeded');
    expect(result.stdout).toContain('Source: packaged demo project');
    expect(result.stdout).toContain('LLM calls: none');
    expect(result.stdout).toContain('Warehouse:');
    expect(result.stdout).toContain('dbt:');
    expect(result.stdout).toContain('BI:');
    expect(result.stdout).toContain('Notion:');
    expect(result.stdout).toContain('Semantic-layer sources:');
    expect(result.stdout).toContain('Knowledge pages:');
    expect(result.stdout).not.toContain('ktx serve --mcp stdio');
    expect(result.stdout).not.toContain(['--mode', 'deterministic'].join(' '));
  });

  it('runs hybrid agent search against the seeded demo through the built binary', async () => {
    const projectDir = join(tempDir, 'seeded-hybrid-search-project');

    const seeded = await runBuiltCli(['setup', 'demo', '--project-dir', projectDir, '--plain', '--no-input'], {
      env: { ...process.env, ANTHROPIC_API_KEY: '' },
    });
    expectProjectStderr(seeded, projectDir);
    expect(seeded.stdout).toContain('Mode: seeded');

    const wikiSearch = await runBuiltCli([
      'agent',
      'wiki',
      'search',
      'ARR contract',
      '--json',
      '--limit',
      '5',
      '--project-dir',
      projectDir,
    ]);
    expect(wikiSearch).toMatchObject({ code: 0, stderr: '' });
    const wikiJson = parseJsonOutput<{
      results: Array<{ key: string; score: number; matchReasons?: string[] }>;
      totalFound: number;
    }>(wikiSearch.stdout);
    expect(wikiJson.totalFound).toBeGreaterThan(0);
    expect(wikiJson.results.some((result) => result.matchReasons?.length)).toBe(true);

    const slSearch = await runBuiltCli([
      'agent',
      'sl',
      'list',
      '--json',
      '--query',
      'ARR',
      '--project-dir',
      projectDir,
    ]);
    expect(slSearch).toMatchObject({ code: 0, stderr: '' });
    const slJson = parseJsonOutput<{
      sources: Array<{ connectionId: string; name: string; score?: number; matchReasons?: string[] }>;
      totalSources: number;
    }>(slSearch.stdout);
    expect(slJson.totalSources).toBeGreaterThan(0);
    expect(slJson.sources.some((source) => source.matchReasons?.length)).toBe(true);
  });

  it('prints guided JSON for agent semantic-layer search outside a project through the built binary', async () => {
    const projectDir = join(tempDir, 'missing-search-project');
    await mkdir(projectDir, { recursive: true });

    const result = await runBuiltCli([
      'agent',
      'sl',
      'list',
      '--json',
      '--query',
      'revenue',
      '--project-dir',
      projectDir,
    ]);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    const errorJson = parseJsonOutput<{
      ok: false;
      error: { code: string; message: string; nextSteps: string[] };
    }>(result.stderr);
    expect(errorJson).toEqual({
      ok: false,
      error: {
        code: 'agent_sl_search_missing_project',
        message: `Semantic-layer search needs an initialized KTX project at ${projectDir}.`,
        nextSteps: [
          'ktx demo',
          `ktx setup --project-dir ${projectDir}`,
          'ktx ingest <connection>',
          `ktx agent sl list --json --query "revenue" --project-dir ${projectDir}`,
        ],
      },
    });
  });

  it('runs the pre-seeded demo and inspect without credentials', async () => {
    const projectDir = join(tempDir, 'seeded-demo-project');

    const seeded = await runBuiltCli(['setup', 'demo', '--mode', 'seeded', '--project-dir', projectDir, '--no-input']);
    expect(seeded.code).toBe(0);
    expect(seeded.stdout).toContain('Mode: seeded');
    expect(seeded.stdout).toContain('LLM calls: none');
    expect(seeded.stdout).toContain('Semantic-layer sources:');
    expect(seeded.stdout).toContain('Knowledge pages:');

    const inspect = await runBuiltCli(['setup', 'demo', 'inspect', '--project-dir', projectDir, '--no-input']);
    expectProjectStderr(inspect, projectDir);
    expect(inspect.stdout).toContain('Mode: seeded');
    expect(inspect.stdout).toContain('Status: ready');
    expect(inspect.stdout).toContain('Warehouse: 8 tables, 11,234 rows');
    expect(inspect.stdout).toContain('Rows: accounts 210, arr_movements 720');
    expect(inspect.stdout).toContain('dbt: 3 models, 8 source tables');
    expect(inspect.stdout).toContain('BI: 5 explores, 2 dashboards');
    expect(inspect.stdout).toContain('Notion: 8 pages');
    expect(inspect.stdout).toContain('Semantic-layer sources:');
    expect(inspect.stdout).toContain('Knowledge pages:');
    expect(inspect.stdout).toContain('Evidence links:');
    expect(inspect.stdout).toContain('Report: reports/seeded-demo-report.json');
    expect(inspect.stdout).toContain('Replay: replays/replay.memory-flow.v1.json');
    expect(inspect.stdout).toContain('Latest replay: seeded (packaged, prebuilt)');
    expect(inspect.stdout).toContain('ktx agent tools --json');
    expect(inspect.stdout).toContain('ktx agent context --json');
    expect(inspect.stdout).not.toContain('ktx ask "your question here"');
    expect(inspect.stdout).not.toContain('ktx serve --mcp stdio');
  });

  it('serves seeded demo wiki and semantic-layer context over stdio MCP', async () => {
    const projectDir = join(tempDir, 'seeded-mcp-project');

    const seeded = await runBuiltCli(
      ['setup', 'demo', '--mode', 'seeded', '--project-dir', projectDir, '--plain', '--no-input'],
      {
        env: { ...process.env, ANTHROPIC_API_KEY: '' },
      },
    );
    expectProjectStderr(seeded, projectDir);
    expect(seeded.stdout).toContain('Mode: seeded');

    const client = new Client({ name: 'ktx-seeded-demo-smoke-client', version: '0.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI_BIN, 'serve', '--mcp', 'stdio', '--project-dir', projectDir, '--user-id', 'smoke-user'],
      stderr: 'pipe',
    });

    try {
      await client.connect(transport);
      const toolNames = (await client.listTools()).tools.map((tool) => tool.name).sort();
      expect(toolNames).toEqual(
        expect.arrayContaining(['knowledge_read', 'knowledge_search', 'sl_read_source', 'sl_validate']),
      );

      const knowledgeSearch = structuredContent<{
        results: Array<{ key: string; summary: string; score: number }>;
        totalFound: number;
      }>(await client.callTool({ name: 'knowledge_search', arguments: { query: 'ARR contract-first definition', limit: 10 } }));
      expect(knowledgeSearch.totalFound).toBeGreaterThan(0);
      expect(knowledgeSearch.results.map((result) => result.key)).toContain('orbit-arr-contract-first-definition');

      const knowledgeRead = structuredContent<{
        key: string;
        summary: string;
        content: string;
        tags: string[];
        slRefs: string[];
      }>(await client.callTool({ name: 'knowledge_read', arguments: { key: 'orbit-arr-contract-first-definition' } }));
      expect(knowledgeRead.key).toBe('orbit-arr-contract-first-definition');
      expect(knowledgeRead.summary).toContain('ARR');
      expect(knowledgeRead.content).toContain('contract');
      expect(knowledgeRead.slRefs).toContain('mart_arr_daily');

      const slRead = structuredContent<{ sourceName: string; yaml: string }>(
        await client.callTool({
          name: 'sl_read_source',
          arguments: { connectionId: 'dbt-main', sourceName: 'mart_arr_daily' },
        }),
      );
      expect(slRead.sourceName).toBe('mart_arr_daily');
      expect(slRead.yaml).toContain('name: mart_arr_daily');
      expect(slRead.yaml).toContain('measures:');

      const slValidate = structuredContent<{ success: boolean; errors: string[]; warnings: string[] }>(
        await client.callTool({
          name: 'sl_validate',
          arguments: { connectionId: 'dbt-main', names: ['mart_arr_daily', 'stg_contracts'] },
        }),
      );
      expect(slValidate.success).toBe(true);
      expect(slValidate.errors).toEqual([]);
    } finally {
      await client.close();
    }
  });

  it('runs doctor setup through the built binary', async () => {
    const result = await runBuiltCli(['dev', 'doctor', 'setup', '--no-input']);

    expect(result.stdout).toContain('KTX setup doctor');
    expect(result.stdout).toContain('Node 22+');
    expect(result.stdout).toContain('Workspace-local CLI');
    expect(result.stderr).toBe(`Project: ${process.cwd()}\n`);
    expect([0, 1]).toContain(result.code);
  });

  it('reports missing Anthropic credentials for full demo through the built binary', async () => {
    const projectDir = join(tempDir, 'full-demo-missing-key');

    const result = await runBuiltCli(['setup', 'demo', '--mode', 'full', '--project-dir', projectDir, '--no-input'], {
      env: { ...process.env, ANTHROPIC_API_KEY: '' },
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('ktx setup demo --mode full needs ANTHROPIC_API_KEY');
    expect(result.stderr).toContain('ktx setup demo --mode seeded --no-input');
  });

  it('requires force for demo reset through the built binary', async () => {
    const projectDir = join(tempDir, 'reset-demo-project');

    const init = await runBuiltCli(['setup', 'demo', 'init', '--project-dir', projectDir, '--no-input']);
    expectProjectStderr(init, projectDir);

    const withoutForce = await runBuiltCli(['setup', 'demo', 'reset', '--project-dir', projectDir, '--no-input']);
    expect(withoutForce.code).toBe(1);
    expect(withoutForce.stderr).toContain(
      `ktx setup demo reset is destructive; pass --force to recreate ${projectDir}`,
    );

    const withForce = await runBuiltCli([
      'setup',
      'demo',
      'reset',
      '--project-dir',
      projectDir,
      '--force',
      '--no-input',
    ]);
    expectProjectStderr(withForce, projectDir);
    expect(withForce.stdout).toContain(`Demo project reset: ${projectDir}`);
  });

  it('reports corrupted demo state with reset guidance through the built binary', async () => {
    const projectDir = join(tempDir, 'corrupt-demo-project');

    const init = await runBuiltCli(['setup', 'demo', 'init', '--project-dir', projectDir, '--no-input']);
    expectProjectStderr(init, projectDir);
    await rm(join(projectDir, 'demo.db'), { force: true });

    const replay = await runBuiltCli(['setup', 'demo', '--mode', 'replay', '--project-dir', projectDir, '--no-input']);
    expect(replay.code).toBe(1);
    expect(replay.stderr).toContain(`Demo project is not ready at ${projectDir}: missing demo.db`);
    expect(replay.stderr).toContain(`ktx setup demo reset --project-dir ${projectDir} --force --no-input`);
  });

  it('runs demo doctor through the built binary', async () => {
    const projectDir = join(tempDir, 'doctor-demo-project');

    const init = await runBuiltCli(['setup', 'demo', 'init', '--project-dir', projectDir, '--no-input']);
    expectProjectStderr(init, projectDir);

    const result = await runBuiltCli(['setup', 'demo', 'doctor', '--project-dir', projectDir, '--no-input']);
    expect(result.stdout).toContain('KTX demo doctor');
    expect(result.stdout).toContain('Demo dataset');
    expect(result.stdout).toContain('Demo replay');
    expect(result.stdout).toContain('Demo LLM provider');
    expect(result.stderr).toBe(`Project: ${projectDir}\n`);
    expect([0, 1]).toContain(result.code);
  });

  it('runs demo ingest seeded mode through the built binary', async () => {
    const projectDir = join(tempDir, 'seeded-ingest-alias');

    const result = await runBuiltCli([
      'setup',
      'demo',
      'ingest',
      '--mode',
      'seeded',
      '--project-dir',
      projectDir,
      '--no-input',
    ]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Mode: seeded');
    expect(result.stdout).toContain('LLM calls: none');
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

    const structural = await runBuiltCli(['dev', 'scan', 'warehouse', '--project-dir', projectDir]);
    expectProjectStderr(structural, projectDir);
    expect(structural.stdout).toContain('Status: done');
    expect(structural.stdout).toContain('Mode: structural');
    const structuralRunId = getRunId(structural.stdout);

    const structuralReportResult = await runBuiltCli([
      'dev',
      'scan',
      'report',
      '--json',
      '--project-dir',
      projectDir,
      structuralRunId,
    ]);
    expect(structuralReportResult).toMatchObject({ code: 0, stderr: '' });
    const structuralReport = parseJsonOutput<{
      mode: string;
      artifactPaths: { manifestShards: string[]; enrichmentArtifacts: string[] };
      manifestShardsWritten: number;
    }>(structuralReportResult.stdout);
    expect(structuralReport.mode).toBe('structural');
    expect(structuralReport.artifactPaths.manifestShards).toEqual(['semantic-layer/warehouse/_schema/public.yaml']);
    expect(structuralReport.artifactPaths.enrichmentArtifacts).toEqual([]);
    expect(structuralReport.manifestShardsWritten).toBe(1);

    const structuralManifest = await readFile(
      join(projectDir, 'semantic-layer/warehouse/_schema/public.yaml'),
      'utf-8',
    );
    expect(structuralManifest).toContain('customers:');
    expect(structuralManifest).toContain('orders:');
    expect(structuralManifest).toContain('source: formal');
    expect(structuralManifest).not.toContain('ai:');

    const providerlessEnriched = await runBuiltCli([
      'dev',
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
    const providerlessRunId = getRunId(providerlessEnriched.stdout);

    const providerlessReportResult = await runBuiltCli([
      'dev',
      'scan',
      'report',
      '--json',
      '--project-dir',
      projectDir,
      providerlessRunId,
    ]);
    expect(providerlessReportResult).toMatchObject({ code: 0, stderr: '' });
    const providerlessReport = parseJsonOutput<{
      mode: string;
      enrichment: {
        tableDescriptions: string;
        columnDescriptions: string;
        embeddings: string;
        deterministicRelationships: string;
        statisticalValidation: string;
      };
      relationships: { accepted: number; review: number; rejected: number; skipped: number };
      warnings: Array<{ code: string }>;
      artifactPaths: { enrichmentArtifacts: string[]; manifestShards: string[] };
    }>(providerlessReportResult.stdout);
    expect(providerlessReport.mode).toBe('enriched');
    expect(providerlessReport.enrichment).toMatchObject({
      tableDescriptions: 'skipped',
      columnDescriptions: 'skipped',
      embeddings: 'skipped',
      deterministicRelationships: 'completed',
      statisticalValidation: 'completed',
    });
    expect(providerlessReport.relationships).toEqual({ accepted: 1, review: 0, rejected: 0, skipped: 0 });
    expect(providerlessReport.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'scan_enrichment_backend_not_configured' })]),
    );
    expect(providerlessReport.artifactPaths.enrichmentArtifacts).toEqual(
      expect.arrayContaining([
        expect.stringContaining('/enrichment/relationships.json'),
        expect.stringContaining('/enrichment/relationship-profile.json'),
        expect.stringContaining('/enrichment/relationship-diagnostics.json'),
      ]),
    );
    expect(providerlessReport.artifactPaths.manifestShards).toEqual(['semantic-layer/warehouse/_schema/public.yaml']);

    await writeSqliteScanConfig(projectDir, dbPath, true);
    const enriched = await runBuiltCli(['dev', 'scan', 'warehouse', '--project-dir', projectDir, '--mode', 'enriched']);
    expectProjectStderr(enriched, projectDir);
    expect(enriched.stdout).toContain('Mode: enriched');
    const enrichedRunId = getRunId(enriched.stdout);

    const enrichedReportResult = await runBuiltCli([
      'dev',
      'scan',
      'report',
      '--json',
      '--project-dir',
      projectDir,
      enrichedRunId,
    ]);
    expect(enrichedReportResult).toMatchObject({ code: 0, stderr: '' });
    const enrichedReport = parseJsonOutput<{
      mode: string;
      enrichment: { tableDescriptions: string; columnDescriptions: string; embeddings: string };
      artifactPaths: { enrichmentArtifacts: string[]; manifestShards: string[] };
    }>(enrichedReportResult.stdout);
    expect(enrichedReport.mode).toBe('enriched');
    expect(enrichedReport.enrichment).toMatchObject({
      tableDescriptions: 'completed',
      columnDescriptions: 'completed',
      embeddings: 'completed',
    });
    expect(enrichedReport.artifactPaths.enrichmentArtifacts).toEqual(
      expect.arrayContaining([
        expect.stringContaining('/enrichment/descriptions.json'),
        expect.stringContaining('/enrichment/embeddings.json'),
        expect.stringContaining('/enrichment/relationships.json'),
        expect.stringContaining('/enrichment/relationship-profile.json'),
        expect.stringContaining('/enrichment/relationship-diagnostics.json'),
      ]),
    );
    expect(enrichedReport.artifactPaths.manifestShards).toEqual(['semantic-layer/warehouse/_schema/public.yaml']);

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

  it('serves local ingest MCP tools over stdio from the built binary', async () => {
    const projectDir = join(tempDir, 'project');

    const init = await runSetupNewProject(projectDir);
    expectProjectStderr(init, projectDir);
    await writeWarehouseConfig(projectDir);

    const client = new Client({ name: 'ktx-smoke-client', version: '0.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI_BIN, 'serve', '--mcp', 'stdio', '--project-dir', projectDir, '--user-id', 'smoke-user'],
      stderr: 'pipe',
    });

    try {
      await client.connect(transport);
      const tools = await client.listTools();
      const toolNames = tools.tools.map((tool) => tool.name).sort();
      expect(toolNames).toEqual(
        expect.arrayContaining([
          'connection_list',
          'connection_test',
          'ingest_report',
          'ingest_replay',
          'ingest_status',
          'ingest_trigger',
          'knowledge_read',
          'knowledge_search',
          'knowledge_write',
          'scan_list_artifacts',
          'scan_read_artifact',
          'scan_report',
          'scan_status',
          'scan_trigger',
          'sl_list_sources',
          'sl_read_source',
          'sl_validate',
          'sl_write_source',
        ]),
      );

      const connections = structuredContent<{
        connections: Array<{ id: string; name: string; connectionType: string }>;
      }>(await client.callTool({ name: 'connection_list', arguments: {} }));
      expect(connections).toEqual({
        connections: [{ id: 'warehouse', name: 'warehouse', connectionType: 'POSTGRESQL' }],
      });

      await expect(client.callTool({ name: 'ingest_status', arguments: { runId: 'missing-run' } })).resolves.toEqual({
        content: [{ type: 'text', text: 'Ingest run "missing-run" was not found.' }],
        isError: true,
      });

      await expect(client.callTool({ name: 'ingest_report', arguments: { runId: 'missing-run' } })).resolves.toEqual({
        content: [{ type: 'text', text: 'Ingest report "missing-run" was not found.' }],
        isError: true,
      });

      await expect(client.callTool({ name: 'ingest_replay', arguments: { runId: 'missing-run' } })).resolves.toEqual({
        content: [{ type: 'text', text: 'Ingest replay "missing-run" was not found.' }],
        isError: true,
      });
    } finally {
      await client.close();
    }
  });

  it('serves scan execution and artifact inspection tools over stdio from the built binary', async () => {
    const projectDir = join(tempDir, 'scan-mcp-project');
    const init = await runSetupNewProject(projectDir);
    expectProjectStderr(init, projectDir);

    const dbPath = join(projectDir, 'warehouse.db');
    createSqliteWarehouse(dbPath);
    await writeSqliteScanConfig(projectDir, dbPath);

    const client = new Client({ name: 'ktx-scan-smoke-client', version: '0.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI_BIN, 'serve', '--mcp', 'stdio', '--project-dir', projectDir, '--user-id', 'smoke-user'],
      stderr: 'pipe',
    });

    try {
      await client.connect(transport);

      const connectionTest = structuredContent<{
        id: string;
        connectionType: string;
        ok: boolean;
        tableCount: number | null;
      }>(await client.callTool({ name: 'connection_test', arguments: { connectionId: 'warehouse' } }));
      expect(connectionTest).toMatchObject({
        id: 'warehouse',
        connectionType: 'SQLITE',
        ok: true,
        tableCount: 2,
      });

      const trigger = structuredContent<{
        runId: string;
        status: 'done';
        done: true;
        connectionId: string;
        mode: string;
        dryRun: boolean;
        report: {
          artifactPaths: { manifestShards: string[] };
          manifestShardsWritten: number;
        };
      }>(
        await client.callTool({
          name: 'scan_trigger',
          arguments: {
            connectionId: 'warehouse',
            mode: 'structural',
            detectRelationships: false,
            dryRun: false,
          },
        }),
      );
      expect(trigger).toMatchObject({
        status: 'done',
        done: true,
        connectionId: 'warehouse',
        mode: 'structural',
        dryRun: false,
      });
      expect(trigger.report.artifactPaths.manifestShards).toEqual(['semantic-layer/warehouse/_schema/public.yaml']);
      expect(trigger.report.manifestShardsWritten).toBe(1);

      const status = structuredContent<{
        runId: string;
        status: string;
        done: boolean;
        reportPath: string | null;
      }>(await client.callTool({ name: 'scan_status', arguments: { runId: trigger.runId } }));
      expect(status).toMatchObject({
        runId: trigger.runId,
        status: 'done',
        done: true,
      });
      expect(status.reportPath).toContain('scan-report.json');

      const artifacts = structuredContent<{
        runId: string;
        artifacts: Array<{ path: string; type: string }>;
      }>(await client.callTool({ name: 'scan_list_artifacts', arguments: { runId: trigger.runId } }));
      expect(artifacts.artifacts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: 'semantic-layer/warehouse/_schema/public.yaml', type: 'manifest_shard' }),
          expect.objectContaining({ type: 'report' }),
          expect.objectContaining({ type: 'raw_source' }),
        ]),
      );

      const manifestArtifact = structuredContent<{
        runId: string;
        path: string;
        type: string;
        content: string;
      }>(
        await client.callTool({
          name: 'scan_read_artifact',
          arguments: {
            runId: trigger.runId,
            path: 'semantic-layer/warehouse/_schema/public.yaml',
          },
        }),
      );
      expect(manifestArtifact).toMatchObject({
        runId: trigger.runId,
        path: 'semantic-layer/warehouse/_schema/public.yaml',
        type: 'manifest_shard',
      });
      expect(manifestArtifact.content).toContain('orders:');
      expect(manifestArtifact.content).toContain('source: formal');
    } finally {
      await client.close();
    }
  });
});
