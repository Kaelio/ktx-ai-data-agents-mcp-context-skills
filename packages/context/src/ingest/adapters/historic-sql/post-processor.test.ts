import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import { describe, expect, it } from 'vitest';
import { HistoricSqlProjectionPostProcessor } from './post-processor.js';

async function tempWorkdir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'historic-sql-post-processor-'));
}

async function writeJson(root: string, relPath: string, value: unknown): Promise<void> {
  const target = join(root, relPath);
  await mkdir(join(target, '..'), { recursive: true });
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

describe('HistoricSqlProjectionPostProcessor', () => {
  it('projects current run evidence before the ingest squash commit', async () => {
    const workdir = await tempWorkdir();
    await mkdir(join(workdir, 'semantic-layer/warehouse/_schema'), { recursive: true });
    await writeFile(
      join(workdir, 'semantic-layer/warehouse/_schema/public.yaml'),
      YAML.stringify({ tables: { orders: { table: 'public.orders', columns: [{ name: 'id', type: 'string' }] } } }),
      'utf-8',
    );
    await writeJson(workdir, 'raw-sources/warehouse/historic-sql/sync-1/manifest.json', {
      source: 'historic-sql',
      connectionId: 'warehouse',
      dialect: 'postgres',
      fetchedAt: '2026-05-11T00:00:00.000Z',
      windowStart: '2026-02-10T00:00:00.000Z',
      windowEnd: '2026-05-11T00:00:00.000Z',
      snapshotRowCount: 1,
      touchedTableCount: 1,
      parseFailures: 0,
      warnings: [],
      probeWarnings: [],
      staleArchiveAfterDays: 90,
    });
    await writeJson(workdir, 'raw-sources/warehouse/historic-sql/sync-1/tables/public.orders.json', { table: 'public.orders' });
    await writeJson(workdir, '.ktx/ingest-evidence/historic-sql/run-1/orders.json', {
      kind: 'table_usage',
      connectionId: 'warehouse',
      table: 'public.orders',
      rawPath: 'tables/public.orders.json',
      usage: {
        narrative: 'Orders are repeatedly queried by lifecycle status.',
        frequencyTier: 'high',
        commonFilters: ['status'],
        commonJoins: [],
        staleSince: null,
      },
    });

    const result = await new HistoricSqlProjectionPostProcessor().run({
      connectionId: 'warehouse',
      sourceKey: 'historic-sql',
      syncId: 'sync-1',
      jobId: 'job-1',
      runId: 'run-1',
      workdir,
      parseArtifacts: null,
    });

    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.touchedSources).toEqual([{ connectionId: 'warehouse', sourceName: 'orders' }]);
    expect(result.result).toMatchObject({ tableUsageMerged: 1 });
    await expect(readFile(join(workdir, 'semantic-layer/warehouse/_schema/public.yaml'), 'utf-8')).resolves.toContain(
      'Orders are repeatedly queried by lifecycle status.',
    );
  });
});
