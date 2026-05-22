import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { tableRefSet, type KtxTableRefKey } from '../../../scan/table-ref.js';
import { LiveDatabaseSourceAdapter } from './live-database.adapter.js';

describe('LiveDatabaseSourceAdapter', () => {
  it('fetches a schema snapshot through the introspection port', async () => {
    const extractSchema = vi.fn().mockResolvedValue({
      connectionId: 'conn-1',
      driver: 'postgres',
      extractedAt: '2026-04-27T00:00:00.000Z',
      scope: { schemas: ['public'] },
      metadata: {},
      tables: [
        {
          name: 'orders',
          catalog: null,
          db: 'public',
          kind: 'table',
          comment: null,
          estimatedRows: null,
          columns: [
            {
              name: 'id',
              nativeType: 'integer',
              normalizedType: 'integer',
              dimensionType: 'number',
              nullable: false,
              primaryKey: true,
              comment: null,
            },
          ],
          foreignKeys: [],
        },
      ],
    });
    const adapter = new LiveDatabaseSourceAdapter({
      introspection: { extractSchema },
      now: () => new Date('2026-04-27T00:00:00.000Z'),
    });
    const dir = await mkdtemp(join(tmpdir(), 'ktx-live-db-adapter-'));

    await adapter.fetch(undefined, dir, { connectionId: 'conn-1', sourceKey: 'live-database' });

    expect(extractSchema).toHaveBeenCalledWith('conn-1', { tableScope: undefined });
    await expect(adapter.detect(dir)).resolves.toBe(true);
    const chunked = await adapter.chunk(dir);
    expect(chunked.workUnits.map((wu) => wu.unitKey)).toEqual(['live-database-public-orders']);
  });

  it('declares the live database source and skill', () => {
    const adapter = new LiveDatabaseSourceAdapter({
      introspection: { extractSchema: vi.fn() },
    });
    expect(adapter.source).toBe('live-database');
    expect(adapter.skillNames).toEqual(['live_database_ingest']);
  });

  it('threads tableScope into the introspection port and applies a defensive final filter', async () => {
    const extractSchema = vi.fn(
      async (_connectionId: string, _options?: { tableScope?: ReadonlySet<KtxTableRefKey> }) => ({
        connectionId: 'warehouse',
        driver: 'snowflake' as const,
        extractedAt: '2026-05-22T00:00:00.000Z',
        scope: {},
        metadata: {},
        tables: [
          {
            catalog: 'A',
            db: 'MARTS',
            name: 'IN_SCOPE',
            kind: 'table' as const,
            comment: null,
            estimatedRows: 0,
            columns: [],
            foreignKeys: [],
          },
          {
            catalog: 'A',
            db: 'MARTS',
            name: 'OUT_OF_SCOPE',
            kind: 'table' as const,
            comment: null,
            estimatedRows: 0,
            columns: [],
            foreignKeys: [],
          },
        ],
      }),
    );
    const scope = tableRefSet([{ catalog: 'A', db: 'MARTS', name: 'IN_SCOPE' }]);
    const adapter = new LiveDatabaseSourceAdapter({
      introspection: { extractSchema },
      resolveTableScope: (connectionId) => (connectionId === 'warehouse' ? scope : undefined),
    });
    const stagedDir = await mkdtemp(join(tmpdir(), 'ktx-livedb-scope-'));
    try {
      await adapter.fetch(undefined, stagedDir, {
        connectionId: 'warehouse',
        sourceKey: 'live-database',
      } as never);
      expect(extractSchema).toHaveBeenCalledWith('warehouse', { tableScope: scope });
      const tables = await readdir(join(stagedDir, 'tables'));
      expect(tables).toHaveLength(1);
      const table = JSON.parse(await readFile(join(stagedDir, 'tables', tables[0]!), 'utf8')) as { name?: string };
      expect(table.name).toBe('IN_SCOPE');
    } finally {
      await rm(stagedDir, { recursive: true, force: true });
    }
  });
});
