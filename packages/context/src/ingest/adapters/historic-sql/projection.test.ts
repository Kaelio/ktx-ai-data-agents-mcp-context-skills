import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import { describe, expect, it } from 'vitest';
import { projectHistoricSqlEvidence } from './projection.js';

async function tempWorkdir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'historic-sql-projection-'));
}

async function writeText(root: string, relPath: string, content: string): Promise<void> {
  const target = join(root, relPath);
  await mkdir(join(target, '..'), { recursive: true });
  await writeFile(target, content, 'utf-8');
}

async function writeJson(root: string, relPath: string, value: unknown): Promise<void> {
  await writeText(root, relPath, `${JSON.stringify(value, null, 2)}\n`);
}

describe('projectHistoricSqlEvidence', () => {
  it('merges table usage into matching _schema shards and preserves external usage keys', async () => {
    const workdir = await tempWorkdir();
    await writeText(
      workdir,
      'semantic-layer/warehouse/_schema/public.yaml',
      YAML.stringify({
        tables: {
          orders: {
            table: 'public.orders',
            usage: {
              narrative: 'Old generated usage.',
              frequencyTier: 'low',
              commonFilters: ['old_status'],
              commonJoins: [],
              ownerNote: 'keep me',
            },
            columns: [{ name: 'id', type: 'string' }],
          },
        },
      }),
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
        narrative: 'Orders are repeatedly queried for lifecycle analysis.',
        frequencyTier: 'high',
        commonFilters: ['status', 'created_at'],
        commonGroupBys: ['status'],
        commonJoins: [{ table: 'public.customers', on: ['customer_id'] }],
        staleSince: null,
      },
    });

    const result = await projectHistoricSqlEvidence({ workdir, connectionId: 'warehouse', syncId: 'sync-1', runId: 'run-1' });

    expect(result.touchedSources).toEqual([{ connectionId: 'warehouse', sourceName: 'orders' }]);
    expect(result.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: 'sl',
          key: 'orders',
          rawPaths: ['tables/public.orders.json'],
        }),
      ]),
    );
    const shard = YAML.parse(await readFile(join(workdir, 'semantic-layer/warehouse/_schema/public.yaml'), 'utf-8'));
    expect(shard.tables.orders.usage).toEqual({
      ownerNote: 'keep me',
      narrative: 'Orders are repeatedly queried for lifecycle analysis.',
      frequencyTier: 'high',
      commonFilters: ['status', 'created_at'],
      commonGroupBys: ['status'],
      commonJoins: [{ table: 'public.customers', on: ['customer_id'] }],
      staleSince: null,
    });
  });

  it('writes pattern pages, reuses similar slugs, and marks missing old pattern pages stale', async () => {
    const workdir = await tempWorkdir();
    await writeJson(workdir, 'raw-sources/warehouse/historic-sql/sync-1/manifest.json', {
      source: 'historic-sql',
      connectionId: 'warehouse',
      dialect: 'postgres',
      fetchedAt: '2026-05-11T00:00:00.000Z',
      windowStart: '2026-02-10T00:00:00.000Z',
      windowEnd: '2026-05-11T00:00:00.000Z',
      snapshotRowCount: 2,
      touchedTableCount: 2,
      parseFailures: 0,
      warnings: [],
      probeWarnings: [],
      staleArchiveAfterDays: 90,
    });
    await writeJson(workdir, 'raw-sources/warehouse/historic-sql/sync-1/tables/public.orders.json', { table: 'public.orders' });
    await writeJson(workdir, 'raw-sources/warehouse/historic-sql/sync-1/tables/public.customers.json', { table: 'public.customers' });
    await writeText(
      workdir,
      'wiki/global/historic-sql-old-order-lifecycle.md',
      [
        '---',
        YAML.stringify({
          summary: 'Old order lifecycle page',
          tags: ['historic-sql', 'pattern'],
          refs: [],
          sl_refs: ['orders'],
          usage_mode: 'auto',
          source: 'historic-sql',
          tables: ['public.orders', 'public.customers'],
          fingerprints: ['pg:1'],
        }).trimEnd(),
        '---',
        '',
        'Old body',
        '',
      ].join('\n'),
    );
    await writeText(
      workdir,
      'wiki/global/historic-sql-retired-pattern.md',
      [
        '---',
        YAML.stringify({
          summary: 'Retired pattern',
          tags: ['historic-sql', 'pattern'],
          refs: [],
          sl_refs: [],
          usage_mode: 'auto',
          source: 'historic-sql',
          tables: ['public.tickets'],
          fingerprints: ['pg:9'],
        }).trimEnd(),
        '---',
        '',
        'Retired body',
        '',
      ].join('\n'),
    );
    await writeJson(workdir, '.ktx/ingest-evidence/historic-sql/run-1/pattern.json', {
      kind: 'pattern',
      connectionId: 'warehouse',
      rawPath: 'patterns-input.json',
      pattern: {
        slug: 'order-lifecycle-analysis',
        title: 'Order Lifecycle Analysis',
        narrative: 'Analysts compare order status with customer segment.',
        definitionSql: 'select * from public.orders join public.customers on customers.id = orders.customer_id',
        tablesInvolved: ['public.orders', 'public.customers'],
        slRefs: ['orders', 'customers'],
        constituentTemplateIds: ['pg:1', 'pg:2'],
      },
    });

    const result = await projectHistoricSqlEvidence({ workdir, connectionId: 'warehouse', syncId: 'sync-1', runId: 'run-1' });

    expect(result.patternPagesWritten).toBe(1);
    expect(result.changedWikiPageKeys).toContain('historic-sql-old-order-lifecycle');
    expect(result.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: 'wiki',
          key: 'historic-sql-old-order-lifecycle',
          rawPaths: ['patterns-input.json'],
        }),
      ]),
    );
    await expect(readFile(join(workdir, 'wiki/global/historic-sql-old-order-lifecycle.md'), 'utf-8')).resolves.toContain(
      'Order Lifecycle Analysis',
    );
    await expect(readFile(join(workdir, 'wiki/global/historic-sql-retired-pattern.md'), 'utf-8')).resolves.toContain(
      'stale_since: "2026-05-11T00:00:00.000Z"',
    );
  });

  it('rewrites a reappearing archived pattern at the flat slug', async () => {
    const workdir = await tempWorkdir();
    await writeJson(workdir, 'raw-sources/warehouse/historic-sql/sync-1/manifest.json', {
      source: 'historic-sql',
      connectionId: 'warehouse',
      dialect: 'postgres',
      fetchedAt: '2026-05-11T00:00:00.000Z',
      windowStart: '2026-02-10T00:00:00.000Z',
      windowEnd: '2026-05-11T00:00:00.000Z',
      snapshotRowCount: 2,
      touchedTableCount: 2,
      parseFailures: 0,
      warnings: [],
      probeWarnings: [],
      staleArchiveAfterDays: 30,
    });
    await writeJson(workdir, 'raw-sources/warehouse/historic-sql/sync-1/tables/public.orders.json', { table: 'public.orders' });
    await writeJson(workdir, 'raw-sources/warehouse/historic-sql/sync-1/tables/public.customers.json', { table: 'public.customers' });
    await writeText(
      workdir,
      'wiki/global/historic-sql-order-lifecycle-analysis.md',
      [
        '---',
        YAML.stringify({
          summary: 'Archived order lifecycle page',
          tags: ['historic-sql', 'pattern', 'archived'],
          refs: [],
          sl_refs: ['orders'],
          usage_mode: 'auto',
          source: 'historic-sql',
          tables: ['public.orders', 'public.customers'],
          fingerprints: ['pg:1'],
          stale_since: '2026-01-01T00:00:00.000Z',
        }).trimEnd(),
        '---',
        '',
        'Archived body',
        '',
      ].join('\n'),
    );
    await writeJson(workdir, '.ktx/ingest-evidence/historic-sql/run-1/pattern.json', {
      kind: 'pattern',
      connectionId: 'warehouse',
      rawPath: 'patterns-input.json',
      pattern: {
        slug: 'order-lifecycle-analysis',
        title: 'Order Lifecycle Analysis',
        narrative: 'Analysts compare order status with customer segment again.',
        definitionSql: 'select * from public.orders join public.customers on customers.id = orders.customer_id',
        tablesInvolved: ['public.orders', 'public.customers'],
        slRefs: ['orders', 'customers'],
        constituentTemplateIds: ['pg:1', 'pg:2'],
      },
    });

    const result = await projectHistoricSqlEvidence({ workdir, connectionId: 'warehouse', syncId: 'sync-1', runId: 'run-1' });

    expect(result.patternPagesWritten).toBe(1);
    const page = await readFile(join(workdir, 'wiki/global/historic-sql-order-lifecycle-analysis.md'), 'utf-8');
    expect(page).toContain('Analysts compare order status with customer segment again.');
    expect(page).not.toContain('Archived body');
    expect(page).not.toContain('archived');
  });

  it('leaves already archived pattern pages stable when they are still absent', async () => {
    const workdir = await tempWorkdir();
    await writeJson(workdir, 'raw-sources/warehouse/historic-sql/sync-1/manifest.json', {
      source: 'historic-sql',
      connectionId: 'warehouse',
      dialect: 'postgres',
      fetchedAt: '2026-05-11T00:00:00.000Z',
      windowStart: '2026-02-10T00:00:00.000Z',
      windowEnd: '2026-05-11T00:00:00.000Z',
      snapshotRowCount: 0,
      touchedTableCount: 0,
      parseFailures: 0,
      warnings: [],
      probeWarnings: [],
      staleArchiveAfterDays: 30,
    });
    await writeText(
      workdir,
      'wiki/global/historic-sql-retired-pattern.md',
      [
        '---',
        YAML.stringify({
          summary: 'Retired pattern',
          tags: ['historic-sql', 'pattern', 'archived'],
          refs: [],
          sl_refs: [],
          usage_mode: 'auto',
          source: 'historic-sql',
          tables: ['public.tickets'],
          fingerprints: ['pg:9'],
          stale_since: '2026-01-01T00:00:00.000Z',
        }).trimEnd(),
        '---',
        '',
        'Archived retired body',
        '',
      ].join('\n'),
    );

    const result = await projectHistoricSqlEvidence({ workdir, connectionId: 'warehouse', syncId: 'sync-1', runId: 'run-1' });

    expect(result.archivedPatternPages).toBe(0);
    expect(result.stalePatternPagesMarked).toBe(0);
    await expect(readFile(join(workdir, 'wiki/global/historic-sql-retired-pattern.md'), 'utf-8')).resolves.toContain(
      'Archived retired body',
    );
  });

  it('marks missing table usage stale without deleting old query pages', async () => {
    const workdir = await tempWorkdir();
    await writeText(
      workdir,
      'semantic-layer/warehouse/_schema/public.yaml',
      YAML.stringify({
        tables: {
          orders: {
            table: 'public.orders',
            usage: {
              narrative: 'Orders were active before.',
              frequencyTier: 'high',
              commonFilters: ['status'],
              commonGroupBys: ['status'],
              commonJoins: [{ table: 'public.customers', on: ['customer_id'] }],
              ownerNote: 'keep analyst annotation',
            },
            columns: [{ name: 'id', type: 'string' }],
          },
        },
      }),
    );
    await writeJson(workdir, 'raw-sources/warehouse/historic-sql/sync-1/manifest.json', {
      source: 'historic-sql',
      connectionId: 'warehouse',
      dialect: 'postgres',
      fetchedAt: '2026-05-11T00:00:00.000Z',
      windowStart: '2026-02-10T00:00:00.000Z',
      windowEnd: '2026-05-11T00:00:00.000Z',
      snapshotRowCount: 0,
      touchedTableCount: 0,
      parseFailures: 0,
      warnings: [],
      probeWarnings: [],
      staleArchiveAfterDays: 90,
    });
    await writeJson(workdir, '.ktx/ingest-evidence/historic-sql/run-1/customers.json', {
      kind: 'table_usage',
      connectionId: 'warehouse',
      table: 'public.customers',
      rawPath: 'tables/public.customers.json',
      usage: {
        narrative: 'Customers were queried.',
        frequencyTier: 'low',
        commonFilters: [],
        commonJoins: [],
        staleSince: null,
      },
    });
    await writeText(
      workdir,
      'wiki/global/historic-sql-old-template.md',
      [
        '---',
        YAML.stringify({
          summary: 'Old template page',
          tags: ['historic-sql', 'query-pattern'],
          refs: [],
          sl_refs: ['orders'],
          usage_mode: 'auto',
          source: 'historic-sql',
          tables: ['public.orders'],
          fingerprints: ['old:1'],
        }).trimEnd(),
        '---',
        '',
        'Old body',
        '',
      ].join('\n'),
    );

    const result = await projectHistoricSqlEvidence({ workdir, connectionId: 'warehouse', syncId: 'sync-1', runId: 'run-1' });

    expect(result.staleTablesMarked).toBe(1);
    expect(result.touchedSources).toEqual([{ connectionId: 'warehouse', sourceName: 'orders' }]);
    const staleAction = result.actions.find((action) => action.target === 'sl' && action.key === 'orders');
    expect(staleAction).toEqual(expect.objectContaining({ target: 'sl', key: 'orders' }));
    expect(staleAction?.rawPaths).toBeUndefined();
    const shard = YAML.parse(await readFile(join(workdir, 'semantic-layer/warehouse/_schema/public.yaml'), 'utf-8'));
    expect(shard.tables.orders.usage).toEqual({
      ownerNote: 'keep analyst annotation',
      narrative: 'No recent historic SQL usage was observed in the latest snapshot.',
      frequencyTier: 'unused',
      commonFilters: [],
      commonGroupBys: [],
      commonJoins: [],
      staleSince: '2026-05-11T00:00:00.000Z',
    });
    await expect(readFile(join(workdir, 'wiki/global/historic-sql-old-template.md'), 'utf-8')).resolves.toContain(
      'Old body',
    );
  });

  it('does not mark stale or archive pages when override replay has no current-run evidence', async () => {
    const workdir = await tempWorkdir();
    await writeText(
      workdir,
      'semantic-layer/warehouse/_schema/public.yaml',
      YAML.stringify({
        tables: {
          orders: {
            table: 'public.orders',
            usage: {
              narrative: 'Orders were active before.',
              frequencyTier: 'high',
              commonFilters: ['status'],
              commonGroupBys: ['status'],
              commonJoins: [],
            },
            columns: [{ name: 'id', type: 'string' }],
          },
        },
      }),
    );
    await writeJson(workdir, 'raw-sources/warehouse/historic-sql/override-sync/manifest.json', {
      source: 'historic-sql',
      connectionId: 'warehouse',
      dialect: 'postgres',
      fetchedAt: '2026-05-11T00:00:00.000Z',
      windowStart: '2026-02-10T00:00:00.000Z',
      windowEnd: '2026-05-11T00:00:00.000Z',
      snapshotRowCount: 0,
      touchedTableCount: 0,
      parseFailures: 0,
      warnings: [],
      probeWarnings: [],
      staleArchiveAfterDays: 90,
    });

    const result = await projectHistoricSqlEvidence({
      workdir,
      connectionId: 'warehouse',
      syncId: 'override-sync',
      runId: 'override-run',
      overrideReplay: {
        priorJobId: 'prior-job',
        priorRunId: 'prior-run',
        priorSyncId: 'prior-sync',
        evictionRawPaths: ['tables/public/orders.json'],
      },
    });

    expect(result.tableUsageMerged).toBe(0);
    expect(result.staleTablesMarked).toBe(0);
    expect(result.patternPagesWritten).toBe(0);
    expect(result.stalePatternPagesMarked).toBe(0);
    expect(result.archivedPatternPages).toBe(0);
    expect(result.touchedSources).toEqual([]);
    expect(result.changedWikiPageKeys).toEqual([]);
    expect(result.actions).toEqual([]);
  });
});
