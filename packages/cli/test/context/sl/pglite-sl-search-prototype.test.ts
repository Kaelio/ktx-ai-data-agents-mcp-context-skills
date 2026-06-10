import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initKtxProject, type KtxLocalProject } from '../../../src/context/project/project.js';
import { assertSearchBackendConformanceCase } from '../search/backend-conformance.test-utils.js';
import { searchLocalSlSources, type LocalSlSourceSearchResult } from '../../../src/context/sl/local-sl.js';
import { searchLocalSlSourcesWithPglitePrototype } from '../../../src/context/sl/pglite-sl-search-prototype.js';
import { seedSlSourceFile } from './sl-source-seeding.test-utils.js';

const ORDERS_YAML = [
  'name: orders',
  'descriptions:',
  '  user: Orders with paid revenue and refund status.',
  'table: public.orders',
  'grain:',
  '  - order_id',
  'columns:',
  '  - name: order_id',
  '    type: string',
  '  - name: status',
  '    type: string',
  '  - name: revenue',
  '    type: number',
  'measures:',
  '  - name: total_revenue',
  '    expr: sum(revenue)',
  '',
].join('\n');

const FINANCE_ORDERS_YAML = [
  'name: orders',
  'descriptions:',
  '  user: Finance orders used for invoice reconciliation.',
  'table: finance.orders',
  'grain:',
  '  - order_id',
  'columns:',
  '  - name: order_id',
  '    type: string',
  '  - name: invoice_status',
  '    type: string',
  '',
].join('\n');

const CUSTOMERS_YAML = [
  'name: customers',
  'descriptions:',
  '  user: Customer lifecycle accounts by region.',
  'table: public.customers',
  'grain:',
  '  - customer_id',
  'columns:',
  '  - name: customer_id',
  '    type: string',
  '  - name: region',
  '    type: string',
  '',
].join('\n');

class FakeEmbeddingPort {
  readonly maxBatchSize = 16;

  async computeEmbedding(text: string): Promise<number[]> {
    const normalized = text.toLowerCase();
    if (normalized.includes('semantic revenue') || normalized.includes('orders with paid revenue')) {
      return [1, 0, 0];
    }
    if (normalized.includes('finance orders')) {
      return [0.72, 0.28, 0];
    }
    return [0, 1, 0];
  }

  async computeEmbeddingsBulk(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((text) => this.computeEmbedding(text)));
  }
}

async function allocatePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (typeof address !== 'object' || address === null) {
    throw new Error('Expected TCP server address while allocating a PGlite SL prototype port.');
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
  return address.port;
}

function toConformanceResult(result: LocalSlSourceSearchResult) {
  return {
    id: `${result.connectionId}/${result.name}`,
    score: result.score,
    matchReasons: result.matchReasons ?? [],
    lanes: result.lanes,
    dictionaryMatches: result.dictionaryMatches,
  };
}

async function seedSemanticLayerProject(project: KtxLocalProject): Promise<void> {
  await seedSlSourceFile(project, { connectionId: 'warehouse', sourceName: 'orders', yaml: ORDERS_YAML });
  await seedSlSourceFile(project, { connectionId: 'finance', sourceName: 'orders', yaml: FINANCE_ORDERS_YAML });
  await seedSlSourceFile(project, { connectionId: 'warehouse', sourceName: 'customers', yaml: CUSTOMERS_YAML });

  await project.fileStore.writeFile(
    'raw-sources/warehouse/live-database/sync-1/enrichment/relationship-profile.json',
    `${JSON.stringify(
      {
        connectionId: 'warehouse',
        driver: 'postgres',
        sqlAvailable: true,
        queryCount: 2,
        tables: [],
        columns: {
          'orders.status': {
            table: { catalog: null, db: 'public', name: 'orders' },
            column: 'status',
            nativeType: 'text',
            normalizedType: 'string',
            rowCount: 10,
            nullCount: 0,
            distinctCount: 2,
            uniquenessRatio: 0.2,
            nullRate: 0,
            sampleValues: ['paid', 'refunded'],
            minTextLength: 4,
            maxTextLength: 8,
          },
          'customers.region': {
            table: { catalog: null, db: 'public', name: 'customers' },
            column: 'region',
            nativeType: 'text',
            normalizedType: 'string',
            rowCount: 10,
            nullCount: 0,
            distinctCount: 3,
            uniquenessRatio: 0.3,
            nullRate: 0,
            sampleValues: ['emea', 'amer', 'apac'],
            minTextLength: 4,
            maxTextLength: 4,
          },
        },
        warnings: [],
      },
      null,
      2,
    )}\n`,
    'ktx',
    'ktx@example.com',
    'Seed PGlite dictionary profile',
  );
}

