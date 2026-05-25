import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeLocalGitRepo } from '../../../test/make-local-git-repo.js';
import type { SourceAdapter } from '../../../../../src/context/ingest/types.js';
import type { MetricFlowParseResult } from '../../../../../src/context/ingest/adapters/metricflow/deep-parse.js';
import { MetricflowSourceAdapter } from '../../../../../src/context/ingest/adapters/metricflow/metricflow.adapter.js';
import { readMetricflowProjectionConfig, writeMetricflowProjectionConfig } from '../../../../../src/context/ingest/adapters/metricflow/projection-config.js';

function compileOnlyRequiredDepsCheck(): void {
  // @ts-expect-error MetricflowSourceAdapter requires an explicit cache home.
  new MetricflowSourceAdapter();
}
void compileOnlyRequiredDepsCheck;

async function makeRepo(tmpRoot: string, files: Record<string, string>) {
  const fixtureDir = join(tmpRoot, 'fixture-src');
  for (const [path, content] of Object.entries(files)) {
    const dest = join(fixtureDir, path);
    await mkdir(join(dest, '..'), { recursive: true });
    await writeFile(dest, content, 'utf-8');
  }
  return makeLocalGitRepo(fixtureDir, join(tmpRoot, 'origin'));
}

function metricflowParseResult(): MetricFlowParseResult {
  return {
    semanticModels: [
      {
        name: 'orders',
        description: 'Orders',
        modelRef: 'orders',
        dimensions: [{ name: 'status', column: 'status', type: 'string', label: 'Status' }],
        measures: [{ type: 'simple', name: 'order_count', column: 'id', aggregation: 'count' }],
        entities: [{ name: 'customer', type: 'foreign', expr: 'customer_id' }],
        defaultTimeDimension: null,
      },
    ],
    crossModelMetrics: [],
    relationships: [],
    warnings: ['parser warning'],
  };
}

