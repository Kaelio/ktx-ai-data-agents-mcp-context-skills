import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initKtxProject, type KtxLocalProject } from '../../context/project/project.js';
import { loadLatestSlDictionaryEntries } from './sl-dictionary-profile.js';

describe('loadLatestSlDictionaryEntries', () => {
  let tempDir: string;
  let project: KtxLocalProject;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-sl-dictionary-profile-'));
    project = await initKtxProject({ projectDir: join(tempDir, 'project') });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('loads latest relationship-profile sample values for dictionary candidate columns', async () => {
    await project.fileStore.writeFile(
      'raw-sources/warehouse/live-database/sync-1/enrichment/relationship-profile.json',
      `${JSON.stringify(
        {
          connectionId: 'warehouse',
          driver: 'postgres',
          sqlAvailable: true,
          queryCount: 4,
          tables: [],
          columns: {
            'orders.status': {
              table: { catalog: null, db: 'public', name: 'orders' },
              column: 'status',
              nativeType: 'text',
              normalizedType: 'string',
              rowCount: 20,
              nullCount: 0,
              distinctCount: 3,
              uniquenessRatio: 0.15,
              nullRate: 0,
              sampleValues: ['paid', 'refunded', 'pending'],
              minTextLength: 4,
              maxTextLength: 8,
            },
            'orders.customer_id': {
              table: { catalog: null, db: 'public', name: 'orders' },
              column: 'customer_id',
              nativeType: 'text',
              normalizedType: 'string',
              rowCount: 20,
              nullCount: 0,
              distinctCount: 20,
              uniquenessRatio: 1,
              nullRate: 0,
              sampleValues: ['cus_1'],
              minTextLength: 5,
              maxTextLength: 5,
            },
          },
          warnings: [],
        },
        null,
        2,
      )}\n`,
      'ktx',
      'ktx@example.com',
      'Seed profile',
    );

    await project.fileStore.writeFile(
      'raw-sources/warehouse/live-database/sync-2/enrichment/relationship-profile.json',
      `${JSON.stringify(
        {
          connectionId: 'warehouse',
          driver: 'postgres',
          sqlAvailable: true,
          queryCount: 4,
          tables: [],
          columns: {
            'orders.status': {
              table: { catalog: null, db: 'public', name: 'orders' },
              column: 'status',
              nativeType: 'text',
              normalizedType: 'string',
              rowCount: 20,
              nullCount: 0,
              distinctCount: 2,
              uniquenessRatio: 0.1,
              nullRate: 0,
              sampleValues: ['settled', 'voided'],
              minTextLength: 6,
              maxTextLength: 7,
            },
          },
          warnings: [],
        },
        null,
        2,
      )}\n`,
      'ktx',
      'ktx@example.com',
      'Seed newer profile',
    );

    await expect(loadLatestSlDictionaryEntries(project, ['warehouse'])).resolves.toEqual([
      { connectionId: 'warehouse', sourceName: 'orders', columnName: 'status', value: 'settled', cardinality: 2 },
      { connectionId: 'warehouse', sourceName: 'orders', columnName: 'status', value: 'voided', cardinality: 2 },
    ]);
  });

  it('returns an empty list when no relationship profile exists', async () => {
    await expect(loadLatestSlDictionaryEntries(project, ['warehouse'])).resolves.toEqual([]);
  });
});