describe('PGlite semantic-layer search prototype', () => {
  let tempDir: string;
  let project: KtxLocalProject;
  let pgliteDataDir: string;
  let port: number;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-pglite-sl-prototype-'));
    project = await initKtxProject({ projectDir: join(tempDir, 'project') });
    project.config.ingest.embeddings.dimensions = 3;
    pgliteDataDir = join(tempDir, 'pglite-search');
    port = await allocatePort();
    await seedSemanticLayerProject(project);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('returns lexical semantic-layer matches through PGlite FTS', async () => {
    const results = await searchLocalSlSourcesWithPglitePrototype(project, {
      query: 'paid revenue',
      limit: 5,
      pglite: { dataDir: pgliteDataDir, host: '127.0.0.1', port },
    });

    assertSearchBackendConformanceCase({
      backendName: 'pglite-owner-prototype',
      surface: 'semantic-layer',
      caseName: 'pglite lexical source ranking',
      results: results.map(toConformanceResult),
      expectedTopIds: ['warehouse/orders'],
      expectedReasonsById: {
        'warehouse/orders': ['lexical'],
      },
      expectedLanes: {
        lexical: { status: 'available' },
        semantic: { status: 'skipped', reason: 'embedding_unconfigured' },
      },
    });
  });

  it('returns dictionary evidence through PGlite pg_trgm and exact matching', async () => {
    const results = await searchLocalSlSourcesWithPglitePrototype(project, {
      connectionId: 'warehouse',
      query: 'refund',
      limit: 5,
      pglite: { dataDir: pgliteDataDir, host: '127.0.0.1', port },
    });

    assertSearchBackendConformanceCase({
      backendName: 'pglite-owner-prototype',
      surface: 'semantic-layer',
      caseName: 'pglite dictionary source evidence',
      results: results.map(toConformanceResult),
      expectedTopIds: ['warehouse/orders'],
      expectedReasonsById: {
        'warehouse/orders': ['dictionary'],
      },
      expectedLanes: {
        dictionary: { status: 'available' },
        semantic: { status: 'skipped', reason: 'embedding_unconfigured' },
      },
      expectedDictionaryMatchesById: {
        'warehouse/orders': [{ column: 'status', values: ['refunded'] }],
      },
    });
  });

  it('returns semantic matches through PGlite vector ordering when embeddings are configured', async () => {
    const results = await searchLocalSlSourcesWithPglitePrototype(project, {
      query: 'semantic revenue',
      limit: 5,
      embeddingService: new FakeEmbeddingPort(),
      pglite: { dataDir: pgliteDataDir, host: '127.0.0.1', port },
    });

    assertSearchBackendConformanceCase({
      backendName: 'pglite-owner-prototype',
      surface: 'semantic-layer',
      caseName: 'pglite semantic source ranking',
      results: results.map(toConformanceResult),
      expectedTopIds: ['warehouse/orders'],
      expectedReasonsById: {
        'warehouse/orders': ['semantic'],
      },
      expectedLanes: {
        semantic: { status: 'available' },
      },
    });
  });

  it('routes through PGlite only when the private local search input opts in', async () => {
    const results = await searchLocalSlSources(project, {
      query: 'refnd',
      limit: 5,
      backend: 'pglite-owner-prototype',
      pglite: { dataDir: pgliteDataDir, host: '127.0.0.1', port },
    });

    expect(results[0]).toMatchObject({
      connectionId: 'warehouse',
      name: 'orders',
      matchReasons: expect.arrayContaining(['dictionary']),
      dictionaryMatches: [{ column: 'status', values: ['refunded'] }],
    });
  });
});
