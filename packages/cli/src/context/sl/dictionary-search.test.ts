import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initKtxProject, type KtxLocalProject } from '../../context/project/project.js';
import { createKtxDictionarySearchService } from './dictionary-search.js';

describe('createKtxDictionarySearchService', () => {
  let tempDir: string;
  let project: KtxLocalProject;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-dictionary-search-'));
    project = await initKtxProject({ projectDir: join(tempDir, 'project') });
    project.config.connections.warehouse = { driver: 'postgres', url: 'env:DATABASE_URL' };
    project.config.connections.billing = { driver: 'postgres', url: 'env:BILLING_DATABASE_URL' };
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  async function seedProfile(input: {
    connectionId: string;
    syncId: string;
    columns: Record<string, unknown>;
  }): Promise<void> {
    await project.fileStore.writeFile(
      `raw-sources/${input.connectionId}/live-database/${input.syncId}/enrichment/relationship-profile.json`,
      `${JSON.stringify(
        {
          connectionId: input.connectionId,
          driver: 'postgres',
          sqlAvailable: true,
          queryCount: 4,
          tables: [],
          columns: input.columns,
          warnings: [],
        },
        null,
        2,
      )}\n`,
      'ktx',
      'ktx@example.com',
      'Seed relationship profile',
    );
  }

  it('returns matches and non-authoritative misses across configured connections', async () => {
    await seedProfile({
      connectionId: 'warehouse',
      syncId: 'sync-1',
      columns: {
        'orders.status': {
          table: { catalog: null, db: 'public', name: 'orders' },
          column: 'status',
          nativeType: 'text',
          normalizedType: 'string',
          distinctCount: 3,
          sampleValues: ['paid', 'refunded', 'pending'],
        },
      },
    });
    await seedProfile({
      connectionId: 'billing',
      syncId: 'sync-2',
      columns: {
        'customers.name': {
          table: { catalog: null, db: 'public', name: 'customers' },
          column: 'name',
          nativeType: 'text',
          normalizedType: 'string',
          distinctCount: 4,
          sampleValues: ['Acme Corp', 'Globex'],
        },
      },
    });
    const service = createKtxDictionarySearchService(project);

    await expect(service.search({ values: ['PAID', 'missing'] })).resolves.toEqual({
      searched: [
        {
          connectionId: 'billing',
          coverage: {
            sampledRows: null,
            valuesPerColumn: null,
            profiledColumns: 1,
            syncId: 'sync-2',
            profiledAt: null,
          },
          status: 'ready',
        },
        {
          connectionId: 'warehouse',
          coverage: {
            sampledRows: null,
            valuesPerColumn: null,
            profiledColumns: 1,
            syncId: 'sync-1',
            profiledAt: null,
          },
          status: 'ready',
        },
      ],
      results: [
        {
          value: 'PAID',
          matches: [
            {
              connectionId: 'warehouse',
              sourceName: 'orders',
              columnName: 'status',
              matchedValue: 'paid',
              cardinality: 3,
            },
          ],
          misses: [{ connectionId: 'billing', reason: 'value_not_in_sample' }],
        },
        {
          value: 'missing',
          matches: [],
          misses: [
            { connectionId: 'billing', reason: 'value_not_in_sample' },
            { connectionId: 'warehouse', reason: 'value_not_in_sample' },
          ],
        },
      ],
    });
  });

  it('distinguishes missing profile artifacts from profiles with no candidate columns', async () => {
    await seedProfile({
      connectionId: 'billing',
      syncId: 'sync-empty',
      columns: {
        'events.id': {
          table: { catalog: null, db: 'public', name: 'events' },
          column: 'id',
          nativeType: 'integer',
          normalizedType: 'integer',
          distinctCount: 100,
          sampleValues: [1, 2, 3],
        },
      },
    });
    const service = createKtxDictionarySearchService(project);

    await expect(service.search({ values: ['Acme'] })).resolves.toEqual({
      searched: [
        {
          connectionId: 'billing',
          coverage: {
            sampledRows: null,
            valuesPerColumn: null,
            profiledColumns: 0,
            syncId: 'sync-empty',
            profiledAt: null,
          },
          status: 'no_candidate_columns',
        },
        {
          connectionId: 'warehouse',
          coverage: {
            sampledRows: null,
            valuesPerColumn: null,
            profiledColumns: 0,
            syncId: null,
            profiledAt: null,
          },
          status: 'no_profile_artifact',
        },
      ],
      results: [
        {
          value: 'Acme',
          matches: [],
          misses: [
            { connectionId: 'billing', reason: 'no_candidate_columns' },
            { connectionId: 'warehouse', reason: 'no_profile_artifact' },
          ],
        },
      ],
    });
  });

  it('scopes search to the requested connection', async () => {
    await seedProfile({
      connectionId: 'warehouse',
      syncId: 'sync-1',
      columns: {
        'orders.status': {
          table: { catalog: null, db: 'public', name: 'orders' },
          column: 'status',
          nativeType: 'text',
          normalizedType: 'string',
          distinctCount: 3,
          sampleValues: ['paid'],
        },
      },
    });
    await seedProfile({
      connectionId: 'billing',
      syncId: 'sync-2',
      columns: {
        'invoices.status': {
          table: { catalog: null, db: 'public', name: 'invoices' },
          column: 'status',
          nativeType: 'text',
          normalizedType: 'string',
          distinctCount: 2,
          sampleValues: ['paid'],
        },
      },
    });
    const service = createKtxDictionarySearchService(project);

    await expect(service.search({ connectionId: 'billing', values: ['paid'] })).resolves.toMatchObject({
      searched: [{ connectionId: 'billing', status: 'ready' }],
      results: [
        {
          value: 'paid',
          matches: [{ connectionId: 'billing', sourceName: 'invoices', columnName: 'status', matchedValue: 'paid' }],
          misses: [],
        },
      ],
    });
  });
});
