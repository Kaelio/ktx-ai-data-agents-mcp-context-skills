import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
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

    expect(extractSchema).toHaveBeenCalledWith('conn-1');
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
});