describe('MetricflowSourceAdapter', () => {
  let tmpRoot: string;
  let stagedDir: string;
  let adapter: SourceAdapter;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'mf-adapter-'));
    stagedDir = join(tmpRoot, 'stage');
    adapter = new MetricflowSourceAdapter({ homeDir: join(tmpRoot, 'cache-home') });
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('declares the expected source key and skill list', () => {
    expect(adapter.source).toBe('metricflow');
    expect(adapter.skillNames).toEqual(['metricflow_ingest']);
  });

  it('returns configured target warehouse connection ids', async () => {
    const metricflow = new MetricflowSourceAdapter({
      homeDir: join(tmpRoot, 'cache-home'),
      targetConnectionIds: ['warehouse', 'analytics', 'warehouse'],
    });

    await expect(metricflow.listTargetConnectionIds?.(stagedDir)).resolves.toEqual(['analytics', 'warehouse']);
  });

  it('detects a staged dir with a semantic_models YAML', async () => {
    await mkdir(join(stagedDir, 'models'), { recursive: true });
    await writeFile(
      join(stagedDir, 'models/orders.yml'),
      'semantic_models:\n  - {name: orders, model: x, measures: [{name: c, agg: count, expr: id}]}\n',
      'utf-8',
    );
    expect(await adapter.detect(stagedDir)).toBe(true);
  });

  it('rejects a staged dir with no MetricFlow-shaped YAML', async () => {
    await mkdir(stagedDir, { recursive: true });
    await writeFile(join(stagedDir, 'dbt_project.yml'), 'name: proj\n', 'utf-8');
    expect(await adapter.detect(stagedDir)).toBe(false);
  });

  it('chunk: first-run on a minimal single-model dir emits one WU', async () => {
    await mkdir(join(stagedDir, 'models'), { recursive: true });
    await writeFile(
      join(stagedDir, 'models/orders.yml'),
      'semantic_models:\n  - {name: orders, model: x, measures: [{name: c, agg: count, expr: id}]}\n',
      'utf-8',
    );
    const result = await adapter.chunk(stagedDir);
    expect(result.workUnits).toHaveLength(1);
    expect(result.workUnits[0].unitKey).toBe('metricflow-orders');
  });

  it('attaches deep parse artifacts to the chunk result', async () => {
    await mkdir(stagedDir, { recursive: true });
    await writeFile(
      join(stagedDir, 'semantic_models.yml'),
      [
        'semantic_models:',
        '  - name: orders',
        "    model: ref('orders')",
        '    dimensions: []',
        '    measures:',
        '      - name: order_count',
        '        agg: count',
        "        expr: '1'",
      ].join('\n'),
    );

    const chunk = await adapter.chunk(stagedDir);

    expect(chunk.parseArtifacts).toMatchObject({
      semanticModels: [{ name: 'orders', modelRef: 'orders' }],
      crossModelMetrics: [],
      relationships: [],
      warnings: [],
    });
  });

  it('fetches repo YAML files into the staged directory using a per-connection cache', async () => {
    const repo = await makeRepo(tmpRoot, {
      'dbt_project.yml': 'name: analytics\n',
      'models/orders.yml': 'semantic_models:\n  - name: orders\n    model: ref("orders")\n',
      'models/readme.md': '# ignored\n',
    });

    await adapter.fetch?.(
      {
        repoUrl: repo.repoUrl,
        branch: 'main',
        path: null,
        authToken: null,
        parsedTargetTables: {},
      },
      stagedDir,
      { connectionId: 'warehouse-1', sourceKey: 'metricflow' },
    );

    await expect(readFile(join(stagedDir, 'models/orders.yml'), 'utf-8')).resolves.toContain('semantic_models');
    expect(await adapter.detect(stagedDir)).toBe(true);
  });

  it('persists parsed target tables for deterministic projection during fetch', async () => {
    const repo = await makeRepo(tmpRoot, {
      'dbt_project.yml': 'name: analytics\n',
      'models/orders.yml': 'semantic_models:\n  - name: orders\n    model: ref("orders")\n',
    });

    await adapter.fetch?.(
      {
        repoUrl: repo.repoUrl,
        branch: 'main',
        path: null,
        authToken: null,
        parsedTargetTables: {
          orders: {
            ok: true,
            catalog: null,
            schema: 'analytics',
            name: 'orders',
            canonicalTable: 'analytics.orders',
          },
        },
      },
      stagedDir,
      { connectionId: 'warehouse-1', sourceKey: 'metricflow' },
    );

    await expect(readMetricflowProjectionConfig(stagedDir)).resolves.toMatchObject({
      parsedTargetTables: {
        orders: {
          ok: true,
          schema: 'analytics',
          name: 'orders',
        },
      },
    });
  });

  it('projects parsed MetricFlow semantic models in the integration worktree', async () => {
    await writeMetricflowProjectionConfig(stagedDir, {
      parsedTargetTables: {
        orders: {
          ok: true,
          catalog: null,
          schema: 'analytics',
          name: 'orders',
          canonicalTable: 'analytics.orders',
        },
      },
    });
    const scoped = {
      getManifestEntry: vi.fn().mockResolvedValue(null),
      isManifestBacked: vi.fn().mockResolvedValue(false),
      loadAllSources: vi.fn().mockResolvedValue({ sources: [], loadErrors: [] }),
      loadSource: vi.fn().mockResolvedValue(null),
      writeSource: vi.fn().mockResolvedValue({ warnings: [] }),
    };
    const semanticLayerService = {
      forWorktree: vi.fn().mockReturnValue(scoped),
      getManifestEntry: vi.fn(),
      isManifestBacked: vi.fn(),
      loadAllSources: vi.fn(),
      loadSource: vi.fn(),
      writeSource: vi.fn(),
    };

    const result = await adapter.project?.({
      connectionId: 'warehouse-1',
      sourceKey: 'metricflow',
      syncId: 'sync-1',
      jobId: 'job-1',
      runId: 'run-1',
      stagedDir,
      workdir: '/tmp/metricflow-integration',
      parseArtifacts: metricflowParseResult(),
      semanticLayerService: semanticLayerService as never,
    });

    expect(semanticLayerService.forWorktree).toHaveBeenCalledWith('/tmp/metricflow-integration');
    expect(scoped.writeSource).toHaveBeenCalledWith(
      'warehouse-1',
      expect.objectContaining({ name: 'orders' }),
      'dbt MetricFlow',
      expect.any(String),
      'dbt MetricFlow sync: create source orders',
      { skipValidation: true },
    );
    expect(result).toMatchObject({
      warnings: ['parser warning'],
      errors: [],
      touchedSources: [{ connectionId: 'warehouse-1', sourceName: 'orders' }],
      changedWikiPageKeys: [],
    });
  });

  it('returns a projection error when parse artifacts are missing', async () => {
    const result = await adapter.project?.({
      connectionId: 'warehouse-1',
      sourceKey: 'metricflow',
      syncId: 'sync-1',
      jobId: 'job-1',
      runId: 'run-1',
      stagedDir,
      workdir: '/tmp/metricflow-integration',
      parseArtifacts: undefined,
      semanticLayerService: {} as never,
    });

    expect(result).toMatchObject({
      warnings: [],
      errors: ['MetricFlow deterministic projection requires parseArtifacts from chunk()'],
      touchedSources: [],
      changedWikiPageKeys: [],
    });
  });
});
