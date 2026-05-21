import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listLookerTargetConnectionIds } from './target-connections.js';

describe('listLookerTargetConnectionIds', () => {
  let stagedDir: string;

  beforeEach(async () => {
    stagedDir = await mkdtemp(join(tmpdir(), 'looker-targets-'));
  });

  afterEach(async () => {
    await rm(stagedDir, { recursive: true, force: true });
  });

  it('collects unique target warehouse IDs from explores, dashboard queries, and Look queries', async () => {
    await mkdir(join(stagedDir, 'explores', 'b2b'), { recursive: true });
    await mkdir(join(stagedDir, 'dashboards'), { recursive: true });
    await mkdir(join(stagedDir, 'looks'), { recursive: true });

    await writeFile(
      join(stagedDir, 'explores', 'b2b', 'sales_pipeline.json'),
      JSON.stringify({
        modelName: 'b2b',
        exploreName: 'sales_pipeline',
        label: null,
        description: null,
        fields: { dimensions: [], measures: [] },
        joins: [],
        targetWarehouseConnectionId: '22222222-2222-4222-8222-222222222222',
      }),
    );
    await writeFile(
      join(stagedDir, 'dashboards', '1.json'),
      JSON.stringify({
        lookerId: '1',
        title: 'Pipeline',
        description: null,
        folderId: null,
        ownerId: null,
        updatedAt: null,
        tiles: [
          {
            id: '11',
            title: 'ARR',
            lookId: null,
            query: {
              model: 'b2b',
              view: 'sales_pipeline',
              fields: [],
              filters: {},
              sorts: [],
              targetWarehouseConnectionId: '33333333-3333-4333-8333-333333333333',
            },
          },
        ],
      }),
    );
    await writeFile(
      join(stagedDir, 'looks', '2.json'),
      JSON.stringify({
        lookerId: '2',
        title: 'Customers',
        description: null,
        folderId: null,
        ownerId: null,
        updatedAt: null,
        query: {
          model: 'b2b',
          view: 'sales_pipeline',
          fields: [],
          filters: {},
          sorts: [],
          targetWarehouseConnectionId: '22222222-2222-4222-8222-222222222222',
        },
      }),
    );

    await expect(listLookerTargetConnectionIds(stagedDir)).resolves.toEqual([
      '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333',
    ]);
  });
});
