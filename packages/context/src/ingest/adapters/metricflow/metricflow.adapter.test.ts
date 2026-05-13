import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeLocalGitRepo } from '../../../test/make-local-git-repo.js';
import type { SourceAdapter } from '../../types.js';
import { MetricflowSourceAdapter } from './metricflow.adapter.js';

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
});
